// Port of OctoPunk/OctoPunk/Domain/Repositories/TeamRunRepository.swift.

import type {
  ChildAgentKind,
  ChildTask,
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
}

export type { TeamRun, TaskExecutionReport };
