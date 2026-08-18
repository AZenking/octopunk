// Port of OctoPunk/OctoPunk/Domain/Models/TeamModels.swift.
// Timestamps are epoch seconds (numbers) mirroring the REAL SQLite columns;
// UUIDs are strings; enums are string-literal unions with helper tables.

import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_CONCURRENT_TASKS, MAX_CONCURRENT_TASKS_LIMIT } from "../../shared/ipc";

export type { EpochSeconds } from "../../shared/dtos";

export const TEAM_RUN_STATUSES = [
  "ready",
  "running",
  "reviewing",
  "awaiting_final_review",
  "completed",
  "blocked",
  "cancelled",
  "failed",
] as const;
export type TeamRunStatus = (typeof TEAM_RUN_STATUSES)[number];

export function runStatusDisplayName(status: TeamRunStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "running":
      return "Running";
    case "reviewing":
      return "Reviewing";
    case "awaiting_final_review":
      return "Final review";
    case "completed":
      return "Completed";
    case "blocked":
      return "Blocked";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
  }
}

export function runStatusIsTerminal(status: TeamRunStatus): boolean {
  return status === "completed" || status === "blocked" || status === "cancelled" || status === "failed";
}

export const CHILD_TASK_STATUSES = [
  "queued",
  "running",
  "awaiting_report",
  "rework_required",
  "accepted",
  "blocked",
  "cancelled",
  "failed",
] as const;
export type ChildTaskStatus = (typeof CHILD_TASK_STATUSES)[number];

export function taskStatusDisplayName(status: ChildTaskStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Agent working";
    case "awaiting_report":
      return "Report ready";
    case "rework_required":
      return "Rework required";
    case "accepted":
      return "Accepted";
    case "blocked":
      return "Blocked";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
  }
}

export function taskStatusIsActiveExecution(status: ChildTaskStatus): boolean {
  return status === "running" || status === "rework_required";
}

export function taskStatusIsTerminal(status: ChildTaskStatus): boolean {
  return (
    status === "accepted" || status === "blocked" || status === "cancelled" || status === "failed"
  );
}

/** The child-agent runtime chosen by the caller; part of the task contract. */
export const CHILD_AGENT_KINDS = ["claude_code", "codex", "pi"] as const;
export type ChildAgentKind = (typeof CHILD_AGENT_KINDS)[number];

export function agentKindDisplayName(kind: ChildAgentKind): string {
  if (kind === "claude_code") return "Claude Code";
  if (kind === "codex") return "Codex";
  return "Pi";
}

/** The least privilege the task is allowed to receive from its agent. */
export const TASK_EXECUTION_MODES = ["read_only", "workspace_write"] as const;
export type TaskExecutionMode = (typeof TASK_EXECUTION_MODES)[number];

export function executionModeDisplayName(mode: TaskExecutionMode): string {
  return mode === "read_only" ? "Read only" : "Workspace write";
}

/** Whether a task owns its worktree or joins a run-scoped read-only baseline. */
export const TASK_WORKSPACE_KINDS = ["shared_read_only", "isolated_write"] as const;
export type TaskWorkspaceKind = (typeof TASK_WORKSPACE_KINDS)[number];

export function workspaceKindDisplayName(kind: TaskWorkspaceKind): string {
  return kind === "shared_read_only" ? "Shared read-only baseline" : "Isolated write worktree";
}

export const REVIEW_VERDICTS = ["PASS", "REWORK", "BLOCKED"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_FINDING_SEVERITIES = ["blocker", "high", "medium", "low", "info"] as const;
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

export interface ReviewFinding {
  id: string;
  taskID: string | null;
  severity: ReviewFindingSeverity;
  file: string | null;
  line: number | null;
  evidence: string;
  expectedFix: string | null;
}

export function newReviewFinding(finding: Omit<ReviewFinding, "id"> & { id?: string }): ReviewFinding {
  return { id: finding.id ?? randomUUID(), ...finding } as ReviewFinding;
}

export interface TeamRun {
  id: string;
  repositoryPath: string;
  task: string;
  baselineCommit: string;
  targetBranch: string;
  status: TeamRunStatus;
  /** Owning MCP session (stdio process, HTTP session, or "local-ui"); null on legacy rows. */
  sessionId: string | null;
  maxConcurrentTasks: number;
  maxReviewRounds: number;
  currentReviewRound: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Epoch seconds when the run moved to the archived section; null = active. */
  archivedAt: number | null;
}

export function makeTeamRun(init: {
  id?: string;
  repositoryPath: string;
  task: string;
  baselineCommit: string;
  targetBranch?: string;
  status?: TeamRunStatus;
  sessionId?: string | null;
  maxConcurrentTasks?: number;
  maxReviewRounds?: number;
  currentReviewRound?: number;
  revision?: number;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number | null;
}): TeamRun {
  const now = Date.now() / 1000;
  return {
    id: init.id ?? randomUUID(),
    repositoryPath: init.repositoryPath,
    task: init.task,
    baselineCommit: init.baselineCommit,
    targetBranch: init.targetBranch ?? "",
    status: init.status ?? "ready",
    sessionId: init.sessionId ?? null,
    maxConcurrentTasks: Math.max(
      1,
      Math.min(init.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS, MAX_CONCURRENT_TASKS_LIMIT),
    ),
    maxReviewRounds: Math.max(1, init.maxReviewRounds ?? 5),
    currentReviewRound: Math.max(0, init.currentReviewRound ?? 0),
    revision: init.revision ?? 0,
    createdAt: init.createdAt ?? now,
    updatedAt: init.updatedAt ?? now,
    archivedAt: init.archivedAt ?? null,
  };
}

export interface TaskBatch {
  id: string;
  runID: string;
  contextSummary: string;
  createdAt: number;
}

export function makeTaskBatch(init: {
  id?: string;
  runID: string;
  contextSummary?: string;
  createdAt?: number;
}): TaskBatch {
  return {
    id: init.id ?? randomUUID(),
    runID: init.runID,
    contextSummary: init.contextSummary ?? "",
    createdAt: init.createdAt ?? Date.now() / 1000,
  };
}

export interface ChildTask {
  id: string;
  runID: string;
  batchID: string | null;
  clientKey: string | null;
  parentTaskID: string | null;
  title: string;
  prompt: string;
  agentKind: ChildAgentKind;
  /** Per-task model override; null falls back to the per-kind setting, then the agent default. */
  model: string | null;
  executionMode: TaskExecutionMode;
  workspaceKind: TaskWorkspaceKind;
  baselineCommit: string;
  branchName: string;
  worktreePath: string;
  contextSnapshot: string;
  sessionID: string | null;
  currentAttemptID: string | null;
  status: ChildTaskStatus;
  latestReport: string | null;
  latestError: string | null;
  reviewRound: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export function makeChildTask(init: {
  id?: string;
  runID: string;
  batchID?: string | null;
  clientKey?: string | null;
  parentTaskID?: string | null;
  title: string;
  prompt: string;
  agentKind?: ChildAgentKind;
  model?: string | null;
  executionMode?: TaskExecutionMode;
  workspaceKind?: TaskWorkspaceKind;
  baselineCommit: string;
  branchName: string;
  worktreePath: string;
  contextSnapshot?: string;
  sessionID?: string | null;
  currentAttemptID?: string | null;
  status?: ChildTaskStatus;
  latestReport?: string | null;
  latestError?: string | null;
  reviewRound?: number;
  revision?: number;
  createdAt?: number;
  updatedAt?: number;
}): ChildTask {
  const now = Date.now() / 1000;
  return {
    id: init.id ?? randomUUID(),
    runID: init.runID,
    batchID: init.batchID ?? null,
    clientKey: init.clientKey ?? null,
    parentTaskID: init.parentTaskID ?? null,
    title: init.title,
    prompt: init.prompt,
    agentKind: init.agentKind ?? "claude_code",
    model: init.model ?? null,
    executionMode: init.executionMode ?? "workspace_write",
    workspaceKind: init.workspaceKind ?? "isolated_write",
    baselineCommit: init.baselineCommit,
    branchName: init.branchName,
    worktreePath: init.worktreePath,
    contextSnapshot: init.contextSnapshot ?? "",
    sessionID: init.sessionID ?? null,
    currentAttemptID: init.currentAttemptID ?? null,
    status: init.status ?? "queued",
    latestReport: init.latestReport ?? null,
    latestError: init.latestError ?? null,
    reviewRound: init.reviewRound ?? 0,
    revision: init.revision ?? 0,
    createdAt: init.createdAt ?? now,
    updatedAt: init.updatedAt ?? now,
  };
}

export const TASK_ATTEMPT_STATUSES = ["running", "reported", "failed", "cancelled"] as const;
export type TaskAttemptStatus = (typeof TASK_ATTEMPT_STATUSES)[number];

export interface TaskAttempt {
  id: string;
  runID: string;
  taskID: string;
  number: number;
  prompt: string;
  sessionID: string | null;
  status: TaskAttemptStatus;
  startedAt: number;
  finishedAt: number | null;
  failure: string | null;
}

export interface TaskExecutionReport {
  id: string;
  runID: string;
  taskID: string;
  attemptID: string;
  sessionID: string;
  summary: string;
  rawOutput: string;
  tests: string[];
  changedFiles: string[];
  diffSummary: string | null;
  blocker: string | null;
  createdAt: number;
}

/** Bounded, redacted diagnostics for the current attempt. */
export interface TaskExecutionLog {
  id: string;
  runID: string;
  taskID: string;
  attemptID: string;
  stdoutTail: string;
  stderrTail: string;
  latestActivity: string | null;
  toolSummary: string[];
  updatedAt: number;
}

export interface ReviewFeedback {
  summary: string;
  findings: ReviewFinding[];
}

export interface TaskDependency {
  id: string;
  runID: string;
  taskID: string;
  dependsOnTaskID: string;
}

export interface ReviewCycle {
  id: string;
  runID: string;
  taskID: string | null;
  round: number;
  reviewer: string;
  verdict: ReviewVerdict;
  summary: string;
  createdAt: number;
}

export interface RelayEvent {
  id: string;
  runID: string;
  taskID: string | null;
  sequence: number;
  kind: string;
  payload: string;
  createdAt: number;
}

export interface TeamRunSnapshot {
  run: TeamRun;
  batches: TaskBatch[];
  tasks: ChildTask[];
  dependencies: TaskDependency[];
  reviewCycles: ReviewCycle[];
  findings: ReviewFinding[];
  attempts: TaskAttempt[];
  reports: TaskExecutionReport[];
  executionLogs: TaskExecutionLog[];
  events: RelayEvent[];
}

export interface TeamRunSummary {
  id: string;
  repositoryPath: string;
  task: string;
  status: TeamRunStatus;
  taskCount: number;
  acceptedTaskCount: number;
  updatedAt: number;
  /** Epoch seconds when the run moved to the sidebar's archived section. */
  archivedAt: number | null;
}

/** Light segmented first-screen view (run header, tasks, dependency graph). */
export interface RunSummary {
  run: TeamRun;
  batches: TaskBatch[];
  tasks: ChildTask[];
  dependencies: TaskDependency[];
}

export interface ContextTaskDigest {
  id: string;
  title: string;
  status: string;
  agentKind: string;
  executionMode: string;
  hasReport: boolean;
  reportBytes: number;
}

export interface ContextFetchDigest {
  summary: string;
  tasks: ContextTaskDigest[];
  generatedAt: number;
}

export interface TaskReportPayload {
  taskID: string;
  report: string;
  truncated: boolean;
}

/** Pure renderer for read-only context summaries (redaction applied by caller). */
export function renderTeamContextSummary(summary: RunSummary, now = Date.now() / 1000): string {
  const lines: string[] = [];
  lines.push(`TeamRun ${summary.run.id.slice(0, 8)} — task: ${summary.run.task}`);
  lines.push(
    `status: ${summary.run.status}, branch: ${
      summary.run.targetBranch.length === 0 ? "detached HEAD" : summary.run.targetBranch
    }, baseline: ${summary.run.baselineCommit.slice(0, 10)}`,
  );
  lines.push(`generated_at: ${new Date(now * 1000).toISOString()}`);
  lines.push(`tasks (${summary.tasks.length}):`);
  for (const task of summary.tasks) {
    const report = task.latestReport == null ? "no" : `yes(${task.latestReport.length}B)`;
    const parent = task.parentTaskID ? ` parent=${task.parentTaskID.slice(0, 8)}` : "";
    lines.push(
      `- [${task.id.slice(0, 8)}] ${task.title} — ${task.status}, ${task.agentKind}/${task.executionMode}, report=${report}${parent}`,
    );
  }
  if (summary.dependencies.length > 0) {
    lines.push("dependencies:");
    for (const dependency of summary.dependencies) {
      lines.push(`- ${dependency.taskID.slice(0, 8)} depends on ${dependency.dependsOnTaskID.slice(0, 8)}`);
    }
  }
  return lines.join("\n");
}

// ---- v0.4 Review Center & quality gates (specs/002-v04-review-center-gates) ----
// New-in-v0.4 entities; not part of the Swift port above. Same conventions:
// string-literal unions with helper tables, epoch-second timestamps, UUID ids.

export const REVIEW_COMMENT_STATUSES = ["open", "resolved", "dismissed", "line_changed"] as const;
export type ReviewCommentStatus = (typeof REVIEW_COMMENT_STATUSES)[number];

export const REVIEW_COMMENT_SEVERITIES = ["info", "risk"] as const;
export type ReviewCommentSeverity = (typeof REVIEW_COMMENT_SEVERITIES)[number];

/** Comment authors: the human reviewer plus every supported child-agent kind. */
export const REVIEW_COMMENT_AUTHORS = ["user", ...CHILD_AGENT_KINDS] as const;
export type ReviewCommentAuthor = (typeof REVIEW_COMMENT_AUTHORS)[number];

export function reviewCommentStatusIsTerminal(status: ReviewCommentStatus): boolean {
  return status === "resolved" || status === "dismissed" || status === "line_changed";
}

/**
 * Only `open` may transition (→ resolved / dismissed / line_changed); terminal
 * states are final and irreversible. `line_changed` keeps the anchor snapshot
 * and reopens the discussion on the moved line (spec edge case: comments must
 * not be silently lost when rework shifts their anchor).
 */
const REVIEW_COMMENT_TRANSITIONS: Record<ReviewCommentStatus, readonly ReviewCommentStatus[]> = {
  open: ["resolved", "dismissed", "line_changed"],
  resolved: [],
  dismissed: [],
  line_changed: [],
};

export function canTransitionReviewComment(from: ReviewCommentStatus, to: ReviewCommentStatus): boolean {
  return REVIEW_COMMENT_TRANSITIONS[from].includes(to);
}

/** Line-anchored review comment (specs/002 data-model: review_comments). */
export interface ReviewComment {
  id: string;
  runID: string;
  taskID: string;
  reviewRound: number;
  filePath: string;
  /** Line anchor on the baseline side of the task diff. */
  lineStart: number;
  lineEnd: number;
  /** Anchor-line content snapshot (≤2 KiB) kept when rework shifts the line. */
  contextSnapshot: string;
  body: string;
  severity: ReviewCommentSeverity;
  author: ReviewCommentAuthor;
  status: ReviewCommentStatus;
  createdAt: number;
  updatedAt: number;
}

export function makeReviewComment(init: {
  id?: string;
  runID: string;
  taskID: string;
  reviewRound?: number;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  contextSnapshot?: string;
  body: string;
  severity?: ReviewCommentSeverity;
  author?: ReviewCommentAuthor;
  status?: ReviewCommentStatus;
  createdAt?: number;
  updatedAt?: number;
}): ReviewComment {
  const now = Date.now() / 1000;
  return {
    id: init.id ?? randomUUID(),
    runID: init.runID,
    taskID: init.taskID,
    reviewRound: init.reviewRound ?? 0,
    filePath: init.filePath,
    lineStart: init.lineStart,
    lineEnd: init.lineEnd ?? init.lineStart,
    contextSnapshot: init.contextSnapshot ?? "",
    body: init.body,
    severity: init.severity ?? "info",
    author: init.author ?? "codex",
    status: init.status ?? "open",
    createdAt: init.createdAt ?? now,
    updatedAt: init.updatedAt ?? now,
  };
}

/** Per-check identifiers (specs/002 data-model: gate_evaluation_items.check_key). */
export const GATE_CHECK_KEYS = [
  "tests",
  "lint",
  "typecheck",
  "build",
  "risk_findings",
  "scope",
  "dependencies",
  "target_baseline",
  "reviewers",
  "high_risk_confirm",
  "todo_clean",
] as const;
export type GateCheckKey = (typeof GATE_CHECK_KEYS)[number];

/** `unknown` marks timeout/unverifiable checks; it never blocks by itself. */
export const GATE_CHECK_STATUSES = ["pass", "fail", "waived", "unknown"] as const;
export type GateCheckStatus = (typeof GATE_CHECK_STATUSES)[number];

export const GATE_OVERALLS = ["pass", "fail", "waived"] as const;
export type GateOverall = (typeof GATE_OVERALLS)[number];

export const GATE_REVIEW_MODES = [
  "standard",
  "cross_model",
  "dual_readonly",
  "contest",
  "role_based",
  "arbitration",
] as const;
export type GateReviewMode = (typeof GATE_REVIEW_MODES)[number];

/** Reviewer disagreement entry stored in arbitrations.disagreements_json. */
export interface ArbitrationDisagreement {
  reviewer: string;
  verdict: ReviewVerdict;
  evidence: string;
}

/** Follow-up entry stored in arbitrations.to_verify_json. */
export interface ArbitrationToVerify {
  claim: string;
  howToVerify: string;
}

/** Arbitration outcome (specs/002 data-model: arbitrations). Pure data. */
export interface Arbitration {
  id: string;
  runID: string;
  taskID: string;
  consensus: string;
  disagreements: ArbitrationDisagreement[];
  toVerify: ArbitrationToVerify[];
  /** FR-013: disagreement forbids auto-pass; stays false until resolved. */
  autoPassed: boolean;
  createdAt: number;
}

export function makeArbitration(init: {
  id?: string;
  runID: string;
  taskID: string;
  consensus?: string;
  disagreements?: ArbitrationDisagreement[];
  toVerify?: ArbitrationToVerify[];
  autoPassed?: boolean;
  createdAt?: number;
}): Arbitration {
  return {
    id: init.id ?? randomUUID(),
    runID: init.runID,
    taskID: init.taskID,
    consensus: init.consensus ?? "",
    disagreements: init.disagreements ?? [],
    toVerify: init.toVerify ?? [],
    autoPassed: init.autoPassed ?? false,
    createdAt: init.createdAt ?? Date.now() / 1000,
  };
}

/** Delivery summary (specs/002 data-model: delivery_summaries). Pure data. */
export interface DeliverySummary {
  id: string;
  runID: string;
  /** Null for the run-level final review summary. */
  taskID: string | null;
  verdict: ReviewVerdict;
  summaryMD: string;
  /** Evidence references (report/log/diff/gate/review ids). */
  evidence: string[];
  createdAt: number;
}

export function makeDeliverySummary(init: {
  id?: string;
  runID: string;
  taskID?: string | null;
  verdict: ReviewVerdict;
  summaryMD?: string;
  evidence?: string[];
  createdAt?: number;
}): DeliverySummary {
  return {
    id: init.id ?? randomUUID(),
    runID: init.runID,
    taskID: init.taskID ?? null,
    verdict: init.verdict,
    summaryMD: init.summaryMD ?? "",
    evidence: init.evidence ?? [],
    createdAt: init.createdAt ?? Date.now() / 1000,
  };
}

/** Domain error carrying the same user-facing messages as the Swift enum. */
export type DomainErrorKind =
  | "invalidTask"
  | "invalidTransition"
  | "activeTeamRunExists"
  | "concurrencyLimitReached"
  | "reviewLimitReached"
  | "missingDependency"
  | "dependencyCycle"
  | "optimisticLockFailed"
  | "runNotFound"
  | "taskNotFound"
  | "taskNotReady"
  | "finalReviewRequired"
  | "invalidTaskReference"
  | "duplicateClientKey"
  | "contextTooLarge"
  | "batchNotFound"
  | "reportNotAvailable";

export class DomainError extends Error {
  readonly kind: DomainErrorKind;

  constructor(kind: DomainErrorKind, message: string) {
    super(message);
    this.name = "DomainError";
    this.kind = kind;
  }

  static invalidTask(message: string): DomainError {
    return new DomainError("invalidTask", message);
  }
  static invalidTransition(entity: string, from: string, to: string): DomainError {
    return new DomainError("invalidTransition", `Invalid ${entity} transition: ${from} → ${to}`);
  }
  static activeTeamRunExists(): DomainError {
    return new DomainError("activeTeamRunExists", "This session already has an active TeamRun.");
  }
  static concurrencyLimitReached(): DomainError {
    return new DomainError(
      "concurrencyLimitReached",
      "The run already reached its max concurrent child-agent tasks.",
    );
  }
  static reviewLimitReached(): DomainError {
    return new DomainError(
      "reviewLimitReached",
      "The review limit was reached; explicit resume or cancellation is required.",
    );
  }
  static missingDependency(id: string): DomainError {
    return new DomainError("missingDependency", `Dependency task does not exist: ${id}`);
  }
  static dependencyCycle(): DomainError {
    return new DomainError("dependencyCycle", "Task dependencies contain a cycle.");
  }
  static optimisticLockFailed(): DomainError {
    return new DomainError("optimisticLockFailed", "The aggregate changed; reload and retry the command.");
  }
  static runNotFound(id: string): DomainError {
    return new DomainError("runNotFound", `TeamRun not found: ${id}`);
  }
  static taskNotFound(id: string): DomainError {
    return new DomainError("taskNotFound", `Child task not found: ${id}`);
  }
  static taskNotReady(id: string): DomainError {
    return new DomainError("taskNotReady", `Child task is not ready for this operation: ${id}`);
  }
  static finalReviewRequired(): DomainError {
    return new DomainError("finalReviewRequired", "Final Codex review must be PASS before completing the team.");
  }
  static invalidTaskReference(message: string): DomainError {
    return new DomainError("invalidTaskReference", `Invalid task reference: ${message}`);
  }
  static duplicateClientKey(key: string): DomainError {
    return new DomainError("duplicateClientKey", `Duplicate batch client key: ${key}`);
  }
  static contextTooLarge(): DomainError {
    return new DomainError("contextTooLarge", "The parent context summary exceeds the 16 KiB limit.");
  }
  static batchNotFound(id: string): DomainError {
    return new DomainError("batchNotFound", `Task batch not found: ${id}`);
  }
  static reportNotAvailable(id: string): DomainError {
    return new DomainError("reportNotAvailable", `No report is available yet for task: ${id}`);
  }
}
