// 跨模型审查模式编排服务(specs/002-v04-review-center-gates User Story 3 / research R8)。
// 用例编排层:六种审查模式(standard/cross_model/dual_readonly/contest/role_based/
// arbitration)的审查任务统一建模为「只读子任务」经既有 delegateTask 通道派发
// (R8:审查者与执行者走同一受控执行面——沙箱/脱敏/日志,不建平行状态机);
// 仲裁结果(共识/分歧/待验证)经仓储 recordArbitration 落库,分歧一律不自动
// 通过(FR-013),交人工/主 Agent 决断。纯编排:执行经 teamService 端口、
// 状态与结论判定经仓储快照;GUI 与 MCP 共享本服务(宪法原则二)。

import {
  DomainError,
  agentKindDisplayName,
  taskStatusIsTerminal,
} from "../domain/models";
import type {
  Arbitration,
  ArbitrationDisagreement,
  ArbitrationToVerify,
  ChildAgentKind,
  ChildTask,
  GateReviewMode,
  ReviewVerdict,
  RunSummary,
  TeamRun,
  TeamRunSnapshot,
} from "../domain/models";
import type { DelegateTaskInput } from "../domain/repositoryPort";
import type { GateConfigInput } from "../domain/policy";
import type { DiffTreeEntryDTO, ReviewCommentDTO } from "../../shared/dtos";
import { ChildAgentDiagnostics, type GitDiffSide } from "./ports";

/** 审查提示词首行标记:latestReviewTasks 以此前缀识别审查子任务(见该方法注释)。 */
const REVIEW_PROMPT_TAG = "[OctoPunk-Review";

/** specs/002 FR-013 / 本任务约束:报告摘录经 redact 后 ≤2KiB。 */
const REPORT_EXCERPT_LIMIT = 2 * 1024;
/** 提示词内 Diff 文件清单与未解决发现条数上限(防超大 Diff 撑爆提示词)。 */
const DIFF_LIST_LIMIT = 50;
const OPEN_FINDINGS_LIMIT = 20;
/** 仲裁收集轮询:每 5s 查一次仓储快照,上限 10 分钟。 */
const COLLECT_POLL_INTERVAL_MS = 5_000;
const COLLECT_TIMEOUT_MS = 10 * 60 * 1000;

function reviewPromptPrefix(runID: string, taskID: string): string {
  return `${REVIEW_PROMPT_TAG} run=${runID} task=${taskID}`;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 仓储结构性端口(TeamRunRepository 的子集):快照/轻量摘要读取与仲裁落库。
 * 判定一律以仓储为事实源,本服务不持有任何运行态。
 */
export interface ReviewModeRepositoryPort {
  snapshot(runID: string): Promise<TeamRunSnapshot>;
  runSummary(runID: string): Promise<RunSummary>;
  recordArbitration(input: {
    runID: string;
    taskID: string;
    consensus: string;
    disagreements: ArbitrationDisagreement[];
    toVerify: ArbitrationToVerify[];
    autoPassed: boolean;
  }): Promise<Arbitration>;
  getArbitration(runID: string, taskID: string): Promise<Arbitration | null>;
}

/**
 * 团队服务结构性端口(AgentTeamApplicationService 结构性满足):审查子任务的
 * 派发(含启动/事件监控/节奏控制)全部经既有 delegateTask 通道执行;返回值
 * 只要求携带任务 id。snapshot/runSummary 为可选成员——AgentTeamApplicationService
 * 未公开二者,读取路径统一走 repository 端口,端口成员仅供组合根注入富端口时使用。
 */
export interface ReviewModeTeamPort {
  delegateTask(input: DelegateTaskInput): Promise<{ id: string }>;
  snapshot?(runID: string): Promise<TeamRunSnapshot>;
  runSummary?(runID: string): Promise<RunSummary>;
}

/** 门禁服务结构性端口(QualityGateService 满足):读取 run 生效配置的 reviewMode。 */
export interface ReviewModeGatePort {
  getEffectiveConfig(runID: string): Promise<GateConfigInput | null>;
}

/** 审查中心结构性端口(ReviewCenterService 满足)。 */
export interface ReviewModeReviewCenterPort {
  getDiffTree(runID: string, taskID: string, side: GitDiffSide): Promise<DiffTreeEntryDTO[]>;
  unresolvedFindings(runID: string, taskID: string): Promise<ReviewCommentDTO[]>;
}

// ---------------------------------------------------------------------------
// 六模式派发计划(纯函数,便于独立测试)
// ---------------------------------------------------------------------------

interface ReviewDispatchPlan {
  agentKind: ChildAgentKind;
  /** Per-task model override;null = 沿用 per-kind 设置。 */
  model: string | null;
  /** 展示角色(进入任务标题 `[审查] <原标题> (<角色>)`)。 */
  role: string;
  /** 提示词中的角色要求。 */
  roleInstruction: string;
  /** 降级等派发说明(写入提示词,保证「一切结论可追溯来源」)。 */
  note: string | null;
}

/** cross_model 对向规则:claude_code→codex;codex/pi→claude_code。 */
function oppositeAgentKind(kind: ChildAgentKind): ChildAgentKind {
  return kind === "claude_code" ? "codex" : "claude_code";
}

function dualReadonlyPlans(degradedContest: boolean): ReviewDispatchPlan[] {
  const base = "双只读独立调查:你与其他只读审查者并行独立调查、彼此不可见;请独立给出结论,不要试图猜测或迎合其他审查者。所有疑点必须落到文件/行级证据。";
  const rolePrefix = degradedContest ? "竞赛·退化双只读" : "独立调查";
  return [
    {
      agentKind: "claude_code",
      model: null,
      role: `${rolePrefix}·${agentKindDisplayName("claude_code")}`,
      roleInstruction: base,
      note: degradedContest
        ? "本任务以 contest 模式派发,但未配置两个不同 model,已退化为双只读独立调查(claude_code + codex 各一)。"
        : null,
    },
    {
      agentKind: "codex",
      model: null,
      role: `${rolePrefix}·${agentKindDisplayName("codex")}`,
      roleInstruction: base,
      note: degradedContest
        ? "本任务以 contest 模式派发,但未配置两个不同 model,已退化为双只读独立调查(claude_code + codex 各一)。"
        : null,
    },
  ];
}

/**
 * 六模式 → 只读审查子任务派发计划:
 * - standard:不派发(走既有常规审查流,本服务返回空)。
 * - cross_model:单个审查者,kind 与实现者相反(claude_code↔codex)。
 * - dual_readonly:claude_code 与 codex 各一,独立调查。
 * - contest:同 kind 两个不同 model(dispatchReview 的 contestModels 提供);
 *   无可用双模型时退化为 dual_readonly 并在提示词/标题注明。
 * - role_based:三个只读任务(security/architecture/testing),kind 轮转
 *   claude_code/codex/pi。
 * - arbitration:两个 reviewer(claude_code + codex),与 dual_readonly 同构,
 *   但提示词要求独立仲裁结论。
 */
export function reviewDispatchPlans(input: {
  mode: GateReviewMode;
  implementerKind: ChildAgentKind;
  contestModels: string[];
}): ReviewDispatchPlan[] {
  switch (input.mode) {
    case "cross_model":
      return [
        {
          agentKind: oppositeAgentKind(input.implementerKind),
          model: null,
          role: `对向互查·${agentKindDisplayName(oppositeAgentKind(input.implementerKind))}`,
          roleInstruction:
            "对向互查:你与实现者来自不同模型家族,重点检查对方模型易犯的偏差——越权修改、绕过任务约束、与任务无关的改动、报告与实际 Diff 不符;每条疑点必须给出文件/行级证据。",
          note: null,
        },
      ];
    case "dual_readonly":
      return dualReadonlyPlans(false);
    case "contest": {
      const models = [...new Set(input.contestModels.map((model) => model.trim()).filter((model) => model.length > 0))];
      if (models.length >= 2) {
        const kind = input.implementerKind;
        return [0, 1].map((index) => ({
          agentKind: kind,
          model: models[index],
          role: `竞赛评审·${index === 0 ? "A" : "B"}(${models[index]})`,
          roleInstruction:
            "竞赛评审:与另一位使用不同 model 的评审并行评审同一任务;请独立、完整地给出结论,不要猜测对方判断;所有疑点必须落到文件/行级证据。",
          note: null,
        }));
      }
      return dualReadonlyPlans(true);
    }
    case "role_based":
      return [
        {
          agentKind: "claude_code",
          model: null,
          role: "安全审查",
          roleInstruction:
            "安全审查角色:聚焦凭证泄漏、注入、越权路径、敏感文件(如 .env/.pem/migrations)与不安全默认值;其余维度仅记录明显问题。",
          note: null,
        },
        {
          agentKind: "codex",
          model: null,
          role: "架构审查",
          roleInstruction:
            "架构审查角色:聚焦分层边界(领域/应用/数据)、端口依赖方向、状态机一致性与并行安全;不纠缠代码风格问题。",
          note: null,
        },
        {
          agentKind: "pi",
          model: null,
          role: "测试审查",
          roleInstruction:
            "测试审查角色:聚焦变更是否有对应测试覆盖、回归风险、门禁命令(tests/lint/typecheck/build)可复现性;给出最小复现建议。",
          note: null,
        },
      ];
    case "arbitration":
      return ["claude_code", "codex"].map((kind) => ({
        agentKind: kind as ChildAgentKind,
        model: null,
        role: `仲裁·${agentKindDisplayName(kind as ChildAgentKind)}`,
        roleInstruction:
          "仲裁 reviewer:你是仲裁成员之一,必须基于证据独立给出仲裁结论;分歧不会被自动通过,请把无法自行验证的疑点明确列为「待验证」并写明验证方法。",
        note: null,
      }));
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// 审查报告解析(纯函数;collectArbitration 的机器判定依据)
// ---------------------------------------------------------------------------

const VERDICT_TOKEN = /\b(PASS|REWORK|BLOCKED)\b/i;
const VERDICT_KEYWORD = /(结论|conclusion|verdict)/i;

function asVerdict(value: string): ReviewVerdict {
  return value.toUpperCase() as ReviewVerdict;
}

/**
 * 从审查报告文本抽取结论行(容忍格式差异):
 * 1. 优先取含「结论/conclusion/verdict」关键字且带结论词(PASS/REWORK/BLOCKED)
 *    的行,多处以最后一处为准(结论通常收尾;正文引用的结论行可被最终行覆盖)。
 * 2. 回退:整行剥掉 Markdown/列表装饰后恰为结论词的行,同样取最后一处。
 * 3. 均未命中 → null(调用方记入 toVerify「结论无法解析」+ 摘录)。
 */
export function parseReviewVerdict(report: string | null): {
  verdict: ReviewVerdict;
  line: string;
} | null {
  if (report == null || report.trim().length === 0) return null;
  const lines = report.split(/\r?\n/);
  let keywordHit: { verdict: ReviewVerdict; line: string } | null = null;
  for (const line of lines) {
    if (!VERDICT_KEYWORD.test(line)) continue;
    const match = VERDICT_TOKEN.exec(line);
    if (match != null) keywordHit = { verdict: asVerdict(match[1]), line: line.trim() };
  }
  if (keywordHit != null) return keywordHit;
  let bareHit: { verdict: ReviewVerdict; line: string } | null = null;
  for (const line of lines) {
    const normalized = line
      .replace(/^[\s#>*\-•\d.、)（(]+/, "")
      .replace(/[*_`~:：,。;；\s]+$/, "")
      .toUpperCase();
    if (normalized === "PASS" || normalized === "REWORK" || normalized === "BLOCKED") {
      bareHit = { verdict: normalized, line: line.trim() };
    }
  }
  return bareHit;
}

/** 结论行之后的要点(发现条目/项目符号行),去重、截断;供共识合并与分歧证据摘录。 */
function reviewKeyPoints(report: string, verdictLine: string, limit: number): string[] {
  const lines = report.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === verdictLine);
  const tail = index >= 0 ? lines.slice(index + 1) : lines;
  const points: string[] = [];
  for (const line of tail) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/^#{1,6}\s/.test(trimmed) || VERDICT_KEYWORD.test(trimmed)) continue;
    if (/^(?:[-*•]|\d+[.、)])/.test(trimmed) || /^(发现|文件)/.test(trimmed)) {
      const point = truncate(trimmed.replace(/^[-*•]\s*/, ""), 160);
      if (!points.includes(point)) points.push(point);
      if (points.length >= limit) break;
    }
  }
  return points;
}

/** 审查任务到达可收集状态:报告就绪、待返工或任一终态。 */
function reviewCollectionComplete(status: ChildTask["status"]): boolean {
  return status === "awaiting_report" || status === "rework_required" || taskStatusIsTerminal(status);
}

// ---------------------------------------------------------------------------
// 应用服务
// ---------------------------------------------------------------------------

export class ReviewModeService {
  private readonly repository: ReviewModeRepositoryPort;
  private readonly teamService: ReviewModeTeamPort;
  private readonly gate: ReviewModeGatePort;
  private readonly reviewCenter: ReviewModeReviewCenterPort;

  constructor(input: {
    repository: ReviewModeRepositoryPort;
    teamService: ReviewModeTeamPort;
    gate: ReviewModeGatePort;
    reviewCenter: ReviewModeReviewCenterPort;
  }) {
    this.repository = input.repository;
    this.teamService = input.teamService;
    this.gate = input.gate;
    this.reviewCenter = input.reviewCenter;
  }

  /**
   * 按审查模式派发只读审查子任务。mode 缺省时读 run 生效配置的 reviewMode
   * (getEffectiveConfig),仍无则 standard——standard 不派发、返回空列表
   * (提示调用方走既有常规审查流)。
   *
   * 派发规则见 reviewDispatchPlans。审查任务与被审任务并行(被审任务通常已在
   * awaiting_report),不建依赖;审查任务之间也不互相依赖。requestID 确定性派生
   * `review:<mode>:<taskID>:<i>`,重放命中仓储响应缓存,天然幂等。
   */
  async dispatchReview(input: {
    runID: string;
    taskID: string;
    mode?: GateReviewMode;
    /**
     * contest 模式的参赛 model 对(需 ≥2 个互异值才按竞赛派发;不足则退化为
     * dual_readonly 并在审查任务标题/提示词中注明)。端口层不感知全局 model
     * 配置,由调用方(GUI/MCP)从设置注入,保持本服务纯编排。
     */
    contestModels?: string[];
  }): Promise<{ reviewTaskIDs: string[]; mode: GateReviewMode }> {
    const mode = input.mode ?? (await this.effectiveReviewMode(input.runID));
    if (mode === "standard") {
      // standard = 常规审查流(既有 ReviewCenter/门禁),本服务不派发。
      return { reviewTaskIDs: [], mode };
    }
    const summary = await this.repository.runSummary(input.runID);
    const task = summary.tasks.find((candidate) => candidate.id === input.taskID);
    if (task == null) throw DomainError.taskNotFound(input.taskID);

    const plans = reviewDispatchPlans({
      mode,
      implementerKind: task.agentKind,
      contestModels: input.contestModels ?? [],
    });
    if (plans.length === 0) return { reviewTaskIDs: [], mode };

    const promptContext = await this.buildPromptContext(summary.run, task);

    const reviewTaskIDs: string[] = [];
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      const delegated = await this.teamService.delegateTask({
        requestID: `review:${mode}:${input.taskID}:${index}`,
        runID: input.runID,
        title: `[审查] ${task.title} (${plan.role})`,
        prompt: this.renderReviewPrompt({ run: summary.run, task, mode, plan, context: promptContext }),
        agentKind: plan.agentKind,
        model: plan.model,
        executionMode: "read_only",
        dependencies: [],
      });
      reviewTaskIDs.push(delegated.id);
    }
    return { reviewTaskIDs, mode };
  }

  /**
   * 收集审查任务结论并聚合仲裁(共识/分歧/待验证三段,FR-013):
   * - 轮询仓储快照,等全部审查任务到达 awaiting_report/rework_required/终态
   *   (每 5s 一次,上限 10 分钟);超时者记入 toVerify「审查任务未完成」。
   * - 解析各报告结论行(见 parseReviewVerdict);无法解析 → toVerify
   *   「结论无法解析」+ 摘录。
   * - 聚合:全体已解析且结论一致 → consensus 写一致结论 + 要点合并,仅
   *   一致为 PASS 时 autoPassed=true(仍需门禁/accept 流程,autoPassed 只是
   *   仲裁层结论);存在分歧 → consensus 写明「审查结论存在分歧」+ 投票分布,
   *   disagreements 每 reviewer 一条(结论行 + 首条发现摘录),autoPassed=false;
   *   已解析部分一致但有未完成/未解析 → 不满足全体一致,autoPassed=false,
   *   缺口记入 toVerify(disagreements 留空——reviewer 之间并无分歧)。
   * 结果 recordArbitration 落库后返回(重复调用会追加新仲裁记录,
   * getArbitration 取最新一条)。
   */
  async collectArbitration(input: {
    runID: string;
    taskID: string;
    reviewTaskIDs: string[];
  }): Promise<Arbitration> {
    if (input.reviewTaskIDs.length === 0) {
      throw DomainError.invalidTask(
        "collectArbitration requires at least one review task ID (standard mode dispatches none).",
      );
    }
    const tasks = await this.waitForReviewTasks(input.runID, input.reviewTaskIDs);
    const aggregate = this.aggregateReviews(tasks);
    return await this.repository.recordArbitration({
      runID: input.runID,
      taskID: input.taskID,
      consensus: aggregate.consensus,
      disagreements: aggregate.disagreements,
      toVerify: aggregate.toVerify,
      autoPassed: aggregate.autoPassed,
    });
  }

  /** 仲裁结论读取直通(最新一条)。 */
  async getArbitration(runID: string, taskID: string): Promise<Arbitration | null> {
    return await this.repository.getArbitration(runID, taskID);
  }

  /**
   * 该任务的审查子任务清单(供 UI 展示)。识别方式:executionMode = read_only
   * 且 prompt 首行以 `[OctoPunk-Review run=<runID> task=<taskID>` 开头。
   * 不用 parentTask 关联——既有 delegateTask 通道固定 parentTask: null(仓储
   * createTaskBatch 不接受 parent),也不只用标题前缀 `[审查]`——标题不含
   * run/task 定位信息且可能同名;prompt 首行标记是派发时写入的机器可读定位,
   * 实现最简且可靠。
   */
  async latestReviewTasks(runID: string, taskID: string): Promise<ChildTask[]> {
    const snapshot = await this.repository.snapshot(runID);
    const prefix = reviewPromptPrefix(runID, taskID);
    return snapshot.tasks
      .filter((task) => task.executionMode === "read_only" && task.prompt.startsWith(prefix))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  // MARK: - Internals

  private async effectiveReviewMode(runID: string): Promise<GateReviewMode> {
    const config = await this.gate.getEffectiveConfig(runID);
    return config?.reviewMode ?? "standard";
  }

  private async waitForReviewTasks(runID: string, taskIDs: string[]): Promise<ChildTask[]> {
    const deadline = Date.now() + COLLECT_TIMEOUT_MS;
    for (;;) {
      const snapshot = await this.repository.snapshot(runID);
      const tasks: ChildTask[] = [];
      for (const id of taskIDs) {
        const task = snapshot.tasks.find((candidate) => candidate.id === id);
        if (task == null) throw DomainError.taskNotFound(id);
        tasks.push(task);
      }
      if (tasks.every((task) => reviewCollectionComplete(task.status))) return tasks;
      if (Date.now() + COLLECT_POLL_INTERVAL_MS > deadline) return tasks;
      await sleep(COLLECT_POLL_INTERVAL_MS);
    }
  }

  private aggregateReviews(tasks: ChildTask[]): {
    consensus: string;
    disagreements: ArbitrationDisagreement[];
    toVerify: ArbitrationToVerify[];
    autoPassed: boolean;
  } {
    const toVerify: ArbitrationToVerify[] = [];
    const unfinished = tasks.filter((task) => !reviewCollectionComplete(task.status));
    for (const task of unfinished) {
      toVerify.push({
        claim: `审查任务未完成:${task.title}(当前状态 ${task.status})`,
        howToVerify: "在 Run 详情跟踪该只读审查任务;到达 awaiting_report/终态后重新执行 collectArbitration 刷新仲裁结论。",
      });
    }

    const kindCounts = new Map<string, number>();
    for (const task of tasks) {
      kindCounts.set(task.agentKind, (kindCounts.get(task.agentKind) ?? 0) + 1);
    }

    const parsed: { task: ChildTask; verdict: ReviewVerdict; line: string; keyPoints: string[] }[] = [];
    for (const task of tasks) {
      if (!reviewCollectionComplete(task.status)) continue;
      const hit = parseReviewVerdict(task.latestReport);
      if (hit == null) {
        toVerify.push({
          claim: `结论无法解析:${task.title}。报告摘录:${truncate(ChildAgentDiagnostics.redact(task.latestReport ?? "(无报告)"), 200)}`,
          howToVerify: `人工阅读该审查任务(${task.id})报告全文并判定结论。`,
        });
        continue;
      }
      parsed.push({
        task,
        verdict: hit.verdict,
        line: hit.line,
        keyPoints: reviewKeyPoints(task.latestReport ?? "", hit.line, 3),
      });
    }

    const verdicts = [...new Set(parsed.map((entry) => entry.verdict))];
    const disagreements: ArbitrationDisagreement[] = [];
    let consensus: string;
    let autoPassed = false;

    if (parsed.length === 0) {
      consensus = `无有效审查结论:${unfinished.length} 份未完成、${toVerify.length - unfinished.length} 份无法解析。分歧/缺口不自动通过,待人工或主 Agent 决断。`;
    } else if (verdicts.length > 1) {
      // reviewer 之间结论不一致:每 reviewer 一条分歧记录(含结论一致方,呈现完整投票)。
      const tally = verdicts
        .map((verdict) => `${verdict}×${parsed.filter((entry) => entry.verdict === verdict).length}`)
        .join("、");
      consensus = `审查结论存在分歧。投票分布:${tally}(共 ${parsed.length} 份有效结论)。分歧不自动通过,待人工或主 Agent 决断。`;
      for (const entry of parsed) {
        disagreements.push({
          reviewer: this.reviewerLabel(entry.task, kindCounts),
          verdict: entry.verdict,
          evidence: truncate(
            `${entry.line} | 首条发现:${entry.keyPoints[0] ?? "(无发现条目)"}`,
            400,
          ),
        });
      }
    } else if (parsed.length === tasks.length) {
      // 全体已解析且一致:唯一允许 autoPassed=true 的分支(且结论必须为 PASS)。
      const verdict = verdicts[0];
      autoPassed = verdict === "PASS";
      const merged: string[] = [];
      for (const entry of parsed) {
        for (const point of entry.keyPoints) {
          if (!merged.includes(point)) merged.push(point);
          if (merged.length >= 12) break;
        }
      }
      consensus = [
        `审查结论一致:${verdict}(${parsed.length}/${tasks.length} 位 reviewer 全体同意)。`,
        ...(merged.length > 0 ? ["要点合并:"] : []),
        ...merged.map((point) => `- ${point}`),
        autoPassed
          ? "仲裁层结论为自动通过;任务仍需通过门禁与既有 accept 流程(autoPassed 仅是仲裁层结论)。"
          : "仲裁层结论为不通过;按结论进入对应返工/阻断流程。",
      ].join("\n");
    } else {
      // 已解析部分一致,但存在未完成/未解析:不满足「全体一致」,失败侧关闭。
      const verdict = verdicts[0];
      consensus = `已解析的 ${parsed.length} 份审查结论一致:${verdict};另有 ${tasks.length - parsed.length} 份未完成/无法解析,不满足全体一致,不自动通过。`;
    }

    return { consensus, disagreements, toVerify, autoPassed };
  }

  /**
   * reviewer 标识:默认 agentKind;同 kind 多任务(如 contest/role_based 轮转)
   * 时追加标题中的角色括注消歧,保证分歧记录可追溯到具体审查任务。
   */
  private reviewerLabel(task: ChildTask, kindCounts: Map<string, number>): string {
    if ((kindCounts.get(task.agentKind) ?? 0) <= 1) return task.agentKind;
    const role = /\(([^()]*)\)\s*$/.exec(task.title)?.[1] ?? task.id.slice(0, 8);
    return `${task.agentKind}(${role})`;
  }

  /** 汇总审查提示词的证据段:报告摘录 / Diff 文件清单 / 未解决发现。 */
  private async buildPromptContext(
    run: TeamRun,
    task: ChildTask,
  ): Promise<{ reportExcerpt: string; diffLines: string[]; openFindingLines: string[] }> {
    const reportExcerpt = ChildAgentDiagnostics.redact(
      task.latestReport ?? "(暂无执行报告)",
      REPORT_EXCERPT_LIMIT,
    );

    let diffLines: string[];
    try {
      const tree = await this.reviewCenter.getDiffTree(run.id, task.id, "worktree");
      diffLines =
        tree.length === 0
          ? ["(无变更文件)"]
          : tree.slice(0, DIFF_LIST_LIMIT).map((entry) => formatDiffEntry(entry));
      if (tree.length > DIFF_LIST_LIMIT) {
        diffLines.push(`…(其余 ${tree.length - DIFF_LIST_LIMIT} 个文件略)`);
      }
    } catch (error) {
      // Diff 不可得不应阻塞派发;缺口显式写入提示词,保持可追溯。
      diffLines = [`(Diff 清单不可用:${error instanceof Error ? error.message : String(error)})`];
    }

    let openFindingLines: string[];
    try {
      const findings = await this.reviewCenter.unresolvedFindings(run.id, task.id);
      openFindingLines =
        findings.length === 0
          ? ["(无)"]
          : findings.slice(0, OPEN_FINDINGS_LIMIT).map((finding) => {
              const firstLine = finding.body.split("\n")[0] ?? "";
              return `- [${finding.severity}] ${finding.filePath}:${finding.lineStart} — ${truncate(firstLine, 120)}`;
            });
      if (findings.length > OPEN_FINDINGS_LIMIT) {
        openFindingLines.push(`…(其余 ${findings.length - OPEN_FINDINGS_LIMIT} 条略)`);
      }
    } catch (error) {
      openFindingLines = [`(未解决发现不可用:${error instanceof Error ? error.message : String(error)})`];
    }

    return { reportExcerpt, diffLines, openFindingLines };
  }

  private renderReviewPrompt(input: {
    run: TeamRun;
    task: ChildTask;
    mode: GateReviewMode;
    plan: ReviewDispatchPlan;
    context: { reportExcerpt: string; diffLines: string[]; openFindingLines: string[] };
  }): string {
    const { run, task, mode, plan, context } = input;
    const lines: string[] = [];
    lines.push(`${reviewPromptPrefix(run.id, task.id)} mode=${mode} role=${plan.role}]`);
    lines.push("");
    lines.push(
      `你是 OctoPunk 只读审查者(模式:${mode},角色:${plan.role}),只能读取代码与报告,不得修改任何文件、不得派发子任务。`,
    );
    lines.push("");
    lines.push("## 被审任务");
    lines.push(`- 标题:${task.title}`);
    lines.push(
      `- 执行者:${agentKindDisplayName(task.agentKind)}${task.model == null ? "" : ` (model: ${task.model})`} · 状态:${task.status}`,
    );
    lines.push(`- 所属 Run:${run.task}`);
    if (plan.note != null) {
      lines.push(`- 派发说明:${plan.note}`);
    }
    lines.push("");
    lines.push("## 执行报告摘录(已脱敏,≤2KiB)");
    lines.push(context.reportExcerpt);
    lines.push("");
    lines.push("## Diff 文件清单(worktree 侧)");
    lines.push(...context.diffLines);
    lines.push("");
    lines.push("## 未解决发现(Review Center open findings)");
    lines.push(...context.openFindingLines);
    lines.push("");
    lines.push("## 角色要求");
    lines.push(plan.roleInstruction);
    lines.push("");
    lines.push("## 输出格式(机器解析依据,必须严格遵守)");
    lines.push("结论: PASS");
    lines.push("(三选一:PASS / REWORK / BLOCKED;「结论:」必须单独成行,放在报告开头或结尾)");
    lines.push("发现:");
    lines.push(
      "- 文件: <路径> | 行: <行号> | 严重度: blocker|high|medium|low|info | 证据: <代码或报告引文> | 建议: <修复建议>",
    );
    lines.push("(每条发现一行,字段齐全;无发现时写「发现: 无」)");
    return lines.join("\n");
  }
}

function formatDiffEntry(entry: DiffTreeEntryDTO): string {
  const flags = [entry.isBinary ? "binary" : null, entry.oversize ? "oversize" : null]
    .filter((flag): flag is string => flag != null)
    .join(",");
  return `- ${entry.path} (${entry.changeType}, +${entry.additions}/-${entry.deletions}${flags.length > 0 ? `, ${flags}` : ""})`;
}
