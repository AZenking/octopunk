// Review Center 应用服务(specs/002-v04-review-center-gates User Story 1)。
// 用例编排层:跨 run 待审查聚合、三方 Diff 委托、行级评论锚点校验、
// 评论→返工聚合、返工后锚点回填判定与交付摘要生成都在这里完成;
// 仓储只持久化(anchor 校验在服务层),GitPort 只负责读 Diff。
// GUI 与 MCP 共享本服务(宪法原则二)。

import type {
  Arbitration,
  ArbitrationDisagreement,
  ArbitrationToVerify,
  ChildTask,
  DeliverySummary,
  ReviewComment,
  ReviewCommentAuthor,
  ReviewCommentSeverity,
  ReviewVerdict,
  TeamRun,
} from "../domain/models";
import { DomainError, newReviewFinding } from "../domain/models";
import type {
  ReviewCommentDraft,
  ReviewDecisionInput,
  TeamRunRepository,
} from "../domain/repositoryPort";
import type {
  ChildTaskDTO,
  DeliverySummaryDTO,
  DiffPageDTO,
  DiffTreeEntryDTO,
  ReviewCommentDTO,
  ReviewPendingTaskDTO,
} from "../../shared/dtos";
import type { GitDiffSide, GitPort } from "./ports";
import { ChildAgentDiagnostics } from "./ports";

/** Review Center 列表的报告预览长度(ReviewPendingTaskDTO.latestReport)。 */
const PENDING_REPORT_PREVIEW_LIMIT = 200;

/** specs/002 data-model:评论正文 ≤8KiB,锚点行快照 ≤2KiB(写入前 redact)。 */
const COMMENT_BODY_LIMIT = 8 * 1024;
const CONTEXT_SNAPSHOT_LIMIT = 2 * 1024;

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

/** ReviewComment 与 ReviewCommentDTO 字段同名同型,直传即可。 */
function reviewCommentDTO(comment: ReviewComment): ReviewCommentDTO {
  return { ...comment };
}

/** waiver/open 计数是派生值(不落库),由调用处按当前状态计算后注入。 */
function deliverySummaryDTO(
  summary: DeliverySummary,
  counts: { waiverCount: number; openFindingCount: number },
): DeliverySummaryDTO {
  return {
    id: summary.id,
    runID: summary.runID,
    taskID: summary.taskID,
    verdict: summary.verdict,
    summaryMd: summary.summaryMD,
    evidence: [...summary.evidence],
    waiverCount: counts.waiverCount,
    openFindingCount: counts.openFindingCount,
    createdAt: summary.createdAt,
  };
}

/**
 * 敏感路径启发式(spec FR-004 / Edge Cases):仅用于 Diff 树标记,
 * 内容展示仍统一走 redact 规则。规则从宽——误标只是多一层提示,漏标才是风险。
 */
export function sensitivePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  // 数据库迁移目录(migrations/…)视为高风险变更来源。
  if (/(^|\/)migrations?\//.test(normalized)) return true;
  const fileName = normalized.substring(normalized.lastIndexOf("/") + 1);
  return (
    fileName.includes(".env") ||
    fileName.endsWith(".pem") ||
    fileName.includes("key") ||
    fileName.includes("secret") ||
    fileName.includes("credential")
  );
}

/** 待写入的行级评论(服务层入参;file/line 为基线侧锚点)。 */
export interface ReviewCommentInput {
  file: string;
  lineStart: number;
  lineEnd?: number;
  body: string;
  severity?: ReviewCommentSeverity;
  author?: ReviewCommentAuthor;
  /** 锚点行内容快照(≤2KiB),由调用方在评论现场捕获;缺省留空。 */
  contextSnapshot?: string;
}

/**
 * rework 委托端口:AgentTeamApplicationService 结构性满足。审查中心的批量
 * 返工不新建状态机,而是聚合评论后走既有 requestRework(轮次、事件、
 * launch 节奏与既有审查流完全一致)。
 */
export interface TeamReworkPort {
  requestRework(input: ReviewDecisionInput): Promise<ChildTaskDTO>;
}

export class ReviewCenterService {
  private readonly repository: TeamRunRepository;
  private readonly git: GitPort;
  private readonly teamService: TeamReworkPort;

  constructor(input: { repository: TeamRunRepository; git: GitPort; teamService: TeamReworkPort }) {
    this.repository = input.repository;
    this.git = input.git;
    this.teamService = input.teamService;
  }

  /**
   * 跨 run 待审查任务聚合(specs/002 派生视图:status ∈
   * {awaiting_report, rework_required} 的任务,跨 run 收进 Review Center 列表)。
   * 性能:逐 run 使用轻量 runSummary(不含 reports/events/日志),仅对存在
   * 待审查任务的 run 追加一次 listOpenReviewComments;不新增 SQL。
   */
  async pendingReviewTasks(): Promise<ReviewPendingTaskDTO[]> {
    const summaries = await this.repository.listRuns();
    const result: ReviewPendingTaskDTO[] = [];
    for (const runSummary of summaries) {
      const summary = await this.repository.runSummary(runSummary.id);
      const pending = summary.tasks.filter(
        (task) => task.status === "awaiting_report" || task.status === "rework_required",
      );
      if (pending.length === 0) continue;
      // 仓储已按 severity DESC 排序(risk 置顶);这里只按任务分组计数。
      const openComments = await this.repository.listOpenReviewComments(runSummary.id);
      for (const task of pending) {
        const taskComments = openComments.filter((comment) => comment.taskID === task.id);
        result.push({
          runID: runSummary.id,
          runTitle: summary.run.task,
          taskID: task.id,
          title: task.title,
          agentKind: task.agentKind,
          model: task.model,
          executionMode: task.executionMode,
          reviewRound: task.reviewRound,
          status: task.status,
          latestReport: task.latestReport == null ? null : truncate(task.latestReport, PENDING_REPORT_PREVIEW_LIMIT),
          unresolvedFindingCount: taskComments.length,
          hasRiskFinding: taskComments.some((comment) => comment.severity === "risk"),
          updatedAt: task.updatedAt,
        });
      }
    }
    // 最近更新优先,审查者从最新任务开始处理。
    result.sort((a, b) => b.updatedAt - a.updatedAt);
    return result;
  }

  /**
   * 变更树(单文件变更统计)。side=integration 且集成工作区缺失时,
   * GitAdapterError.integrationWorktreeMissing 的可读错误原样透传。
   */
  async getDiffTree(runID: string, taskID: string, side: GitDiffSide): Promise<DiffTreeEntryDTO[]> {
    const { run, task } = await this.runTask(runID, taskID);
    return await this.git.diffTree({
      repositoryURL: run.repositoryPath,
      runID,
      taskID,
      baselineCommit: task.baselineCommit,
      taskBranch: task.branchName,
      side,
    });
  }

  /** 单文件 Diff 分页(单页 ≤64KiB 且已 redact;cursor=null 从头开始)。 */
  async getDiffPage(
    runID: string,
    taskID: string,
    side: GitDiffSide,
    path: string,
    cursor: string | null,
  ): Promise<DiffPageDTO> {
    const { run, task } = await this.runTask(runID, taskID);
    return await this.git.diffPage({
      repositoryURL: run.repositoryPath,
      runID,
      taskID,
      baselineCommit: task.baselineCommit,
      taskBranch: task.branchName,
      side,
      path,
      cursor,
    });
  }

  /**
   * 批量添加行级评论。锚点校验在服务层:评论文件必须出现在该任务
   * worktree 侧 Diff 的文件集中(仓储只持久化,不校验);正文写入前
   * redact,密钥类内容不得明文落库(spec Edge Cases)。
   */
  async addComments(input: {
    requestID: string;
    runID: string;
    taskID: string;
    comments: ReviewCommentInput[];
  }): Promise<ReviewCommentDTO[]> {
    if (input.comments.length === 0) {
      throw DomainError.invalidTask("add_review_comments requires at least one comment.");
    }
    for (const comment of input.comments) {
      if (!(comment.lineStart >= 1)) {
        throw DomainError.invalidTask(`评论行锚点必须 ≥1:${comment.file}:${comment.lineStart}`);
      }
      if (comment.lineEnd != null && comment.lineEnd < comment.lineStart) {
        throw DomainError.invalidTask(`评论行区间不合法(line_end < line_start):${comment.file}`);
      }
      if (comment.body.trim().length === 0) {
        throw DomainError.invalidTask(`评论正文不能为空:${comment.file}:${comment.lineStart}`);
      }
    }
    const tree = await this.getDiffTree(input.runID, input.taskID, "worktree");
    const changedPaths = new Set(tree.map((entry) => entry.path));
    for (const comment of input.comments) {
      if (!changedPaths.has(comment.file)) {
        throw DomainError.invalidTask(`评论锚点文件不在该任务的 Diff 中:${comment.file}`);
      }
    }
    const drafts: ReviewCommentDraft[] = input.comments.map((comment) => ({
      filePath: comment.file,
      lineStart: comment.lineStart,
      lineEnd: comment.lineEnd ?? comment.lineStart,
      // 快照由调用方捕获(≤2KiB);缺省留空,仅失去返工后的漂移比对依据。
      contextSnapshot: truncate(ChildAgentDiagnostics.redact(comment.contextSnapshot ?? ""), CONTEXT_SNAPSHOT_LIMIT),
      body: truncate(ChildAgentDiagnostics.redact(comment.body), COMMENT_BODY_LIMIT),
      severity: comment.severity ?? "info",
      author: comment.author ?? "user",
    }));
    const created = await this.repository.addReviewComments({ ...input, comments: drafts });
    return created.map(reviewCommentDTO);
  }

  /**
   * 勾选多条 open 评论聚合为一次返工:评论转为 findings(证据=评论正文,
   * 携带文件/行锚点)后委托既有 requestRework,复用其轮次、事件与子 Agent
   * 会话状态机;评论状态此时保持 open,待新报告到达后由
   * refreshCommentStatuses 复审回填。
   */
  async reworkBatch(input: {
    requestID: string;
    runID: string;
    taskID: string;
    commentIDs: string[];
    summary: string;
    reviewer?: string;
  }): Promise<ChildTaskDTO> {
    if (input.commentIDs.length === 0) {
      throw DomainError.invalidTask("request_rework_batch requires at least one comment id.");
    }
    const comments = await this.repository.listReviewComments(input.runID, input.taskID);
    const selected: ReviewComment[] = [];
    for (const commentID of input.commentIDs) {
      const comment = comments.find((candidate) => candidate.id === commentID);
      if (comment == null) {
        throw DomainError.invalidTask(`Review comment not found: ${commentID}`);
      }
      if (comment.status !== "open") {
        throw DomainError.invalidTask(
          `仅 open 评论可合入返工(评论 ${commentID} 当前为 ${comment.status})`,
        );
      }
      selected.push(comment);
    }
    const findings = selected.map((comment) =>
      newReviewFinding({
        taskID: comment.taskID,
        // risk 评论映射为 high 级 finding(info 保持 info),供审查流与门禁共用。
        severity: comment.severity === "risk" ? "high" : "info",
        file: comment.filePath,
        line: comment.lineStart,
        evidence: comment.body,
        expectedFix: `按审查评论修复 ${comment.filePath}:${comment.lineStart},并保持该锚点上下文可追溯(评论 ${comment.id})。`,
      }),
    );
    const summary =
      input.summary.trim().length > 0 ? input.summary : `批量返工:聚合 ${selected.length} 条行级评论。`;
    return await this.teamService.requestRework({
      requestID: input.requestID,
      runID: input.runID,
      taskID: input.taskID,
      reviewer: input.reviewer ?? "user",
      verdict: "REWORK",
      summary,
      findings,
    });
  }

  /**
   * 返工新报告到达后的锚点回填复审(幂等、只处理 open 评论):
   * - 锚点文件已从 worktree 侧 Diff 消失 → 问题随 Diff 不复存在,resolved;
   * - 锚点行(基线侧行号)在 Diff 中被删除/改写 → line_changed(仓储保留
   *   context_snapshot,spec Edge Case:评论不得静默丢失);
   * - 锚点行区间未受 Diff 影响(或二进制/超大文件无法逐行核对)→ 保持 open
   *   等待人工复审。
   */
  async refreshCommentStatuses(runID: string, taskID: string): Promise<ReviewCommentDTO[]> {
    const openComments = (await this.repository.listReviewComments(runID, taskID)).filter(
      (comment) => comment.status === "open",
    );
    if (openComments.length === 0) return [];
    const tree = await this.getDiffTree(runID, taskID, "worktree");
    const updated: ReviewComment[] = [];
    for (const comment of openComments) {
      const entry = tree.find((candidate) => candidate.path === comment.filePath) ?? null;
      if (entry == null) {
        updated.push(
          await this.repository.setReviewCommentStatus({
            // requestID 确定性派生:重放返回缓存结果;终态不可逆保证不会重复迁移。
            requestID: `${comment.id}:refresh`,
            runID,
            commentID: comment.id,
            status: "resolved",
          }),
        );
        continue;
      }
      // 二进制/超大文件无逐行内容,无法验证 ≠ 已解决,保持 open。
      if (entry.isBinary || entry.oversize) continue;
      if (await this.anchorLinesChanged(runID, taskID, comment)) {
        updated.push(
          await this.repository.setReviewCommentStatus({
            requestID: `${comment.id}:refresh`,
            runID,
            commentID: comment.id,
            status: "line_changed",
          }),
        );
      }
    }
    return updated.map(reviewCommentDTO);
  }

  /**
   * 未解决发现清单(open 评论,risk 置顶):供门禁 risk_findings 项与
   * UI 消费;排序沿用仓储(severity DESC, created_at)。
   */
  async unresolvedFindings(runID: string, taskID: string): Promise<ReviewCommentDTO[]> {
    const openComments = await this.repository.listOpenReviewComments(runID);
    return openComments
      .filter((comment) => comment.taskID === taskID)
      .map(reviewCommentDTO);
  }

  /**
   * 生成结构化交付摘要(结论/证据/豁免清单/遗留 open findings)并入档。
   * taskID 为 null 时生成 run 级终审摘要。
   */
  async generateDeliverySummary(input: {
    runID: string;
    taskID: string | null;
    verdict: ReviewVerdict;
    summaryLines?: string[];
  }): Promise<DeliverySummaryDTO> {
    const snapshot = await this.repository.snapshot(input.runID);
    const task =
      input.taskID == null
        ? null
        : (snapshot.tasks.find((candidate) => candidate.id === input.taskID) ?? null);
    if (input.taskID != null && task == null) {
      throw DomainError.taskNotFound(input.taskID);
    }
    // 证据聚合:执行报告 id、最近门禁判定 id、评论 id 集。
    const latestReport =
      task == null
        ? null
        : ([...snapshot.reports].reverse().find((report) => report.taskID === task.id) ?? null);
    const evaluation =
      task == null ? null : await this.repository.getLatestGateEvaluation(input.runID, task.id);
    const waivedItems = (evaluation?.items ?? []).filter((item) => item.status === "waived");
    const targets = task == null ? snapshot.tasks : [task];
    const comments: ReviewComment[] = [];
    for (const target of targets) {
      comments.push(...(await this.repository.listReviewComments(input.runID, target.id)));
    }
    const openComments = comments.filter((comment) => comment.status === "open");
    const riskCount = openComments.filter((comment) => comment.severity === "risk").length;

    const evidence: string[] = [];
    if (latestReport != null) evidence.push(latestReport.id);
    if (evaluation != null) evidence.push(evaluation.id);
    for (const comment of comments) evidence.push(comment.id);

    const lines: string[] = [];
    lines.push("# 交付摘要(Delivery Summary)");
    lines.push("");
    lines.push(`- 结论:**${input.verdict}**`);
    lines.push(`- Run:${snapshot.run.task}(\`${snapshot.run.id}\`)`);
    if (task != null) {
      lines.push(`- 任务:${task.title}(\`${task.id}\`,第 ${task.reviewRound} 轮审查)`);
    } else {
      lines.push(`- 审查轮次:${snapshot.run.currentReviewRound}`);
    }
    lines.push(`- 行级评论:${comments.length} 条(未解决 ${openComments.length},其中 risk ${riskCount})`);
    lines.push("");
    lines.push("## 证据(Evidence)");
    if (latestReport != null) lines.push(`- 执行报告:\`${latestReport.id}\``);
    if (evaluation != null) {
      lines.push(`- 门禁判定:\`${evaluation.id}\`(overall: ${evaluation.overall})`);
    }
    if (latestReport == null && evaluation == null) lines.push("- (无)");
    lines.push("");
    lines.push("## 豁免清单(Waivers)");
    if (waivedItems.length === 0) {
      lines.push("- (无豁免项)");
    } else {
      for (const item of waivedItems) {
        const at = item.waivedAt == null ? "" : `(${new Date(item.waivedAt * 1000).toISOString()})`;
        lines.push(
          `- [${item.checkKey}] 由 ${item.waivedBy ?? "unknown"} 豁免 — ${item.waivedReason ?? "(未填理由)"}${at}`,
        );
      }
    }
    lines.push("");
    lines.push("## 遗留未解决发现(Open Findings)");
    if (openComments.length === 0) {
      lines.push("- (无遗留项)");
    } else {
      // risk 置顶,与未解决发现清单一序。
      const ordered = [...openComments].sort((a, b) =>
        a.severity === b.severity ? 0 : a.severity === "risk" ? -1 : 1,
      );
      for (const comment of ordered) {
        lines.push(
          `- [${comment.severity}] ${comment.filePath}:${comment.lineStart} — ${truncate(
            comment.body.split("\n")[0] ?? "",
            160,
          )}`,
        );
      }
    }
    if (input.summaryLines != null && input.summaryLines.length > 0) {
      lines.push("");
      lines.push("## 备注(Notes)");
      for (const extra of input.summaryLines) {
        lines.push(`- ${ChildAgentDiagnostics.redact(extra)}`);
      }
    }

    const recorded = await this.repository.recordDeliverySummary({
      runID: input.runID,
      taskID: input.taskID,
      verdict: input.verdict,
      summaryMd: lines.join("\n"),
      evidence,
    });
    return deliverySummaryDTO(recorded, {
      waiverCount: waivedItems.length,
      openFindingCount: openComments.length,
    });
  }

  /** 读取交付摘要;waiver/open 计数为派生值,按当前状态重算。 */
  async getDeliverySummary(runID: string, taskID: string | null): Promise<DeliverySummaryDTO | null> {
    const summary = await this.repository.getDeliverySummary(runID, taskID);
    if (summary == null) return null;
    const evaluation =
      taskID == null ? null : await this.repository.getLatestGateEvaluation(runID, taskID);
    const waiverCount = (evaluation?.items ?? []).filter((item) => item.status === "waived").length;
    const openFindingCount = (await this.repository.listOpenReviewComments(runID)).filter(
      (comment) => taskID == null || comment.taskID === taskID,
    ).length;
    return deliverySummaryDTO(summary, { waiverCount, openFindingCount });
  }

  /** 仲裁结论写入(US3 跨模型审查;分歧时 autoPassed 必须为 false)。 */
  async recordArbitration(input: {
    runID: string;
    taskID: string;
    consensus: string;
    disagreements: ArbitrationDisagreement[];
    toVerify: ArbitrationToVerify[];
    autoPassed: boolean;
  }): Promise<Arbitration> {
    return await this.repository.recordArbitration(input);
  }

  /** 仲裁结论读取(共识/分歧/待验证 + auto_passed)。 */
  async getArbitration(runID: string, taskID: string): Promise<Arbitration | null> {
    return await this.repository.getArbitration(runID, taskID);
  }

  /** 轻量取 run + task(runSummary 不加载 reports/events/日志)。 */
  private async runTask(runID: string, taskID: string): Promise<{ run: TeamRun; task: ChildTask }> {
    const summary = await this.repository.runSummary(runID);
    const task = summary.tasks.find((candidate) => candidate.id === taskID);
    if (task == null) throw DomainError.taskNotFound(taskID);
    return { run: summary.run, task };
  }

  /**
   * 锚点回填判定:分页读完该文件 worktree 侧 Diff(worktree 侧的 old 端
   * 即基线提交,oldLine 与评论锚点同坐标系),锚点区间内任一基线行被
   * 删除(del 行携带 oldLine)即视为行变更。分页游标严格前进,由适配器
   * 保证每页至少产出 1 行。
   */
  private async anchorLinesChanged(
    runID: string,
    taskID: string,
    comment: ReviewComment,
  ): Promise<boolean> {
    const { run, task } = await this.runTask(runID, taskID);
    const anchorLines = new Set<number>();
    for (let line = comment.lineStart; line <= comment.lineEnd; line++) {
      anchorLines.add(line);
    }
    let cursor: string | null = null;
    do {
      const page = await this.git.diffPage({
        repositoryURL: run.repositoryPath,
        runID,
        taskID,
        baselineCommit: task.baselineCommit,
        taskBranch: task.branchName,
        side: "worktree",
        path: comment.filePath,
        cursor,
      });
      for (const hunk of page.hunks) {
        for (const line of hunk.lines) {
          if (line.origin === "del" && line.oldLine != null && anchorLines.has(line.oldLine)) {
            return true;
          }
        }
      }
      cursor = page.nextCursor;
    } while (cursor != null);
    return false;
  }
}
