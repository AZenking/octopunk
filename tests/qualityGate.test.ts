// T020: QualityGateService 质量门禁测试(specs/002-v04-review-center-gates
// US4,契约不变量 interfaces.md D 节 4/5 + FR-007/008/009)。组合方式照
// tests/reviewCenter.test.ts:真实 SqliteTeamRunRepository(内存 DB)+ 真实
// GitAdapter(临时 git 仓库;命令类检查经 GitAdapter.prepareWorkspace 在
// task.worktreePath 建真实 worktree)+ stub ProcessPort(可控退出码/超时,
// 验证命令类判定在 worktree 内受控执行)与 stub reviewCenter 端口(返回
// 构造的 open/risk 评论与 diffTree;逐行内容仍走真实 git.diffPage)。

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OctoPunkDatabase } from "../electron/data/database";
import { SqliteTeamRunRepository } from "../electron/data/repository";
import { DomainError } from "../electron/domain/models";
import type { ChildTask } from "../electron/domain/models";
import { QualityGateService } from "../electron/application/qualityGateService";
import type { ReviewCenterGatePort } from "../electron/application/qualityGateService";
import { AgentTeamApplicationService } from "../electron/application/agentTeamService";
import type { ChildExecutionService } from "../electron/application/childExecutionService";
import type { TaskIntegrationService } from "../electron/application/taskIntegrationService";
import type { ProcessPort, ProcessRequest, ProcessResult } from "../electron/application/ports";
import { GitAdapter } from "../electron/platform/gitAdapter";
import { LocalProcessAdapter } from "../electron/platform/processAdapter";
import type { GateConfigInput } from "../electron/domain/policy";
import type { DiffTreeEntryDTO, ReviewCommentDTO } from "../shared/dtos";

const GIT = "/usr/bin/git";

function git(cwd: string, args: string[]): string {
  return execFileSync(
    GIT,
    ["-c", "user.email=octo@test.dev", "-c", "user.name=OctoPunk Test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function write(repositoryURL: string, relativePath: string, content: string | Buffer): void {
  fs.writeFileSync(path.join(repositoryURL, relativePath), content);
}

/** 基线文件内容(不含 TODO/FIXME 词,避免干扰 todo_clean 扫描)。 */
const FEATURE_BASE = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n";
const KEEP_BASE = "k1\nk2\nk3\nk4\nk5\nk6\nk7\nk8\nk9\nk10\n";
/** scope 用任务提交:两个文件都在白名单外/内可控。 */
const FEATURE_ROUND1 = "l1\nl2\nl3-changed\nl4\nl5\nl6\nl7\nl8\n";
const KEEP_ROUND1 = "k1\nk2-changed\nk3\nk4\nk5\nk6\nk7\nk8\nk9\nk10\n";
/** todo 用任务提交:新增行携带 TODO 标记。 */
const FEATURE_TODO = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nTODO: wire up the real cache\n";

// ---- stub 端口 ----

/** 可控 ProcessPort:记录请求;behavior 决定退出码/挂起(模拟超时)。 */
type StubProcessBehavior = (request: ProcessRequest, signal?: AbortSignal) => Promise<ProcessResult>;

class StubProcessPort implements ProcessPort {
  readonly requests: ProcessRequest[] = [];
  behavior: StubProcessBehavior = async () => ({ exitCode: 0, stdout: "", stderr: "" });

  run(request: ProcessRequest, signal?: AbortSignal): Promise<ProcessResult> {
    this.requests.push(request);
    return this.behavior(request, signal);
  }

  async runStreaming(request: ProcessRequest): Promise<ProcessResult> {
    return this.run(request);
  }

  async terminate(): Promise<void> {}
  async terminateAll(): Promise<void> {}
}

function exitWith(exitCode: number, stdout = "", stderr = ""): StubProcessBehavior {
  return async () => ({ exitCode, stdout, stderr });
}

/** 永不完成,直到 AbortSignal 触发(模拟超时被服务侧 abort)。 */
const hangUntilAborted: StubProcessBehavior = (_request, signal) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("process aborted by timeout")));
  });

/** 可控 reviewCenter 端口:返回构造的未解决评论与 worktree 侧 diffTree。 */
class StubReviewCenterPort implements ReviewCenterGatePort {
  findings: ReviewCommentDTO[] = [];
  tree: DiffTreeEntryDTO[] = [];

  async unresolvedFindings(): Promise<ReviewCommentDTO[]> {
    return this.findings.map((finding) => ({ ...finding }));
  }

  async getDiffTree(): Promise<DiffTreeEntryDTO[]> {
    return this.tree.map((entry) => ({ ...entry }));
  }
}

function diffEntry(path_: string, overrides: Partial<DiffTreeEntryDTO> = {}): DiffTreeEntryDTO {
  return { path: path_, changeType: "modified", additions: 1, deletions: 0, isBinary: false, oversize: false, ...overrides };
}

function comment(id: string, overrides: Partial<ReviewCommentDTO> = {}): ReviewCommentDTO {
  return {
    id,
    runID: "",
    taskID: "",
    reviewRound: 1,
    filePath: "feature.ts",
    lineStart: 3,
    lineEnd: 3,
    contextSnapshot: "l3",
    body: "finding body",
    severity: "risk",
    author: "user",
    status: "open",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// AgentTeamApplicationService 装配用的最小 stub(门禁路径不触达子执行/集成)。
const unusedChildExecution = {
  cancel: async () => {},
  execute: async () => {
    throw new Error("child execution must not run in gate tests");
  },
} as unknown as ChildExecutionService;
const unusedIntegration = {
  integrate: async () => {
    throw new Error("integration must not run in gate tests");
  },
} as unknown as TaskIntegrationService;

// ---- 世界装配 ----

interface World {
  root: string;
  repositoryURL: string;
  db: OctoPunkDatabase;
  repository: SqliteTeamRunRepository;
  gitPort: GitAdapter;
  processPort: StubProcessPort;
  reviewCenter: StubReviewCenterPort;
  service: QualityGateService;
  baselineCommit: string;
  runID: string;
  task: ChildTask;
  runGit: (args: string[]) => string;
}

interface WorldInit {
  prefix: string;
  /** 在任务分支上落一次提交(reviewCenter.test.ts 的直接建分支方式)。 */
  branchFiles?: (repo: string) => void;
  /** 经 GitAdapter.prepareWorkspace 在 task.worktreePath 建真实 worktree(命令类检查用)。 */
  useWorktree?: boolean;
  /** startTeam 前先保存的项目默认门禁。 */
  projectDefault?: GateConfigInput;
  /** 经 AgentTeamApplicationService 启动(启动快照集成)并可携带覆盖。 */
  startViaApp?: boolean;
  gateOverride?: GateConfigInput | null;
  /** repositoryPath 指向不存在的目录(inspect 必须抛错)。 */
  missingRepository?: boolean;
}

const roots: string[] = [];
/** 真实 worktree 落在 Application Support 布局下,afterAll 显式回收。 */
const createdWorktrees: { repo: string; worktreePath: string; runDirectory: string }[] = [];

async function buildWorld(init: WorldInit): Promise<World> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `octopunk-qualitygate-${init.prefix}-`));
  roots.push(root);
  const repositoryURL = path.join(root, "repo");
  fs.mkdirSync(repositoryURL);
  git(repositoryURL, ["init", "-q", "-b", "main"]);
  write(repositoryURL, "feature.ts", FEATURE_BASE);
  write(repositoryURL, "keep.ts", KEEP_BASE);
  git(repositoryURL, ["add", "-A"]);
  git(repositoryURL, ["commit", "-qm", "baseline"]);
  const baselineCommit = git(repositoryURL, ["rev-parse", "HEAD"]).trim();

  const db = OctoPunkDatabase.inMemory();
  const repository = new SqliteTeamRunRepository(db.writer);
  const processPort = new StubProcessPort();
  const reviewCenter = new StubReviewCenterPort();
  const gitPort = new GitAdapter(new LocalProcessAdapter(), GIT, path.join(root, "support"));
  const service = new QualityGateService({ repository, git: gitPort, process: processPort, reviewCenter });

  const startInput = {
    requestID: `${init.prefix}-start`,
    sessionID: `${init.prefix}-session`,
    repositoryPath: init.missingRepository ? path.join(root, "missing-repo") : repositoryURL,
    task: "Quality gate flow",
    baselineCommit,
    targetBranch: "main",
    maxConcurrentTasks: 3,
    maxReviewRounds: 5,
  };
  if (init.projectDefault != null) {
    await service.saveProjectDefault(`${init.prefix}-default`, startInput.repositoryPath, init.projectDefault);
  }

  let runID: string;
  if (init.startViaApp) {
    const appService = new AgentTeamApplicationService({
      repository,
      childExecution: unusedChildExecution,
      integration: unusedIntegration,
      qualityGate: service,
    });
    const status = await appService.startTeam({ ...startInput, gateOverride: init.gateOverride ?? null });
    runID = status.run.id;
  } else {
    const start = await repository.startTeam(startInput);
    runID = start.run.id;
  }

  const task = await repository.delegateTask({
    requestID: `${init.prefix}-delegate`,
    runID,
    title: "Change feature.ts",
    prompt: "Change feature.ts",
    agentKind: "claude_code",
    model: null,
    executionMode: init.useWorktree ? "workspace_write" : "read_only",
    dependencies: [],
  });

  if (init.useWorktree) {
    // 生产布局:worktree 位于 task.worktreePath(delegateTask 计算,Application
    // Support 下),由真实 GitAdapter 创建并检出任务分支。
    await gitPort.prepareWorkspace({
      repositoryURL,
      runID,
      taskID: task.id,
      baselineCommit,
      branchName: task.branchName,
      worktreeURL: task.worktreePath,
    });
    createdWorktrees.push({
      repo: repositoryURL,
      worktreePath: task.worktreePath,
      runDirectory: path.dirname(task.worktreePath),
    });
  } else if (init.branchFiles != null) {
    git(repositoryURL, ["checkout", "-qb", task.branchName, baselineCommit]);
    init.branchFiles(repositoryURL);
    git(repositoryURL, ["add", "-A"]);
    git(repositoryURL, ["commit", "-qm", "task changes"]);
    git(repositoryURL, ["checkout", "-q", "main"]);
  }

  return {
    root,
    repositoryURL,
    db,
    repository,
    gitPort,
    processPort,
    reviewCenter,
    service,
    baselineCommit,
    runID,
    task,
    runGit: (args: string[]) => git(repositoryURL, args),
  };
}

/** 模拟子 Agent 报告,把任务推进到 awaiting_report(acceptTask 的前置状态)。 */
function reportInput(world: World, requestID: string) {
  return {
    requestID,
    runID: world.runID,
    taskID: world.task.id,
    sessionID: "session-1",
    report: "Implemented",
    rawOutput: "done",
    tests: ["vitest 2/2"],
    changedFiles: ["feature.ts"],
    diffSummary: "1 file changed",
    blocker: null,
  };
}

function itemOf(evaluation: { items: { checkKey: string }[] }, checkKey: string) {
  const item = evaluation.items.find((candidate) => candidate.checkKey === checkKey);
  expect(item, `expected gate item ${checkKey}`).toBeDefined();
  return item!;
}

function makeAppService(world: World): AgentTeamApplicationService {
  return new AgentTeamApplicationService({
    repository: world.repository,
    childExecution: unusedChildExecution,
    integration: unusedIntegration,
    qualityGate: world.service,
  });
}

afterAll(() => {
  // 先拆 worktree(git 元数据在临时仓库里),再删 Application Support 布局,
  // 最后删临时根;对可能由本文件新建的空父目录做尽力而为回收。
  for (const created of createdWorktrees) {
    try {
      git(created.repo, ["worktree", "remove", "--force", created.worktreePath]);
    } catch {
      // 临时仓库可能已被删除;目录回收仍会执行。
    }
    fs.rmSync(created.runDirectory, { recursive: true, force: true });
  }
  const supportParents = new Set<string>();
  for (const created of createdWorktrees) {
    supportParents.add(path.dirname(created.runDirectory));
    supportParents.add(path.dirname(path.dirname(created.runDirectory)));
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

// ---- 1. 无配置 = 平凡门禁 ----

describe("QualityGateService 平凡门禁", () => {
  it("无配置:getEffectiveConfig 为 null,evaluate 返回空 items 且 overall=pass", async () => {
    const world = await buildWorld({ prefix: "plain" });
    expect(await world.service.getEffectiveConfig(world.runID)).toBeNull();

    const evaluation = await world.service.evaluate({
      requestID: "plain-eval",
      runID: world.runID,
      taskID: world.task.id,
    });
    expect(evaluation.overall).toBe("pass");
    expect(evaluation.items).toEqual([]);
    expect(evaluation.runID).toBe(world.runID);
    expect(evaluation.taskID).toBe(world.task.id);
  }, 20000);
});

// ---- 2. 状态类判定 ----

describe("QualityGateService 状态类判定", () => {
  it("risk_findings:open risk 超过 maxRiskFindings → fail(锚点+修复建议);阈值内/清零 → pass", async () => {
    const world = await buildWorld({ prefix: "risk" });
    await world.service.saveProjectDefault("risk-config-0", world.repositoryURL, { maxRiskFindings: 0 });
    world.reviewCenter.findings = [
      comment("risk-1", { severity: "risk", filePath: "feature.ts", lineStart: 3 }),
      comment("info-1", { severity: "info", filePath: "keep.ts", lineStart: 5 }),
    ];

    const failed = await world.service.evaluate({
      requestID: "risk-fail",
      runID: world.runID,
      taskID: world.task.id,
    });
    const riskItem = itemOf(failed, "risk_findings");
    expect(failed.overall).toBe("fail");
    expect(riskItem.status).toBe("fail");
    expect(riskItem.detail).toContain("超过阈值 0");
    expect(riskItem.detail).toContain("feature.ts:3");
    expect(riskItem.fixSuggestion).toContain("Review Center");

    // 阈值 1:恰好 1 条 risk 未超 → pass。
    await world.service.saveProjectDefault("risk-config-1", world.repositoryURL, { maxRiskFindings: 1 });
    const boundary = await world.service.evaluate({
      requestID: "risk-boundary",
      runID: world.runID,
      taskID: world.task.id,
    });
    expect(boundary.overall).toBe("pass");
    expect(itemOf(boundary, "risk_findings").status).toBe("pass");

    // 清零 → pass 且明细为 0 条。
    world.reviewCenter.findings = [];
    const cleared = await world.service.evaluate({
      requestID: "risk-clear",
      runID: world.runID,
      taskID: world.task.id,
    });
    expect(cleared.overall).toBe("pass");
    expect(itemOf(cleared, "risk_findings").detail).toContain("未解决 risk 发现 0 条");
  }, 20000);

  it("scope:diffTree 路径越界 → fail 列出越界文件;白名单内 → pass;空白名单 → 不启用该检查", async () => {
    const world = await buildWorld({
      prefix: "scope",
      branchFiles: (repo) => {
        write(repo, "feature.ts", FEATURE_ROUND1);
        write(repo, "keep.ts", KEEP_ROUND1);
      },
    });
    world.reviewCenter.tree = [diffEntry("feature.ts"), diffEntry("keep.ts")];

    await world.service.saveProjectDefault("scope-out", world.repositoryURL, { scopeAllowedPaths: ["src"] });
    const violated = await world.service.evaluate({
      requestID: "scope-fail",
      runID: world.runID,
      taskID: world.task.id,
    });
    const scopeItem = itemOf(violated, "scope");
    expect(violated.overall).toBe("fail");
    expect(scopeItem.status).toBe("fail");
    expect(scopeItem.detail).toContain("越界变更 2 个文件");
    expect(scopeItem.detail).toContain("feature.ts");
    expect(scopeItem.detail).toContain("keep.ts");
    expect(scopeItem.fixSuggestion).toContain("白名单");

    await world.service.saveProjectDefault("scope-in", world.repositoryURL, {
      scopeAllowedPaths: ["feature.ts", "keep.ts"],
    });
    const allowed = await world.service.evaluate({
      requestID: "scope-pass",
      runID: world.runID,
      taskID: world.task.id,
    });
    expect(allowed.overall).toBe("pass");
    expect(itemOf(allowed, "scope").status).toBe("pass");
    expect(itemOf(allowed, "scope").detail).toContain("全部位于白名单前缀内");

    // 空白名单 = 不限制 → 不产出 scope 检查项。
    await world.service.saveProjectDefault("scope-off", world.repositoryURL, { scopeAllowedPaths: [] });
    const disabled = await world.service.evaluate({
      requestID: "scope-off-eval",
      runID: world.runID,
      taskID: world.task.id,
    });
    expect(disabled.overall).toBe("pass");
    expect(disabled.items.map((item) => item.checkKey)).toEqual(["risk_findings"]);
  }, 20000);

  it("todo_clean:新增 Diff 行含 TODO → fail;清理后 → pass;遗留 open 评论同样判 fail", async () => {
    const world = await buildWorld({
      prefix: "todo",
      branchFiles: (repo) => {
        write(repo, "feature.ts", FEATURE_TODO);
      },
    });
    world.reviewCenter.tree = [diffEntry("feature.ts", { additions: 1, deletions: 1 })];
    await world.service.saveProjectDefault("todo-config", world.repositoryURL, { requireTodoClean: true });

    const dirty = await world.service.evaluate({
      requestID: "todo-fail",
      runID: world.runID,
      taskID: world.task.id,
    });
    const todoItem = itemOf(dirty, "todo_clean");
    expect(dirty.overall).toBe("fail");
    expect(todoItem.status).toBe("fail");
    expect(todoItem.detail).toContain("TODO/FIXME 标记 1 处");
    expect(todoItem.detail).toContain("feature.ts:");
    expect(todoItem.fixSuggestion).toContain("TODO/FIXME");

    // 返工:去掉 TODO 行重新提交,Diff 干净 → pass。
    world.runGit(["checkout", "-q", world.task.branchName]);
    write(world.repositoryURL, "feature.ts", FEATURE_BASE);
    world.runGit(["add", "-A"]);
    world.runGit(["commit", "-qm", "round 2 rework"]);
    world.runGit(["checkout", "-q", "main"]);
    const clean = await world.service.evaluate({
      requestID: "todo-pass",
      runID: world.runID,
      taskID: world.task.id,
    });
    expect(clean.overall).toBe("pass");
    expect(itemOf(clean, "todo_clean").status).toBe("pass");
    expect(itemOf(clean, "todo_clean").detail).toContain("无新增 TODO/FIXME 标记");

    // 无 TODO 但遗留 open 评论 → 仍不满足"已知评论清零"。
    world.reviewCenter.findings = [comment("open-1", { severity: "info" })];
    const withComments = await world.service.evaluate({
      requestID: "todo-open-comments",
      runID: world.runID,
      taskID: world.task.id,
    });
    const commentItem = itemOf(withComments, "todo_clean");
    expect(withComments.overall).toBe("fail");
    expect(commentItem.status).toBe("fail");
    expect(commentItem.detail).toContain("open 评论 1 条");
  }, 20000);

  it("todo_clean:Diff 全为二进制 → unknown 且不影响 overall(契约不变量 4)", async () => {
    const world = await buildWorld({
      prefix: "bin",
      branchFiles: (repo) => {
        write(repo, "blob.bin", Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x00, 0x09]));
      },
    });
    world.reviewCenter.tree = [diffEntry("blob.bin", { isBinary: true, additions: 0, deletions: 0 })];
    await world.service.saveProjectDefault("bin-config", world.repositoryURL, { requireTodoClean: true });

    const evaluation = await world.service.evaluate({
      requestID: "bin-eval",
      runID: world.runID,
      taskID: world.task.id,
    });
    const todoItem = itemOf(evaluation, "todo_clean");
    expect(todoItem.status).toBe("unknown");
    expect(todoItem.detail).toContain("无法");
    expect(todoItem.fixSuggestion).toBeNull();
    // unknown 仅呈现:overall 仍 pass。
    expect(evaluation.overall).toBe("pass");
  }, 20000);
});

// ---- 3. Git 类判定 ----

describe("QualityGateService Git 类判定", () => {
  it("target_baseline:基线一致 → pass;目标分支移动/脏工作区 → fail;恢复后 → pass", async () => {
    const world = await buildWorld({ prefix: "baseline" });
    await world.service.saveProjectDefault("baseline-config", world.repositoryURL, {
      requireTargetBaselineSafe: true,
    });

    const evaluate = (requestID: string) =>
      world.service.evaluate({ requestID, runID: world.runID, taskID: world.task.id });

    const safe = await evaluate("baseline-safe");
    expect(itemOf(safe, "target_baseline").status).toBe("pass");
    expect(itemOf(safe, "target_baseline").detail).toContain("安全基线");
    expect(safe.overall).toBe("pass");

    // 目标仓库切到别的分支并推进(head 离开基线且不在目标分支)→ fail。
    world.runGit(["checkout", "-qb", "side-trip"]);
    world.runGit(["commit", "--allow-empty", "-qm", "side trip"]);
    const moved = await evaluate("baseline-moved");
    const movedItem = itemOf(moved, "target_baseline");
    expect(moved.overall).toBe("fail");
    expect(movedItem.status).toBe("fail");
    expect(movedItem.detail).toContain("目标基线不安全");
    expect(movedItem.detail).toContain("side-trip");
    expect(movedItem.fixSuggestion).toContain("基线");

    // 目标分支上的合法推进 + 脏工作区(未提交改动)→ fail。
    world.runGit(["checkout", "-q", "main"]);
    world.runGit(["commit", "--allow-empty", "-qm", "target moved"]);
    write(world.repositoryURL, "dirty.txt", "uncommitted\n");
    const dirty = await evaluate("baseline-dirty");
    expect(itemOf(dirty, "target_baseline").status).toBe("fail");
    expect(itemOf(dirty, "target_baseline").detail).toContain("未提交改动 有");

    // 回到基线并清理工作区 → pass。
    world.runGit(["reset", "-q", "--hard", world.baselineCommit]);
    world.runGit(["clean", "-fdq"]);
    const restored = await evaluate("baseline-restored");
    expect(itemOf(restored, "target_baseline").status).toBe("pass");
    expect(restored.overall).toBe("pass");
  }, 20000);

  it("target_baseline:git.inspect 抛错(目标仓库不可达)→ unknown 不影响 overall", async () => {
    const world = await buildWorld({ prefix: "missing", missingRepository: true });
    await world.service.saveProjectDefault("missing-config", path.join(world.root, "missing-repo"), {
      requireTargetBaselineSafe: true,
    });

    const evaluation = await world.service.evaluate({
      requestID: "missing-eval",
      runID: world.runID,
      taskID: world.task.id,
    });
    const baselineItem = itemOf(evaluation, "target_baseline");
    expect(baselineItem.status).toBe("unknown");
    expect(baselineItem.detail).toContain("无法检查目标仓库状态");
    expect(baselineItem.fixSuggestion).toBeNull();
    expect(evaluation.overall).toBe("pass");
  }, 20000);
});

// ---- 4. 命令类判定 ----

describe("QualityGateService 命令类判定", () => {
  it("退出码 0 → pass 且在任务 worktree 内受控执行;非 0 → fail 含输出尾段(redact)", async () => {
    const world = await buildWorld({ prefix: "cmd", useWorktree: true });
    await world.service.saveProjectDefault("cmd-tests", world.repositoryURL, {
      checks: { tests: { command: "pnpm test", timeoutSeconds: 5 } },
    });

    world.processPort.behavior = exitWith(0, "3 passed\n");
    const passed = await world.service.evaluate({
      requestID: "cmd-pass",
      runID: world.runID,
      taskID: world.task.id,
    });
    expect(passed.overall).toBe("pass");
    expect(itemOf(passed, "tests").status).toBe("pass");
    expect(itemOf(passed, "tests").detail).toContain("pnpm test");
    // 请求形态:/bin/sh -c + worktree 工作目录 + 零环境注入。
    expect(world.processPort.requests).toHaveLength(1);
    expect(world.processPort.requests[0]).toMatchObject({
      executable: "/bin/sh",
      arguments: ["-c", "pnpm test"],
      workingDirectory: world.task.worktreePath,
      environment: {},
    });

    world.processPort.behavior = exitWith(2, "VITE-GATE-STDOUT-TAIL", "VITE-GATE-STDERR-TAIL api_key=supersecret\n");
    const failed = await world.service.evaluate({
      requestID: "cmd-fail",
      runID: world.runID,
      taskID: world.task.id,
    });
    const failedItem = itemOf(failed, "tests");
    expect(failed.overall).toBe("fail");
    expect(failedItem.status).toBe("fail");
    expect(failedItem.detail).toContain("退出码 2");
    expect(failedItem.detail).toContain("VITE-GATE-STDERR-TAIL");
    expect(failedItem.detail).toContain("VITE-GATE-STDOUT-TAIL");
    // 输出尾段经 redact:密钥不明文落库。
    expect(failedItem.detail).toContain("[REDACTED]");
    expect(failedItem.detail).not.toContain("supersecret");
    expect(failedItem.fixSuggestion).toContain("测试");
  }, 30000);

  it("命令超时 → unknown;worktree 缺失 → unknown(均不影响 overall)", async () => {
    const world = await buildWorld({ prefix: "timeout", useWorktree: true });
    await world.service.saveProjectDefault("timeout-lint", world.repositoryURL, {
      checks: { lint: { command: "sleep 30", timeoutSeconds: 1 } },
    });

    // 超时:stub 挂起直至服务侧 AbortSignal 触发 → unknown,overall 不因此 fail。
    world.processPort.behavior = hangUntilAborted;
    const timedOut = await world.service.evaluate({
      requestID: "cmd-timeout",
      runID: world.runID,
      taskID: world.task.id,
    });
    const timeoutItem = itemOf(timedOut, "lint");
    expect(timeoutItem.status).toBe("unknown");
    expect(timeoutItem.detail).toContain("超时");
    expect(timeoutItem.fixSuggestion).toBeNull();
    expect(timedOut.overall).toBe("pass");

    // worktree 缺失:第二个任务从未创建 worktree → 无法执行 → unknown。
    const orphan = await world.repository.delegateTask({
      requestID: "timeout-orphan-delegate",
      runID: world.runID,
      title: "No worktree",
      prompt: "No worktree",
      agentKind: "claude_code",
      model: null,
      executionMode: "workspace_write",
      dependencies: [],
    });
    world.processPort.behavior = exitWith(0);
    const missing = await world.service.evaluate({
      requestID: "cmd-missing-worktree",
      runID: world.runID,
      taskID: orphan.id,
    });
    const missingItem = itemOf(missing, "lint");
    expect(missingItem.status).toBe("unknown");
    expect(missingItem.detail).toContain("worktree 不可用");
    expect(missingItem.detail).toContain(orphan.worktreePath);
    expect(missing.overall).toBe("pass");
    // worktree 探测失败时不应发起进程请求。
    expect(world.processPort.requests).toHaveLength(1); // 仅超时用例发起过一次
  }, 30000);
});

// ---- 5. unknown 不改变 overall ----

describe("QualityGateService unknown 语义(契约不变量 4)", () => {
  it("fail + unknown → overall fail;仅 unknown → overall pass", async () => {
    const world = await buildWorld({ prefix: "mix" });
    await world.service.saveProjectDefault("mix-config", world.repositoryURL, {
      maxRiskFindings: 0,
      requiredReviewers: ["codex"],
    });

    world.reviewCenter.findings = [comment("mix-risk")];
    const mixed = await world.service.evaluate({
      requestID: "mix-fail",
      runID: world.runID,
      taskID: world.task.id,
    });
    expect(itemOf(mixed, "risk_findings").status).toBe("fail");
    expect(itemOf(mixed, "reviewers").status).toBe("unknown");
    expect(mixed.overall).toBe("fail");

    world.reviewCenter.findings = [];
    const onlyUnknown = await world.service.evaluate({
      requestID: "mix-unknown-only",
      runID: world.runID,
      taskID: world.task.id,
    });
    expect(itemOf(onlyUnknown, "risk_findings").status).toBe("pass");
    expect(itemOf(onlyUnknown, "reviewers").status).toBe("unknown");
    expect(onlyUnknown.overall).toBe("pass");
  }, 20000);
});

// ---- 6/7. 豁免重算与 accept 拦截 ----

describe("QualityGateService 豁免与 accept 门禁", () => {
  it("waive:逐项豁免必附理由 → item waived、overall → waived;此后 acceptTask 放行且不重新判定", async () => {
    const world = await buildWorld({ prefix: "waive" });
    await world.repository.submitReport(reportInput(world, "waive-report"));
    await world.service.saveProjectDefault("waive-config", world.repositoryURL, { maxRiskFindings: 0 });
    world.reviewCenter.findings = [comment("waive-risk")];

    const failed = await world.service.evaluate({
      requestID: "waive-eval",
      runID: world.runID,
      taskID: world.task.id,
    });
    expect(failed.overall).toBe("fail");
    const riskItem = itemOf(failed, "risk_findings");

    // 契约不变量 5:豁免必须携带理由。
    await expect(
      world.service.waive({
        requestID: "waive-no-reason",
        evaluationID: failed.id,
        itemID: riskItem.id,
        waivedBy: "user",
        waivedReason: "   ",
      }),
    ).rejects.toThrow(DomainError);

    const waived = await world.service.waive({
      requestID: "waive-item",
      evaluationID: failed.id,
      itemID: riskItem.id,
      waivedBy: "user",
      waivedReason: "已知风险,人工评估接受",
    });
    expect(waived.overall).toBe("waived");
    expect(itemOf(waived, "risk_findings")).toMatchObject({
      status: "waived",
      waivedBy: "user",
      waivedReason: "已知风险,人工评估接受",
    });
    expect(itemOf(waived, "risk_findings").waivedAt).not.toBeNull();
    expect((await world.service.latestEvaluation(world.runID, world.task.id))?.overall).toBe("waived");

    // accept 放行:最近判定为 waived,不再强制重评(重评会生成全新未豁免项)。
    const evaluationCount = () =>
      (
        world.db.writer
          .prepare("SELECT COUNT(*) AS count FROM gate_evaluations WHERE run_id = ? AND task_id = ?")
          .get(world.runID, world.task.id) as { count: number }
      ).count;
    const before = evaluationCount();
    const app = makeAppService(world);
    const accepted = await app.acceptTask({
      requestID: "waive-accept",
      runID: world.runID,
      taskID: world.task.id,
      reviewer: "user",
      verdict: "PASS",
      summary: "accepted after waiver",
      findings: [],
    });
    expect(accepted.status).toBe("accepted");
    expect(evaluationCount()).toBe(before);
  }, 20000);

  it("accept 拦截:未豁免 fail → DomainError 且消息含逐项 checkKey;同 requestID 重放 evaluate 幂等不重复插行", async () => {
    const world = await buildWorld({ prefix: "block" });
    await world.repository.submitReport(reportInput(world, "block-report"));
    await world.service.saveProjectDefault("block-config", world.repositoryURL, { maxRiskFindings: 0 });
    world.reviewCenter.findings = [
      comment("block-risk", { severity: "risk", filePath: "feature.ts", lineStart: 3 }),
    ];

    const app = makeAppService(world);
    const acceptInput = {
      runID: world.runID,
      taskID: world.task.id,
      reviewer: "user",
      verdict: "PASS" as const,
      summary: "accept attempt",
      findings: [],
    };

    // 无历史判定 → 强制判定 → fail → 拒绝,消息含逐项 checkKey 明细。
    const rejection = await app
      .acceptTask({ ...acceptInput, requestID: "block-accept-1" })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DomainError);
    expect(String((rejection as Error).message)).toContain("质量门禁拒绝");
    expect(String((rejection as Error).message)).toContain("risk_findings");
    expect(String((rejection as Error).message)).toContain("feature.ts:3");

    // 再次 accept:读最近一条判定(不重复强制判定)→ 同样拒绝。
    await expect(app.acceptTask({ ...acceptInput, requestID: "block-accept-2" })).rejects.toThrow(
      /risk_findings/,
    );

    // 幂等(契约不变量 2):同 requestID 重放 evaluate 返回缓存判定,不重复插行。
    const evaluations = () =>
      (
        world.db.writer
          .prepare("SELECT COUNT(*) AS count FROM gate_evaluations WHERE run_id = ? AND task_id = ?")
          .get(world.runID, world.task.id) as { count: number }
      ).count;
    const itemsOf = (evaluationID: string) =>
      (
        world.db.writer
          .prepare("SELECT COUNT(*) AS count FROM gate_evaluation_items WHERE evaluation_id = ?")
          .get(evaluationID) as { count: number }
      ).count;

    const first = await world.service.evaluate({
      requestID: "block-replay",
      runID: world.runID,
      taskID: world.task.id,
    });
    const evaluationsAfterFirst = evaluations();
    const itemsAfterFirst = itemsOf(first.id);

    const replay = await world.service.evaluate({
      requestID: "block-replay",
      runID: world.runID,
      taskID: world.task.id,
    });
    expect(replay.id).toBe(first.id);
    expect(replay.overall).toBe(first.overall);
    expect(evaluations()).toBe(evaluationsAfterFirst);
    expect(itemsOf(first.id)).toBe(itemsAfterFirst);

    // 不同 requestID 重跑则生成新判定(幂等键区分)。
    const rerun = await world.service.evaluate({
      requestID: "block-rerun",
      runID: world.runID,
      taskID: world.task.id,
    });
    expect(rerun.id).not.toBe(first.id);
    expect(evaluations()).toBe(evaluationsAfterFirst + 1);
  }, 20000);
});

// ---- 8/9. 配置校验与启动快照 ----

describe("QualityGateService 配置校验与启动快照", () => {
  it("矛盾组合:saveProjectDefault(requireDependenciesAccepted × contest)拒绝;snapshotForRun 合并后矛盾同样拒绝且不落快照", async () => {
    const world = await buildWorld({ prefix: "conflict" });

    await expect(
      world.service.saveProjectDefault("conflict-bad", world.repositoryURL, {
        reviewMode: "contest",
        requireDependenciesAccepted: true,
      }),
    ).rejects.toThrow(DomainError);

    // 各自单独保存合法;再验证合并期拒绝。
    await world.service.saveProjectDefault("conflict-ok", world.repositoryURL, {
      reviewMode: "standard",
      maxRiskFindings: 2,
    });
    await expect(
      world.service.snapshotForRun(world.runID, { reviewMode: "contest", requireDependenciesAccepted: true }),
    ).rejects.toThrow(DomainError);
    // 快照未写入:生效配置回退项目默认。
    expect(await world.service.getEffectiveConfig(world.runID)).toMatchObject({
      reviewMode: "standard",
      maxRiskFindings: 2,
    });
  }, 20000);

  it("startTeam 尽力而为:矛盾 gateOverride 不阻断启动、不落快照(判定期回退项目默认)", async () => {
    const world = await buildWorld({
      prefix: "besteffort",
      projectDefault: { reviewMode: "standard", maxRiskFindings: 2 },
      startViaApp: true,
      gateOverride: { reviewMode: "contest", requireDependenciesAccepted: true },
    });
    // 启动未被矛盾覆盖阻断(快照失败被吞掉),run 可用且无快照。
    expect(await world.repository.getRunGateSnapshot(world.runID)).toBeNull();
    expect(await world.service.getEffectiveConfig(world.runID)).toMatchObject({
      reviewMode: "standard",
      maxRiskFindings: 2,
    });
  }, 20000);

  it("启动快照:startTeam(带 override)后 getEffectiveConfig 返回合并快照;项目默认后续修改不影响已启动 run;evaluate 按快照执行", async () => {
    const world = await buildWorld({
      prefix: "snapshot",
      projectDefault: { reviewMode: "standard", maxRiskFindings: 3 },
      startViaApp: true,
      gateOverride: { maxRiskFindings: 5, requireTodoClean: true },
    });

    const effective = await world.service.getEffectiveConfig(world.runID);
    expect(effective).toMatchObject({ maxRiskFindings: 5, requireTodoClean: true, reviewMode: "standard" });

    // R4 冻结:改项目默认不影响已启动 run 的生效配置。
    await world.service.saveProjectDefault("snapshot-new-default", world.repositoryURL, { maxRiskFindings: 9 });
    expect(await world.service.getEffectiveConfig(world.runID)).toMatchObject({ maxRiskFindings: 5 });

    // evaluate 采用快照(requireTodoClean 来自 override)。
    const evaluation = await world.service.evaluate({
      requestID: "snapshot-eval",
      runID: world.runID,
      taskID: world.task.id,
    });
    expect(evaluation.items.map((item) => item.checkKey)).toContain("todo_clean");
    expect(evaluation.overall).toBe("pass");
  }, 20000);
});
