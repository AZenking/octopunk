// Port of OctoPunk/OctoPunk/Domain/Repositories/TeamRunRepository.swift.

import type {
  Arbitration,
  ArbitrationDisagreement,
  ArbitrationToVerify,
  ChildAgentKind,
  ChildTask,
  DeliverySummary,
  DoctorCheckKey,
  DoctorCheckStatus,
  DoctorOverall,
  DoctorTriggeredBy,
  GateCheckKey,
  GateCheckStatus,
  GateOverall,
  ReviewComment,
  ReviewCommentAuthor,
  ReviewCommentSeverity,
  ReviewFinding,
  ReviewVerdict,
  TaskExecutionMode,
  TaskExecutionReport,
  TeamRun,
  TeamRunSnapshot,
  TeamRunSummary,
} from "../domain/models";
import type { ContextFetchDigest, TaskReportPayload } from "../domain/models";
import type { ChildAgentEvent } from "../application/ports";

export interface StartTeamInput {
  requestID: string;
  /** Owning MCP session; scopes the single-active-run rule to this session. */
  sessionID: string;
  repositoryPath: string;
  task: string;
  baselineCommit: string;
  targetBranch: string;
  maxConcurrentTasks: number;
  maxReviewRounds: number;
}

export interface DelegateTaskInput {
  requestID: string;
  runID: string;
  title: string;
  prompt: string;
  agentKind: ChildAgentKind;
  /** Per-task model override; null/empty falls back to the per-kind setting. */
  model: string | null;
  executionMode: TaskExecutionMode;
  dependencies: string[];
  /**
   * Delegation-time interactive flag (specs/001-v03 T026): lets the launch gate
   * count the task against the globally reserved interactive slot. Default false.
   */
  interactive?: boolean;
}

export interface TaskReference {
  taskID: string | null;
  clientKey: string | null;
}

export function isExactlyOneReference(reference: TaskReference): boolean {
  return (reference.taskID == null) !== (reference.clientKey == null);
}

export interface DelegateTaskItemInput {
  clientKey: string;
  title: string;
  prompt: string;
  agentKind: ChildAgentKind;
  /** Per-task model override; null/empty falls back to the per-kind setting. */
  model: string | null;
  executionMode: TaskExecutionMode;
  parentTask: TaskReference | null;
  dependencies: TaskReference[];
  /** Interactive-slot eligible (specs/001-v03 T026); default false. */
  interactive?: boolean;
}

export interface DelegateTasksInput {
  requestID: string;
  runID: string;
  contextSummary: string;
  tasks: DelegateTaskItemInput[];
}

export interface DelegateTasksResult {
  batch: import("../domain/models").TaskBatch;
  tasks: ChildTask[];
}

export interface JoinTasksInput {
  runID: string;
  batchID: string | null;
  taskIDs: string[];
  /** Timeout in seconds; clamped to [0, 45] by the service. */
  timeoutSeconds: number;
}

export interface TaskExecutionEventInput {
  runID: string;
  taskID: string;
  event: ChildAgentEvent;
}

export interface TaskReportInput {
  requestID: string;
  runID: string;
  taskID: string;
  sessionID: string;
  report: string;
  rawOutput: string;
  tests: string[];
  changedFiles: string[];
  diffSummary: string | null;
  blocker: string | null;
}

export interface ReviewDecisionInput {
  requestID: string;
  runID: string;
  taskID: string;
  reviewer: string;
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
}

// ---- v0.4 review center & quality gates (specs/002-v04-review-center-gates) ----

/** Persistable shape of one line-anchored review comment (specs/002 data-model). */
export interface ReviewCommentDraft {
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  /** Anchor-line content snapshot (≤2 KiB) captured by the caller. */
  contextSnapshot: string;
  body: string;
  severity: ReviewCommentSeverity;
  author: ReviewCommentAuthor;
}

/** Per-check gate outcome (gate_evaluation_items rows). Pure data. */
export interface GateEvaluationItem {
  id: string;
  evaluationID: string;
  checkKey: GateCheckKey;
  /** `unknown` marks timeout/unverifiable checks; it never blocks by itself. */
  status: GateCheckStatus;
  detail: string;
  fixSuggestion: string | null;
  waivedBy: string | null;
  waivedReason: string | null;
  waivedAt: number | null;
}

/** Full gate judgement with its per-check items (gate_evaluations + items). */
export interface GateEvaluation {
  id: string;
  runID: string;
  taskID: string;
  requestID: string;
  /** pass / fail / waived (recalculated to `waived` once every fail item is waived). */
  overall: GateOverall;
  evaluatedAt: number;
  items: GateEvaluationItem[];
}

/** GitHub PR write-back link (pr_links; one per run+task, upserted). */
export interface PrLink {
  id: string;
  runID: string;
  taskID: string;
  prURL: string;
  prNumber: number;
  lastSyncedAt: number;
}

// ---- v0.3 stability & multi-run (specs/001-v03-stability-multi-teamrun) ----

/** Per-check doctor outcome (doctor_check_items rows). Pure data. */
export interface DoctorReportItem {
  id: string;
  reportID: string;
  checkKey: DoctorCheckKey;
  /** `unknown` marks timeout/unverifiable checks; it never equals a pass. */
  status: DoctorCheckStatus;
  /** Conclusion summary (redacted ≤2 KiB; observed values on fail). */
  detail: string;
  /** Blast radius, e.g. "delegation will fail". */
  impact: string;
  /** Recommended remediation. */
  suggestion: string;
  durationMs: number;
}

/** Full doctor judgement with its per-check items (doctor_reports + items). */
export interface DoctorReport {
  id: string;
  triggeredBy: DoctorTriggeredBy;
  /** Repository the report targets; null covers the global checks. */
  repositoryPath: string | null;
  /** pass / fail / degraded — derived via doctorOverallOf at write time. */
  overall: DoctorOverall;
  items: DoctorReportItem[];
  createdAt: number;
}

/** Minimal observation contract shared by all segmented queries (constitution I). */
export interface AsyncStream<T> extends AsyncIterable<T> {
  cancel(): void;
}

export function makeStream<T>(
  subscribe: (emit: (value: T) => void, fail: (error: Error) => void) => () => void,
): AsyncStream<T> {
  const queued: T[] = [];
  let error: Error | null = null;
  let finished = false;
  let waiter: ((step: { value?: T; error?: Error; done?: boolean }) => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let started = false;

  const ensureSubscribed = (): void => {
    if (started) return;
    started = true;
    unsubscribe = subscribe(
      (value) => {
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve({ value });
        } else {
          queued.push(value);
        }
      },
      (failure) => {
        error = failure;
        finished = true;
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve({ error: failure });
        }
      },
    );
  };

  const stream: AsyncStream<T> = {
    cancel(): void {
      finished = true;
      unsubscribe?.();
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          ensureSubscribed();
          if (queued.length > 0) {
            return { value: queued.shift() as T, done: false };
          }
          if (error) {
            throw error;
          }
          if (finished) {
            return { value: undefined as never, done: true };
          }
          const step = await new Promise<{ value?: T; error?: Error; done?: boolean }>((resolve) => {
            waiter = resolve;
          });
          if (step.error) throw step.error;
          if (step.done) return { value: undefined as never, done: true };
          return { value: step.value as T, done: false };
        },
      };
    },
  };
  return stream;
}

export interface TeamRunRepository {
  startTeam(input: StartTeamInput): Promise<TeamRunSnapshot>;
  delegateTask(input: DelegateTaskInput): Promise<ChildTask>;
  delegateTasks(input: DelegateTasksInput): Promise<DelegateTasksResult>;
  setTaskBaseline(input: {
    requestID: string;
    runID: string;
    taskID: string;
    baselineCommit: string;
  }): Promise<ChildTask>;
  markTaskRunning(input: {
    requestID: string;
    runID: string;
    taskID: string;
    sessionID: string | null;
  }): Promise<ChildTask>;
  submitReport(input: TaskReportInput): Promise<ChildTask>;
  recordTaskExecutionEvent(input: TaskExecutionEventInput): Promise<void>;
  requestRework(input: ReviewDecisionInput): Promise<ChildTask>;
  acceptTask(input: ReviewDecisionInput): Promise<ChildTask>;
  blockTask(input: ReviewDecisionInput): Promise<ChildTask>;
  failTask(input: {
    requestID: string;
    runID: string;
    taskID: string;
    summary: string;
    /** False when an automatic retry is pending: keep the run draining siblings. */
    blockRun?: boolean;
  }): Promise<ChildTask>;
  resumeTask(input: { requestID: string; runID: string; taskID: string }): Promise<ChildTask>;
  cancelTask(input: { requestID: string; runID: string; taskID: string }): Promise<ChildTask>;
  completeTeam(input: {
    requestID: string;
    runID: string;
    finalVerdict: ReviewVerdict;
    summary: string;
  }): Promise<TeamRunSnapshot>;
  cancelTeam(input: { requestID: string; runID: string }): Promise<TeamRunSnapshot>;
  /** Soft delete: hides the run from the sidebar; the audit record stays persisted. */
  hideRun(input: { requestID: string; runID: string }): Promise<void>;
  /** Moves a finished run to the archived section; reversible via unarchiveRun. */
  archiveRun(input: { requestID: string; runID: string }): Promise<void>;
  /** Restores an archived run to the active sidebar list. */
  unarchiveRun(input: { requestID: string; runID: string }): Promise<void>;
  snapshot(runID: string): Promise<TeamRunSnapshot>;
  /** With a sessionID: that session's active run; without: the most recent active run overall. */
  activeRun(sessionID?: string): Promise<TeamRunSnapshot | null>;
  /** Session teardown: flips the session's still-active runs to `failed`; returns the failed run IDs. */
  failActiveRunsForSession(input: { sessionID: string; reason: string }): Promise<string[]>;
  listRuns(): Promise<TeamRunSummary[]>;
  events(runID: string, after: number | null): Promise<import("../domain/models").RelayEvent[]>;
  executionLog(runID: string, taskID: string): Promise<import("../domain/models").TaskExecutionLog | null>;
  observe(runID: string): AsyncStream<TeamRunSnapshot>;
  importLegacySnapshot(data: Buffer, sourceURL: string): Promise<TeamRunSnapshot | null>;
  // Segmented queries and observations (constitution I).
  runSummary(runID: string): Promise<import("../domain/models").RunSummary>;
  observeRunSummary(runID: string): AsyncStream<import("../domain/models").RunSummary>;
  eventTail(runID: string, limit: number): Promise<import("../domain/models").RelayEvent[]>;
  eventPage(runID: string, before: number, limit: number): Promise<import("../domain/models").RelayEvent[]>;
  observeEventTail(runID: string, limit: number): AsyncStream<import("../domain/models").RelayEvent[]>;
  /** Streams the selected task's execution log on every write (value-deduped). */
  observeExecutionLog(runID: string, taskID: string): AsyncStream<import("../domain/models").TaskExecutionLog | null>;
  observeRunSummaries(): AsyncStream<TeamRunSummary[]>;
  fetchTeamContext(input: {
    requestID: string;
    runID: string;
    requesterTaskID: string;
  }): Promise<ContextFetchDigest>;
  fetchTaskReport(input: {
    requestID: string;
    runID: string;
    requesterTaskID: string;
    targetTaskID: string;
  }): Promise<TaskReportPayload>;
  // ---- v0.4 review center & quality gates (specs/002-v04-review-center-gates) ----
  /**
   * Batch-inserts line-anchored review comments in one transaction. Anchors
   * must belong to the task's diff — that validation lives in the service
   * layer; the repository only persists.
   */
  addReviewComments(input: {
    requestID: string;
    runID: string;
    taskID: string;
    comments: ReviewCommentDraft[];
  }): Promise<ReviewComment[]>;
  listReviewComments(runID: string, taskID: string): Promise<ReviewComment[]>;
  /** Unresolved findings across the run's tasks; risk-severity entries first. */
  listOpenReviewComments(runID: string): Promise<ReviewComment[]>;
  /**
   * Moves an `open` comment to a terminal state. Invalid transitions throw
   * `DomainError.invalidTransition` (terminal states are irreversible).
   */
  setReviewCommentStatus(input: {
    requestID: string;
    runID: string;
    commentID: string;
    status: "resolved" | "dismissed" | "line_changed";
  }): Promise<ReviewComment>;
  /** Project-default gate config; null when the project never saved one. */
  getGateConfig(repositoryPath: string): Promise<{ configJson: string; updatedAt: number } | null>;
  saveGateConfig(input: { repositoryPath: string; configJson: string; updatedAt: number }): Promise<void>;
  /** Idempotent: replaying the same requestID returns the cached evaluation. */
  recordGateEvaluation(input: {
    requestID: string;
    runID: string;
    taskID: string;
    overall: GateOverall;
    items: {
      checkKey: GateCheckKey;
      status: GateCheckStatus;
      detail: string;
      fixSuggestion?: string | null;
    }[];
  }): Promise<GateEvaluation>;
  getLatestGateEvaluation(runID: string, taskID: string): Promise<GateEvaluation | null>;
  /** Items of one evaluation — the read model for service-layer overall recalc. */
  listGateEvaluationItems(evaluationID: string): Promise<GateEvaluationItem[]>;
  /** Marks one failed item as waived with a per-item audit trail. */
  waiveGateItem(input: {
    requestID: string;
    evaluationID: string;
    itemID: string;
    waivedBy: string;
    waivedReason: string;
  }): Promise<GateEvaluationItem>;
  /**
   * Persists a recalculated overall (the service layer recomputes it from the
   * full item list after a waiver) and re-reads the evaluation with its items.
   * Only writes/audits when the overall actually changes.
   */
  updateGateEvaluationOverall(input: {
    evaluationID: string;
    overall: GateOverall;
  }): Promise<GateEvaluation>;
  recordArbitration(input: {
    runID: string;
    taskID: string;
    consensus: string;
    disagreements: ArbitrationDisagreement[];
    toVerify: ArbitrationToVerify[];
    autoPassed: boolean;
  }): Promise<Arbitration>;
  getArbitration(runID: string, taskID: string): Promise<Arbitration | null>;
  /** taskID null records the run-level final-review summary. */
  recordDeliverySummary(input: {
    runID: string;
    taskID: string | null;
    verdict: ReviewVerdict;
    summaryMd: string;
    evidence: string[];
  }): Promise<DeliverySummary>;
  getDeliverySummary(runID: string, taskID: string | null): Promise<DeliverySummary | null>;
  /** Upserts the (single) PR write-back link of a run+task. */
  savePrLink(input: {
    runID: string;
    taskID: string;
    prURL: string;
    prNumber: number;
    lastSyncedAt?: number;
  }): Promise<PrLink>;
  getPrLink(runID: string, taskID: string): Promise<PrLink | null>;
  /** Reads the run's frozen gate snapshot; null when the run never saved one. */
  getRunGateSnapshot(runID: string): Promise<string | null>;
  /** Freezes the run's effective gates into team_runs.gate_snapshot_json. */
  saveRunGateSnapshot(runID: string, snapshotJson: string): Promise<void>;
  // ---- v0.3 stability & multi-run (specs/001-v03-stability-multi-teamrun) ----
  /**
   * Sets the run's scheduling priority (quota ordering: priority DESC,
   * created_at ASC). Rejects out-of-range values with `DomainError.invalidTask`
   * (isValidRunPriority); idempotent per requestID.
   */
  setRunPriority(input: { requestID: string; runID: string; priority: number }): Promise<TeamRun>;
  /** Pauses the run: stops new quota grants only; in-flight tasks unaffected. */
  pauseRun(input: { requestID: string; runID: string }): Promise<TeamRun>;
  /** Resumes a paused run; queued tasks continue by priority. */
  resumeRun(input: { requestID: string; runID: string }): Promise<TeamRun>;
  /**
   * Idempotent: replaying the same requestID returns the cached report. The
   * overall is derived in the domain (doctorOverallOf), never trusted from input.
   */
  recordDoctorReport(input: {
    requestID: string;
    triggeredBy: DoctorTriggeredBy;
    repositoryPath: string | null;
    items: {
      checkKey: DoctorCheckKey;
      status: DoctorCheckStatus;
      detail: string;
      impact: string;
      suggestion: string;
      durationMs: number;
    }[];
  }): Promise<DoctorReport>;
  /** Latest report for the repository; null queries the global reports. */
  getLatestDoctorReport(repositoryPath: string | null): Promise<DoctorReport | null>;
  /** Updates one item of the report and recalculates overall + updated time. */
  rerunDoctorCheckItem(input: {
    requestID: string;
    reportID: string;
    checkKey: DoctorCheckKey;
    status: DoctorCheckStatus;
    detail: string;
    impact: string;
    suggestion: string;
    durationMs: number;
  }): Promise<DoctorReport>;
  /**
   * Writes the attempt's child PID (set at spawn, cleared to null on clean
   * exit) — the crash-recovery process reconciliation key. Throws unless the
   * attempt belongs to the given task.
   */
  updateAttemptPid(input: {
    runID: string;
    taskID: string;
    attemptID: string;
    pid: number | null;
  }): Promise<void>;
  /**
   * The task's current attempt PID (child_tasks.current_attempt_id →
   * task_attempts.pid) — the read side of the crash-recovery process
   * reconciliation. Null when the task has no attempt / no PID recorded.
   */
  attemptPid(input: { runID: string; taskID: string }): Promise<number | null>;
}

export type { TeamRun, TaskExecutionReport };
