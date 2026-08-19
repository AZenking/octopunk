// Quality Gate 应用服务(specs/002-v04-review-center-gates / research R3、R4)。
// 用例编排层:门禁配置读写(项目默认 + 运行快照)、三类判定(状态类/Git 类/
// 命令类)、逐项明细落库、豁免后 overall 重算。判定结果 100% 先落库
// (recordGateEvaluation,requestID 幂等)再返回;unknown 永不改变 overall 的
// fail 判定(契约不变量 4);无配置视为全 pass 平凡门禁(interfaces.md B 节)。
// 命令类检查经 ProcessPort 在任务 worktree 内受控执行,环境白名单由
// LocalProcessAdapter 的 minimum() 统一收口(宪法原则四;应用层禁 node:fs
// 与子进程直调)。GUI 与 MCP 共享本服务(宪法原则二)。

import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/models";
import type {
  ChildTask,
  GateCheckKey,
  GateCheckStatus,
  GateOverall,
  ReviewCycle,
  RunSummary,
  TeamRun,
} from "../domain/models";
import {
  GATE_COMMAND_KEYS,
  validateGateConfig,
  type GateCheckCommandInput,
  type GateCommandKey,
  type GateConfigInput,
} from "../domain/policy";
import type { GateEvaluation, TeamRunRepository } from "../domain/repositoryPort";
import type { DiffTreeEntryDTO, ReviewCommentDTO } from "../../shared/dtos";
import {
  ChildAgentDiagnostics,
  CancellationError,
  type GitDiffSide,
  type GitPort,
  type ProcessPort,
} from "./ports";

/** specs/002 data-model:命令输出尾段经 redact 后 ≤2KiB 写入 detail。 */
const COMMAND_OUTPUT_TAIL_LIMIT = 2 * 1024;
/** todo_clean 扫描新增 Diff 行中的遗留标记(含 open 评论计数,spec FR)。 */
const TODO_MARKER_PATTERN = /\b(?:TODO|FIXME)\b/;
/** 单文件 Diff 分页扫描上限;超出视为无法完整确认 → unknown(不臆断 fail)。 */
const TODO_SCAN_PAGE_LIMIT = 256;
/** detail 中列举路径/评论锚点的条数上限(防超大 Diff 撑爆明细)。 */
const DETAIL_LIST_LIMIT = 8;

/**
 * Review Center 结构性端口(避免循环依赖):只取门禁判定所需的两个只读
 * 视图。ReviewCenterService 结构性满足本接口(duck typing,无需相互 import)。
 */
export interface ReviewCenterGatePort {
  unresolvedFindings(runID: string, taskID: string): Promise<ReviewCommentDTO[]>;
  getDiffTree(runID: string, taskID: string, side: GitDiffSide): Promise<DiffTreeEntryDTO[]>;
}

/** evaluate 的逐项草稿(落库前形态;id/豁免字段由仓储生成)。 */
interface GateItemDraft {
  checkKey: GateCheckKey;
  status: GateCheckStatus;
  detail: string;
  fixSuggestion: string | null;
}

/** 判定期使用的归一化配置(缺省字段落到 spec 默认值)。 */
interface EffectiveGateConfig {
  checks: Partial<Record<GateCommandKey, GateCheckCommandInput | null>>;
  maxRiskFindings: number;
  scopeAllowedPaths: string[];
  requireDependenciesAccepted: boolean;
  requireTargetBaselineSafe: boolean;
  requiredReviewers: string[];
  manualConfirmHighRisk: boolean;
  requireTodoClean: boolean;
}

/** 失败项的固定修复建议模板(按 check_key,specs FR-008 拒绝布尔值)。 */
const FIX_SUGGESTIONS: Record<GateCheckKey, string> = {
  tests: "在任务 worktree 内修复失败用例并重跑配置的测试命令,确认退出码为 0 后重新执行门禁。",
  lint: "运行项目 lint 命令并修复全部告警,使检查命令退出码为 0 后重新执行门禁。",
  typecheck: "修复类型错误后重跑 typecheck 命令,确保无类型错误再重新执行门禁。",
  build: "修复构建错误后重跑构建命令,确保退出码为 0 再重新执行门禁。",
  risk_findings: "在 Review Center 逐条解决或 dismiss(附理由)未解决的 risk 评论,使数量降至阈值内。",
  scope: "将变更收敛到 scope_allowed_paths 白名单内,或由项目负责人显式更新门禁白名单。",
  dependencies: "等待依赖任务全部 accepted(必要时驱动其返工/验收)后重新执行门禁。",
  target_baseline: "切回目标分支并提交或清理工作区改动,使目标仓库回到安全基线后再验收。",
  reviewers: "按 required_reviewers 补齐对应类型的审查轮次;无法自动确认时人工复核审查记录。",
  high_risk_confirm: "对 risk 评论逐条解决,或以附理由的 dismiss 形成显式确认记录后再验收。",
  todo_clean: "清理变更中新增的 TODO/FIXME 标记并处理遗留 open 评论,再重新执行门禁。",
};

/** 安全解码 config_json:解析失败/非对象一律视为无配置(回退下一层)。 */
function decodeConfigJSON(json: string | null): GateConfigInput | null {
  if (json == null || json.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as GateConfigInput;
  } catch {
    return null;
  }
}

/** 运行期字段归一(保存时校验之外的防御:快照 JSON 只被断言、未被验证)。 */
function normalizeGateConfig(config: GateConfigInput): EffectiveGateConfig {
  return {
    checks: config.checks ?? {},
    maxRiskFindings: typeof config.maxRiskFindings === "number" ? config.maxRiskFindings : 0,
    scopeAllowedPaths: Array.isArray(config.scopeAllowedPaths) ? config.scopeAllowedPaths : [],
    requireDependenciesAccepted: config.requireDependenciesAccepted === true,
    requireTargetBaselineSafe: config.requireTargetBaselineSafe === true,
    requiredReviewers: Array.isArray(config.requiredReviewers) ? config.requiredReviewers : [],
    manualConfirmHighRisk: config.manualConfirmHighRisk === true,
    requireTodoClean: config.requireTodoClean === true,
  };
}

/** 项目默认 ⊕ 运行覆盖(字段级;覆盖侧 undefined 不覆盖,便于部分覆盖)。 */
function mergeGateConfigs(base: GateConfigInput | null, override: GateConfigInput | null): GateConfigInput {
  const merged: GateConfigInput = { ...(base ?? {}) };
  if (override == null) return merged;
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/** overall 重算:unwaived fail 仍在 → fail;存在 waived(且无 fail)→ waived;否则 pass。 */
function overallFromItems(items: readonly { status: GateCheckStatus }[]): GateOverall {
  if (items.some((item) => item.status === "fail")) return "fail";
  if (items.some((item) => item.status === "waived")) return "waived";
  return "pass";
}

/** scope 白名单前缀匹配:目录前缀按段匹配("src" 覆盖 "src/a.ts",不覆盖 "srcx/a.ts")。 */
function pathAllowedByPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return path === prefix || path.startsWith(normalized);
  });
}

/**
 * LocalProcessAdapter 对非 0 退出码抛错而非返回结果(Port 契约的适配器实现
 * 细节);应用层不 import 平台类,按结构读取 {exitCode, stdout, stderr}。
 */
function processFailureOf(error: unknown): { exitCode: number; output: string } | null {
  if (typeof error !== "object" || error == null) return null;
  const candidate = error as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
  if (typeof candidate.exitCode !== "number") return null;
  const output = [candidate.stderr, candidate.stdout]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return { exitCode: candidate.exitCode, output };
}

export class QualityGateService {
  private readonly repository: TeamRunRepository;
  private readonly git: GitPort;
  private readonly process: ProcessPort;
  private readonly reviewCenter: ReviewCenterGatePort;

  constructor(input: {
    repository: TeamRunRepository;
    git: GitPort;
    process: ProcessPort;
    reviewCenter: ReviewCenterGatePort;
  }) {
    this.repository = input.repository;
    this.git = input.git;
    this.process = input.process;
    this.reviewCenter = input.reviewCenter;
  }

  /**
   * run 的生效配置(R4):优先 gate_snapshot_json(启动时冻结,项目默认后续
   * 修改不影响已启动的 run);无快照(旧 run / 未走 startTeam 集成)回退项目
   * 默认 config_json;再无则 null = 全 pass 平凡门禁(interfaces.md B 节)。
   */
  async getEffectiveConfig(runID: string): Promise<GateConfigInput | null> {
    const fromSnapshot = decodeConfigJSON(await this.repository.getRunGateSnapshot(runID));
    if (fromSnapshot != null) return fromSnapshot;
    const summary = await this.repository.runSummary(runID);
    const project = await this.repository.getGateConfig(summary.run.repositoryPath);
    return decodeConfigJSON(project?.configJson ?? null);
  }

  /**
   * 写项目默认门禁:保存前领域校验(结构/矛盾组合,policy FR-007,错误即抛)。
   * requestID 保留在签名中对齐下游 API;仓储按 repository_path upsert,天然幂等。
   */
  async saveProjectDefault(
    requestID: string,
    repositoryPath: string,
    config: GateConfigInput,
  ): Promise<void> {
    validateGateConfig(config);
    await this.repository.saveGateConfig({
      repositoryPath,
      configJson: JSON.stringify(config),
      updatedAt: Date.now() / 1000,
    });
  }

  /**
   * 启动时固化运行快照(startTeam 集成任务调用):项目默认 ⊕ 覆盖后整体过
   * 一次保存时校验——矛盾组合(如 contest × require_dependencies_accepted)
   * 可能只在合并后才出现,必须在启动期拒绝而非运行中卡死。
   */
  async snapshotForRun(runID: string, override: GateConfigInput | null): Promise<void> {
    const summary = await this.repository.runSummary(runID);
    const project = await this.repository.getGateConfig(summary.run.repositoryPath);
    const merged = mergeGateConfigs(decodeConfigJSON(project?.configJson ?? null), override);
    validateGateConfig(merged);
    await this.repository.saveRunGateSnapshot(runID, JSON.stringify(merged));
  }

  /**
   * 执行门禁判定(specs FR-008:overall + 逐项明细,拒绝布尔值)。三类判定:
   * 状态类经仓储/ReviewCenter、Git 类经 GitPort、命令类经 ProcessPort;结果
   * 先 recordGateEvaluation(requestID 幂等)再返回。unknown 只呈现不阻塞。
   */
  async evaluate(input: { requestID: string; runID: string; taskID: string }): Promise<GateEvaluation> {
    const summary = await this.repository.runSummary(input.runID);
    const task = summary.tasks.find((candidate) => candidate.id === input.taskID);
    if (task == null) throw DomainError.taskNotFound(input.taskID);

    const effective = await this.getEffectiveConfig(input.runID);
    const drafts: GateItemDraft[] = [];
    if (effective == null) {
      // 无配置 = 全 pass 平凡门禁:不产出检查项,但仍落库留档(可审计)。
      return await this.repository.recordGateEvaluation({
        requestID: input.requestID,
        runID: input.runID,
        taskID: input.taskID,
        overall: "pass",
        items: [],
      });
    }

    const config = normalizeGateConfig(effective);
    const findings = await this.reviewCenter.unresolvedFindings(input.runID, input.taskID);
    // scope 与 todo_clean 共用 worktree 侧变更树:按需取一次,避免重复 git 往返。
    const needsTree = config.scopeAllowedPaths.length > 0 || config.requireTodoClean;
    const tree = needsTree
      ? await this.reviewCenter.getDiffTree(input.runID, input.taskID, "worktree")
      : [];

    // ---- 状态类检查 ----
    drafts.push(this.checkRiskFindings(config, findings));
    if (config.scopeAllowedPaths.length > 0) {
      drafts.push(this.checkScope(config, tree));
    }
    if (config.requireDependenciesAccepted) {
      drafts.push(this.checkDependencies(summary, task));
    }
    if (config.requiredReviewers.length > 0) {
      // reviewCycles 只在完整 snapshot 中;仅在启用该检查时才加载重聚合。
      const snapshot = await this.repository.snapshot(input.runID);
      drafts.push(this.checkReviewers(snapshot.reviewCycles, task, config.requiredReviewers));
    }
    if (config.manualConfirmHighRisk) {
      drafts.push(this.checkHighRiskConfirm(findings));
    }
    if (config.requireTodoClean) {
      drafts.push(await this.checkTodoClean(summary.run, task, tree, findings));
    }

    // ---- Git 类(GitPort) ----
    if (config.requireTargetBaselineSafe) {
      drafts.push(await this.checkTargetBaseline(summary.run));
    }

    // ---- 命令类(ProcessPort,任务 worktree 内受控执行) ----
    for (const key of GATE_COMMAND_KEYS) {
      const command = config.checks[key];
      if (command == null) continue;
      drafts.push(await this.runCheckCommand(key, command, task));
    }

    return await this.repository.recordGateEvaluation({
      requestID: input.requestID,
      runID: input.runID,
      taskID: input.taskID,
      overall: overallFromItems(drafts),
      items: drafts,
    });
  }

  /**
   * 豁免失败项(逐项、必须附理由,契约不变量 5):仓储落豁免留痕后按当前
   * 全量 items 重算 overall(全部 fail 项已豁免 → waived)并持久化。
   */
  async waive(input: {
    requestID: string;
    evaluationID: string;
    itemID: string;
    waivedBy: string;
    waivedReason: string;
  }): Promise<GateEvaluation> {
    if (input.waivedReason.trim().length === 0) {
      throw DomainError.invalidTask("豁免必须携带理由(waive_gate_item 契约不变量 5)。");
    }
    await this.repository.waiveGateItem(input);
    const items = await this.repository.listGateEvaluationItems(input.evaluationID);
    return await this.repository.updateGateEvaluationOverall({
      evaluationID: input.evaluationID,
      overall: overallFromItems(items),
    });
  }

  /** 最近一次门禁判定直通(accept 前强制判定与上下文展示共用)。 */
  async latestEvaluation(runID: string, taskID: string): Promise<GateEvaluation | null> {
    return await this.repository.getLatestGateEvaluation(runID, taskID);
  }

  // ---- 状态类检查 ----

  /** risk_findings:未解决 risk 评论数 ≤ maxRiskFindings(默认 0,零容忍)。 */
  private checkRiskFindings(
    config: EffectiveGateConfig,
    findings: readonly ReviewCommentDTO[],
  ): GateItemDraft {
    const risks = findings.filter((finding) => finding.severity === "risk");
    const passed = risks.length <= config.maxRiskFindings;
    const anchors = risks
      .slice(0, DETAIL_LIST_LIMIT)
      .map((finding) => `${finding.filePath}:${finding.lineStart}`)
      .join("、");
    return {
      checkKey: "risk_findings",
      status: passed ? "pass" : "fail",
      detail: passed
        ? `未解决 risk 发现 ${risks.length} 条(阈值 ${config.maxRiskFindings})。`
        : `未解决 risk 发现 ${risks.length} 条,超过阈值 ${config.maxRiskFindings}${
            anchors.length > 0 ? `:${anchors}` : ""
          }。`,
      fixSuggestion: passed ? null : FIX_SUGGESTIONS.risk_findings,
    };
  }

  /** scope:worktree 侧 Diff 全部路径 ⊆ scopeAllowedPaths(空列表 = 不限,不启用检查)。 */
  private checkScope(config: EffectiveGateConfig, tree: readonly DiffTreeEntryDTO[]): GateItemDraft {
    const violations = tree.filter((entry) => !pathAllowedByPrefix(entry.path, config.scopeAllowedPaths));
    const passed = violations.length === 0;
    const listed = violations.slice(0, DETAIL_LIST_LIMIT).map((entry) => entry.path).join("、");
    return {
      checkKey: "scope",
      status: passed ? "pass" : "fail",
      detail: passed
        ? `变更 ${tree.length} 个文件,全部位于白名单前缀内(${config.scopeAllowedPaths.join("、")})。`
        : `越界变更 ${violations.length} 个文件(白名单 ${config.scopeAllowedPaths.join("、")})${
            listed.length > 0 ? `:${listed}` : ""
          }。`,
      fixSuggestion: passed ? null : FIX_SUGGESTIONS.scope,
    };
  }

  /** dependencies:该任务依赖的任务全部 accepted(依赖缺失按未 accepted 处理)。 */
  private checkDependencies(summary: RunSummary, task: ChildTask): GateItemDraft {
    const dependencyIDs = summary.dependencies
      .filter((dependency) => dependency.taskID === task.id)
      .map((dependency) => dependency.dependsOnTaskID);
    const notAccepted = dependencyIDs.filter((id) => {
      const dependency = summary.tasks.find((candidate) => candidate.id === id);
      return dependency == null || dependency.status !== "accepted";
    });
    const passed = notAccepted.length === 0;
    return {
      checkKey: "dependencies",
      status: passed ? "pass" : "fail",
      detail: passed
        ? `依赖任务 ${dependencyIDs.length} 个,均已 accepted。`
        : `依赖任务未全部 accepted(缺失/未验收 ${notAccepted.length} 个:${notAccepted.join("、")})。`,
      fixSuggestion: passed ? null : FIX_SUGGESTIONS.dependencies,
    };
  }

  /**
   * reviewers(近似判定):required_reviewers 中每种类型在该任务的审查轮次
   * 记录里出现即 pass;记录缺失 ≠ 审查未发生,无法确认 → unknown(不阻塞)。
   */
  private checkReviewers(
    cycles: readonly ReviewCycle[],
    task: ChildTask,
    required: readonly string[],
  ): GateItemDraft {
    const present = new Set(cycles.filter((cycle) => cycle.taskID === task.id).map((c) => c.reviewer));
    const missing = required.filter((reviewer) => !present.has(reviewer));
    if (missing.length === 0) {
      return {
        checkKey: "reviewers",
        status: "pass",
        detail: `required_reviewers(${required.join("、")})均有对应审查轮次记录。`,
        fixSuggestion: null,
      };
    }
    return {
      checkKey: "reviewers",
      status: "unknown",
      detail: `无法确认 ${missing.join("、")} 的审查轮次记录(近似判定:轮次缺失不等于审查未发生)。`,
      fixSuggestion: null,
    };
  }

  /**
   * high_risk_confirm:存在 risk 评论时须有显式确认。dismissed(附理由)的
   * risk 评论已离开 open 清单 = 已有显式确认记录;故 open risk > 0 即 fail,
   * 无 risk 评论直接 pass。
   */
  private checkHighRiskConfirm(findings: readonly ReviewCommentDTO[]): GateItemDraft {
    const risks = findings.filter((finding) => finding.severity === "risk");
    if (risks.length === 0) {
      return {
        checkKey: "high_risk_confirm",
        status: "pass",
        detail: "无 risk 评论,无需人工确认。",
        fixSuggestion: null,
      };
    }
    const anchors = risks
      .slice(0, DETAIL_LIST_LIMIT)
      .map((finding) => `${finding.filePath}:${finding.lineStart}`)
      .join("、");
    return {
      checkKey: "high_risk_confirm",
      status: "fail",
      detail: `存在 ${risks.length} 条未确认 risk 评论(需解决或附理由 dismiss):${anchors}。`,
      fixSuggestion: FIX_SUGGESTIONS.high_risk_confirm,
    };
  }

  /**
   * todo_clean:新增 Diff 行中的 TODO/FIXME 标记数 + open 评论数 = 0。
   * 实现选择:应用层禁 node:fs,不能直接读 worktree 文件内容;改用
   * git.diffPage(worktree 侧,任务分支 ↔ 基线)分页扫描【新增行】的标记 ——
   * 走已注入的 GitPort 而非 reviewCenter.getDiffPage,避免加宽结构性端口,
   * 且 run/task 参数在判定现场齐备。二进制/超大文件无逐行内容,逐条跳过;
   * 变更全部为二进制/超大时无可扫描文本 → unknown(不臆断 pass/fail)。
   */
  private async checkTodoClean(
    run: TeamRun,
    task: ChildTask,
    tree: readonly DiffTreeEntryDTO[],
    findings: readonly ReviewCommentDTO[],
  ): Promise<GateItemDraft> {
    let markers = 0;
    const anchors: string[] = [];
    let oversized = false;
    let scannable = 0;
    for (const entry of tree) {
      if (entry.isBinary || entry.oversize) continue;
      scannable += 1;
      let cursor: string | null = null;
      let pages = 0;
      let incomplete = false;
      do {
        if (++pages > TODO_SCAN_PAGE_LIMIT) {
          incomplete = true;
          break;
        }
        const page = await this.git.diffPage({
          repositoryURL: run.repositoryPath,
          runID: task.runID,
          taskID: task.id,
          baselineCommit: task.baselineCommit,
          taskBranch: task.branchName,
          side: "worktree",
          path: entry.path,
          cursor,
        });
        for (const hunk of page.hunks) {
          for (const line of hunk.lines) {
            if (line.origin === "add" && TODO_MARKER_PATTERN.test(line.text)) {
              markers += 1;
              if (anchors.length < DETAIL_LIST_LIMIT) {
                anchors.push(`${entry.path}:${line.newLine ?? "?"}`);
              }
            }
          }
        }
        cursor = page.nextCursor;
      } while (cursor != null && !incomplete);
      if (incomplete) {
        oversized = true;
        break;
      }
    }
    if (oversized) {
      return {
        checkKey: "todo_clean",
        status: "unknown",
        detail: `Diff 分页超过 ${TODO_SCAN_PAGE_LIMIT} 页,无法完整扫描 TODO/FIXME(无法确认)。`,
        fixSuggestion: null,
      };
    }
    // 有变更文件但全部为二进制/超大文件:没有可扫描的新增文本行,无法确认
    // "无遗留 TODO" → unknown(仅呈现,不臆断 pass/fail)。
    if (tree.length > 0 && scannable === 0) {
      return {
        checkKey: "todo_clean",
        status: "unknown",
        detail: "Diff 全为二进制/超大文件,无新增文本行可扫描 TODO/FIXME(无法确认)。",
        fixSuggestion: null,
      };
    }
    const openCount = findings.length;
    const passed = markers + openCount === 0;
    return {
      checkKey: "todo_clean",
      status: passed ? "pass" : "fail",
      detail: passed
        ? "无新增 TODO/FIXME 标记且无遗留 open 评论。"
        : `新增 TODO/FIXME 标记 ${markers} 处${
            anchors.length > 0 ? `(${anchors.join("、")})` : ""
          } + open 评论 ${openCount} 条。`,
      fixSuggestion: passed ? null : FIX_SUGGESTIONS.todo_clean,
    };
  }

  // ---- Git 类检查 ----

  /**
   * target_baseline(精确规则):head === baselineCommit,或当前分支 ===
   * targetBranch 且工作区干净(head 在基线之后未变基的合法推进)。
   * inspect 失败(仓库不可达等)→ unknown,不臆断 fail。
   */
  private async checkTargetBaseline(run: TeamRun): Promise<GateItemDraft> {
    let state;
    try {
      state = await this.git.inspect(run.repositoryPath);
    } catch (error) {
      return {
        checkKey: "target_baseline",
        status: "unknown",
        detail: `无法检查目标仓库状态:${ChildAgentDiagnostics.redact(String(error))}`,
        fixSuggestion: null,
      };
    }
    const onBaseline = state.head === run.baselineCommit;
    const onTargetBranch =
      run.targetBranch.length > 0 &&
      state.branchName === run.targetBranch &&
      !state.hasUncommittedChanges;
    if (onBaseline || onTargetBranch) {
      return {
        checkKey: "target_baseline",
        status: "pass",
        detail: `目标仓库位于安全基线(head ${state.head.slice(0, 10)}${
          onBaseline ? " === baseline" : `,分支 ${state.branchName} 且工作区干净`
        })。`,
        fixSuggestion: null,
      };
    }
    return {
      checkKey: "target_baseline",
      status: "fail",
      detail: `目标基线不安全:当前分支 ${state.branchName ?? "(detached)"}、head ${
        state.head.slice(0, 10)
      }(baseline ${run.baselineCommit.slice(0, 10)})、未提交改动 ${
        state.hasUncommittedChanges ? "有" : "无"
      }。`,
      fixSuggestion: FIX_SUGGESTIONS.target_baseline,
    };
  }

  // ---- 命令类检查 ----

  /**
   * tests/lint/typecheck/build:在任务 worktree 内经 /bin/sh -c 受控执行;
   * 超时 → unknown(注明"命令超时,无法确认");退出码 0 → pass;非 0 →
   * fail(detail 含 redact 后输出尾段 ≤2KiB);worktree 缺失/无法执行 → unknown。
   */
  private async runCheckCommand(
    key: GateCommandKey,
    command: GateCheckCommandInput,
    task: ChildTask,
  ): Promise<GateItemDraft> {
    // 应用层禁 fs:worktree 可用性经 git.inspect 探测(缺失/非仓库即抛错)。
    try {
      await this.git.inspect(task.worktreePath);
    } catch {
      return {
        checkKey: key,
        status: "unknown",
        detail: `任务 worktree 不可用(${task.worktreePath}),无法执行 ${key} 检查(无法确认)。`,
        fixSuggestion: null,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), command.timeoutSeconds * 1000);
    try {
      const result = await this.process.run(
        {
          id: randomUUID(),
          executable: "/bin/sh",
          arguments: ["-c", command.command],
          workingDirectory: task.worktreePath,
          // 环境白名单:请求侧零注入,由 LocalProcessAdapter 的 minimum()
          // (PATH/HOME 等最小集)统一收口;命令无法读取宿主其余环境。
          environment: {},
        },
        controller.signal,
      );
      if (result.exitCode === 0) {
        return {
          checkKey: key,
          status: "pass",
          detail: `命令 \`${command.command}\` 退出码 0(worktree 内受控执行,超时 ${command.timeoutSeconds}s)。`,
          fixSuggestion: null,
        };
      }
      return {
        checkKey: key,
        status: "fail",
        detail: this.commandFailureDetail(key, command, result.exitCode, `${result.stderr}\n${result.stdout}`),
        fixSuggestion: FIX_SUGGESTIONS[key],
      };
    } catch (error) {
      if (controller.signal.aborted || error instanceof CancellationError) {
        return {
          checkKey: key,
          status: "unknown",
          detail: `命令超时(${command.timeoutSeconds}s),无法确认:\`${command.command}\`。`,
          fixSuggestion: null,
        };
      }
      const failure = processFailureOf(error);
      if (failure != null) {
        return {
          checkKey: key,
          status: "fail",
          detail: this.commandFailureDetail(key, command, failure.exitCode, failure.output),
          fixSuggestion: FIX_SUGGESTIONS[key],
        };
      }
      return {
        checkKey: key,
        status: "unknown",
        detail: `命令无法执行(无法确认):\`${command.command}\` — ${ChildAgentDiagnostics.redact(
          error instanceof Error ? error.message : String(error),
        )}`,
        fixSuggestion: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 非零退出的明细:命令 + 退出码 + redact 后输出尾段(≤2KiB,尾段优先)。 */
  private commandFailureDetail(
    key: GateCommandKey,
    command: GateCheckCommandInput,
    exitCode: number,
    output: string,
  ): string {
    const tail = ChildAgentDiagnostics.redact(output, COMMAND_OUTPUT_TAIL_LIMIT).trim();
    return [
      `${key} 检查失败:命令 \`${command.command}\` 退出码 ${exitCode}。`,
      tail.length > 0 ? `输出尾段(redact ≤2KiB):\n${tail}` : "(无输出)",
    ].join("\n");
  }
}
