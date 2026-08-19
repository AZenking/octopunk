// T024: ReviewModeService 跨模型审查模式测试(specs/002-v04-review-center-gates
// US3 / research R8)。组合方式照 tests/qualityGate.test.ts 与
// tests/reviewCenter.test.ts:真实 SqliteTeamRunRepository(OctoPunkDatabase
// .inMemory)承担全部状态与幂等缓存,造数走 startTeam/delegateTask/
// markTaskRunning/submitReport 仓储直写;teamService/gate/reviewCenter 用 stub
// 端口(teamService.stub delegateTask 直接透传真实 repository.delegateTask)。
// 派发与提示词路径不触达文件系统(diff/findings 来自 stub reviewCenter),
// 无需临时 git 仓库,也不产生 /tmp 残留。

import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { OctoPunkDatabase } from "../electron/data/database";
import { SqliteTeamRunRepository } from "../electron/data/repository";
import { DomainError } from "../electron/domain/models";
import type { ChildAgentKind, ChildTask } from "../electron/domain/models";
import {
  ReviewModeService,
  parseReviewVerdict,
  reviewDispatchPlans,
} from "../electron/application/reviewModeService";
import type {
  ReviewModeGatePort,
  ReviewModeReviewCenterPort,
  ReviewModeTeamPort,
} from "../electron/application/reviewModeService";
import type { DelegateTaskInput } from "../electron/domain/repositoryPort";
import type { GateConfigInput } from "../electron/domain/policy";
import type { DiffTreeEntryDTO, ReviewCommentDTO } from "../shared/dtos";

// ---- stub 端口 ----

/** 可控 gate 端口:config 决定 mode 缺省时的 effectiveReviewMode。 */
class StubGatePort implements ReviewModeGatePort {
  config: GateConfigInput | null = null;

  async getEffectiveConfig(): Promise<GateConfigInput | null> {
    return this.config;
  }
}

/** 可控 reviewCenter 端口:返回构造的 diff 树与未解决发现。 */
class StubReviewCenterPort implements ReviewModeReviewCenterPort {
  tree: DiffTreeEntryDTO[] = [];
  findings: ReviewCommentDTO[] = [];

  async getDiffTree(): Promise<DiffTreeEntryDTO[]> {
    return this.tree.map((entry) => ({ ...entry }));
  }

  async unresolvedFindings(): Promise<ReviewCommentDTO[]> {
    return this.findings.map((finding) => ({ ...finding }));
  }
}

/** 记录派发请求并透传真实仓储(delegateTask 幂等/落库由仓储承载)。 */
class RecordingTeamPort implements ReviewModeTeamPort {
  readonly inputs: DelegateTaskInput[] = [];

  constructor(private readonly repository: SqliteTeamRunRepository) {}

  async delegateTask(input: DelegateTaskInput): Promise<{ id: string }> {
    this.inputs.push(input);
    return await this.repository.delegateTask(input);
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
    body: "risky inline change",
    severity: "risk",
    author: "user",
    status: "open",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// ---- 世界装配 ----

interface World {
  prefix: string;
  runID: string;
  repository: SqliteTeamRunRepository;
  service: ReviewModeService;
  team: RecordingTeamPort;
  gate: StubGatePort;
  reviewCenter: StubReviewCenterPort;
  implementer: ChildTask;
  taskID: string;
}

async function buildWorld(prefix: string, implementerKind: ChildAgentKind = "claude_code"): Promise<World> {
  const db = OctoPunkDatabase.inMemory();
  const repository = new SqliteTeamRunRepository(db.writer);
  const gate = new StubGatePort();
  const reviewCenter = new StubReviewCenterPort();
  const team = new RecordingTeamPort(repository);
  const service = new ReviewModeService({ repository, teamService: team, gate, reviewCenter });

  const start = await repository.startTeam({
    requestID: `${prefix}-start`,
    sessionID: `${prefix}-session`,
    // 派发/收集路径端口全为 stub,仓储仅存档路径,不触达文件系统。
    repositoryPath: path.join(os.tmpdir(), `octopunk-reviewmode-${prefix}-unused`),
    task: "Review mode flow",
    baselineCommit: "baseline-commit-placeholder",
    targetBranch: "main",
    maxConcurrentTasks: 3,
    maxReviewRounds: 5,
  });
  const implementer = await repository.delegateTask({
    requestID: `${prefix}-delegate`,
    runID: start.run.id,
    title: "Change feature.ts",
    prompt: "Change feature.ts",
    agentKind: implementerKind,
    model: null,
    executionMode: "workspace_write",
    dependencies: [],
  });

  const world: World = {
    prefix,
    runID: start.run.id,
    repository,
    service,
    team,
    gate,
    reviewCenter,
    implementer,
    taskID: implementer.id,
  };
  return world;
}

/** 模拟审查子 Agent 报告(仓储直写),任务进入 awaiting_report。 */
function reportFor(world: World, requestID: string, taskID: string, report: string) {
  return {
    requestID,
    runID: world.runID,
    taskID,
    sessionID: "session-1",
    report,
    rawOutput: "done",
    tests: [],
    changedFiles: [],
    diffSummary: null,
    blocker: null,
  };
}

async function tasksOf(world: World): Promise<ChildTask[]> {
  return (await world.repository.snapshot(world.runID)).tasks;
}

async function taskByID(world: World, id: string): Promise<ChildTask> {
  const task = (await tasksOf(world)).find((candidate) => candidate.id === id);
  if (task == null) throw new Error(`task ${id} not found`);
  return task;
}

// ---- 1. 纯函数 parseReviewVerdict ----

describe("parseReviewVerdict 纯函数", () => {
  it("标准行与带装饰行(加粗/列表/引用/英文关键字)都能解析", () => {
    expect(parseReviewVerdict("结论: PASS")?.verdict).toBe("PASS");
    expect(parseReviewVerdict("审查完成。\n**结论:PASS**")?.verdict).toBe("PASS");
    expect(parseReviewVerdict("- 结论: REWORK")?.verdict).toBe("REWORK");
    expect(parseReviewVerdict("> 结论: BLOCKED")?.verdict).toBe("BLOCKED");
    expect(parseReviewVerdict("Conclusion: pass")?.verdict).toBe("PASS");
    // line 返回原行(trim 后),供分歧证据摘录引用。
    expect(parseReviewVerdict("- 结论: REWORK")?.line).toBe("- 结论: REWORK");
  });

  it("多处结论行取最后一处;关键字行无结论词不覆盖既有命中", () => {
    const report = "结论: PASS\n发现:\n- 文件: a.ts | 行: 1 | 证据: x\n结论: BLOCKED";
    expect(parseReviewVerdict(report)?.verdict).toBe("BLOCKED");
    expect(parseReviewVerdict(report)?.line).toBe("结论: BLOCKED");

    const withNoise = "结论: REWORK\n结论待定,详见附录\nverdict: PASS";
    expect(parseReviewVerdict(withNoise)?.verdict).toBe("PASS");
  });

  it("裸行回退:整行剥掉 Markdown/列表装饰后恰为结论词,同样取最后一处", () => {
    expect(parseReviewVerdict("总体没问题。\nPASS")?.verdict).toBe("PASS");
    expect(parseReviewVerdict("**REWORK**")?.verdict).toBe("REWORK");
    expect(parseReviewVerdict("- blocked")?.verdict).toBe("BLOCKED");
    expect(parseReviewVerdict("PASS\nREWORK")?.verdict).toBe("REWORK");
  });

  it("无法解析(null/空白/无结论词/仅关键字无结论词/词嵌在句中)→ null", () => {
    expect(parseReviewVerdict(null)).toBeNull();
    expect(parseReviewVerdict("")).toBeNull();
    expect(parseReviewVerdict("   \n  ")).toBeNull();
    expect(parseReviewVerdict("看起来一切正常,建议合入。")).toBeNull();
    expect(parseReviewVerdict("结论正在整理中,稍后补充。")).toBeNull();
    expect(parseReviewVerdict("最后再说一句 passed 好像也不算")).toBeNull();
  });
});

// ---- 2. 纯函数 reviewDispatchPlans(六模式派发计划) ----

describe("reviewDispatchPlans 六模式派发计划", () => {
  it("cross_model:审查者 kind 与实现者相反(claude_code→codex、codex/pi→claude_code)", () => {
    const fromClaude = reviewDispatchPlans({ mode: "cross_model", implementerKind: "claude_code", contestModels: [] });
    expect(fromClaude).toHaveLength(1);
    expect(fromClaude[0].agentKind).toBe("codex");
    expect(fromClaude[0].model).toBeNull();

    expect(reviewDispatchPlans({ mode: "cross_model", implementerKind: "codex", contestModels: [] })[0].agentKind).toBe("claude_code");
    expect(reviewDispatchPlans({ mode: "cross_model", implementerKind: "pi", contestModels: [] })[0].agentKind).toBe("claude_code");
    expect(fromClaude[0].role).toContain("对向互查");
  });

  it("dual_readonly:claude_code 与 codex 各一,独立调查", () => {
    const plans = reviewDispatchPlans({ mode: "dual_readonly", implementerKind: "codex", contestModels: [] });
    expect(plans.map((plan) => plan.agentKind)).toEqual(["claude_code", "codex"]);
    expect(plans.map((plan) => plan.model)).toEqual([null, null]);
    expect(plans.every((plan) => plan.role.includes("独立调查"))).toBe(true);
    expect(plans.every((plan) => plan.note == null)).toBe(true);
  });

  it("role_based:三个只读任务,角色轮转 claude_code/codex/pi", () => {
    const plans = reviewDispatchPlans({ mode: "role_based", implementerKind: "claude_code", contestModels: [] });
    expect(plans.map((plan) => plan.agentKind)).toEqual(["claude_code", "codex", "pi"]);
    expect(plans.map((plan) => plan.role)).toEqual(["安全审查", "架构审查", "测试审查"]);
  });

  it("arbitration:两位 reviewer(claude_code + codex),提示词要求独立仲裁结论", () => {
    const plans = reviewDispatchPlans({ mode: "arbitration", implementerKind: "pi", contestModels: [] });
    expect(plans.map((plan) => plan.agentKind)).toEqual(["claude_code", "codex"]);
    expect(plans.every((plan) => plan.roleInstruction.includes("仲裁"))).toBe(true);
  });

  it("contest:≥2 互异 model → 同 kind 双任务各带 model", () => {
    const plans = reviewDispatchPlans({ mode: "contest", implementerKind: "codex", contestModels: ["glm-4.7", "glm-5"] });
    expect(plans.map((plan) => plan.agentKind)).toEqual(["codex", "codex"]);
    expect(plans.map((plan) => plan.model)).toEqual(["glm-4.7", "glm-5"]);
    expect(plans.every((plan) => plan.role.includes("竞赛评审"))).toBe(true);
  });

  it("contest:不足 2 互异 model(空/单个/重复)→ 退化 dual_readonly 且注明", () => {
    for (const contestModels of [[], ["only-one"], ["dup", "dup ", "  "]]) {
      const plans = reviewDispatchPlans({ mode: "contest", implementerKind: "pi", contestModels });
      expect(plans.map((plan) => plan.agentKind)).toEqual(["claude_code", "codex"]);
      expect(plans.every((plan) => plan.role.includes("竞赛·退化双只读"))).toBe(true);
      expect(plans.every((plan) => plan.note?.includes("退化为双只读"))).toBe(true);
    }
  });

  it("standard:空计划", () => {
    expect(reviewDispatchPlans({ mode: "standard", implementerKind: "claude_code", contestModels: [] })).toEqual([]);
  });
});

// ---- 3. dispatchReview:派发、幂等与提示词 ----

describe("dispatchReview 六模式派发", () => {
  it("cross_model:按实现者 kind 派单个对向审查任务(claude_code/codex/pi 三向)", async () => {
    const world = await buildWorld("dispatch-cross", "claude_code");
    const claudeReview = await world.service.dispatchReview({ runID: world.runID, taskID: world.taskID, mode: "cross_model" });
    expect(claudeReview.mode).toBe("cross_model");
    expect(claudeReview.reviewTaskIDs).toHaveLength(1);
    expect((await taskByID(world, claudeReview.reviewTaskIDs[0])).agentKind).toBe("codex");

    const codexImplementer = await world.repository.delegateTask({
      requestID: "dispatch-cross-delegate-codex",
      runID: world.runID,
      title: "Change keep.ts",
      prompt: "Change keep.ts",
      agentKind: "codex",
      model: null,
      executionMode: "workspace_write",
      dependencies: [],
    });
    const codexReview = await world.service.dispatchReview({ runID: world.runID, taskID: codexImplementer.id, mode: "cross_model" });
    expect((await taskByID(world, codexReview.reviewTaskIDs[0])).agentKind).toBe("claude_code");

    const piImplementer = await world.repository.delegateTask({
      requestID: "dispatch-cross-delegate-pi",
      runID: world.runID,
      title: "Change other.ts",
      prompt: "Change other.ts",
      agentKind: "pi",
      model: null,
      executionMode: "workspace_write",
      dependencies: [],
    });
    const piReview = await world.service.dispatchReview({ runID: world.runID, taskID: piImplementer.id, mode: "cross_model" });
    expect((await taskByID(world, piReview.reviewTaskIDs[0])).agentKind).toBe("claude_code");
  }, 20000);

  it("dual_readonly/role_based/arbitration:任务数与 kind/角色轮转正确", async () => {
    const dual = await buildWorld("dispatch-dual");
    const dualReview = await dual.service.dispatchReview({ runID: dual.runID, taskID: dual.taskID, mode: "dual_readonly" });
    expect(dualReview.reviewTaskIDs).toHaveLength(2);
    expect((await tasksOf(dual)).filter((task) => dualReview.reviewTaskIDs.includes(task.id)).map((task) => task.agentKind)).toEqual(["claude_code", "codex"]);

    const roleBased = await buildWorld("dispatch-role");
    const roleReview = await roleBased.service.dispatchReview({ runID: roleBased.runID, taskID: roleBased.taskID, mode: "role_based" });
    expect(roleReview.reviewTaskIDs).toHaveLength(3);
    const roleTasks = (await tasksOf(roleBased)).filter((task) => roleReview.reviewTaskIDs.includes(task.id));
    expect(roleTasks.map((task) => task.agentKind)).toEqual(["claude_code", "codex", "pi"]);
    // 标题进入角色括注:[审查] <原标题> (<角色>)。
    expect(roleTasks.map((task) => task.title)).toEqual([
      "[审查] Change feature.ts (安全审查)",
      "[审查] Change feature.ts (架构审查)",
      "[审查] Change feature.ts (测试审查)",
    ]);

    const arbitration = await buildWorld("dispatch-arb");
    const arbReview = await arbitration.service.dispatchReview({ runID: arbitration.runID, taskID: arbitration.taskID, mode: "arbitration" });
    expect(arbReview.reviewTaskIDs).toHaveLength(2);
    const arbTasks = (await tasksOf(arbitration)).filter((task) => arbReview.reviewTaskIDs.includes(task.id));
    expect(arbTasks.map((task) => task.agentKind)).toEqual(["claude_code", "codex"]);
    expect(arbTasks.every((task) => task.title.startsWith("[审查] Change feature.ts (仲裁·"))).toBe(true);
    expect(arbTasks.every((task) => task.executionMode === "read_only")).toBe(true);
  }, 20000);

  it("contest:双互异 model → 2 同 kind 各带 model;不足 → 退化 dual_readonly 且标题注明", async () => {
    const contest = await buildWorld("dispatch-contest", "codex");
    const full = await contest.service.dispatchReview({
      runID: contest.runID,
      taskID: contest.taskID,
      mode: "contest",
      contestModels: ["glm-4.7", "glm-5"],
    });
    expect(full.reviewTaskIDs).toHaveLength(2);
    const fullTasks = (await tasksOf(contest)).filter((task) => full.reviewTaskIDs.includes(task.id));
    expect(fullTasks.map((task) => task.agentKind)).toEqual(["codex", "codex"]);
    expect(fullTasks.map((task) => task.model)).toEqual(["glm-4.7", "glm-5"]);
    expect(fullTasks.every((task) => task.title.includes("竞赛评审·"))).toBe(true);

    const degraded = await buildWorld("dispatch-contest-degraded", "codex");
    const degradedReview = await degraded.service.dispatchReview({
      runID: degraded.runID,
      taskID: degraded.taskID,
      mode: "contest",
      contestModels: ["glm-4.7"],
    });
    expect(degradedReview.reviewTaskIDs).toHaveLength(2);
    const degradedTasks = (await tasksOf(degraded)).filter((task) => degradedReview.reviewTaskIDs.includes(task.id));
    expect(degradedTasks.map((task) => task.agentKind)).toEqual(["claude_code", "codex"]);
    expect(degradedTasks.every((task) => task.title.includes("竞赛·退化双只读"))).toBe(true);
  }, 20000);

  it("standard:不派发返回空;mode 缺省时读 gate 生效配置,无配置回退 standard", async () => {
    const world = await buildWorld("dispatch-standard");
    const before = (await tasksOf(world)).length;
    const result = await world.service.dispatchReview({ runID: world.runID, taskID: world.taskID, mode: "standard" });
    expect(result).toEqual({ reviewTaskIDs: [], mode: "standard" });
    expect(await tasksOf(world)).toHaveLength(before);

    // 缺省 mode:gate 配置 arbitration → 按 arbitration 派发。
    world.gate.config = { reviewMode: "arbitration" };
    const viaGate = await world.service.dispatchReview({ runID: world.runID, taskID: world.taskID });
    expect(viaGate.mode).toBe("arbitration");
    expect(viaGate.reviewTaskIDs).toHaveLength(2);

    // 另一个被审任务 + gate 无配置 → 回退 standard,不派发。
    const second = await world.repository.delegateTask({
      requestID: "dispatch-standard-delegate-2",
      runID: world.runID,
      title: "Change keep.ts",
      prompt: "Change keep.ts",
      agentKind: "claude_code",
      model: null,
      executionMode: "workspace_write",
      dependencies: [],
    });
    world.gate.config = null;
    const fallback = await world.service.dispatchReview({ runID: world.runID, taskID: second.id });
    expect(fallback).toEqual({ reviewTaskIDs: [], mode: "standard" });
  }, 20000);

  it("幂等:同参数重放返回相同 taskIDs(requestID 派生缓存),不新增任务", async () => {
    const world = await buildWorld("dispatch-idempotent");
    const first = await world.service.dispatchReview({ runID: world.runID, taskID: world.taskID, mode: "arbitration" });
    const taskCount = (await tasksOf(world)).length;
    const replay = await world.service.dispatchReview({ runID: world.runID, taskID: world.taskID, mode: "arbitration" });
    expect(replay.reviewTaskIDs).toEqual(first.reviewTaskIDs);
    expect(replay.mode).toBe("arbitration");
    expect(await tasksOf(world)).toHaveLength(taskCount);
    // 透传层收到两次请求,但仓储按 requestID(`review:<mode>:<taskID>:<i>`)命中缓存。
    expect(world.team.inputs.map((input) => input.requestID)).toEqual([
      `review:arbitration:${world.taskID}:0`,
      `review:arbitration:${world.taskID}:1`,
      `review:arbitration:${world.taskID}:0`,
      `review:arbitration:${world.taskID}:1`,
    ]);
  }, 20000);
});

describe("dispatchReview 审查提示词内容", () => {
  it("prompt 含 [OctoPunk-Review 标记、被审任务标题、结论输出格式,并注入报告摘录与 diff/未解决发现", async () => {
    const world = await buildWorld("prompt");
    await world.repository.submitReport(
      reportFor(world, "prompt-report", world.taskID, "Implemented the cache warmer with guard rails and regression tests."),
    );
    world.reviewCenter.tree = [diffEntry("feature.ts"), diffEntry("keep.ts")];
    world.reviewCenter.findings = [comment("finding-1", { severity: "risk", filePath: "feature.ts", lineStart: 3, body: "risky inline change" })];

    const dispatch = await world.service.dispatchReview({ runID: world.runID, taskID: world.taskID, mode: "arbitration" });
    expect(dispatch.reviewTaskIDs).toHaveLength(2);
    expect(world.team.inputs[0].executionMode).toBe("read_only");
    expect(world.team.inputs[0].dependencies).toEqual([]);

    const prompt = world.team.inputs[0].prompt;
    // 机器可读定位标记(latestReviewTasks 识别依据)+ 模式。
    expect(prompt.startsWith(`[OctoPunk-Review run=${world.runID} task=${world.taskID}`)).toBe(true);
    expect(prompt).toContain("mode=arbitration");
    // 被审任务标题。
    expect(prompt).toContain("- 标题:Change feature.ts");
    // 结论输出格式要求(机器解析依据)。
    expect(prompt).toContain("结论: PASS");
    expect(prompt).toContain("三选一:PASS / REWORK / BLOCKED");
    // 经 stub 端口注入的报告摘录与 diff 清单、未解决发现。
    expect(prompt).toContain("Implemented the cache warmer with guard rails and regression tests.");
    expect(prompt).toContain("- feature.ts (modified, +1/-0)");
    expect(prompt).toContain("- keep.ts (modified, +1/-0)");
    expect(prompt).toContain("- [risk] feature.ts:3 — risky inline change");
  }, 20000);
});

// ---- 4. collectArbitration:聚合与落库 ----

describe("collectArbitration 聚合", () => {
  it("全一致 PASS:consensus 含合并要点、autoPassed=true;getArbitration 可读回;重复收集追加记录", async () => {
    const world = await buildWorld("collect-pass");
    const { reviewTaskIDs } = await world.service.dispatchReview({ runID: world.runID, taskID: world.taskID, mode: "arbitration" });
    await world.repository.submitReport(
      reportFor(world, "collect-pass-0", reviewTaskIDs[0], "结论: PASS\n发现:\n- 文件: feature.ts | 行: 3 | 严重度: low | 证据: l3 mismatch | 建议: rename later"),
    );
    await world.repository.submitReport(
      reportFor(world, "collect-pass-1", reviewTaskIDs[1], "结论: PASS\n发现:\n- 文件: keep.ts | 行: 2 | 严重度: info | 证据: k2 renamed | 建议: align naming"),
    );

    const arbitration = await world.service.collectArbitration({ runID: world.runID, taskID: world.taskID, reviewTaskIDs });
    expect(arbitration.runID).toBe(world.runID);
    expect(arbitration.taskID).toBe(world.taskID);
    expect(arbitration.autoPassed).toBe(true);
    expect(arbitration.disagreements).toEqual([]);
    expect(arbitration.toVerify).toEqual([]);
    expect(arbitration.consensus).toContain("审查结论一致:PASS(2/2");
    expect(arbitration.consensus).toContain("要点合并:");
    expect(arbitration.consensus).toContain("文件: feature.ts");
    expect(arbitration.consensus).toContain("文件: keep.ts");

    // 落库后可读回(getArbitration 取最新一条);重复收集追加新仲裁记录。
    expect(await world.service.getArbitration(world.runID, world.taskID)).toMatchObject({ id: arbitration.id, autoPassed: true });
    const second = await world.service.collectArbitration({ runID: world.runID, taskID: world.taskID, reviewTaskIDs });
    expect(second.id).not.toBe(arbitration.id);
    expect(second.autoPassed).toBe(true);
    expect((await world.service.getArbitration(world.runID, world.taskID))?.id).toBe(second.id);
  }, 20000);

  it("一 PASS 一 REWORK:disagreements 两条含 verdict/evidence、consensus 写分歧、autoPassed=false", async () => {
    const world = await buildWorld("collect-disagree");
    const { reviewTaskIDs } = await world.service.dispatchReview({ runID: world.runID, taskID: world.taskID, mode: "arbitration" });
    await world.repository.submitReport(
      reportFor(world, "collect-disagree-0", reviewTaskIDs[0], "结论: PASS\n发现:\n- 文件: keep.ts | 行: 2 | 严重度: info | 证据: k2 renamed | 建议: align naming"),
    );
    await world.repository.submitReport(
      reportFor(world, "collect-disagree-1", reviewTaskIDs[1], "结论: REWORK\n发现:\n- 文件: feature.ts | 行: 3 | 严重度: high | 证据: broken contract | 建议: restore signature"),
    );

    const arbitration = await world.service.collectArbitration({ runID: world.runID, taskID: world.taskID, reviewTaskIDs });
    expect(arbitration.autoPassed).toBe(false);
    expect(arbitration.toVerify).toEqual([]);
    expect(arbitration.disagreements).toHaveLength(2);
    expect(arbitration.disagreements.map((entry) => entry.verdict).sort()).toEqual(["PASS", "REWORK"]);
    expect(new Set(arbitration.disagreements.map((entry) => entry.reviewer))).toEqual(new Set(["claude_code", "codex"]));
    for (const entry of arbitration.disagreements) {
      expect(entry.evidence).toContain(`结论: ${entry.verdict}`);
      expect(entry.evidence).toContain("首条发现:");
    }
    expect(arbitration.consensus).toContain("审查结论存在分歧");
    expect(arbitration.consensus).toContain("投票分布:PASS×1、REWORK×1");
  }, 20000);

  it("一个未完成(状态 running)→ toVerify 记未完成、autoPassed=false、不满足全体一致", async () => {
    const world = await buildWorld("collect-unfinished");
    const { reviewTaskIDs } = await world.service.dispatchReview({ runID: world.runID, taskID: world.taskID, mode: "arbitration" });
    await world.repository.submitReport(
      reportFor(world, "collect-unfinished-0", reviewTaskIDs[0], "结论: PASS\n发现:\n- 文件: feature.ts | 行: 3 | 严重度: low | 证据: l3 mismatch | 建议: rename later"),
    );
    await world.repository.markTaskRunning({
      requestID: "collect-unfinished-run",
      runID: world.runID,
      taskID: reviewTaskIDs[1],
      sessionID: "session-1",
    });

    // 服务轮询常量:5s/次、上限 10min(未导出;fake timers 快进到超时返回)。
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    let arbitration;
    try {
      const pending = world.service.collectArbitration({ runID: world.runID, taskID: world.taskID, reviewTaskIDs });
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 3 * 5_000);
      arbitration = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(arbitration.autoPassed).toBe(false);
    expect(arbitration.disagreements).toEqual([]);
    expect(arbitration.toVerify).toHaveLength(1);
    expect(arbitration.toVerify[0].claim).toContain("审查任务未完成");
    expect(arbitration.toVerify[0].claim).toContain("(当前状态 running)");
    expect(arbitration.toVerify[0].howToVerify.length).toBeGreaterThan(0);
    expect(arbitration.consensus).toContain("已解析的 1 份审查结论一致:PASS");
    expect(arbitration.consensus).toContain("不满足全体一致,不自动通过");
  }, 30000);

  it("结论行乱写 → toVerify 记「结论无法解析」、autoPassed=false、无有效审查结论", async () => {
    const world = await buildWorld("collect-garbled");
    const { reviewTaskIDs } = await world.service.dispatchReview({ runID: world.runID, taskID: world.taskID, mode: "arbitration" });
    await world.repository.submitReport(reportFor(world, "collect-garbled-0", reviewTaskIDs[0], "Looks good overall; recommend merging."));
    await world.repository.submitReport(reportFor(world, "collect-garbled-1", reviewTaskIDs[1], "整体可接受,没有大的问题。"));

    const arbitration = await world.service.collectArbitration({ runID: world.runID, taskID: world.taskID, reviewTaskIDs });
    expect(arbitration.autoPassed).toBe(false);
    expect(arbitration.disagreements).toEqual([]);
    expect(arbitration.toVerify).toHaveLength(2);
    for (const entry of arbitration.toVerify) {
      expect(entry.claim).toContain("结论无法解析");
      expect(entry.claim).toContain("报告摘录:");
    }
    expect(arbitration.consensus).toContain("无有效审查结论");
    expect(arbitration.consensus).toContain("2 份无法解析");
  }, 20000);

  it("空 reviewTaskIDs → 拒绝(standard 模式不派发,无仲裁可收集)", async () => {
    const world = await buildWorld("collect-empty");
    await expect(
      world.service.collectArbitration({ runID: world.runID, taskID: world.taskID, reviewTaskIDs: [] }),
    ).rejects.toThrow(DomainError);
    expect(await world.service.getArbitration(world.runID, world.taskID)).toBeNull();
  }, 20000);
});

// ---- 5. latestReviewTasks ----

describe("latestReviewTasks / getArbitration 读取", () => {
  it("识别本任务的 [审查] 只读子任务(prompt 标记),排除无标记的同标题任务;未收集前仲裁为 null", async () => {
    const world = await buildWorld("latest");
    expect(await world.service.getArbitration(world.runID, world.taskID)).toBeNull();

    const dispatch = await world.service.dispatchReview({ runID: world.runID, taskID: world.taskID, mode: "role_based" });
    expect(dispatch.reviewTaskIDs).toHaveLength(3);
    // 干扰项:手工委派的只读任务,标题也带 [审查],但 prompt 无 [OctoPunk-Review 标记。
    const imposter = await world.repository.delegateTask({
      requestID: "latest-delegate-imposter",
      runID: world.runID,
      title: "[审查] Change feature.ts (手工)",
      prompt: "Manual review without the OctoPunk-Review marker.",
      agentKind: "claude_code",
      model: null,
      executionMode: "read_only",
      dependencies: [],
    });

    const latest = await world.service.latestReviewTasks(world.runID, world.taskID);
    expect(latest.map((task) => task.id).sort()).toEqual([...dispatch.reviewTaskIDs].sort());
    expect(latest.map((task) => task.id)).not.toContain(imposter.id);
    expect(latest.every((task) => task.executionMode === "read_only")).toBe(true);
    expect(latest.every((task) => task.title.startsWith("[审查] Change feature.ts"))).toBe(true);
    // role_based 三任务按派发顺序(createdAt)返回。
    expect(latest.map((task) => task.title)).toEqual([
      "[审查] Change feature.ts (安全审查)",
      "[审查] Change feature.ts (架构审查)",
      "[审查] Change feature.ts (测试审查)",
    ]);
  }, 20000);
});
