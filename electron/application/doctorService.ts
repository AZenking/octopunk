// Doctor 环境体检服务(specs/001-v03-stability-multi-teamrun US3 / FR-011..014,
// research R5)。九项检查并行执行,单项 5s 超时或抛错 → `unknown`(「无法确
// 认」),绝不拖垮整体;诚实优于臆造——读不到的数据源(如 Provider 配额)
// 固定 unknown。报告经仓储落库(overall 由领域 doctorOverallOf 派生),诊断
// 包导出前统一脱敏(FR-013)。GUI(IPC)与 MCP 共享本服务(宪法原则二)。

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DoctorCheckItemDTO,
  DoctorReportDTO,
} from "../../shared/dtos";
import {
  DOCTOR_CHECK_KEYS,
  agentKindDisplayName,
  type ChildAgentKind,
  type DoctorCheckKey,
  type DoctorTriggeredBy,
} from "../domain/models";
import { DomainError } from "../domain/models";
import type { DoctorReport, TeamRunRepository } from "../domain/repositoryPort";
import type { DiagnosticsProbePort } from "../platform/diagnosticsProbes";
import { ChildAgentDiagnostics, type ChildAgentAvailability } from "./ports";

// ---------------------------------------------------------------------------
// Injected ports (structural, defined here so the composition root stays flat)
// ---------------------------------------------------------------------------

/** appEnvironment.checkAgent 的结构切片:可执行 + 版本/错误 detail。 */
export interface DoctorAgentsPort {
  check(
    kind: "claude_code" | "codex" | "pi",
    override?: string | null,
  ): Promise<ChildAgentAvailability>;
}

/** GitAdapter.inspect 的结构切片(HEAD/分支/脏状态)。 */
export interface DoctorGitPort {
  inspect(url: string): Promise<{
    repositoryURL: string;
    head: string;
    hasUncommittedChanges: boolean;
    branchName: string | null;
  }>;
}

/** 数据库健康:schema 版本 + PRAGMA quick_check(null = 无法执行)。 */
export interface DoctorDatabasePort {
  health(): { version: number; quickCheck: boolean | null };
}

/** 受控命令执行(mcp_stdio/sandbox 轻探测);exitCode null = 无法启动/超时。 */
export type DoctorRunCommand = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

/** 可选的 worktree 建删探测(接线补;缺省只用磁盘余量判断)。 */
export interface DoctorWorktreeProbePort {
  canCreateWorktree(): Promise<boolean>;
}

/** 单项检查结论(落库前的草稿;overall 由仓储侧领域规则派生)。 */
interface ItemDraft {
  checkKey: DoctorCheckKey;
  status: "pass" | "fail" | "unknown";
  detail: string;
  impact: string;
  suggestion: string;
  durationMs: number;
}

/** 一次检查的共享上下文:agent 探测在九项间复用(一轮三个进程)。 */
interface CheckContext {
  /** null = 全局体检(仓库相关项按「跳过」语义处理)。 */
  repositoryPath: string | null;
  /** rerunItem 找不回报告所属仓库时为 false(此时 git_repo 只能 unknown)。 */
  scopeKnown: boolean;
  /** 惰性共享的三 Agent 探测;runCheckup 注入,rerunItem 时单项自建。 */
  agentProbe?: Promise<ChildAgentAvailability[]>;
}

const AGENT_KINDS: readonly ChildAgentKind[] = ["claude_code", "codex", "pi"];

/** 各 Agent CLI 的可执行名(建议文案用)。 */
const AGENT_BINARIES: Record<ChildAgentKind, string> = {
  claude_code: "claude",
  codex: "codex",
  pi: "pi",
};

/** detail 列(redact + 路径脱敏后)的硬上限,对齐 doctor_check_items 语义。 */
const DETAIL_LIMIT = 2048;
/** 单项检查超时(research R5:默认 5s)。 */
const DEFAULT_ITEM_TIMEOUT_MS = 5000;
/** worktree 托管目录的磁盘余量阈值(默认 1GiB,可注入覆盖)。 */
const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024;

/** 登录态失败的文本特征(checkAgent detail;子串匹配,大小写不敏感)。 */
const LOGIN_FAILURE_PATTERN =
  /not logged|log ?in required|login required|no api key|unauthorized|authentication|未登录|请先登录/i;

class DoctorCheckTimeoutError extends Error {
  constructor() {
    super("doctor check timeout");
    this.name = "DoctorCheckTimeoutError";
  }
}

/** 单项超时护栏:race 后清理定时器;输者 promise 的后续拒绝已被吞掉。 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  // 输掉 race 的 promise 之后若拒绝,不得变成 unhandled rejection。
  promise.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DoctorCheckTimeoutError()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

/** 主目录 → ~,再走 ChildAgentDiagnostics.redact(密钥/Token);导出与 detail 共用。 */
function sanitize(value: string): string {
  let result = value;
  const home = os.homedir();
  if (home.length > 1) result = result.split(home).join("~");
  return ChildAgentDiagnostics.redact(result);
}

function clip(value: string, limit = DETAIL_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function sanitizeDetail(value: string): string {
  return clip(sanitize(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileIsExecutable(file: string): boolean {
  try {
    return fs.existsSync(file) && fs.accessSync(file, fs.constants.X_OK) === undefined;
  } catch {
    return false;
  }
}

function gib(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GiB`;
}

/**
 * 内置受控命令执行兜底:独立子进程、输出截断、4.5s 强杀(exitCode → null),
 * 不继承主进程环境之外的状态。组合根注入 runCommand 时本函数不会被使用。
 */
function defaultRunCommand(cmd: string, args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ stdout: "", stderr: "", exitCode: null });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 8192) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 4500);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout: stdout.slice(0, 8192), stderr: stderr.slice(0, 8192), exitCode: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.slice(0, 8192),
        stderr: stderr.slice(0, 8192),
        exitCode: timedOut ? null : code,
      });
    });
  });
}

export class DoctorService {
  private readonly repository: TeamRunRepository;
  private readonly agents: DoctorAgentsPort;
  private readonly git: DoctorGitPort;
  private readonly probes: DiagnosticsProbePort;
  private readonly db: DoctorDatabasePort;
  private readonly selfExecutable: () => string;
  private readonly env: { PATH?: string } | undefined;
  private readonly runCommand: DoctorRunCommand;
  private readonly minFreeBytes: number;
  private readonly worktreeRoot: (() => string | null) | null;
  private readonly worktreeProbe: DoctorWorktreeProbePort | null;
  private readonly expectedSchemaVersion: number | null;
  private readonly itemTimeoutMs: number;
  /** reportID → repositoryPath(重检时找回仓库范围;进程重启后由调用方补传)。 */
  private readonly reportScopes = new Map<string, string | null>();

  constructor(input: {
    repository: TeamRunRepository;
    agents: DoctorAgentsPort;
    git: DoctorGitPort;
    probes: DiagnosticsProbePort;
    db: DoctorDatabasePort;
    selfExecutable: () => string;
    env?: { PATH?: string };
    runCommand?: DoctorRunCommand;
    /** worktree/磁盘采样针对的托管根目录;null = 未提供(该项转 unknown)。 */
    worktreeRoot?: () => string | null;
    worktreeProbe?: DoctorWorktreeProbePort;
    /** 当前迁移版本(OctoPunkDatabaseMigrator.currentVersion);null = 只查 quick_check。 */
    expectedSchemaVersion?: number;
    minFreeBytes?: number;
    itemTimeoutMs?: number;
  }) {
    this.repository = input.repository;
    this.agents = input.agents;
    this.git = input.git;
    this.probes = input.probes;
    this.db = input.db;
    this.selfExecutable = input.selfExecutable;
    this.env = input.env;
    this.runCommand = input.runCommand ?? defaultRunCommand;
    this.worktreeRoot = input.worktreeRoot ?? null;
    this.worktreeProbe = input.worktreeProbe ?? null;
    this.expectedSchemaVersion = input.expectedSchemaVersion ?? null;
    this.minFreeBytes = input.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
    this.itemTimeoutMs = input.itemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS;
  }

  // MARK: - API

  /**
   * 九项检查并行执行(FR-011):单项超时/抛错 → unknown(不拖垮整体),
   * 结果经 recordDoctorReport 落库(requestID 幂等)并返回 DTO。
   */
  async runCheckup(input: {
    requestID: string;
    repositoryPath?: string | null;
    triggeredBy: DoctorTriggeredBy;
  }): Promise<DoctorReportDTO> {
    const agentProbe = Promise.all(AGENT_KINDS.map((kind) => this.agents.check(kind)));
    agentProbe.catch(() => {}); // 各单项经由 withTimeout 观察 rejection
    const ctx: CheckContext = {
      repositoryPath: input.repositoryPath ?? null,
      scopeKnown: true,
      agentProbe,
    };
    const items = await Promise.all(
      DOCTOR_CHECK_KEYS.map((checkKey) => this.runGuarded(checkKey, ctx)),
    );
    const report = await this.repository.recordDoctorReport({
      requestID: input.requestID,
      triggeredBy: input.triggeredBy,
      repositoryPath: ctx.repositoryPath,
      items: items.map(({ checkKey, status, detail, impact, suggestion, durationMs }) => ({
        checkKey,
        status,
        detail,
        impact,
        suggestion,
        durationMs,
      })),
    });
    this.reportScopes.set(report.id, report.repositoryPath);
    return doctorReportDTO(report);
  }

  /** 最新体检报告直通(repositoryPath 省略 = 全局报告)。 */
  async latestReport(repositoryPath?: string | null): Promise<DoctorReportDTO | null> {
    const report = await this.repository.getLatestDoctorReport(repositoryPath ?? null);
    if (report == null) return null;
    this.reportScopes.set(report.id, report.repositoryPath);
    return doctorReportDTO(report);
  }

  /**
   * 单项重检(FR-014):只重跑该检查器并更新对应行,overall 由仓储重算。
   * 报告范围优先取入参,其次本进程的 runCheckup/latestReport 记忆;都拿不
   * 到时仓库相关项只能 unknown(诚实优于臆造),调用方可传 repositoryPath
   * 避免该情况。
   */
  async rerunItem(input: {
    requestID: string;
    reportID: string;
    checkKey: DoctorCheckKey;
    repositoryPath?: string | null;
  }): Promise<DoctorReportDTO> {
    const scopeKnown =
      input.repositoryPath !== undefined || this.reportScopes.has(input.reportID);
    const repositoryPath =
      input.repositoryPath !== undefined
        ? input.repositoryPath ?? null
        : (this.reportScopes.get(input.reportID) ?? null);
    const ctx: CheckContext = { repositoryPath, scopeKnown };
    const draft = await this.runGuarded(input.checkKey, ctx);
    const report = await this.repository.rerunDoctorCheckItem({
      requestID: input.requestID,
      reportID: input.reportID,
      checkKey: draft.checkKey,
      status: draft.status,
      detail: draft.detail,
      impact: draft.impact,
      suggestion: draft.suggestion,
      durationMs: draft.durationMs,
    });
    this.reportScopes.set(report.id, report.repositoryPath);
    return doctorReportDTO(report);
  }

  /**
   * 脱敏诊断包(FR-013):报告 JSON + 机器概要。主目录 → ~,再过
   * ChildAgentDiagnostics.redact(密钥/Token);OS 版本保留(排查必需,
   * 不含身份)。接受现成报告或 reportID(仅能解析到「最新」的那份,其余
   * 请直接传报告对象)。
   */
  async exportDiagnosticBundle(reportOrID: DoctorReportDTO | string): Promise<string> {
    const report = await this.resolveReport(reportOrID);
    const system = this.probes.sampleSystem();
    const bundle = {
      kind: "octopunk-doctor-bundle",
      schema: 1,
      generatedAt: new Date().toISOString(),
      machine: {
        os: `${os.platform()} ${os.release()}`,
        cpuCores: system.cpuCores,
        loadavg: system.loadavg,
        memoryFreeBytes: system.freeMemBytes,
        memoryTotalBytes: system.totalMemBytes,
      },
      report: {
        id: report.id,
        triggeredBy: report.triggeredBy,
        repositoryPath: report.repositoryPath == null ? "(全局)" : sanitize(report.repositoryPath),
        overall: report.overall,
        createdAt: new Date(report.createdAt * 1000).toISOString(),
        items: report.items.map((item) => ({
          checkKey: item.checkKey,
          status: item.status,
          detail: sanitizeDetail(item.detail),
          impact: clip(item.impact),
          suggestion: clip(item.suggestion),
          durationMs: item.durationMs,
        })),
      },
    };
    return JSON.stringify(bundle, null, 2);
  }

  /**
   * start_team 前的「注定失败」级拦截(FR-014):只收仓库不可用与全部
   * CLI 不可用两类;其余(未登录/磁盘紧张等)不阻塞,交给完整体检呈现。
   * 单项探测超时按「无法确认」跳过,不产生阻塞项(不臆造)。
   */
  async prestartBlockers(repositoryPath: string): Promise<string[]> {
    const [repoBlocker, cliBlocker] = await Promise.all([
      this.prestartRepositoryBlocker(repositoryPath),
      this.prestartCliBlocker(),
    ]);
    const blockers: string[] = [];
    if (repoBlocker != null) blockers.push(repoBlocker);
    if (cliBlocker != null) blockers.push(cliBlocker);
    return blockers;
  }

  // MARK: - Guarded execution

  /** 单项执行的统一护栏:5s 超时 → unknown「检查超时,无法确认」;抛错 → unknown。 */
  private async runGuarded(checkKey: DoctorCheckKey, ctx: CheckContext): Promise<ItemDraft> {
    const startedAt = Date.now();
    try {
      const draft = await withTimeout(this.checkOne(checkKey, ctx), this.itemTimeoutMs);
      return { ...draft, durationMs: Date.now() - startedAt };
    } catch (error) {
      const detail =
        error instanceof DoctorCheckTimeoutError
          ? "检查超时,无法确认。"
          : `检查失败,无法确认:${sanitizeDetail(errorMessage(error))}`;
      return {
        checkKey,
        status: "unknown",
        detail,
        impact: IMPACTS[checkKey],
        suggestion: SUGGESTIONS[checkKey],
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /** 九项检查器分派(与 DOCTOR_CHECK_KEYS 一一对应)。 */
  private async checkOne(checkKey: DoctorCheckKey, ctx: CheckContext): Promise<Omit<ItemDraft, "durationMs">> {
    switch (checkKey) {
      case "cli_path":
        return await this.checkCliPath(ctx);
      case "gui_path":
        return await this.checkGuiPath(ctx);
      case "login":
        return await this.checkLogin(ctx);
      case "mcp_stdio":
        return await this.checkMcpStdio();
      case "git_repo":
        return await this.checkGitRepo(ctx);
      case "worktree_disk":
        return await this.checkWorktreeDisk();
      case "sandbox":
        return await this.checkSandbox();
      case "provider_quota":
        return {
          checkKey,
          status: "unknown",
          detail: "OctoPunk 当前无法稳定读取 Provider 配额与限流状态,需在 Provider 控制台确认。",
          impact: IMPACTS.provider_quota,
          suggestion: SUGGESTIONS.provider_quota,
        };
      case "db_health":
        return this.checkDbHealth();
    }
  }

  // MARK: - Individual checks

  /** ① cli_path:三 Agent 可执行 + 版本;缺失者 fail(detail 含名称与建议)。 */
  private async checkCliPath(ctx: CheckContext): Promise<Omit<ItemDraft, "durationMs">> {
    const results = await this.agentResults(ctx);
    const missing = results.filter((result) => !result.isAvailable);
    if (missing.length > 0) {
      const lines = missing.map(
        (result) =>
          `${agentKindDisplayName(result.kind)}(${AGENT_BINARIES[result.kind]}):${sanitizeDetail(
            result.detail,
          )}`,
      );
      return {
        checkKey: "cli_path",
        status: "fail",
        detail: `以下 Agent CLI 不可用——${lines.join("；")}。`,
        impact: IMPACTS.cli_path,
        suggestion: SUGGESTIONS.cli_path,
      };
    }
    const versions = results.map((result) => {
      const version = result.detail.trim();
      return `${agentKindDisplayName(result.kind)}: ${version.length > 0 ? version : "可用"}`;
    });
    return {
      checkKey: "cli_path",
      status: "pass",
      detail: `三个 Agent CLI 均可执行——${versions.join("；")}。`,
      impact: IMPACTS.cli_path,
      suggestion: SUGGESTIONS.cli_path,
    };
  }

  /**
   * ② gui_path:GUI 进程继承的 PATH 是否覆盖各可执行目录(实现取简:
   * 目录 ∈ PATH 条目)。无法判断(无 PATH / 无可用 CLI)→ unknown。
   */
  private async checkGuiPath(ctx: CheckContext): Promise<Omit<ItemDraft, "durationMs">> {
    const rawPath = this.env?.PATH ?? process.env.PATH;
    if (rawPath == null || rawPath.trim().length === 0) {
      return {
        checkKey: "gui_path",
        status: "unknown",
        detail: "无法获取 GUI 进程继承的 PATH,不能对比终端环境。",
        impact: IMPACTS.gui_path,
        suggestion: SUGGESTIONS.gui_path,
      };
    }
    const entries = rawPath.split(path.delimiter).filter((entry) => entry.length > 0);
    const results = await this.agentResults(ctx);
    const usable = results.filter((result) => result.isAvailable);
    if (usable.length === 0) {
      return {
        checkKey: "gui_path",
        status: "unknown",
        detail: "没有可用的 Agent CLI,无法对比 PATH 一致性(先看 cli_path 项)。",
        impact: IMPACTS.gui_path,
        suggestion: SUGGESTIONS.gui_path,
      };
    }
    const outside = usable.filter((result) => !entries.includes(path.dirname(result.executable)));
    if (outside.length === 0) {
      return {
        checkKey: "gui_path",
        status: "pass",
        detail: `GUI 进程 PATH 已包含全部可用 CLI 的目录(${usable
          .map((result) => agentKindDisplayName(result.kind))
          .join("、")})。`,
        impact: IMPACTS.gui_path,
        suggestion: SUGGESTIONS.gui_path,
      };
    }
    const lines = outside.map(
      (result) =>
        `${agentKindDisplayName(result.kind)} 的目录 ${sanitize(path.dirname(result.executable))} 不在 GUI PATH 中`,
    );
    return {
      checkKey: "gui_path",
      status: "fail",
      detail: `GUI 继承的 PATH 缺少部分 CLI 目录——${lines.join("；")}。终端可用不代表 GUI 可用。`,
      impact: IMPACTS.gui_path,
      suggestion: SUGGESTIONS.gui_path,
    };
  }

  /** ③ login:checkAgent detail 的登录态解析;not-logged → fail,其余存疑 → unknown。 */
  private async checkLogin(ctx: CheckContext): Promise<Omit<ItemDraft, "durationMs">> {
    const results = await this.agentResults(ctx);
    const failed: string[] = [];
    const uncertain: string[] = [];
    for (const result of results) {
      const label = agentKindDisplayName(result.kind);
      if (result.isAvailable) continue;
      if (LOGIN_FAILURE_PATTERN.test(result.detail)) {
        failed.push(`${label}:${sanitizeDetail(result.detail)}`);
      } else {
        uncertain.push(`${label}:${sanitizeDetail(result.detail)}`);
      }
    }
    if (failed.length > 0) {
      return {
        checkKey: "login",
        status: "fail",
        detail: `以下 Agent 登录态异常——${failed.join("；")}。`,
        impact: IMPACTS.login,
        suggestion: SUGGESTIONS.login,
      };
    }
    if (uncertain.length > 0) {
      return {
        checkKey: "login",
        status: "unknown",
        detail: `CLI 启动失败且无法判定是否登录问题——${uncertain.join("；")}。`,
        impact: IMPACTS.login,
        suggestion: SUGGESTIONS.login,
      };
    }
    return {
      checkKey: "login",
      status: "pass",
      detail: "三个 Agent CLI 均可启动,未见登录失败特征(基于 CLI 探测输出判断)。",
      impact: IMPACTS.login,
      suggestion: SUGGESTIONS.login,
    };
  }

  /** ④ mcp_stdio:自启动可执行存在 + 轻探测(--version 级,经受控 runCommand)。 */
  private async checkMcpStdio(): Promise<Omit<ItemDraft, "durationMs">> {
    const executable = this.selfExecutable();
    if (!fileIsExecutable(executable)) {
      return {
        checkKey: "mcp_stdio",
        status: "fail",
        detail: `MCP 自启动可执行文件不可用:${sanitize(executable)}。子 Agent 将无法连接受限 MCP 服务。`,
        impact: IMPACTS.mcp_stdio,
        suggestion: SUGGESTIONS.mcp_stdio,
      };
    }
    const probe = await this.runCommand(executable, ["--version"]);
    if (probe.exitCode === 0) {
      return {
        checkKey: "mcp_stdio",
        status: "pass",
        detail: `自启动可执行 ${sanitize(executable)} 轻探测(--version)退出码 0,可正常拉起。`,
        impact: IMPACTS.mcp_stdio,
        suggestion: SUGGESTIONS.mcp_stdio,
      };
    }
    if (probe.exitCode == null) {
      return {
        checkKey: "mcp_stdio",
        status: "fail",
        detail: `自启动可执行 ${sanitize(executable)} 存在,但探测命令无法执行(启动失败或被中断)。`,
        impact: IMPACTS.mcp_stdio,
        suggestion: SUGGESTIONS.mcp_stdio,
      };
    }
    return {
      checkKey: "mcp_stdio",
      status: "unknown",
      detail: `自启动可执行 ${sanitize(executable)} 探测命令退出码 ${probe.exitCode},无法确认 MCP stdio 拉起是否正常:${sanitizeDetail(
        probe.stderr.trim().split("\n")[0] ?? "",
      )}`,
      impact: IMPACTS.mcp_stdio,
      suggestion: SUGGESTIONS.mcp_stdio,
    };
  }

  /** ⑤ git_repo:HEAD/分支/脏;脏 → fail(建议提交);空仓 → fail;其余错误 → unknown。 */
  private async checkGitRepo(ctx: CheckContext): Promise<Omit<ItemDraft, "durationMs">> {
    if (!ctx.scopeKnown) {
      return {
        checkKey: "git_repo",
        status: "unknown",
        detail: "无法确定该报告对应的仓库,请重新运行完整体检。",
        impact: IMPACTS.git_repo,
        suggestion: SUGGESTIONS.git_repo,
      };
    }
    if (ctx.repositoryPath == null) {
      return {
        checkKey: "git_repo",
        status: "pass",
        detail: "全局体检未指定仓库,跳过仓库状态检查。",
        impact: IMPACTS.git_repo,
        suggestion: SUGGESTIONS.git_repo,
      };
    }
    let state;
    try {
      state = await this.git.inspect(ctx.repositoryPath);
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes("no commits yet") || message.includes("初始提交")) {
        return {
          checkKey: "git_repo",
          status: "fail",
          detail: "仓库还没有任何提交,TeamRun 无法锚定基线(HEAD)。请先完成一次初始提交。",
          impact: IMPACTS.git_repo,
          suggestion: SUGGESTIONS.git_repo,
        };
      }
      return {
        checkKey: "git_repo",
        status: "unknown",
        detail: `无法检查仓库状态:${sanitizeDetail(message)}`,
        impact: IMPACTS.git_repo,
        suggestion: SUGGESTIONS.git_repo,
      };
    }
    if (state.hasUncommittedChanges) {
      return {
        checkKey: "git_repo",
        status: "fail",
        detail: `仓库有未提交改动(分支 ${state.branchName ?? "(detached)"}、head ${state.head.slice(0, 10)}),集成结果无法安全落盘。`,
        impact: IMPACTS.git_repo,
        suggestion: SUGGESTIONS.git_repo,
      };
    }
    return {
      checkKey: "git_repo",
      status: "pass",
      detail: `仓库状态正常:分支 ${state.branchName ?? "(detached)"}、head ${state.head.slice(0, 10)}、工作区干净。`,
      impact: IMPACTS.git_repo,
      suggestion: SUGGESTIONS.git_repo,
    };
  }

  /**
   * ⑥ worktree_disk:托管目录磁盘余量(statfs 经探针;阈值默认 1GiB 可注入)
   * + 可选的建删探测端口。采样失败 → unknown,不臆造。
   */
  private async checkWorktreeDisk(): Promise<Omit<ItemDraft, "durationMs">> {
    const root = this.worktreeRoot?.() ?? null;
    if (root == null) {
      return {
        checkKey: "worktree_disk",
        status: "unknown",
        detail: "未提供 worktree 托管根目录,无法采样磁盘余量。",
        impact: IMPACTS.worktree_disk,
        suggestion: SUGGESTIONS.worktree_disk,
      };
    }
    if (this.worktreeProbe != null && !(await this.worktreeProbe.canCreateWorktree())) {
      return {
        checkKey: "worktree_disk",
        status: "fail",
        detail: `无法在托管目录 ${sanitize(root)} 创建/删除临时目录,worktree 将不可用。`,
        impact: IMPACTS.worktree_disk,
        suggestion: SUGGESTIONS.worktree_disk,
      };
    }
    const sample = await this.probes.sampleDisk(root);
    if (sample == null) {
      return {
        checkKey: "worktree_disk",
        status: "unknown",
        detail: `磁盘采样失败(statfs ${sanitize(root)}),无法确认剩余空间。`,
        impact: IMPACTS.worktree_disk,
        suggestion: SUGGESTIONS.worktree_disk,
      };
    }
    if (sample.freeBytes < this.minFreeBytes) {
      return {
        checkKey: "worktree_disk",
        status: "fail",
        detail: `托管目录剩余空间 ${gib(sample.freeBytes)}(共 ${gib(sample.totalBytes)}),低于阈值 ${gib(
          this.minFreeBytes,
        )},worktree 可能创建失败。`,
        impact: IMPACTS.worktree_disk,
        suggestion: SUGGESTIONS.worktree_disk,
      };
    }
    return {
      checkKey: "worktree_disk",
      status: "pass",
      detail: `托管目录磁盘余量充足:剩余 ${gib(sample.freeBytes)} / 共 ${gib(sample.totalBytes)}。`,
      impact: IMPACTS.worktree_disk,
      suggestion: SUGGESTIONS.worktree_disk,
    };
  }

  /** ⑦ sandbox:sandbox-exec 实跑一次最小沙箱;退出码 0 → pass,无命令 → fail(macOS 必备)。 */
  private async checkSandbox(): Promise<Omit<ItemDraft, "durationMs">> {
    // "(version)" 单独传入是非法 profile(退出码 64);合法最小探测 =
    // 声明版本 + allow default 后在沙箱内执行 /bin/echo(实跑,非仅语法检查)。
    const probe = await this.runCommand("sandbox-exec", [
      "-p",
      "(version 1)(allow default)",
      "/bin/echo",
      "ok",
    ]);
    if (probe.exitCode === 0) {
      return {
        checkKey: "sandbox",
        status: "pass",
        detail: "sandbox-exec 可用(最小沙箱内执行命令成功),离线沙箱执行可用。",
        impact: IMPACTS.sandbox,
        suggestion: SUGGESTIONS.sandbox,
      };
    }
    if (probe.exitCode == null) {
      return {
        checkKey: "sandbox",
        status: "fail",
        detail: "找不到 sandbox-exec 或无法执行(macOS 必备组件),离线沙箱任务将失败。",
        impact: IMPACTS.sandbox,
        suggestion: SUGGESTIONS.sandbox,
      };
    }
    return {
      checkKey: "sandbox",
      status: "fail",
      detail: `sandbox-exec 探测失败(退出码 ${probe.exitCode}):${sanitizeDetail(
        probe.stderr.trim().split("\n")[0] ?? "",
      )}`,
      impact: IMPACTS.sandbox,
      suggestion: SUGGESTIONS.sandbox,
    };
  }

  /** ⑨ db_health:schema 版本 + PRAGMA quick_check;quick_check false → fail。 */
  private checkDbHealth(): Omit<ItemDraft, "durationMs"> {
    let health: { version: number; quickCheck: boolean | null };
    try {
      health = this.db.health();
    } catch (error) {
      return {
        checkKey: "db_health",
        status: "unknown",
        detail: `无法读取数据库健康信息:${sanitizeDetail(errorMessage(error))}`,
        impact: IMPACTS.db_health,
        suggestion: SUGGESTIONS.db_health,
      };
    }
    if (health.quickCheck === false) {
      return {
        checkKey: "db_health",
        status: "fail",
        detail: `数据库 PRAGMA quick_check 未通过(schema 版本 ${health.version}),数据可能已损坏。`,
        impact: IMPACTS.db_health,
        suggestion: SUGGESTIONS.db_health,
      };
    }
    if (this.expectedSchemaVersion != null && health.version < this.expectedSchemaVersion) {
      return {
        checkKey: "db_health",
        status: "fail",
        detail: `数据库 schema 版本落后(当前 ${health.version},期望 ${this.expectedSchemaVersion}),请重启应用完成迁移。`,
        impact: IMPACTS.db_health,
        suggestion: SUGGESTIONS.db_health,
      };
    }
    if (this.expectedSchemaVersion != null && health.version > this.expectedSchemaVersion) {
      return {
        checkKey: "db_health",
        status: "unknown",
        detail: `数据库 schema 版本(${health.version})高于当前应用(${this.expectedSchemaVersion}),可能由更新版本写入。`,
        impact: IMPACTS.db_health,
        suggestion: SUGGESTIONS.db_health,
      };
    }
    if (this.expectedSchemaVersion == null && !(health.version > 0)) {
      return {
        checkKey: "db_health",
        status: "fail",
        detail: "数据库 schema 版本异常(≤0),可能未完成初始化。",
        impact: IMPACTS.db_health,
        suggestion: SUGGESTIONS.db_health,
      };
    }
    return {
      checkKey: "db_health",
      status: "pass",
      detail: `数据库健康:schema 版本 ${health.version},quick_check ${health.quickCheck == null ? "未执行(视为通过)" : "通过"}。`,
      impact: IMPACTS.db_health,
      suggestion: SUGGESTIONS.db_health,
    };
  }

  // MARK: - Prestart helpers

  /** 仓库不可用 → 阻塞原因;探测超时 → null(不臆造)。 */
  private async prestartRepositoryBlocker(repositoryPath: string): Promise<string | null> {
    try {
      await withTimeout(this.git.inspect(repositoryPath), this.itemTimeoutMs);
      return null;
    } catch (error) {
      if (error instanceof DoctorCheckTimeoutError) return null;
      const message = sanitizeDetail(errorMessage(error));
      if (message.includes("no commits yet") || message.includes("初始提交")) {
        return "仓库还没有任何提交,请先完成初始提交再启动 TeamRun。";
      }
      return `目标仓库不可用(${message}),start_team 注定失败;请运行体检查看诊断。`;
    }
  }

  /** 全部 CLI 不可用 → 阻塞原因;探测超时 → null(不臆造)。 */
  private async prestartCliBlocker(): Promise<string | null> {
    const probe = Promise.all(AGENT_KINDS.map((kind) => this.agents.check(kind)));
    let results: ChildAgentAvailability[];
    try {
      results = await withTimeout(probe, this.itemTimeoutMs);
    } catch {
      return null;
    }
    if (results.some((result) => result.isAvailable)) return null;
    const lines = results.map(
      (result) =>
        `${agentKindDisplayName(result.kind)}(${AGENT_BINARIES[result.kind]}):${sanitizeDetail(result.detail)}`,
    );
    return `全部 Agent CLI 不可用——${lines.join("；")}。请先安装或配置 CLI,再启动 TeamRun。`;
  }

  // MARK: - Shared helpers

  /** 复用同轮 checkup 的三 Agent 探测;单检(rerunItem)时自建一轮。 */
  private agentResults(ctx: CheckContext): Promise<ChildAgentAvailability[]> {
    if (ctx.agentProbe != null) return ctx.agentProbe;
    const probe = Promise.all(AGENT_KINDS.map((kind) => this.agents.check(kind)));
    probe.catch(() => {}); // 由 withTimeout 的调用方观察 rejection
    return probe;
  }

  /** 诊断包入参解析:reportID 只能解析到对应范围的「最新」报告。 */
  private async resolveReport(reportOrID: DoctorReportDTO | string): Promise<DoctorReportDTO> {
    if (typeof reportOrID !== "string") return reportOrID;
    const scope = this.reportScopes.get(reportOrID) ?? null;
    const report = await this.repository.getLatestDoctorReport(scope);
    if (report == null || report.id !== reportOrID) {
      throw DomainError.invalidTask(`Doctor report not found: ${reportOrID}`);
    }
    this.reportScopes.set(report.id, report.repositoryPath);
    return doctorReportDTO(report);
  }
}

// ---------------------------------------------------------------------------
// DTO mapping (local — application/dtos.ts stays untouched for this task)
// ---------------------------------------------------------------------------

function doctorReportDTO(report: DoctorReport): DoctorReportDTO {
  const items: DoctorCheckItemDTO[] = report.items.map((item) => ({
    checkKey: item.checkKey,
    status: item.status,
    detail: item.detail,
    impact: item.impact,
    suggestion: item.suggestion,
    durationMs: item.durationMs,
  }));
  return {
    id: report.id,
    triggeredBy: report.triggeredBy,
    repositoryPath: report.repositoryPath,
    overall: report.overall,
    items,
    createdAt: report.createdAt,
  };
}

/** 影响范围文案(FR-012:每项必含失败原因/影响/建议)。 */
const IMPACTS: Record<DoctorCheckKey, string> = {
  cli_path: "对应 Agent 的任务委派将直接失败。",
  gui_path: "GUI 内启动的任务可能找不到 CLI(终端正常不代表 GUI 正常)。",
  login: "对应 Agent 的任务会在启动或执行中被拒绝。",
  mcp_stdio: "子 Agent 无法连接受限 MCP 服务,读取上下文与提交报告将失败。",
  git_repo: "TeamRun 无法锚定基线或安全落盘集成结果。",
  worktree_disk: "任务 worktree 创建失败,任务无法启动。",
  sandbox: "离线(只读)沙箱执行的任务将失败。",
  provider_quota: "配额耗尽或限流期间,任务启动会失败或反复重试。",
  db_health: "状态与审计数据不可靠,严重时应用无法工作。",
};

/** 推荐处理方式文案。 */
const SUGGESTIONS: Record<DoctorCheckKey, string> = {
  cli_path: "按官方文档安装缺失的 CLI,或在 OctoPunk 设置中显式配置可执行路径。",
  gui_path: "在设置中为各 Agent 显式配置绝对路径,或从 shell 启动 OctoPunk 以继承完整 PATH。",
  login: "在终端执行对应 CLI 的登录命令,完成后重检本项。",
  mcp_stdio: "重新安装/修复 OctoPunk;开发模式请确认应用根目录可写。",
  git_repo: "提交或暂存(git stash)当前改动后再启动 TeamRun。",
  worktree_disk: "清理托管目录所在磁盘,或把 OctoPunk 数据目录迁到空间充足的卷。",
  sandbox: "确认 /usr/bin/sandbox-exec 存在且可执行(macOS 系统组件)。",
  provider_quota: "登录 Provider 控制台查看配额与限流;必要时等待解除或提升配额。",
  db_health: "备份数据目录后重启应用触发迁移;持续失败请用恢复视图检查数据文件。",
};
