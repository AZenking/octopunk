// T025: DoctorService 组合测试(specs/001-v03-stability-multi-teamrun US3 /
// FR-011..014 / R5)。组合方式:真实 SqliteTeamRunRepository(内存 DB,承载数据
// 落库与 overall 派生)+ 全部检查器依赖注入 stub(agents.check 可控可用性与
// detail、git.inspect 可控状态/抛错/挂起、probes.sampleDisk 可控余量、db.health
// 可控版本与 quick_check、runCommand 可控退出码与挂起、selfExecutable 指向真实
// 存在的可执行文件 process.execPath)。九项并行、单项超时→unknown 的诚实降级
// 语义与诊断包脱敏(home→~ + redact)均为断言对象。

import { describe, expect, it } from "vitest";
import os from "node:os";
import { OctoPunkDatabase } from "../electron/data/database";
import { SqliteTeamRunRepository } from "../electron/data/repository";
import type { DoctorReportDTO } from "../shared/dtos";
import type { DoctorCheckKey } from "../electron/domain/models";
import { DOCTOR_CHECK_KEYS } from "../electron/domain/models";
import {
  DoctorService,
  type DoctorAgentsPort,
  type DoctorDatabasePort,
  type DoctorGitPort,
  type DoctorRunCommand,
} from "../electron/application/doctorService";
import type {
  DiagnosticsProbePort,
  DiskSample,
} from "../electron/platform/diagnosticsProbes";
import type { ChildAgentAvailability } from "../electron/application/ports";
import { GitAdapterError } from "../electron/application/ports";

const GIB = 1024 * 1024 * 1024;
const HOME = os.homedir();
const REPO = "/tmp/octo-doctor-repo";

// ---- stub 端口 ----

class StubAgents implements DoctorAgentsPort {
  readonly entries = new Map<string, ChildAgentAvailability>();
  readonly hangKinds = new Set<string>();

  constructor() {
    for (const [kind, binary] of [
      ["claude_code", "claude"],
      ["codex", "codex"],
      ["pi", "pi"],
    ] as const) {
      this.entries.set(kind, {
        kind,
        executable: `/usr/local/bin/${binary}`,
        isAvailable: true,
        detail: "1.0.0 (stub)",
      });
    }
  }

  set(kind: string, availability: Partial<ChildAgentAvailability>): void {
    this.entries.set(kind, {
      ...(this.entries.get(kind) as ChildAgentAvailability),
      ...availability,
    });
  }

  async check(kind: "claude_code" | "codex" | "pi"): Promise<ChildAgentAvailability> {
    if (this.hangKinds.has(kind)) return await new Promise<ChildAgentAvailability>(() => {});
    const entry = this.entries.get(kind);
    if (entry == null) throw new Error(`no stub for ${kind}`);
    return entry;
  }
}

class StubGit implements DoctorGitPort {
  state = {
    repositoryURL: REPO,
    head: "abcdef1234567890abcdef1234567890abcdef12",
    hasUncommittedChanges: false,
    branchName: "main",
  };
  error: Error | null = null;
  hang = false;
  readonly calls: string[] = [];

  async inspect(
    url: string,
  ): Promise<{
    repositoryURL: string;
    head: string;
    hasUncommittedChanges: boolean;
    branchName: string | null;
  }> {
    this.calls.push(url);
    if (this.hang) return await new Promise<never>(() => {});
    if (this.error != null) throw this.error;
    return { ...this.state, repositoryURL: url };
  }
}

class StubDb implements DoctorDatabasePort {
  result: { version: number; quickCheck: boolean | null } = { version: 11, quickCheck: true };
  error: Error | null = null;

  health(): { version: number; quickCheck: boolean | null } {
    if (this.error != null) throw this.error;
    return this.result;
  }
}

/** runCommand 按 cmd 可控退出码;hangCommands 永不 resolve(单项超时用)。 */
class StubRunCommand {
  readonly calls: Array<{ cmd: string; args: string[] }> = [];
  readonly results = new Map<string, { stdout: string; stderr: string; exitCode: number | null }>();
  readonly hangCommands = new Set<string>();

  readonly invoke: DoctorRunCommand = (cmd, args) => {
    this.calls.push({ cmd, args });
    if (this.hangCommands.has(cmd)) return new Promise(() => {});
    return Promise.resolve(this.results.get(cmd) ?? { stdout: "", stderr: "", exitCode: 0 });
  };
}

/** doctor 只用 sampleDisk/sampleSystem;其余探针方法不会被触达。 */
class StubProbes implements DiagnosticsProbePort {
  disk: DiskSample | null = { freeBytes: 100 * GIB, totalBytes: 500 * GIB };

  async probeProcess(): Promise<never> {
    throw new Error("doctor 不使用 probeProcess");
  }

  async listOctopunkProcesses(): Promise<never[]> {
    return [];
  }

  async scanOrphanWorktrees(): Promise<never[]> {
    return [];
  }

  async scanOrphanBranches(): Promise<never[]> {
    return [];
  }

  sampleSystem(): {
    loadavg: [number, number, number];
    freeMemBytes: number;
    totalMemBytes: number;
    cpuCores: number;
  } {
    return { loadavg: [1, 2, 3], freeMemBytes: 8 * GIB, totalMemBytes: 16 * GIB, cpuCores: 8 };
  }

  async sampleDisk(): Promise<DiskSample | null> {
    return this.disk;
  }
}

// ---- 世界装配 ----

interface World {
  service: DoctorService;
  agents: StubAgents;
  git: StubGit;
  probes: StubProbes;
  db: StubDb;
  runCommand: StubRunCommand;
  repository: SqliteTeamRunRepository;
}

function doctorWorld(init?: {
  envPath?: string;
  selfExecutable?: () => string;
  worktreeRoot?: () => string | null;
  expectedSchemaVersion?: number | null;
  minFreeBytes?: number;
  itemTimeoutMs?: number;
}): World {
  const agents = new StubAgents();
  const git = new StubGit();
  const probes = new StubProbes();
  const db = new StubDb();
  const runCommand = new StubRunCommand();
  const repository = new SqliteTeamRunRepository(OctoPunkDatabase.inMemory().writer);
  const service = new DoctorService({
    repository,
    agents,
    git,
    probes,
    db,
    selfExecutable: init?.selfExecutable ?? (() => process.execPath),
    env: { PATH: init?.envPath ?? "/usr/local/bin:/usr/bin:/bin" },
    runCommand: runCommand.invoke,
    worktreeRoot: init?.worktreeRoot ?? (() => "/Volumes/Extends/DevCache/OctoPunk/worktrees"),
    ...(init?.expectedSchemaVersion !== undefined
      ? { expectedSchemaVersion: init.expectedSchemaVersion }
      : { expectedSchemaVersion: 11 }),
    ...(init?.minFreeBytes != null ? { minFreeBytes: init.minFreeBytes } : {}),
    ...(init?.itemTimeoutMs != null ? { itemTimeoutMs: init.itemTimeoutMs } : {}),
  });
  return { service, agents, git, probes, db, runCommand, repository };
}

let requestCounter = 0;
const nextRequestID = (label: string): string => `doctor-${label}-${(requestCounter += 1)}`;

function statusOf(report: DoctorReportDTO): Map<DoctorCheckKey, string> {
  return new Map(report.items.map((item) => [item.checkKey, item.status]));
}

function detailOf(report: DoctorReportDTO, checkKey: DoctorCheckKey): string {
  const item = report.items.find((entry) => entry.checkKey === checkKey);
  if (item == null) throw new Error(`no item ${checkKey}`);
  return item.detail;
}

/** 基线世界:九项全部可判定 pass(除恒 unknown 的 provider_quota)。 */
async function baselineCheckup(
  world: World,
  input?: { repositoryPath?: string | null },
): Promise<DoctorReportDTO> {
  return await world.service.runCheckup({
    requestID: nextRequestID("base"),
    triggeredBy: "user",
    ...(input?.repositoryPath !== undefined ? { repositoryPath: input.repositoryPath } : {}),
  });
}

describe("DoctorService 九项判定", () => {
  it("基线世界:八项 pass + provider_quota 恒 unknown;git_repo 无路径按「跳过」记 pass", async () => {
    const world = doctorWorld();
    const report = await baselineCheckup(world);
    expect(report.items.map((item) => item.checkKey).sort()).toEqual([...DOCTOR_CHECK_KEYS].sort());
    const status = statusOf(report);
    for (const key of DOCTOR_CHECK_KEYS) {
      expect(status.get(key), key).toBe(key === "provider_quota" ? "unknown" : "pass");
    }
    expect(detailOf(report, "cli_path")).toContain("均可执行");
    expect(detailOf(report, "git_repo")).toContain("全局体检未指定仓库");
    expect(detailOf(report, "worktree_disk")).toContain("GiB");
    expect(detailOf(report, "mcp_stdio")).toContain("退出码 0");
    // 每项带影响范围与建议(FR-012)。
    for (const item of report.items) {
      expect(item.impact.length, `${item.checkKey} impact`).toBeGreaterThan(0);
      expect(item.suggestion.length, `${item.checkKey} suggestion`).toBeGreaterThan(0);
      expect(item.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("cli_path:一个 CLI 缺失 → fail 汇总(名称 + 可执行名);gui_path 仍可 pass;login 无法判定 → unknown", async () => {
    const world = doctorWorld();
    world.agents.set("codex", { isAvailable: false, detail: "executable not found in PATH" });
    const report = await baselineCheckup(world);
    const status = statusOf(report);
    expect(status.get("cli_path")).toBe("fail");
    expect(detailOf(report, "cli_path")).toContain("Codex");
    expect(detailOf(report, "cli_path")).toContain("codex");
    // 可用的 claude/pi 目录都在 PATH 中 → gui_path 依旧 pass。
    expect(status.get("gui_path")).toBe("pass");
    // CLI 缺失但 detail 无登录失败特征 → 登录态存疑(诚实 unknown)。
    expect(status.get("login")).toBe("unknown");
    expect(detailOf(report, "login")).toContain("无法判定");
  });

  it("gui_path:PATH 不含可用 CLI 目录 → fail,提示终端可用不代表 GUI 可用", async () => {
    const world = doctorWorld({ envPath: "/usr/bin:/bin" });
    const report = await baselineCheckup(world);
    expect(statusOf(report).get("gui_path")).toBe("fail");
    expect(detailOf(report, "gui_path")).toContain("不在 GUI PATH");
    expect(detailOf(report, "gui_path")).toContain("/usr/local/bin");
  });

  it("login:detail 含 not logged → fail", async () => {
    const world = doctorWorld();
    world.agents.set("claude_code", { isAvailable: false, detail: "not logged in, run claude login" });
    const report = await baselineCheckup(world);
    expect(statusOf(report).get("login")).toBe("fail");
    expect(detailOf(report, "login")).toContain("登录态异常");
    expect(detailOf(report, "login")).toContain("Claude Code");
  });

  it("mcp_stdio:自启动可执行存在且 --version 退出码 0 → pass;文件缺失 → fail", async () => {
    const world = doctorWorld();
    const pass = await baselineCheckup(world);
    expect(statusOf(pass).get("mcp_stdio")).toBe("pass");

    const missing = doctorWorld({ selfExecutable: () => "/definitely/missing/octopunk-mcp" });
    const fail = await baselineCheckup(missing);
    expect(statusOf(fail).get("mcp_stdio")).toBe("fail");
    expect(detailOf(fail, "mcp_stdio")).toContain("不可用");
  });

  it("git_repo:脏 → fail;空仓(no commits yet)→ fail;inspect 其他错误 → unknown;无路径 → pass 跳过", async () => {
    const dirty = doctorWorld();
    dirty.git.state = { ...dirty.git.state, hasUncommittedChanges: true };
    const dirtyReport = await baselineCheckup(dirty, { repositoryPath: REPO });
    expect(statusOf(dirtyReport).get("git_repo")).toBe("fail");
    expect(detailOf(dirtyReport, "git_repo")).toContain("未提交改动");
    expect(detailOf(dirtyReport, "git_repo")).toContain("main");

    const empty = doctorWorld();
    // 与真实 GitAdapter.inspect 对空仓的报错同源(no commits yet / 初始提交)。
    empty.git.error = GitAdapterError.emptyRepository(REPO);
    const emptyReport = await baselineCheckup(empty, { repositoryPath: REPO });
    expect(statusOf(emptyReport).get("git_repo")).toBe("fail");
    expect(detailOf(emptyReport, "git_repo")).toContain("初始提交");

    const broken = doctorWorld();
    broken.git.error = new Error("not a git repository");
    const brokenReport = await baselineCheckup(broken, { repositoryPath: REPO });
    expect(statusOf(brokenReport).get("git_repo")).toBe("unknown");
    expect(detailOf(brokenReport, "git_repo")).toContain("无法检查仓库状态");

    // 无路径(全局体检)在基线世界已断言 pass 跳过,这里显式复核。
    const global = doctorWorld();
    expect(statusOf(await baselineCheckup(global, { repositoryPath: null })).get("git_repo")).toBe("pass");
    expect(global.git.calls).toHaveLength(0);
  });

  it("worktree_disk:余量低于阈值 → fail(含 GiB 数值);采样 null → unknown;未提供根目录 → unknown", async () => {
    const low = doctorWorld();
    low.probes.disk = { freeBytes: 512 * 1024 * 1024, totalBytes: 100 * GIB };
    const lowReport = await baselineCheckup(low);
    expect(statusOf(lowReport).get("worktree_disk")).toBe("fail");
    expect(detailOf(lowReport, "worktree_disk")).toContain("0.5GiB");
    expect(detailOf(lowReport, "worktree_disk")).toContain("1.0GiB");

    const nullSample = doctorWorld();
    nullSample.probes.disk = null;
    const nullReport = await baselineCheckup(nullSample);
    expect(statusOf(nullReport).get("worktree_disk")).toBe("unknown");
    expect(detailOf(nullReport, "worktree_disk")).toContain("磁盘采样失败");

    // 未提供 worktreeRoot → unknown(未提供托管根目录,诚实优于臆造)。
    const repository = new SqliteTeamRunRepository(OctoPunkDatabase.inMemory().writer);
    const service = new DoctorService({
      repository,
      agents: new StubAgents(),
      git: new StubGit(),
      probes: new StubProbes(),
      db: new StubDb(),
      selfExecutable: () => process.execPath,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      runCommand: new StubRunCommand().invoke,
    });
    const report = await service.runCheckup({
      requestID: nextRequestID("noroot"),
      triggeredBy: "user",
    });
    expect(statusOf(report).get("worktree_disk")).toBe("unknown");
    expect(detailOf(report, "worktree_disk")).toContain("未提供 worktree 托管根目录");
  });

  it("sandbox:退出码 0 → pass;exitCode null → fail(macOS 必备)", async () => {
    const world = doctorWorld();
    const pass = await baselineCheckup(world);
    expect(statusOf(pass).get("sandbox")).toBe("pass");

    const gone = doctorWorld();
    gone.runCommand.results.set("sandbox-exec", { stdout: "", stderr: "", exitCode: null });
    const report = await baselineCheckup(gone);
    expect(statusOf(report).get("sandbox")).toBe("fail");
    expect(detailOf(report, "sandbox")).toContain("找不到 sandbox-exec");

    // 可启动但非零退出同样是 fail(可读 stderr 首行)。
    const weird = doctorWorld();
    weird.runCommand.results.set("sandbox-exec", {
      stdout: "",
      stderr: "profile syntax error",
      exitCode: 3,
    });
    const weirdReport = await baselineCheckup(weird);
    expect(statusOf(weirdReport).get("sandbox")).toBe("fail");
    expect(detailOf(weirdReport, "sandbox")).toContain("退出码 3");
    expect(detailOf(weirdReport, "sandbox")).toContain("profile syntax error");
  });

  it("db_health:quick_check false → fail;schema 版本落后 → fail;超前 → unknown;健康 → pass", async () => {
    const corrupted = doctorWorld();
    corrupted.db.result = { version: 11, quickCheck: false };
    const corruptedReport = await baselineCheckup(corrupted);
    expect(statusOf(corruptedReport).get("db_health")).toBe("fail");
    expect(detailOf(corruptedReport, "db_health")).toContain("quick_check");

    const stale = doctorWorld();
    stale.db.result = { version: 5, quickCheck: true };
    const staleReport = await baselineCheckup(stale);
    expect(statusOf(staleReport).get("db_health")).toBe("fail");
    expect(detailOf(staleReport, "db_health")).toContain("版本落后");

    const ahead = doctorWorld();
    ahead.db.result = { version: 99, quickCheck: true };
    const aheadReport = await baselineCheckup(ahead);
    expect(statusOf(aheadReport).get("db_health")).toBe("unknown");
    expect(detailOf(aheadReport, "db_health")).toContain("高于当前应用");

    // 健康路径在基线世界断言 pass(detail 带版本与 quick_check 结果)。
    const healthy = doctorWorld();
    const healthyReport = await baselineCheckup(healthy);
    expect(statusOf(healthyReport).get("db_health")).toBe("pass");
    expect(detailOf(healthyReport, "db_health")).toContain("11");
  });
});

// ---- 单项超时 ----

describe("DoctorService 单项超时", () => {
  it("挂起的检查器 → 该项 unknown「检查超时」,其余项照常完成", async () => {
    const world = doctorWorld({ itemTimeoutMs: 150 });
    world.runCommand.hangCommands.add("sandbox-exec");
    const report = await baselineCheckup(world);
    const status = statusOf(report);
    expect(status.get("sandbox")).toBe("unknown");
    expect(detailOf(report, "sandbox")).toContain("检查超时");
    // 其余可判定项照常完成,不拖垮整体。
    expect(status.get("cli_path")).toBe("pass");
    expect(status.get("mcp_stdio")).toBe("pass");
    expect(status.get("db_health")).toBe("pass");
    expect(report.items).toHaveLength(9);
  });
});

// ---- overall 派生与 latestReport ----

describe("DoctorService overall 与 latestReport", () => {
  it("fail 混 pass → fail;无 fail 仅 unknown → degraded(均经落库后 latestReport 断言)", async () => {
    const world = doctorWorld();
    world.runCommand.results.set("sandbox-exec", { stdout: "", stderr: "boom", exitCode: 1 });
    const failed = await baselineCheckup(world);
    expect(failed.overall).toBe("fail");
    const latestFail = await world.service.latestReport(null);
    expect(latestFail?.id).toBe(failed.id);
    expect(latestFail?.overall).toBe("fail");

    // 修复 sandbox 后新一轮:其余 pass + provider_quota unknown → degraded。
    world.runCommand.results.delete("sandbox-exec");
    const degraded = await baselineCheckup(world);
    expect(degraded.overall).toBe("degraded");
    const latestDegraded = await world.service.latestReport(null);
    expect(latestDegraded?.id).toBe(degraded.id);
    expect(latestDegraded?.overall).toBe("degraded");
  });

  it("全 pass → pass(provider_quota 恒 unknown,故该分支经同一仓储 recordDoctorReport 直写验证)", async () => {
    const world = doctorWorld();
    // 服务自身永远产生 provider_quota=unknown(诚实降级),九项全 pass 的
    // overall=pass 分支经仓储写入路径验证(与 runCheckup 落库同一入口)。
    const recorded = await world.repository.recordDoctorReport({
      requestID: nextRequestID("allpass"),
      triggeredBy: "user",
      repositoryPath: null,
      items: DOCTOR_CHECK_KEYS.map((checkKey) => ({
        checkKey,
        status: "pass" as const,
        detail: "ok",
        impact: "impact",
        suggestion: "suggestion",
        durationMs: 1,
      })),
    });
    expect(recorded.overall).toBe("pass");
    const latest = await world.service.latestReport(null);
    expect(latest?.id).toBe(recorded.id);
    expect(latest?.overall).toBe("pass");
  });
});

// ---- rerunItem ----

describe("DoctorService.rerunItem", () => {
  it("单项翻转后 overall 由仓储重算;latestReport 反映更新", async () => {
    const world = doctorWorld();
    world.runCommand.results.set("sandbox-exec", { stdout: "", stderr: "boom", exitCode: 1 });
    const initial = await baselineCheckup(world);
    expect(initial.overall).toBe("fail");

    world.runCommand.results.delete("sandbox-exec");
    const updated = await world.service.rerunItem({
      requestID: nextRequestID("rerun"),
      reportID: initial.id,
      checkKey: "sandbox",
    });
    expect(statusOf(updated).get("sandbox")).toBe("pass");
    // 唯一 fail 消除,剩 provider_quota unknown → degraded。
    expect(updated.overall).toBe("degraded");
    const latest = await world.service.latestReport(null);
    expect(latest?.id).toBe(initial.id);
    expect(latest?.overall).toBe("degraded");
  });

  it("未知 reportID / 未知 checkKey → 报错", async () => {
    const world = doctorWorld();
    const report = await baselineCheckup(world);
    await expect(
      world.service.rerunItem({
        requestID: nextRequestID("rerun-miss"),
        reportID: "00000000-0000-0000-0000-000000000000",
        checkKey: "sandbox",
      }),
    ).rejects.toMatchObject({ kind: "invalidTask" });

    await expect(
      world.service.rerunItem({
        requestID: nextRequestID("rerun-badkey"),
        reportID: report.id,
        checkKey: "not_a_real_check" as DoctorCheckKey,
      }),
    ).rejects.toThrow();
  });
});

// ---- 诊断包脱敏 ----

describe("DoctorService.exportDiagnosticBundle", () => {
  it("home → ~、bearer/sk- 与 token= 密钥 redact;machine 段无用户名与家路径", async () => {
    const world = doctorWorld();
    const secretDetail = `配置位于 ${HOME}/.codex/auth.json,token=sk-abcdef1234567890,bearer AbCdEf123456789`;
    const dto: DoctorReportDTO = {
      id: "11111111-1111-1111-1111-111111111111",
      triggeredBy: "user",
      repositoryPath: `${HOME}/dev/octo`,
      overall: "degraded",
      createdAt: 1755500000,
      items: [
        {
          checkKey: "login",
          status: "fail",
          detail: secretDetail,
          impact: "impact",
          suggestion: "suggestion",
          durationMs: 3,
        },
      ],
    };
    const bundle = JSON.parse(await world.service.exportDiagnosticBundle(dto)) as {
      kind: string;
      schema: number;
      machine: Record<string, unknown>;
      report: { repositoryPath: string; items: Array<{ detail: string }> };
    };
    expect(bundle.kind).toBe("octopunk-doctor-bundle");
    expect(bundle.schema).toBe(1);
    expect(bundle.report.repositoryPath).toBe("~/dev/octo");

    const detail = bundle.report.items[0]?.detail ?? "";
    expect(detail).toContain("~/.codex/auth.json");
    expect(detail).toContain("[REDACTED]");
    expect(detail).not.toContain(HOME);
    expect(detail).not.toContain("sk-abcdef1234567890");
    expect(detail).not.toContain("AbCdEf123456789");

    // machine 概要:只有 OS/负载/内存/CPU,无用户名、无家路径。
    expect(Object.keys(bundle.machine).sort()).toEqual([
      "cpuCores",
      "loadavg",
      "memoryFreeBytes",
      "memoryTotalBytes",
      "os",
    ]);
    const machineText = JSON.stringify(bundle.machine);
    expect(machineText).not.toContain(os.userInfo().username);
    expect(machineText).not.toContain(HOME);
  });

  it("reportID 入参:解析到最新报告并同样脱敏", async () => {
    const world = doctorWorld();
    world.agents.set("pi", {
      isAvailable: false,
      detail: `not logged in at ${HOME}/.pi token=sk-zzzzzzzzzzzz123456`,
    });
    const report = await baselineCheckup(world);
    const bundle = JSON.parse(await world.service.exportDiagnosticBundle(report.id)) as {
      report: { id: string; overall: string; items: Array<{ detail: string }> };
    };
    expect(bundle.report.id).toBe(report.id);
    expect(bundle.report.overall).toBe(report.overall);
    const login = bundle.report.items.find((item) => item.checkKey === "login");
    expect(login?.detail).toContain("[REDACTED]");
    expect(login?.detail).not.toContain("sk-zzzzzzzzzzzz123456");
    expect(login?.detail).not.toContain(HOME);
  });
});

// ---- prestartBlockers ----

describe("DoctorService.prestartBlockers", () => {
  it("仓库 inspect 抛错 → 非空阻塞列表(可读原因)", async () => {
    const world = doctorWorld();
    world.git.error = new Error("not a git repository");
    const blockers = await world.service.prestartBlockers(REPO);
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers[0]).toContain("仓库不可用");
  });

  it("全部 CLI 不可用 → 非空阻塞列表;仓库正常时仅此一条", async () => {
    const world = doctorWorld();
    for (const kind of ["claude_code", "codex", "pi"]) {
      world.agents.set(kind, { isAvailable: false, detail: "executable not found" });
    }
    const blockers = await world.service.prestartBlockers(REPO);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("全部 Agent CLI 不可用");
  });

  it("仓库与 CLI 均正常 → 空列表;探测超时按「无法确认」跳过不臆造", async () => {
    const world = doctorWorld();
    expect(await world.service.prestartBlockers(REPO)).toEqual([]);

    const hanging = doctorWorld({ itemTimeoutMs: 120 });
    hanging.git.hang = true;
    expect(await hanging.service.prestartBlockers(REPO)).toEqual([]);
  });
});
