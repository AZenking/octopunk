// T021: RecoveryService 组合测试(specs/001-v03-stability-multi-teamrun US2 / R4)。
// 组合方式照 tests/concurrency.test.ts 与 tests/reviewCenter.test.ts:真实
// SqliteTeamRunRepository(内存 DB)+ 临时 git 仓库(仓库路径真实、分支前缀
// 语义真实),进程/孤儿探针、调度入口与清理端口全部 stub(probeProcess 按
// pid 可控 alive/owned/detail;scanOrphanWorktrees 做真实差集;
// scanOrphanBranches 按 repositoryURL 可控;drainReadyTasks / removePath /
// deleteBranch 记录调用)。应用层服务自身 fs-free,故 stub 探针不触发真实
// 进程/目录扫描,托管根路径仅作为字符串透传断言。

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OctoPunkDatabase } from "../electron/data/database";
import { SqliteTeamRunRepository } from "../electron/data/repository";
import { DomainError } from "../electron/domain/models";
import type { ChildTask } from "../electron/domain/models";
import {
  RecoveryService,
  type RecoveryCleanupPort,
  type RecoveryCleanupTarget,
  type RecoveryRepositoryPort,
  type RecoveryTeamServicePort,
} from "../electron/application/recoveryService";
import type {
  DiagnosticsProbePort,
  OrphanBranchItem,
  OrphanWorktreeItem,
  ProcessProbeResult,
  ScanOrphanBranchesOptions,
  ScanOrphanWorktreesOptions,
} from "../electron/platform/diagnosticsProbes";
import type { ProcessPort } from "../electron/application/ports";
import {
  integrationWorktreeURL,
  sharedReadOnlyWorktreeURL,
} from "../electron/platform/gitAdapter";

const GIT = "/usr/bin/git";

function git(cwd: string, args: string[]): string {
  return execFileSync(
    GIT,
    ["-c", "user.email=octo@test.dev", "-c", "user.name=OctoPunk Test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

// ---- stub 探针端口 ----

/** probeProcess 按 pid 可控;worktree 差集真实计算;branch 按仓库可控。 */
class StubProbes implements DiagnosticsProbePort {
  readonly processResults = new Map<number, ProcessProbeResult>();
  /** 这些 pid 的探测直接 reject(probe == null → 状态未知路径)。 */
  readonly processFailures = new Set<number>();
  readonly worktreeCalls: ScanOrphanWorktreesOptions[] = [];
  worktreeCandidates: OrphanWorktreeItem[] = [];
  readonly branchCalls: ScanOrphanBranchesOptions[] = [];
  readonly branchResults = new Map<string, OrphanBranchItem[]>();

  async probeProcess(pid: number): Promise<ProcessProbeResult> {
    if (this.processFailures.has(pid)) throw new Error("ps 无法启动(stub)");
    return (
      this.processResults.get(pid) ?? {
        alive: false,
        octopunkOwned: false,
        command: null,
        detail: null,
      }
    );
  }

  async listOctopunkProcesses(): Promise<{ pid: number; command: string }[]> {
    return [];
  }

  async scanOrphanWorktrees(options: ScanOrphanWorktreesOptions): Promise<OrphanWorktreeItem[]> {
    this.worktreeCalls.push(options);
    // 与真实探针同语义:候选目录减去登记路径(差集由调用方查库后传入)。
    const registered = new Set(options.registeredPaths);
    return this.worktreeCandidates.filter((candidate) => !registered.has(candidate.path));
  }

  async scanOrphanBranches(options: ScanOrphanBranchesOptions): Promise<OrphanBranchItem[]> {
    this.branchCalls.push(options);
    return this.branchResults.get(options.repositoryURL) ?? [];
  }

  sampleSystem(): {
    loadavg: [number, number, number];
    freeMemBytes: number;
    totalMemBytes: number;
    cpuCores: number;
  } {
    return { loadavg: [0, 0, 0], freeMemBytes: 1, totalMemBytes: 2, cpuCores: 4 };
  }

  async sampleDisk(): Promise<{ freeBytes: number; totalBytes: number } | null> {
    return null;
  }
}

/** drainReadyTasks 只记录调用;throwRuns 可模拟调度入口失败(不拖垮 rerun)。 */
class StubTeamService implements RecoveryTeamServicePort {
  readonly drainCalls: string[] = [];
  failNext = false;

  async drainReadyTasks(runID: string): Promise<void> {
    this.drainCalls.push(runID);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("drain failed (stub)");
    }
  }
}

/** 清理端口记录调用;removeFailures/deleteFailures 可控失败。 */
class StubCleanup implements RecoveryCleanupPort {
  readonly removeCalls: string[] = [];
  readonly deleteCalls: Array<{ repositoryURL: string; branch: string }> = [];
  readonly removeFailures = new Set<string>();
  readonly deleteFailures = new Set<string>();

  async removePath(target: string): Promise<void> {
    this.removeCalls.push(target);
    if (this.removeFailures.has(target)) throw new Error("设备忙,无法删除(stub)");
  }

  async deleteBranch(repositoryURL: string, branch: string): Promise<void> {
    this.deleteCalls.push({ repositoryURL, branch });
    if (this.deleteFailures.has(branch)) throw new Error("分支删除被拒绝(stub)");
  }
}

// ---- 世界装配 ----

interface World {
  root: string;
  repos: string[];
  repository: RecoveryRepositoryPort;
  service: RecoveryService;
  probes: StubProbes;
  teamService: StubTeamService;
  cleanup: StubCleanup;
  processPort: ProcessPort;
}

const roots: string[] = [];

function buildRepo(root: string, name: string): string {
  const repositoryURL = path.join(root, name);
  fs.mkdirSync(repositoryURL);
  git(repositoryURL, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repositoryURL, "feature.ts"), `baseline ${name}\n`);
  git(repositoryURL, ["add", "-A"]);
  git(repositoryURL, ["commit", "-qm", "baseline"]);
  return repositoryURL;
}

let worldCounter = 0;

async function buildWorld(repoCount = 1): Promise<World> {
  const prefix = `recovery-${(worldCounter += 1)}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `octopunk-${prefix}-`));
  roots.push(root);
  const repos: string[] = [];
  for (let index = 0; index < repoCount; index += 1) repos.push(buildRepo(root, `repo-${index}`));

  const probes = new StubProbes();
  const teamService = new StubTeamService();
  const cleanup = new StubCleanup();
  // 应用层服务只把该端口透传给探针;这里给一个永不触发的最小实现。
  const processPort = {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    runStreaming: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    pidOf: () => null,
    terminate: async () => {},
    terminateAll: async () => {},
  } as unknown as ProcessPort;
  const repository: RecoveryRepositoryPort = new SqliteTeamRunRepository(
    OctoPunkDatabase.inMemory().writer,
  );
  const service = new RecoveryService({
    repository,
    probes,
    processPort,
    teamService,
    cleanup,
  });
  return { root, repos, repository, service, probes, teamService, cleanup, processPort };
}

/** startTeam(每个 run 独立 session,规避单 session 单活 run 规则)。 */
async function startRun(world: World, repoIndex: number, tag: string): Promise<string> {
  const repositoryURL = world.repos[repoIndex];
  const start = await world.repository.startTeam({
    requestID: `${tag}-start`,
    sessionID: `${tag}-session`,
    repositoryPath: repositoryURL,
    task: `Recovery world ${tag}`,
    baselineCommit: git(repositoryURL, ["rev-parse", "HEAD"]).trim(),
    targetBranch: "main",
    maxConcurrentTasks: 5,
    maxReviewRounds: 3,
  });
  return start.run.id;
}

async function delegate(
  world: World,
  runID: string,
  input: { tag: string; title: string; dependencies?: string[] },
): Promise<ChildTask> {
  return await world.repository.delegateTask({
    requestID: `${input.tag}-delegate`,
    runID,
    title: input.title,
    prompt: input.title,
    agentKind: "claude_code",
    model: null,
    executionMode: "read_only",
    dependencies: input.dependencies ?? [],
  });
}

/** 任务 → running(带 attempt),可选写入 pid。sessionID 传 null 保持任务无会话。 */
async function runTask(
  world: World,
  runID: string,
  task: ChildTask,
  input: { pid?: number; sessionID?: string | null },
): Promise<ChildTask> {
  const running = await world.repository.markTaskRunning({
    requestID: `${task.id.slice(0, 8)}-mark`,
    runID,
    taskID: task.id,
    sessionID: input.sessionID ?? null,
  });
  if (input.pid != null && running.currentAttemptID != null) {
    await world.repository.updateAttemptPid({
      runID,
      taskID: task.id,
      attemptID: running.currentAttemptID,
      pid: input.pid,
    });
  }
  return running;
}

async function taskStatus(world: World, runID: string, taskID: string): Promise<ChildTask> {
  const task = (await world.repository.runSummary(runID)).tasks.find(
    (candidate) => candidate.id === taskID,
  );
  if (task == null) throw new Error(`task ${taskID} not found`);
  return task;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// ---- 1. scan 进程核对分类(R4 诚实降级语义) ----

describe("RecoveryService.scan 进程核对分类", () => {
  let world: World;
  let runID: string;
  let ids: Record<string, ChildTask>;

  beforeEach(async () => {
    world = await buildWorld();
    runID = await startRun(world, 0, "classify");
    ids = {
      alive: await delegate(world, runID, { tag: "alive", title: "alive" }),
      reused: await delegate(world, runID, { tag: "reused", title: "reused" }),
      dead: await delegate(world, runID, { tag: "dead", title: "dead" }),
      nopid: await delegate(world, runID, { tag: "nopid", title: "nopid" }),
      unknown: await delegate(world, runID, { tag: "unknown", title: "unknown" }),
    };
    await runTask(world, runID, ids.alive, { pid: 424242 });
    await runTask(world, runID, ids.reused, { pid: 424243 });
    await runTask(world, runID, ids.dead, { pid: 424244 });
    await runTask(world, runID, ids.nopid, {});
    await runTask(world, runID, ids.unknown, { pid: 424245 });
    world.probes.processResults.set(424242, {
      alive: true,
      octopunkOwned: true,
      command: "node octopunk-worker --task t1",
      detail: null,
    });
    world.probes.processResults.set(424243, {
      alive: true,
      octopunkOwned: false,
      command: "somebody-else --not-octopunk",
      detail: null,
    });
    world.probes.processResults.set(424245, {
      alive: false,
      octopunkOwned: false,
      command: null,
      detail: "无法运行 ps,权限被拒绝",
    });
  });

  it("pid+alive+owned → process_alive;alive 不 owned / 死 / 无 pid / 探针失败 → interrupted,失败文案含「未知」", async () => {
    const status = await world.service.scan();
    expect(status.scannedAt).toBeGreaterThan(0);
    const byTask = new Map(status.items.filter((item) => item.taskID != null).map((item) => [item.taskID, item]));

    const alive = byTask.get(ids.alive.id);
    expect(alive?.kind).toBe("process_alive");
    expect(alive?.runID).toBe(runID);
    expect(alive?.detail).toContain("仍在运行");

    const reused = byTask.get(ids.reused.id);
    expect(reused?.kind).toBe("interrupted");
    expect(reused?.detail).toContain("复用");

    const dead = byTask.get(ids.dead.id);
    expect(dead?.kind).toBe("interrupted");
    expect(dead?.detail).toContain("已不存在");

    const nopid = byTask.get(ids.nopid.id);
    expect(nopid?.kind).toBe("interrupted");
    expect(nopid?.detail).toContain("无 PID 记录");

    const unknown = byTask.get(ids.unknown.id);
    expect(unknown?.kind).toBe("interrupted");
    expect(unknown?.detail).toContain("状态未知");
    expect(unknown?.detail).toContain("无法运行 ps");
  });

  it("probeProcess 整体 reject 同样落到「状态未知」,不臆造已死", async () => {
    world.probes.processFailures.add(424242);
    const status = await world.service.scan();
    const item = status.items.find((entry) => entry.taskID === ids.alive.id);
    expect(item?.kind).toBe("interrupted");
    expect(item?.detail).toContain("状态未知");
  });

  it("interruptedTasks 只保留 interrupted 子集", async () => {
    const interrupted = await world.service.interruptedTasks(runID);
    expect(interrupted.map((item) => item.taskID).sort()).toEqual(
      [ids.dead.id, ids.nopid.id, ids.reused.id, ids.unknown.id].sort(),
    );
    expect(interrupted.every((item) => item.kind === "interrupted")).toBe(true);
  });
});

// ---- 2. 孤儿 worktree / 分支扫描 ----

describe("RecoveryService.scan 孤儿扫描", () => {
  it("worktree 差集:登记路径(任务 + 集成 + 共享只读)被剔除,未登记目录进 items", async () => {
    const world = await buildWorld();
    const runID = await startRun(world, 0, "orphanwt");
    const task = await delegate(world, runID, { tag: "ow", title: "registered task" });
    const summary = await world.repository.runSummary(runID);
    const registeredTaskPath = task.worktreePath;
    const orphanPath = path.join(world.root, "stray-worktree");

    world.probes.worktreeCandidates = [
      { path: registeredTaskPath, kind: "orphan_worktree", detail: "登记过的任务目录", suggestion: "s" },
      { path: orphanPath, kind: "orphan_worktree", detail: "大小约 12 KB;含 .git 工作树标记", suggestion: "清理" },
    ];

    const status = await world.service.scan();
    const orphans = status.items.filter((item) => item.kind === "orphan_worktree");
    expect(orphans.map((item) => item.detail)).toHaveLength(1);
    expect(orphans[0]?.detail).toContain(orphanPath);
    expect(orphans[0]?.detail).not.toContain(registeredTaskPath);

    // 登记全集透传给探针:任务 worktree + 每 run 的集成/共享只读目录。
    const registered = new Set(world.probes.worktreeCalls[0]?.registeredPaths ?? []);
    expect(registered.has(registeredTaskPath)).toBe(true);
    expect(registered.has(integrationWorktreeURL(runID))).toBe(true);
    expect(registered.has(sharedReadOnlyWorktreeURL(runID, summary.run.baselineCommit))).toBe(true);
  });

  it("分支扫描按仓库去重调用;keep 前缀覆盖同仓库全部 run;runID 收窄只扫该 run 的仓库", async () => {
    const world = await buildWorld(2);
    const [repoA, repoB] = world.repos;
    const runA1 = await startRun(world, 0, "br1");
    const runA2 = await startRun(world, 0, "br2");
    const runB = await startRun(world, 1, "br3");

    world.probes.branchResults.set(repoA, [
      {
        branch: "octopunk/deadbeef/orphan-task",
        kind: "orphan_branch",
        detail: "octopunk/* 分支不属于任何现存 run",
        suggestion: "确认后删除",
      },
    ]);

    const status = await world.service.scan();
    // 三 run 两仓库 → 每仓库恰一次调用(processPort 原样透传)。
    const repos = world.probes.branchCalls.map((call) => call.repositoryURL).sort();
    expect(repos).toEqual([repoA, repoB].sort());
    expect(world.probes.branchCalls[0]?.processPort).toBe(world.processPort);
    const repoACall = world.probes.branchCalls.find((call) => call.repositoryURL === repoA);
    expect(repoACall?.keepPrefixes).toEqual(
      expect.arrayContaining([
        `octopunk/${runA1}/`,
        `octopunk/${runA2}/`,
        `octopunk/${runA1.replaceAll("-", "").slice(0, 8)}/`,
        `octopunk/${runA2.replaceAll("-", "").slice(0, 8)}/`,
      ]),
    );

    const branchItems = status.items.filter((item) => item.kind === "orphan_branch");
    expect(branchItems).toHaveLength(1);
    expect(branchItems[0]?.detail).toContain(repoA);
    expect(branchItems[0]?.detail).toContain("octopunk/deadbeef/orphan-task");

    // runID 收窄:只扫 runB 的仓库(前缀仍按同仓库全部 run 汇总,这里 repoB 只有 runB)。
    world.probes.branchCalls.length = 0;
    const narrowed = await world.service.scan({ runID: runB });
    expect(world.probes.branchCalls.map((call) => call.repositoryURL)).toEqual([repoB]);
    expect(narrowed.items.filter((item) => item.kind === "orphan_branch")).toHaveLength(0);
  });
});

// ---- 3. markInterruptedFailed ----

describe("RecoveryService.markInterruptedFailed", () => {
  it("running 任务 → failed(summary 含系统错误与 failure_kind=system);已 failed 重入幂等返回", async () => {
    const world = await buildWorld();
    const runID = await startRun(world, 0, "mark");
    const task = await delegate(world, runID, { tag: "mk", title: "running one" });
    await runTask(world, runID, task, { pid: 424242 });

    const failed = await world.service.markInterruptedFailed({
      requestID: "mark-fail-1",
      runID,
      taskID: task.id,
      reason: "进程已死",
    });
    expect(failed.status).toBe("failed");
    expect(failed.latestError).toContain("系统错误");
    expect(failed.latestError).toContain("failure_kind=system");
    expect(failed.latestError).toContain("进程已死");
    // failTask 默认 blockRun:保守起见 run 进入 blocked,等待人工重跑。
    expect((await world.repository.runSummary(runID)).run.status).toBe("blocked");

    // 幂等:已 failed 的任务允许重入(新 requestID),返回 failed 任务不抛错。
    const replay = await world.service.markInterruptedFailed({
      requestID: "mark-fail-2",
      runID,
      taskID: task.id,
      reason: "进程已死",
    });
    expect(replay.status).toBe("failed");
    expect(await taskStatus(world, runID, task.id)).toMatchObject({ status: "failed" });
  });

  it("非 running/failed 状态(queued)与未知任务 → 领域错误", async () => {
    const world = await buildWorld();
    const runID = await startRun(world, 0, "mark2");
    const queued = await delegate(world, runID, { tag: "q", title: "queued one" });
    await expect(
      world.service.markInterruptedFailed({
        requestID: "mark-q",
        runID,
        taskID: queued.id,
        reason: "x",
      }),
    ).rejects.toMatchObject({ kind: "taskNotReady" });
    await expect(
      world.service.markInterruptedFailed({
        requestID: "mark-miss",
        runID,
        taskID: "00000000-0000-0000-0000-000000000000",
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

// ---- 4. rerunTask ----

describe("RecoveryService.rerunTask", () => {
  it("includeDownstream=true:failed 目标 → queued;被 block 的下游逐个 resume(有会话 → rework_required);queued 下代不动;drainReadyTasks 被调", async () => {
    const world = await buildWorld();
    const runID = await startRun(world, 0, "rerun");

    // A:failed(无会话 → resume 后 queued)。B 依赖 A:曾运行(带会话)→ blocked。
    // C 依赖 B:从未运行 → blocked。D 依赖 A:queued(依赖失败传播未波及,或已排队)。
    const taskA = await delegate(world, runID, { tag: "A", title: "target" });
    const taskB = await delegate(world, runID, { tag: "B", title: "mid", dependencies: [taskA.id] });
    const taskC = await delegate(world, runID, { tag: "C", title: "leaf", dependencies: [taskB.id] });
    const taskD = await delegate(world, runID, { tag: "D", title: "queued desc", dependencies: [taskA.id] });

    await runTask(world, runID, taskA, { pid: 424242 });
    await world.repository.failTask({ requestID: "A-fail", runID, taskID: taskA.id, summary: "boom" });
    await runTask(world, runID, taskB, { sessionID: "session-b" });
    for (const [task, tag] of [
      [taskB, "B"],
      [taskC, "C"],
    ] as const) {
      await world.repository.blockTask({
        requestID: `${tag}-block`,
        runID,
        taskID: task.id,
        reviewer: "user",
        verdict: "BLOCKED",
        summary: `${tag} blocked by upstream failure`,
        findings: [],
      });
    }
    expect(await taskStatus(world, runID, taskD.id)).toMatchObject({ status: "queued" });

    const affected = await world.service.rerunTask({
      requestID: "rerun-1",
      runID,
      taskID: taskA.id,
      includeDownstream: true,
    });
    const affectedIDs = affected.map((task) => task.id);
    expect(affectedIDs).toEqual([taskA.id, taskB.id, taskC.id]);

    const statusOf = async (task: ChildTask) => (await taskStatus(world, runID, task.id)).status;
    expect(await statusOf(taskA)).toBe("queued");
    expect(await statusOf(taskB)).toBe("rework_required");
    expect(await statusOf(taskC)).toBe("queued");
    // queued 下代不在受影响列表,状态保持 queued。
    expect(affectedIDs).not.toContain(taskD.id);
    expect(await statusOf(taskD)).toBe("queued");
    // resumeTask 把 run 拉回 running,调度入口被调一次。
    expect((await world.repository.runSummary(runID)).run.status).toBe("running");
    expect(world.teamService.drainCalls).toEqual([runID]);
  });

  it("includeDownstream=false:仅目标 resume,下游 blocked 不动", async () => {
    const world = await buildWorld();
    const runID = await startRun(world, 0, "rerun2");
    const taskA = await delegate(world, runID, { tag: "A2", title: "target" });
    const taskB = await delegate(world, runID, { tag: "B2", title: "down", dependencies: [taskA.id] });
    await world.repository.failTask({ requestID: "A2-fail", runID, taskID: taskA.id, summary: "boom" });
    await world.repository.blockTask({
      requestID: "B2-block",
      runID,
      taskID: taskB.id,
      reviewer: "user",
      verdict: "BLOCKED",
      summary: "blocked",
      findings: [],
    });

    const affected = await world.service.rerunTask({
      requestID: "rerun-2",
      runID,
      taskID: taskA.id,
      includeDownstream: false,
    });
    expect(affected.map((task) => task.id)).toEqual([taskA.id]);
    expect(await taskStatus(world, runID, taskA.id)).toMatchObject({ status: "queued" });
    expect(await taskStatus(world, runID, taskB.id)).toMatchObject({ status: "blocked" });
    expect(world.teamService.drainCalls).toEqual([runID]);
  });

  it("非 failed/blocked/cancelled 目标 → taskNotReady;drain 失败不拖垮重跑", async () => {
    const world = await buildWorld();
    const runID = await startRun(world, 0, "rerun3");
    const queued = await delegate(world, runID, { tag: "Q3", title: "queued" });
    await expect(
      world.service.rerunTask({
        requestID: "rerun-3",
        runID,
        taskID: queued.id,
        includeDownstream: true,
      }),
    ).rejects.toMatchObject({ kind: "taskNotReady" });

    const taskA = await delegate(world, runID, { tag: "A3", title: "failed" });
    await world.repository.failTask({ requestID: "A3-fail", runID, taskID: taskA.id, summary: "boom" });
    world.teamService.failNext = true;
    const affected = await world.service.rerunTask({
      requestID: "rerun-4",
      runID,
      taskID: taskA.id,
      includeDownstream: false,
    });
    expect(affected.map((task) => task.id)).toEqual([taskA.id]);
  });
});

// ---- 5. cleanupOrphans ----

describe("RecoveryService.cleanupOrphans", () => {
  it("confirmed=false 必须抛错,且不触发任何清理端口调用", async () => {
    const world = await buildWorld();
    await expect(
      world.service.cleanupOrphans({
        requestID: "clean-no",
        targets: [{ kind: "orphan_worktree", path: "/tmp/wt-1" }],
        confirmed: false,
      }),
    ).rejects.toThrow(/确认/);
    expect(world.cleanup.removeCalls).toHaveLength(0);
    expect(world.cleanup.deleteCalls).toHaveLength(0);
  });

  it("confirmed=true:逐项走 removePath/deleteBranch;端口失败或缺字段进 skipped,不拖垮其他项", async () => {
    const world = await buildWorld();
    world.cleanup.removeFailures.add("/tmp/wt-2");
    world.cleanup.deleteFailures.add("octopunk/x/doomed");
    const targets: RecoveryCleanupTarget[] = [
      { kind: "orphan_worktree", path: "/tmp/wt-1" },
      { kind: "orphan_worktree", path: "/tmp/wt-2" },
      { kind: "stale_lock", path: "/tmp/lock-1" },
      { kind: "orphan_branch", repositoryURL: "/tmp/repoA", branchName: "octopunk/x/ok" },
      { kind: "orphan_branch", repositoryURL: "/tmp/repoA", branchName: "octopunk/x/doomed" },
      { kind: "orphan_branch", repositoryURL: "/tmp/repoA" },
      { kind: "interrupted", runID: "r", taskID: "t" },
    ];

    const result = await world.service.cleanupOrphans({
      requestID: "clean-yes",
      targets,
      confirmed: true,
    });

    expect(result.cleaned).toEqual([
      "orphan_worktree /tmp/wt-1",
      "stale_lock /tmp/lock-1",
      "orphan_branch /tmp/repoA#octopunk/x/ok",
    ]);
    expect(world.cleanup.removeCalls).toEqual(["/tmp/wt-1", "/tmp/wt-2", "/tmp/lock-1"]);
    expect(world.cleanup.deleteCalls).toEqual([
      { repositoryURL: "/tmp/repoA", branch: "octopunk/x/ok" },
      { repositoryURL: "/tmp/repoA", branch: "octopunk/x/doomed" },
    ]);

    // skipped 四项:removePath 失败、deleteBranch 失败、缺 branchName、非可清理类别。
    expect(result.skipped).toHaveLength(4);
    expect(result.skipped.join("\n")).toContain("设备忙");
    expect(result.skipped.join("\n")).toContain("分支删除被拒绝");
    expect(result.skipped.join("\n")).toContain("缺少 repositoryURL/branchName");
    expect(result.skipped.join("\n")).toContain("不是可清理资源");
  });
});
