// T014: 并发预算组合测试(specs/001-v03-stability-multi-teamrun US1,契约
// interfaces.md C 节不变量 1/2/3/4)。组合方式照 tests/qualityGate.test.ts 与
// tests/reviewCenter.test.ts:真实 SqliteTeamRunRepository(内存 DB)+ 真实
// GitAdapter(临时 git 仓库)+ 真实 ConcurrencyBudget(settings 回调可控,经
// makeSettingsStoreBudgetSettings 读可变设置映射——等价于设置页改键)+
// AgentTeamApplicationService(注入预算)。childExecution 用 stub
// ChildExecutionService:start 返回按 taskID 控制的 deferred(可控 pending /
// 立即报告 / 可重试失败),避免真实子进程;workspace_write 任务可选用真实
// GitAdapter.prepareWorkspace 落真实 worktree(零串扰断言用)。
//
// 同仓库集成串行(不变量 3)按任务书简化:直接并发调 GitAdapter.applyIntegration
// 验证 per-repo 锁——第一次合并移动目标分支,排队中的第二次观察到基线移动抛
// targetBranchChanged(可读提示)。

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OctoPunkDatabase } from "../electron/data/database";
import { SqliteTeamRunRepository } from "../electron/data/repository";
import type { ChildTask, TeamRun } from "../electron/domain/models";
import { TeamEventKind } from "../electron/domain/events";
import { AgentTeamApplicationService } from "../electron/application/agentTeamService";
import type { ChildExecutionService } from "../electron/application/childExecutionService";
import { TaskIntegrationService } from "../electron/application/taskIntegrationService";
import { WorkbenchService } from "../electron/application/workbenchService";
import {
  ConcurrencyBudget,
  makeSettingsStoreBudgetSettings,
  type ConcurrencyBudgetSettings,
} from "../electron/application/concurrencyBudget";
import { ResourceMonitor } from "../electron/application/resourceMonitor";
import { DEFAULT_MIN_FREE_DISK_BYTES } from "../shared/ipc";
import {
  ChildAgentExecutionError,
  type ChildAgentReport,
} from "../electron/application/ports";
import { GitAdapter } from "../electron/platform/gitAdapter";
import { LocalProcessAdapter } from "../electron/platform/processAdapter";
import {
  GLOBAL_MAX_CHILDREN_KEY,
  INTERACTIVE_SLOT_RESERVED_KEY,
  PER_KIND_MAX_CHILDREN_KEY,
  PER_PROJECT_MAX_CHILDREN_KEY,
} from "../electron/settingsStore";

const GIT = "/usr/bin/git";

function git(cwd: string, args: string[]): string {
  return execFileSync(
    GIT,
    ["-c", "user.email=octo@test.dev", "-c", "user.name=OctoPunk Test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function write(repositoryURL: string, relativePath: string, content: string): void {
  fs.writeFileSync(path.join(repositoryURL, relativePath), content);
}

// ---- stub ChildExecutionService ----

/** 每任务一个 deferred:resolve = 子 Agent 报告;reject = 执行失败。 */
class StubChildExecution {
  /** 每次 execute 的观察记录(交叉断言:子进程拿到的是自家仓库)。 */
  readonly executions: Array<{ runID: string; taskID: string; agentKind: string; repositoryURL: string }> = [];
  /** prepareWorkspace 的失败记录(诊断并发 worktree 竞态)。 */
  readonly prepareErrors: string[] = [];
  private readonly deferreds = new Map<
    string,
    { resolve: (report: ChildAgentReport) => void; reject: (error: Error) => void }
  >();
  private readonly git: GitAdapter | null;
  /** 真实落下的 worktree(afterAll 回收)。 */
  readonly createdWorktrees: Array<{ repo: string; worktreePath: string; runDirectory: string }> = [];

  constructor(git: GitAdapter | null) {
    this.git = git;
  }

  async execute(
    run: TeamRun,
    task: ChildTask,
    repositoryURL: string,
    _reviewFeedback: unknown,
    _signal?: AbortSignal,
  ): Promise<ChildAgentReport> {
    this.executions.push({
      runID: run.id,
      taskID: task.id,
      agentKind: task.agentKind,
      repositoryURL,
    });
    // 与生产 ChildExecutionService 同构:workspace_write 任务先落真实 worktree。
    if (task.executionMode === "workspace_write" && this.git != null) {
      try {
        await this.git.prepareWorkspace({
          repositoryURL,
          runID: run.id,
          taskID: task.id,
          baselineCommit: task.baselineCommit,
          branchName: task.branchName,
          worktreeURL: task.worktreePath,
        });
        this.createdWorktrees.push({
          repo: repositoryURL,
          worktreePath: task.worktreePath,
          runDirectory: path.dirname(task.worktreePath),
        });
      } catch (error) {
        this.prepareErrors.push(`${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
    return await new Promise<ChildAgentReport>((resolve, reject) => {
      this.deferreds.set(task.id, { resolve, reject });
    });
  }

  async cancel(): Promise<void> {}

  /** 已就绪(可 complete/fail)的挂起执行数——worktree 准备完成后才计入。 */
  pendingCount(): number {
    return this.deferreds.size;
  }

  /** 子 Agent 正常报告 → 任务 awaiting_report。 */
  complete(taskID: string): void {
    const deferred = this.deferreds.get(taskID);
    if (deferred == null) throw new Error(`no pending execution for ${taskID}`);
    this.deferreds.delete(taskID);
    deferred.resolve({
      sessionID: `session-${taskID}`,
      message: `Implemented ${taskID}`,
      rawOutput: "done",
      tests: [],
      changedFiles: [],
      diffSummary: null,
      blocker: null,
    });
  }

  /** 子 Agent 失败:可重试失败(rate_limited)配 executionPolicy 时 run 不被阻断。 */
  fail(taskID: string, retryable = false): void {
    const deferred = this.deferreds.get(taskID);
    if (deferred == null) throw new Error(`no pending execution for ${taskID}`);
    this.deferreds.delete(taskID);
    deferred.reject(
      retryable
        ? new ChildAgentExecutionError("rate_limited", "upstream 429 (stub)")
        : new Error("stub child failure"),
    );
  }
}

// ---- 世界装配 ----

interface RepoHandle {
  path: string;
  baselineCommit: string;
  run: TeamRun;
}

interface World {
  root: string;
  repository: SqliteTeamRunRepository;
  service: AgentTeamApplicationService;
  budget: ConcurrencyBudget;
  gitPort: GitAdapter;
  children: StubChildExecution;
  /** 设置页等价:改这个映射 = 改 SettingsStore 键(预算每次现读)。 */
  settingsMap: Record<string, string>;
  repos: RepoHandle[];
  workbench: WorkbenchService;
}

interface WorldInit {
  prefix: string;
  /** 临时 git 仓库数量(1 = 同仓库场景,2 = 多仓库并行)。 */
  repoCount?: number;
  /** 叠加在基准映射之上的设置键(值为十进制/布尔字符串,同 SettingsStore)。 */
  settings?: Record<string, string>;
  runMaxConcurrentTasks?: number;
  /** stub 子执行为 workspace_write 任务落真实 worktree(零串扰断言用)。 */
  prepareWorktrees?: boolean;
  /** 注入执行策略(自动重试预算;failed 分区用例需要)。 */
  taskRetryLimit?: number;
}

const roots: string[] = [];
/** 全部 stub 子执行(afterAll 聚合回收它们落下的真实 worktree)。 */
const stubs: StubChildExecution[] = [];

function buildRepo(root: string, name: string, fileContent: string): { path: string; baselineCommit: string } {
  const repositoryURL = path.join(root, name);
  fs.mkdirSync(repositoryURL);
  git(repositoryURL, ["init", "-q", "-b", "main"]);
  write(repositoryURL, "feature.ts", fileContent);
  git(repositoryURL, ["add", "-A"]);
  git(repositoryURL, ["commit", "-qm", "baseline"]);
  const baselineCommit = git(repositoryURL, ["rev-parse", "HEAD"]).trim();
  return { path: repositoryURL, baselineCommit };
}

/** 同一 root 内共享一个 GitAdapter(support 目录指向临时根,集成 worktree 不出界)。 */
const gitPortCacheByRoot = new Map<string, GitAdapter>();

function gitPortFor(root: string): GitAdapter {
  let gitPort = gitPortCacheByRoot.get(root);
  if (gitPort == null) {
    gitPort = new GitAdapter(new LocalProcessAdapter(), GIT, path.join(root, "support"));
    gitPortCacheByRoot.set(root, gitPort);
  }
  return gitPort;
}

async function buildWorld(init: WorldInit): Promise<World> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `octopunk-concurrency-${init.prefix}-`));
  roots.push(root);

  const repoCount = init.repoCount ?? 1;
  const settingsMap: Record<string, string> = {
    // 基准:四级都宽裕 + 关闭交互预留(交互槽用例单独开)。
    [GLOBAL_MAX_CHILDREN_KEY]: "6",
    [PER_PROJECT_MAX_CHILDREN_KEY]: "10",
    [PER_KIND_MAX_CHILDREN_KEY]: "10",
    [INTERACTIVE_SLOT_RESERVED_KEY]: "false",
    ...init.settings,
  };
  const settings = (): ConcurrencyBudgetSettings =>
    makeSettingsStoreBudgetSettings((key) => settingsMap[key]);

  const gitPort = gitPortFor(root);
  const budget = new ConcurrencyBudget({ settings });
  const children = new StubChildExecution(init.prepareWorktrees === true ? gitPort : null);
  stubs.push(children);
  const repository = new SqliteTeamRunRepository(OctoPunkDatabase.inMemory().writer);
  const service = new AgentTeamApplicationService({
    repository,
    childExecution: children as unknown as ChildExecutionService,
    integration: new TaskIntegrationService(gitPort),
    concurrencyBudget: budget,
    ...(init.taskRetryLimit != null
      ? { executionPolicy: () => ({ taskRetryLimit: init.taskRetryLimit!, launchStaggerSeconds: 0 }) }
      : {}),
  });

  const repos: RepoHandle[] = [];
  for (let index = 0; index < repoCount; index += 1) {
    const built = buildRepo(root, `repo-${index}`, `baseline ${index}\n`);
    const status = await service.startTeam({
      requestID: `${init.prefix}-start-${index}`,
      sessionID: `${init.prefix}-session-${index}`,
      repositoryPath: built.path,
      task: `Concurrency world ${init.prefix} repo ${index}`,
      baselineCommit: built.baselineCommit,
      targetBranch: "main",
      maxConcurrentTasks: init.runMaxConcurrentTasks ?? 5,
      maxReviewRounds: 3,
    });
    // 域对象经轻量摘要取回(DTO 不保证携带全部调度字段)。
    const run = (await repository.runSummary(status.run.id)).run;
    repos.push({ path: built.path, baselineCommit: built.baselineCommit, run });
  }

  const workbench = new WorkbenchService({ repository, agentTeamService: service });
  return { root, repository, service, budget, gitPort, children, settingsMap, repos, workbench };
}

afterAll(async () => {
  // 先拆真实 worktree(git 元数据在临时仓库里),再删 Application Support 布局,
  // 最后删临时根;对可能由本文件新建的空父目录做尽力而为回收。
  const runDirectories = new Set<string>();
  const allWorktrees = stubs.flatMap((stub) => stub.createdWorktrees);
  for (const created of allWorktrees) {
    runDirectories.add(created.runDirectory);
    try {
      git(created.repo, ["worktree", "remove", "--force", created.worktreePath]);
    } catch {
      // 临时仓库可能已被删除;目录回收仍会执行。
    }
    fs.rmSync(created.runDirectory, { recursive: true, force: true });
  }
  // 失败用例可能仍有 in-flight 的 worktree 创建在 afterAll 之后落地:延迟二扫。
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const runDirectory of runDirectories) {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
  const supportParents = new Set<string>();
  for (const runDirectory of runDirectories) {
    supportParents.add(path.dirname(runDirectory));
    supportParents.add(path.dirname(path.dirname(runDirectory)));
  }
  for (const parent of supportParents) {
    try {
      fs.rmdirSync(parent);
    } catch {
      // 非空(真实数据)或不存在:保留。
    }
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// ---- 断言小工具 ----

async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function taskOf(world: World, runID: string, taskID: string): Promise<ChildTask> {
  const snapshot = await world.repository.snapshot(runID);
  const task = snapshot.tasks.find((candidate) => candidate.id === taskID);
  if (task == null) throw new Error(`task ${taskID} not found in ${runID}`);
  return task;
}

async function waitStatus(world: World, runID: string, taskID: string, status: string): Promise<void> {
  await waitFor(
    `task ${taskID} → ${status}`,
    async () => (await taskOf(world, runID, taskID)).status === status,
  );
}

function queueReasonOf(world: World, runID: string, taskID: string): string | null {
  return world.service.getQueueReasons(runID).find((entry) => entry.taskID === taskID)?.reason ?? null;
}

async function delegate(
  world: World,
  repoIndex: number,
  input: { requestID: string; title: string; agentKind?: "claude_code" | "codex"; executionMode?: "read_only" | "workspace_write" },
): Promise<string> {
  const repo = world.repos[repoIndex];
  const task = await world.service.delegateTask({
    requestID: input.requestID,
    runID: repo.run.id,
    title: input.title,
    prompt: input.title,
    agentKind: input.agentKind ?? "claude_code",
    model: null,
    executionMode: input.executionMode ?? "read_only",
    dependencies: [],
  });
  return task.id;
}

function shortRunOf(runID: string): string {
  return runID.replaceAll("-", "").slice(0, 8);
}

// ---- 1. 四级取最严(不变量 1)----

describe("ConcurrencyBudget 四级取最严", () => {
  it("global=1:仅 1 个 granted,另一个 global_budget;释放后自动放行;调回 3(设置页等价)后排队任务放行且生效值同步", async () => {
    const world = await buildWorld({
      prefix: "global",
      settings: { [GLOBAL_MAX_CHILDREN_KEY]: "1" },
    });
    const repo = world.repos[0];
    const first = await delegate(world, 0, { requestID: "global-t1", title: "First" });
    await waitStatus(world, repo.run.id, first, "running");

    const second = await delegate(world, 0, {
      requestID: "global-t2",
      title: "Second",
      agentKind: "codex",
    });
    await waitStatus(world, repo.run.id, second, "queued");
    expect(queueReasonOf(world, repo.run.id, second)).toBe("global_budget");
    // 不变量 1:活跃数不得超出生效值,且生效值与设置一致(get_team_status 呈现)。
    let counts = world.service.getConcurrencyCounts();
    expect(counts?.global).toMatchObject({ active: 1, limit: 1 });
    expect((await taskOf(world, repo.run.id, first)).status).toBe("running");

    // 释放路径:运行中完成 → capacity-freed 重排 → 第二个获得配额。
    world.children.complete(first);
    await waitStatus(world, repo.run.id, first, "awaiting_report");
    await waitStatus(world, repo.run.id, second, "running");
    expect(queueReasonOf(world, repo.run.id, second)).toBeNull();
    counts = world.service.getConcurrencyCounts();
    expect(counts?.global.active).toBe(1);

    // 设置页等价(quickstart 场景 1 步骤 3):调到 1 → 排队且原因 global_budget;
    // 恢复 3 后 drain 放行;生效值随设置同步为 3。
    const third = await delegate(world, 0, { requestID: "global-t3", title: "Third" });
    await waitStatus(world, repo.run.id, third, "queued");
    expect(queueReasonOf(world, repo.run.id, third)).toBe("global_budget");
    world.settingsMap[GLOBAL_MAX_CHILDREN_KEY] = "3";
    counts = world.service.getConcurrencyCounts();
    expect(counts?.global).toMatchObject({ active: 1, limit: 3 });
    await world.service.drainReadyTasks(repo.run.id);
    await waitStatus(world, repo.run.id, third, "running");
    expect(queueReasonOf(world, repo.run.id, third)).toBeNull();
    expect(world.service.getConcurrencyCounts()?.global.active).toBe(2);
  }, 30000);

  it("perProject=1(kind 不同)→ 第二个 project_budget", async () => {
    const world = await buildWorld({
      prefix: "project",
      settings: { [PER_PROJECT_MAX_CHILDREN_KEY]: "1" },
    });
    const runID = world.repos[0].run.id;
    const first = await delegate(world, 0, { requestID: "project-t1", title: "First" });
    await waitStatus(world, runID, first, "running");

    const second = await delegate(world, 0, {
      requestID: "project-t2",
      title: "Second",
      agentKind: "codex",
    });
    await waitStatus(world, runID, second, "queued");
    expect(queueReasonOf(world, runID, second)).toBe("project_budget");
    const counts = world.service.getConcurrencyCounts();
    expect(counts?.projects).toEqual([
      { repositoryPath: world.repos[0].path, active: 1, limit: 1 },
    ]);
  }, 30000);

  it("perKind=1(同 kind)→ 第二个 kind_budget", async () => {
    const world = await buildWorld({
      prefix: "kind",
      settings: { [PER_KIND_MAX_CHILDREN_KEY]: "1" },
    });
    const runID = world.repos[0].run.id;
    const first = await delegate(world, 0, { requestID: "kind-t1", title: "First" });
    await waitStatus(world, runID, first, "running");

    const second = await delegate(world, 0, { requestID: "kind-t2", title: "Second" });
    await waitStatus(world, runID, second, "queued");
    expect(queueReasonOf(world, runID, second)).toBe("kind_budget");
    const counts = world.service.getConcurrencyCounts();
    expect(counts?.kinds).toEqual([{ agentKind: "claude_code", active: 1, limit: 1 }]);
  }, 30000);

  it("run.maxConcurrentTasks 最小 → run 级拒绝:reason=null(不记录闸门原因),任务留 queued,释放后获得", async () => {
    const world = await buildWorld({ prefix: "runmax", runMaxConcurrentTasks: 1 });
    const repo = world.repos[0];
    const first = await delegate(world, 0, { requestID: "runmax-t1", title: "First" });
    await waitStatus(world, repo.run.id, first, "running");

    const second = await delegate(world, 0, {
      requestID: "runmax-t2",
      title: "Second",
      agentKind: "codex",
    });
    await waitStatus(world, repo.run.id, second, "queued");
    // run 级饱和 = 既有 run 内排队,无闸门原因(getQueueReasons 不含它)。
    expect(queueReasonOf(world, repo.run.id, second)).toBeNull();
    const secondTask = await taskOf(world, repo.run.id, second);
    // 预算直查:wouldGrant 明确返回 granted=false + reason=null。
    expect(
      world.budget.wouldGrant({
        taskID: secondTask.id,
        runID: repo.run.id,
        repositoryPath: repo.path,
        agentKind: secondTask.agentKind,
        runMaxConcurrentTasks: repo.run.maxConcurrentTasks,
      }),
    ).toEqual({ granted: false, reason: null });
    expect(world.service.getConcurrencyCounts()?.runs).toEqual([
      { runID: repo.run.id, active: 1, limit: 1, paused: false },
    ]);

    world.children.complete(first);
    await waitStatus(world, repo.run.id, first, "awaiting_report");
    await waitStatus(world, repo.run.id, second, "running");
  }, 30000);
});

// ---- 2. 多 run 零串扰(不变量 2)----

describe("多 run 并行零串扰", () => {
  it("两仓库两 run 并行 drain:4 任务全部 granted,任务/worktree/事件/报告互不含对方 ID", async () => {
    const world = await buildWorld({
      prefix: "crosstalk",
      repoCount: 2,
      runMaxConcurrentTasks: 3,
      prepareWorktrees: true,
    });
    const [repoA, repoB] = world.repos;

    // 直接经仓储写任务(不走 service.delegateTask 的首启 drain),
    // 然后两个 run 同时 drain——并行领配额的真实路径。
    const idsA: string[] = [];
    const idsB: string[] = [];
    for (const [ids, index, requestPrefix] of [
      [idsA, 0, "a"],
      [idsB, 1, "b"],
    ] as const) {
      for (const kind of ["claude_code", "codex"] as const) {
        const task = await world.repository.delegateTask({
          requestID: `crosstalk-${requestPrefix}-${kind}`,
          runID: world.repos[index].run.id,
          title: `Task ${requestPrefix} ${kind}`,
          prompt: `Task ${requestPrefix} ${kind}`,
          agentKind: kind,
          model: null,
          executionMode: "workspace_write",
          dependencies: [],
        });
        ids.push(task.id);
      }
    }

    await Promise.all([
      world.service.drainReadyTasks(repoA.run.id),
      world.service.drainReadyTasks(repoB.run.id),
    ]);
    await waitFor(
      "4 个子执行全部启动且就绪",
      () => world.children.executions.length === 4 && world.children.pendingCount() === 4,
    );
    if (world.children.prepareErrors.length > 0) {
      throw new Error(`prepareWorkspace 失败:\n${world.children.prepareErrors.join("\n")}`);
    }

    // 两 run 并行 granted 计数正确(不变量 1 聚合呈现)。
    const counts = world.service.getConcurrencyCounts();
    expect(counts?.global).toMatchObject({ active: 4, limit: 6 });
    expect(new Map(counts?.runs.map((entry) => [entry.runID, entry.active]))).toEqual(
      new Map([
        [repoA.run.id, 2],
        [repoB.run.id, 2],
      ]),
    );
    expect(new Map(counts?.projects.map((entry) => [entry.repositoryPath, entry.active]))).toEqual(
      new Map([
        [repoA.path, 2],
        [repoB.path, 2],
      ]),
    );

    // 子执行拿到的仓库正确(executions 记录交叉断言)。
    for (const execution of world.children.executions) {
      const expected = execution.runID === repoA.run.id ? repoA.path : repoB.path;
      expect(execution.repositoryURL).toBe(expected);
    }

    // 任务/worktree/分支:互不含对方 run ID(含短 run ID)。
    const shortA = shortRunOf(repoA.run.id);
    const shortB = shortRunOf(repoB.run.id);
    for (const task of (await world.repository.snapshot(repoA.run.id)).tasks) {
      expect(task.worktreePath).toContain(repoA.run.id);
      expect(task.worktreePath).not.toContain(repoB.run.id);
      expect(task.branchName).toContain(shortA);
      expect(task.branchName).not.toContain(shortB);
    }
    for (const task of (await world.repository.snapshot(repoB.run.id)).tasks) {
      expect(task.worktreePath).toContain(repoB.run.id);
      expect(task.worktreePath).not.toContain(repoA.run.id);
      expect(task.branchName).toContain(shortB);
      expect(task.branchName).not.toContain(shortA);
    }

    // 真实 worktree/分支零串扰:repo A 的 worktree 与分支只属于 run A(反向同)。
    for (const [repo, ownRunID, otherRunID] of [
      [repoA, repoA.run.id, repoB.run.id],
      [repoB, repoB.run.id, repoA.run.id],
    ] as const) {
      // macOS 的 /var → /private/var 符号链接:主工作区比较需两侧都 realpath。
      const mainWorktree = fs.realpathSync(repo.path);
      const worktrees = git(repo.path, ["worktree", "list", "--porcelain"]);
      for (const line of worktrees.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const worktreePath = line.slice("worktree ".length);
        if (fs.realpathSync(worktreePath) === mainWorktree) continue;
        expect(worktreePath, `${worktreePath} 应属于本仓库的 run`).toContain(ownRunID);
        expect(worktreePath).not.toContain(otherRunID);
      }
      const branches = git(repo.path, ["branch", "--format=%(refname:short)"]);
      expect(branches).not.toContain(shortRunOf(otherRunID));
    }

    // 事件:run A 的事件不出现 run B 的任务 ID(反向同)。
    const eventsA = await world.repository.events(repoA.run.id, null);
    const eventsB = await world.repository.events(repoB.run.id, null);
    for (const event of eventsA) {
      expect(event.taskID == null || idsA.includes(event.taskID), `run A 事件泄漏:${event.taskID}`).toBe(true);
    }
    for (const event of eventsB) {
      expect(event.taskID == null || idsB.includes(event.taskID), `run B 事件泄漏:${event.taskID}`).toBe(true);
    }

    // 报告:全部完成后,各自报告互不含对方任务 ID。
    for (const id of [...idsA, ...idsB]) world.children.complete(id);
    const allIDs = [
      ...idsA.map((id) => ({ id, runID: repoA.run.id })),
      ...idsB.map((id) => ({ id, runID: repoB.run.id })),
    ];
    await waitFor("全部 awaiting_report", async () => {
      const statuses = await Promise.all(allIDs.map(({ id, runID }) => taskOf(world, runID, id)));
      return statuses.every((task) => task.status === "awaiting_report");
    });
    for (const [repo, ownIDs, otherIDs] of [
      [repoA, idsA, idsB],
      [repoB, idsB, idsA],
    ] as const) {
      const reports = (await world.repository.snapshot(repo.run.id)).reports;
      expect(reports.map((report) => report.taskID).sort()).toEqual([...ownIDs].sort());
      for (const report of reports) {
        expect(otherIDs).not.toContain(report.taskID);
      }
    }
  }, 60000);
});

// ---- 3. 同仓库集成串行(不变量 3,GitAdapter.applyIntegration per-repo 锁)----

describe("同仓库集成串行", () => {
  it("并发两次 applyIntegration:串行完成,第二次观察到目标分支已移动 → targetBranchChanged(可读提示)", async () => {
    const world = await buildWorld({ prefix: "serial" });
    const repo = world.repos[0];
    // 同仓库第二个 run(模拟对仓库 A 再起第二个 run)。
    const secondStart = await world.repository.startTeam({
      requestID: "serial-start-2",
      sessionID: "serial-session-2",
      repositoryPath: repo.path,
      task: "Same-repo second run",
      baselineCommit: repo.baselineCommit,
      targetBranch: "main",
      maxConcurrentTasks: 3,
      maxReviewRounds: 3,
    });

    // 两个 run 各自的集成分支都已推进一个提交(等价 complete 前的 integrate 汇合)。
    const advance = (runID: string, file: string) => {
      const branch = `octopunk/${runID}/integration`;
      git(repo.path, ["checkout", "-qb", branch, repo.baselineCommit]);
      write(repo.path, file, `from ${runID}\n`);
      git(repo.path, ["add", "-A"]);
      git(repo.path, ["commit", "-qm", `integration ${file}`]);
      git(repo.path, ["checkout", "-q", "main"]);
    };
    advance(repo.run.id, "run-a.txt");
    advance(secondStart.run.id, "run-b.txt");

    // 并发触发终局集成:先调用者先入 per-repo 锁。
    const firstApplied = world.gitPort.applyIntegration({
      repositoryURL: repo.path,
      runID: repo.run.id,
      targetBranch: "main",
      baselineCommit: repo.baselineCommit,
    });
    const secondApplied = world.gitPort.applyIntegration({
      repositoryURL: repo.path,
      runID: secondStart.run.id,
      targetBranch: "main",
      baselineCommit: repo.baselineCommit,
    });
    const results = await Promise.allSettled([firstApplied, secondApplied]);

    // 第一次:合并成功,main 移动到合并提交。
    expect(results[0].status).toBe("fulfilled");
    const mergedHead = (results[0] as PromiseFulfilledResult<string>).value;
    expect(mergedHead).not.toBe(repo.baselineCommit);
    expect(git(repo.path, ["rev-parse", "HEAD"]).trim()).toBe(mergedHead);
    expect(fs.existsSync(path.join(repo.path, "run-a.txt"))).toBe(true);

    // 第二次:串行观察到基线已移动 → 拒绝,提示含期望/实际两侧(可读)。
    expect(results[1].status).toBe("rejected");
    const rejection = (results[1] as PromiseRejectedResult).reason as Error;
    expect(rejection.message).toContain("target branch moved");
    expect(rejection.message).toContain(repo.baselineCommit);
    // 观察到的是第一次合并后的新头 → 证明第二次确实排在第一次之后(串行)。
    expect(rejection.message).toContain(mergedHead);

    // 串行化的另一面:目标分支上只有一次合并,run B 的内容从未被写入。
    const merges = git(repo.path, ["log", "--merges", "--oneline", "main"]).trim();
    expect(merges.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
    expect(fs.existsSync(path.join(repo.path, "run-b.txt"))).toBe(false);
  }, 30000);
});

// ---- 4. 暂停不影响运行中(不变量 4)----

describe("暂停不伤运行中", () => {
  it("pauseRun:queued 原因变 run_paused,运行中照常完成;resume 后 queued 获得;审计事件 run.paused/resumed 各一条", async () => {
    const world = await buildWorld({
      prefix: "pause",
      settings: { [GLOBAL_MAX_CHILDREN_KEY]: "1" },
    });
    const repo = world.repos[0];
    const first = await delegate(world, 0, { requestID: "pause-t1", title: "Running one" });
    await waitStatus(world, repo.run.id, first, "running");
    const second = await delegate(world, 0, {
      requestID: "pause-t2",
      title: "Queued one",
      agentKind: "codex",
    });
    await waitStatus(world, repo.run.id, second, "queued");
    expect(queueReasonOf(world, repo.run.id, second)).toBe("global_budget");

    await world.service.pauseRun({ requestID: "pause-run", runID: repo.run.id });
    await waitFor("queued 原因刷新为 run_paused", () => queueReasonOf(world, repo.run.id, second) === "run_paused");
    expect((await taskOf(world, repo.run.id, second)).status).toBe("queued");
    // 落库镜像 + 预算 paused 集。
    expect((await world.repository.snapshot(repo.run.id)).run.pausedAt).not.toBeNull();
    expect(world.service.getConcurrencyCounts()?.pausedRunIDs).toContain(repo.run.id);

    // 红线:运行中任务照常完成(释放不回收已授配额,但暂停期间 queued 仍被拒)。
    world.children.complete(first);
    await waitStatus(world, repo.run.id, first, "awaiting_report");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await taskOf(world, repo.run.id, second)).status).toBe("queued");
    expect(queueReasonOf(world, repo.run.id, second)).toBe("run_paused");

    await world.service.resumeRun({ requestID: "resume-run", runID: repo.run.id });
    await waitStatus(world, repo.run.id, second, "running");
    expect(queueReasonOf(world, repo.run.id, second)).toBeNull();

    // 审计事件:各恰好一条。
    const events = (await world.repository.snapshot(repo.run.id)).events;
    expect(events.filter((event) => event.kind === TeamEventKind.runPaused)).toHaveLength(1);
    expect(events.filter((event) => event.kind === TeamEventKind.runResumed)).toHaveLength(1);
  }, 30000);
});

// ---- 5. 交互槽预留 ----

describe("交互槽预留", () => {
  it("interactiveSlotReserved:global=2 被普通任务占满共享槽 → interactive 任务仍 granted(全局保留 1 槽)", async () => {
    const world = await buildWorld({
      prefix: "interactive",
      settings: {
        [GLOBAL_MAX_CHILDREN_KEY]: "2",
        [INTERACTIVE_SLOT_RESERVED_KEY]: "true",
      },
    });
    const repo = world.repos[0];
    const first = await delegate(world, 0, { requestID: "interactive-t1", title: "Normal one" });
    await waitStatus(world, repo.run.id, first, "running");

    // 普通任务只能用 2-1=1 个共享槽:第二个普通任务 global_budget。
    const second = await delegate(world, 0, {
      requestID: "interactive-t2",
      title: "Normal two",
      agentKind: "codex",
    });
    await waitStatus(world, repo.run.id, second, "queued");
    expect(queueReasonOf(world, repo.run.id, second)).toBe("global_budget");

    // interactive 任务(委派期标记,T026 前经预算直查)仍可获配额。
    const interactiveTask = {
      taskID: "interactive-probe",
      runID: repo.run.id,
      repositoryPath: repo.path,
      agentKind: "claude_code" as const,
      runMaxConcurrentTasks: 5,
      interactive: true,
    };
    expect(world.budget.tryAcquire(interactiveTask)).toEqual({ granted: true, reason: null });
    const counts = world.service.getConcurrencyCounts();
    expect(counts?.global).toMatchObject({ active: 2, limit: 2, interactiveReserved: true });

    // 全局打满后,再来的 interactive 也排队(global_budget)。
    expect(world.budget.tryAcquire({ ...interactiveTask, taskID: "interactive-probe-2" })).toEqual({
      granted: false,
      reason: "global_budget",
    });
    world.budget.release(repo.run.id, "interactive-probe");

    // 预留只对 interactive 放行:普通任务在共享槽占用时依旧被拒。
    expect(world.budget.wouldGrant({ ...interactiveTask, taskID: "interactive-probe-3", interactive: false })).toEqual({
      granted: false,
      reason: "global_budget",
    });
  }, 30000);

  it("delegate 载荷 interactive 贯穿 launch 闸门:共享槽占满时 interactive 委派任务仍先启动(T026 委派链路)", async () => {
    const world = await buildWorld({
      prefix: "interactive-flow",
      settings: {
        [GLOBAL_MAX_CHILDREN_KEY]: "2",
        [INTERACTIVE_SLOT_RESERVED_KEY]: "true",
      },
    });
    const repo = world.repos[0];
    const first = await delegate(world, 0, { requestID: "iflow-t1", title: "Normal one" });
    await waitStatus(world, repo.run.id, first, "running");

    // 普通任务只能用 2-1=1 个共享槽:第二个普通任务排队 global_budget。
    const second = await delegate(world, 0, {
      requestID: "iflow-t2",
      title: "Normal two",
      agentKind: "codex",
    });
    await waitStatus(world, repo.run.id, second, "queued");
    expect(queueReasonOf(world, repo.run.id, second)).toBe("global_budget");

    // 单任务委派带 interactive:true → launch 的 budgetTask 收到 interactive,
    // 走全局预留槽启动(共享槽已被 first 占满)。
    const interactiveSingle = await world.service.delegateTask({
      requestID: "iflow-t3",
      runID: repo.run.id,
      title: "Interactive single",
      prompt: "Interactive single",
      agentKind: "claude_code",
      model: null,
      executionMode: "read_only",
      dependencies: [],
      interactive: true,
    });
    await waitStatus(world, repo.run.id, interactiveSingle.id, "running");
    expect(queueReasonOf(world, repo.run.id, interactiveSingle.id)).toBeNull();
    expect(world.service.getConcurrencyCounts()?.global).toMatchObject({
      active: 2,
      limit: 2,
      interactiveReserved: true,
    });

    // 批量委派:interactive 项启动,普通项保持排队(按 index 对齐标记)。
    const batch = await world.service.delegateTasks({
      requestID: "iflow-batch",
      runID: repo.run.id,
      contextSummary: "",
      tasks: [
        {
          clientKey: "interactive-item",
          title: "Interactive item",
          prompt: "Interactive item",
          agentKind: "codex",
          model: null,
          executionMode: "read_only",
          parentTask: null,
          dependencies: [],
          interactive: true,
        },
        {
          clientKey: "normal-item",
          title: "Normal item",
          prompt: "Normal item",
          agentKind: "claude_code",
          model: null,
          executionMode: "read_only",
          parentTask: null,
          dependencies: [],
          interactive: false,
        },
      ],
    });
    const interactiveItem = batch.taskMapping.find((entry) => entry.clientKey === "interactive-item")?.task;
    const normalItem = batch.taskMapping.find((entry) => entry.clientKey === "normal-item")?.task;
    expect(interactiveItem).toBeTruthy();
    expect(normalItem).toBeTruthy();
    // 全局 2 槽已满(1 共享 + 1 预留被 interactive single 占用):批内两项此刻
    // 都排队;普通项带 global_budget,interactive 项同样 global_budget(全局
    // 满对 interactive 也拒——预留只豁免「共享槽收缩」,不突破全局上限)。
    await waitStatus(world, repo.run.id, normalItem!.id, "queued");
    expect(queueReasonOf(world, repo.run.id, normalItem!.id)).toBe("global_budget");
    await waitStatus(world, repo.run.id, interactiveItem!.id, "queued");
    expect(queueReasonOf(world, repo.run.id, interactiveItem!.id)).toBe("global_budget");
    // 释放 interactive single(预留槽空出)→ interactive 项经 drain 领预留槽,
    // 而先于它排队的普通任务(second/normal item)仍被拒:标记确实贯穿到了
    // launch 的 budgetTask(否则该项会以普通身份继续排队)。
    world.children.complete(interactiveSingle.id);
    await waitStatus(world, repo.run.id, interactiveSingle.id, "awaiting_report");
    await waitStatus(world, repo.run.id, interactiveItem!.id, "running");
    expect(queueReasonOf(world, repo.run.id, interactiveItem!.id)).toBeNull();
    expect((await taskOf(world, repo.run.id, normalItem!.id)).status).toBe("queued");
    expect((await taskOf(world, repo.run.id, second)).status).toBe("queued");
  }, 30000);
});

// ---- 6. 工作台六分区(US2 / T012,quickstart 场景 1 步骤 2 等价)----

describe("工作台六分区", () => {
  it("多 run 场景 summary() 六分区归类正确:queued 区含闸门原因,integratable 含 accepted", async () => {
    const world = await buildWorld({
      prefix: "workbench",
      repoCount: 2,
      settings: { [GLOBAL_MAX_CHILDREN_KEY]: "2" },
      taskRetryLimit: 1,
    });
    const [repoA, repoB] = world.repos;

    // run A:一个常驻 running,稍后第二个 running(把 global 占满)。
    const runningA1 = await delegate(world, 0, { requestID: "wb-a1", title: "Run A task 1" });
    await waitStatus(world, repoA.run.id, runningA1, "running");

    // run B:依次造出 accepted / awaiting_report / failed / blocked。
    const accepted = await delegate(world, 1, {
      requestID: "wb-b1",
      title: "Run B accepted",
      agentKind: "codex",
    });
    await waitStatus(world, repoB.run.id, accepted, "running");
    world.children.complete(accepted);
    await waitStatus(world, repoB.run.id, accepted, "awaiting_report");
    await world.service.acceptTask({
      requestID: "wb-b1-accept",
      runID: repoB.run.id,
      taskID: accepted,
      reviewer: "user",
      verdict: "PASS",
      summary: "accepted",
      findings: [],
    });
    await waitStatus(world, repoB.run.id, accepted, "accepted");

    const reviewing = await delegate(world, 1, {
      requestID: "wb-b2",
      title: "Run B reviewing",
      agentKind: "codex",
    });
    await waitStatus(world, repoB.run.id, reviewing, "running");
    world.children.complete(reviewing);
    await waitStatus(world, repoB.run.id, reviewing, "awaiting_report");

    // 可重试失败(重试预算 1):任务 failed 但 run 不被阻断,failed 分区可见。
    const failed = await delegate(world, 1, {
      requestID: "wb-b3",
      title: "Run B failed",
      agentKind: "codex",
    });
    await waitStatus(world, repoB.run.id, failed, "running");
    world.children.fail(failed, true);
    await waitStatus(world, repoB.run.id, failed, "failed");

    // 注:blockTask 会把 run 置为终态 blocked(域规则),终态 run 整体退出
    // 工作台——所以 awaiting_input 分区只可能承载"run 摘要不可读"的合成
    // 条目(尽力而为路径),本用例断言其为空。

    // run A 第二个任务占满 global=2 → run B 再委派即排队并携带原因。
    const runningA2 = await delegate(world, 0, { requestID: "wb-a2", title: "Run A task 2" });
    await waitStatus(world, repoA.run.id, runningA2, "running");
    const queued = await delegate(world, 1, {
      requestID: "wb-b5",
      title: "Run B queued",
      agentKind: "codex",
    });
    await waitStatus(world, repoB.run.id, queued, "queued");
    expect(queueReasonOf(world, repoB.run.id, queued)).toBe("global_budget");

    // 两个 run 都未终态(b failed 配了重试预算,run 仍活跃)。
    expect((await world.repository.snapshot(repoA.run.id)).run.status).not.toBe("completed");
    expect((await world.repository.snapshot(repoB.run.id)).run.status).not.toBe("completed");

    const sections = await world.workbench.summary();
    expect(sections.map((section) => section.section)).toEqual([
      "running",
      "queued",
      "awaiting_input",
      "failed",
      "awaiting_review",
      "integratable",
    ]);
    const bySection = new Map(sections.map((section) => [section.section, section.entries]));

    expect(new Set(bySection.get("running")?.map((entry) => entry.taskID))).toEqual(
      new Set([runningA1, runningA2]),
    );
    for (const entry of bySection.get("running") ?? []) {
      expect(entry).toMatchObject({ runID: repoA.run.id, repositoryPath: repoA.path, status: "running" });
    }

    const queuedEntries = bySection.get("queued") ?? [];
    expect(queuedEntries.map((entry) => entry.taskID)).toEqual([queued]);
    expect(queuedEntries[0]).toMatchObject({
      runID: repoB.run.id,
      status: "queued",
      queueReason: "global_budget",
    });

    expect(bySection.get("awaiting_input")).toEqual([]);
    expect(bySection.get("failed")?.map((entry) => entry.taskID)).toEqual([failed]);
    expect(bySection.get("awaiting_review")?.map((entry) => entry.taskID)).toEqual([reviewing]);
    const integratable = bySection.get("integratable") ?? [];
    expect(integratable.map((entry) => entry.taskID)).toEqual([accepted]);
    expect(integratable[0]).toMatchObject({ status: "accepted", repositoryPath: repoB.path });

    // 交叉:run A 的任务只出现在 repo A 条目,run B 同理(零串扰的工作台呈现)。
    for (const section of sections) {
      for (const entry of section.entries) {
        const isA = entry.runID === repoA.run.id;
        expect(entry.repositoryPath).toBe(isA ? repoA.path : repoB.path);
        expect(isA ? [runningA1, runningA2] : [accepted, reviewing, failed, queued]).toContain(entry.taskID);
      }
    }
  }, 60000);
});

// ---- 7. 资源感知调度(T026 / 契约 C 节不变量 4 资源版,quickstart 场景 4)----

describe("ResourceMonitor 资源感知", () => {
  /** 可变 stub 探针状态:改字段 = 改下一轮采样读到的机器状态。 */
  interface StubMachine {
    loadavg1: number;
    cpuCores: number;
    disk: { freeBytes: number; totalBytes: number } | null;
  }

  /**
   * 组装 ResourceMonitor + 可变探针 stub。默认注入记录型预算(观测推送值),
   * 传 budget 时用真实 ConcurrencyBudget(集成用例)。intervalMs=10ms 让
   * waitFor 在真实定时器路径上驱动多轮采样。
   */
  function stubMonitor(input: {
    machine: StubMachine;
    settings?: { resourcePauseEnabled?: boolean; minFreeDiskBytes?: number };
    budget?: ConcurrencyBudget;
  }): { monitor: ResourceMonitor; pushed: Array<boolean | null> } {
    const pushed: Array<boolean | null> = [];
    const budget =
      input.budget ?? {
        setResourcePressure: (value: boolean | null): void => {
          pushed.push(value);
        },
      };
    const monitor = new ResourceMonitor({
      probes: {
        sampleSystem: () => ({
          loadavg: [input.machine.loadavg1, 0, 0],
          freeMemBytes: 0,
          totalMemBytes: 0,
          cpuCores: input.machine.cpuCores,
        }),
        sampleDisk: async () => input.machine.disk,
      },
      budget,
      paths: { worktreeRoot: () => "/tmp/octopunk-resource-monitor-worktrees" },
      settings: () => ({
        resourcePauseEnabled: input.settings?.resourcePauseEnabled ?? true,
        minFreeDiskBytes: input.settings?.minFreeDiskBytes ?? DEFAULT_MIN_FREE_DISK_BYTES,
      }),
      intervalMs: 10,
    });
    return { monitor, pushed };
  }

  it("负载超 cpuCores×2 → setResourcePressure(true);恢复 → false,latest() 快照随轮更新", async () => {
    const machine: StubMachine = {
      loadavg1: 1,
      cpuCores: 4,
      disk: { freeBytes: DEFAULT_MIN_FREE_DISK_BYTES * 4, totalBytes: DEFAULT_MIN_FREE_DISK_BYTES * 8 },
    };
    const { monitor, pushed } = stubMonitor({ machine });
    monitor.start();
    try {
      await waitFor("首轮低压推送 false", () => pushed.length >= 1 && pushed[pushed.length - 1] === false);
      machine.loadavg1 = 4 * 2 + 0.5; // > cores × 2
      await waitFor("负载高压推送 true", () => pushed[pushed.length - 1] === true);
      const high = monitor.latest();
      expect(high.sampledAt).not.toBeNull();
      expect(high.loadavg1).toBe(machine.loadavg1);
      expect(high.cpuCores).toBe(4);
      expect(high.loadHigh).toBe(true);
      expect(high.diskLow).toBe(false);
      expect(high.pressure).toBe(true);
      expect(high.pausingNewTasks).toBe(true);
      machine.loadavg1 = 0.5;
      await waitFor("恢复推送 false", () => pushed[pushed.length - 1] === false);
      const recovered = monitor.latest();
      expect(recovered.pressure).toBe(false);
      expect(recovered.pausingNewTasks).toBe(false);
    } finally {
      monitor.stop();
    }
  }, 30000);

  it("磁盘余量低于阈值 → true;statfs 失败(null)时磁盘维度不参与,负载仍判 → false", async () => {
    const machine: StubMachine = {
      loadavg1: 1,
      cpuCores: 4,
      disk: { freeBytes: DEFAULT_MIN_FREE_DISK_BYTES - 1, totalBytes: DEFAULT_MIN_FREE_DISK_BYTES * 8 },
    };
    const { monitor, pushed } = stubMonitor({ machine });
    monitor.start();
    try {
      await waitFor("磁盘高压推送 true", () => pushed.length >= 1 && pushed[pushed.length - 1] === true);
      const high = monitor.latest();
      expect(high.diskLow).toBe(true);
      expect(high.diskFreeBytes).toBe(machine.disk?.freeBytes);
      expect(high.pressure).toBe(true);
      // 探测失败 → 磁盘维度退出判定;loadavg 恒可得,整体回到 false(非 null)。
      machine.disk = null;
      await waitFor("磁盘维度退出后回到 false", () => pushed.length >= 2 && pushed[pushed.length - 1] === false);
      const degraded = monitor.latest();
      expect(degraded.diskFreeBytes).toBeNull();
      expect(degraded.diskLow).toBeNull();
      expect(degraded.loadHigh).toBe(false);
      expect(degraded.pressure).toBe(false);
    } finally {
      monitor.stop();
    }
  }, 30000);

  it("resourcePauseEnabled=false:两维都高压也恒传 false(只展示不拦截)", async () => {
    const machine: StubMachine = { loadavg1: 100, cpuCores: 1, disk: { freeBytes: 0, totalBytes: 1 } };
    const { monitor, pushed } = stubMonitor({
      machine,
      settings: { resourcePauseEnabled: false },
    });
    monitor.start();
    try {
      await waitFor("首轮推送", () => pushed.length >= 1);
      expect(pushed.every((value) => value === false)).toBe(true);
      const latest = monitor.latest();
      expect(latest.pressure).toBe(true); // 原始判定仍如实入快照
      expect(latest.pausingNewTasks).toBe(false); // 但不进预算闸门
    } finally {
      monitor.stop();
    }
  }, 30000);

  it("预算集成(不变量 4 资源版):高压拒新配额 resource_pressure,已持有不受影响;恢复 → onCapacityFreed 重排后放行", async () => {
    const machine: StubMachine = {
      loadavg1: 1,
      cpuCores: 4,
      disk: { freeBytes: DEFAULT_MIN_FREE_DISK_BYTES * 4, totalBytes: DEFAULT_MIN_FREE_DISK_BYTES * 8 },
    };
    const freed: Array<string | null> = [];
    const budget = new ConcurrencyBudget({
      settings: (): ConcurrencyBudgetSettings => ({
        globalMaxChildren: 6,
        perProjectMaxChildren: 10,
        perKindMaxChildren: 10,
        resourcePauseEnabled: true,
        interactiveSlotReserved: false,
      }),
      onCapacityFreed: (runID) => freed.push(runID),
    });
    const heldTask = {
      taskID: "held-running",
      runID: "run-pressure",
      repositoryPath: "/repo/pressure",
      agentKind: "claude_code" as const,
      runMaxConcurrentTasks: 5,
    };
    expect(budget.tryAcquire(heldTask)).toEqual({ granted: true, reason: null });

    const { monitor } = stubMonitor({ machine, budget });
    monitor.start();
    try {
      await waitFor("首轮低压", () => budget.activeCounts().resourcePressure === false);
      machine.loadavg1 = 4 * 2 + 0.5; // > cores × 2 → 高压
      await waitFor("高压生效", () => budget.activeCounts().resourcePressure === true);
      // 新任务被拒 resource_pressure;运行中已持有的重入不受影响(红线)。
      expect(budget.tryAcquire({ ...heldTask, taskID: "queued-new" })).toEqual({
        granted: false,
        reason: "resource_pressure",
      });
      expect(budget.tryAcquire(heldTask)).toEqual({ granted: true, reason: null });
      expect(budget.activeCounts().global.active).toBe(1);

      // 恢复(压力 true → false)→ onCapacityFreed(null) 全局重排链触发。
      const freedBefore = freed.length;
      machine.loadavg1 = 0.5;
      await waitFor("压力清除", () => budget.activeCounts().resourcePressure === false);
      await waitFor("capacity-freed 触发", () => freed.length > freedBefore);
      expect(freed[freed.length - 1]).toBeNull();
      expect(budget.tryAcquire({ ...heldTask, taskID: "queued-new" })).toEqual({
        granted: true,
        reason: null,
      });
    } finally {
      monitor.stop();
    }
  }, 30000);

  it("start/stop:启动即完成首轮采样;stop 后不再推进快照", async () => {
    const machine: StubMachine = {
      loadavg1: 1,
      cpuCores: 4,
      disk: { freeBytes: DEFAULT_MIN_FREE_DISK_BYTES * 4, totalBytes: DEFAULT_MIN_FREE_DISK_BYTES * 8 },
    };
    const { monitor, pushed } = stubMonitor({ machine });
    expect(monitor.latest().sampledAt).toBeNull();
    monitor.start();
    try {
      // start() 立即触发一轮(不等待第一个间隔)。
      await waitFor("立即首轮采样", () => monitor.latest().sampledAt != null);
      expect(pushed.length).toBeGreaterThanOrEqual(1);
    } finally {
      monitor.stop();
    }
    const sampledAt = monitor.latest().sampledAt;
    machine.loadavg1 = 100;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(monitor.latest().sampledAt).toBe(sampledAt); // 定时器已停
    expect(monitor.latest().pressure).toBe(false); // 快照保持 stop 前的值
  }, 30000);
});
