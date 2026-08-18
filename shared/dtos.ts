// Shared DTO contracts between the Electron main process and the React
// renderer. Types only plus pure helpers (no Node APIs) so both tsconfigs
// can include this directory. Mirrors OctoPunk/OctoPunk/Application/DTOs.

export type TeamRunStatus =
  | "ready"
  | "running"
  | "reviewing"
  | "awaiting_final_review"
  | "completed"
  | "blocked"
  | "cancelled"
  | "failed";

export type ChildTaskStatus =
  | "queued"
  | "running"
  | "awaiting_report"
  | "rework_required"
  | "accepted"
  | "blocked"
  | "cancelled"
  | "failed";

export type ChildAgentKind = "claude_code" | "codex";
export type TaskExecutionMode = "read_only" | "workspace_write";
export type TaskWorkspaceKind = "shared_read_only" | "isolated_write";
export type ReviewVerdict = "PASS" | "REWORK" | "BLOCKED";
export type ReviewFindingSeverity = "blocker" | "high" | "medium" | "low" | "info";

/** Timestamps are REAL epoch seconds, exactly like the SQLite storage. */
export type EpochSeconds = number;

export interface TeamRunDTO {
  id: string;
  repositoryPath: string;
  task: string;
  baselineCommit: string;
  targetBranch: string;
  status: string;
  currentReviewRound: number;
  maxReviewRounds: number;
  revision: number;
  createdAt: EpochSeconds;
  updatedAt: EpochSeconds;
}

export interface ChildTaskDTO {
  id: string;
  runID: string;
  batchID: string | null;
  clientKey: string | null;
  parentTaskID: string | null;
  title: string;
  status: string;
  agentKind: string;
  executionMode: string;
  workspaceKind: string;
  sessionID: string | null;
  currentAttemptID: string | null;
  branchName: string;
  worktreePath: string;
  baselineCommit: string;
  contextSnapshot: string;
  latestReport: string | null;
  latestError: string | null;
  reviewRound: number;
  updatedAt: EpochSeconds;
}

export interface TaskBatchDTO {
  id: string;
  runID: string;
  contextSummary: string;
  createdAt: EpochSeconds;
  taskIDs: string[];
}

export interface DelegateTaskMappingDTO {
  clientKey: string;
  task: ChildTaskDTO;
}

export interface DelegateTasksResultDTO {
  batch: TaskBatchDTO;
  tasks: ChildTaskDTO[];
  taskMapping: DelegateTaskMappingDTO[];
}

export interface TaskExecutionLogDTO {
  id: string;
  runID: string;
  taskID: string;
  attemptID: string;
  stdoutTail: string;
  stderrTail: string;
  latestActivity: string | null;
  toolSummary: string[];
  updatedAt: EpochSeconds;
}

export interface ReviewFindingDTO {
  id: string;
  taskID: string | null;
  severity: string;
  file: string | null;
  line: number | null;
  evidence: string;
  expectedFix: string | null;
}

export interface RelayEventDTO {
  id: string;
  runID: string;
  taskID: string | null;
  sequence: number;
  kind: string;
  payload: string;
  createdAt: EpochSeconds;
}

export interface TaskDependencyDTO {
  id: string;
  runID: string;
  taskID: string;
  dependsOnTaskID: string;
}

export interface ReviewCycleDTO {
  id: string;
  runID: string;
  taskID: string | null;
  round: number;
  reviewer: string;
  verdict: string;
  summary: string;
  createdAt: EpochSeconds;
}

export interface TaskAttemptDTO {
  id: string;
  runID: string;
  taskID: string;
  number: number;
  prompt: string;
  sessionID: string | null;
  status: string;
  startedAt: EpochSeconds;
  finishedAt: EpochSeconds | null;
  failure: string | null;
}

export interface TaskExecutionReportDTO {
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
  createdAt: EpochSeconds;
}

/** First-screen payload for the run detail view (spec 001 US1). */
export interface RunSummaryDTO {
  run: TeamRunDTO;
  batches: TaskBatchDTO[];
  tasks: ChildTaskDTO[];
  dependencies: TaskDependencyDTO[];
  /** Precomputed tree-depth index (O(n)); capped at 8. */
  treeDepth: Record<string, number>;
}

export function treeTitleFor(task: ChildTaskDTO, treeDepth: Record<string, number>): string {
  const depth = treeDepth[task.id] ?? 0;
  return "  ".repeat(depth) + (depth > 0 ? "↳ " : "") + task.title;
}

/** Audit-event tail; `lastSequence` is the backward-paging cursor. */
export interface EventTailDTO {
  events: RelayEventDTO[];
  lastSequence: number;
}

export interface TeamStatusDTO {
  run: TeamRunDTO;
  batches: TaskBatchDTO[];
  tasks: ChildTaskDTO[];
  dependencies: TaskDependencyDTO[];
  reviewCycles: ReviewCycleDTO[];
  findings: ReviewFindingDTO[];
  attempts: TaskAttemptDTO[];
  reports: TaskExecutionReportDTO[];
  executionLogs: TaskExecutionLogDTO[];
  events: RelayEventDTO[];
}

export interface TeamReviewContextDTO {
  run: TeamRunDTO;
  batches: TaskBatchDTO[];
  tasks: ChildTaskDTO[];
  reports: Record<string, string>;
  findings: ReviewFindingDTO[];
  attempts: TaskAttemptDTO[];
  executionReports: TaskExecutionReportDTO[];
  executionLogs: TaskExecutionLogDTO[];
  latestEvents: RelayEventDTO[];
}

export interface TaskExecutionLogSliceDTO {
  taskID: string;
  log: TaskExecutionLogDTO | null;
  events: RelayEventDTO[];
}

export interface TaskReportDTO {
  task: ChildTaskDTO;
  report: string | null;
  status: string;
  executionReport: TaskExecutionReportDTO | null;
}

export interface JoinedTaskDTO {
  id: string;
  clientKey: string | null;
  parentTaskID: string | null;
  title: string;
  status: string;
  agentKind: string;
  executionMode: string;
  report: string | null;
  latestError: string | null;
  executionReport: TaskExecutionReportDTO | null;
  elapsedSeconds: number;
}

export interface JoinTasksDTO {
  runID: string;
  batchID: string | null;
  tasks: JoinedTaskDTO[];
  pendingTaskIDs: string[];
  timedOut: boolean;
  latestEventSequence: number;
  markdownSummary: string;
}

export interface TeamRunSummaryDTO {
  id: string;
  repositoryPath: string;
  task: string;
  status: TeamRunStatus;
  taskCount: number;
  acceptedTaskCount: number;
  updatedAt: EpochSeconds;
  archivedAt: EpochSeconds | null;
}

export interface ContextTaskDigestDTO {
  id: string;
  title: string;
  status: string;
  agentKind: string;
  executionMode: string;
  hasReport: boolean;
  reportBytes: number;
}

export interface ContextFetchDigestDTO {
  summary: string;
  tasks: ContextTaskDigestDTO[];
  generatedAt: EpochSeconds;
}

export interface TaskReportPayloadDTO {
  taskID: string;
  report: string;
  truncated: boolean;
}

export interface ChildAgentAvailabilityDTO {
  kind: ChildAgentKind;
  executable: string;
  isAvailable: boolean;
  detail: string;
}

export interface TaskEventUpdateDTO {
  runID: string;
  batchID: string | null;
  taskID: string | null;
  parentTaskID: string | null;
  sequence: number;
  kind: string;
  status: string | null;
  activityPreview: string | null;
  createdAt: EpochSeconds;
}

export const AGENT_KINDS: ChildAgentKind[] = ["claude_code", "codex"];
export const EXECUTION_MODES: TaskExecutionMode[] = ["read_only", "workspace_write"];

export function displayNameForAgentKind(kind: string): string {
  return kind === "codex" ? "Codex" : kind === "claude_code" ? "Claude Code" : kind;
}

export function displayNameForExecutionMode(mode: string): string {
  return mode === "read_only" ? "Read only" : mode === "workspace_write" ? "Workspace write" : mode;
}

export function displayNameForWorkspaceKind(kind: string): string {
  return kind === "shared_read_only"
    ? "Shared read-only baseline"
    : kind === "isolated_write"
      ? "Isolated write worktree"
      : kind;
}

export function displayNameForRunStatus(status: string): string {
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
    default:
      return status;
  }
}

export function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "blocked" || status === "cancelled" || status === "failed";
}

export function canForceCancelRun(status: string): boolean {
  return !isTerminalRunStatus(status);
}

/** Terminal states whose worktrees can still be cleaned up; completed runs never discard. */
export function canDiscardRun(status: string): boolean {
  return status === "blocked" || status === "failed" || status === "cancelled";
}
