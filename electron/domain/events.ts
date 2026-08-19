// Port of OctoPunk/OctoPunk/Domain/Events/TeamEvents.swift.

import { randomUUID } from "node:crypto";

export const TeamEventKind = {
  teamStarted: "team.started",
  taskDelegated: "task.delegated",
  taskBaselinePrepared: "task.baseline_prepared",
  taskStarted: "task.started",
  agentSession: "agent.session",
  agentOutput: "agent.output",
  agentTool: "agent.tool",
  agentCompleted: "agent.completed",
  agentFailed: "agent.failed",
  agentCancelled: "agent.cancelled",
  taskReported: "task.reported",
  reviewRequested: "review.requested",
  reviewRework: "review.rework",
  taskAccepted: "task.accepted",
  taskBlocked: "task.blocked",
  taskFailed: "task.failed",
  taskResumed: "task.resumed",
  taskCancelled: "task.cancelled",
  taskDiscarded: "task.discarded",
  teamCompleted: "team.completed",
  teamCancelled: "team.cancelled",
  teamFailed: "team.failed",
  teamDiscarded: "team.discarded",
  resultApplied: "team.result_applied",
  integrationConflict: "integration.conflict",
  migrationImported: "migration.imported",
  /** Read-only context fetched live by a sub-agent; metadata only — never content. */
  contextFetched: "context.fetched",
  /** Soft delete: the run left the sidebar list; its audit record stays. */
  runHidden: "run.hidden",
  /** Reversible alternative to hiding: the run moved to the archived section. */
  runArchived: "run.archived",
  /** An archived run was restored to the active sidebar list. */
  runUnarchived: "run.unarchived",
  /** The run was paused: new quota grants stop, in-flight tasks continue. */
  runPaused: "run.paused",
  /** A paused run resumed; queued tasks continue by priority. */
  runResumed: "run.resumed",
  /** The run's scheduling priority changed; payload carries old/new values. */
  runPriorityChanged: "run.priorityChanged",
  /** Batch of line-anchored review comments persisted (specs/002 v0.4 review center). */
  reviewCommentAdded: "review.comment_added",
  /** A review comment moved open → resolved/dismissed/line_changed (irreversible, audited). */
  reviewCommentStatusChanged: "review.comment_status_changed",
  /** A quality-gate evaluation was recorded for a task. */
  gateEvaluated: "gate.evaluated",
  /** A failed gate item was waived with a per-item audit trail (overall recalc is upstream). */
  gateItemWaived: "gate.item_waived",
  /** An arbitration outcome (consensus / disagreements / to-verify) was recorded. */
  arbitrationRecorded: "arbitration.recorded",
  /** A delivery summary was generated for a task or the whole run. */
  summaryGenerated: "summary.generated",
} as const;

export interface TeamEventPayload {
  message: string;
  requestID: string | null;
  metadata: Record<string, string>;
}

export function makeTeamEventPayload(
  message: string,
  requestID: string | null = null,
  metadata: Record<string, string> = {},
): TeamEventPayload {
  return { message, requestID, metadata };
}

export function encodeTeamEventPayload(payload: TeamEventPayload): string {
  return stableStringify(payload);
}

export interface TaskEventUpdate {
  runID: string;
  batchID: string | null;
  taskID: string | null;
  parentTaskID: string | null;
  sequence: number;
  kind: string;
  status: string | null;
  activityPreview: string | null;
  createdAt: number;
}

/** In-process live event hub with the same per-task 0.25s activity throttle. */
export class TaskEventHub {
  private sinks = new Map<string, (update: TaskEventUpdate) => void | Promise<void>>();
  private lastActivityAt = new Map<string, number>();

  subscribe(sink: (update: TaskEventUpdate) => void | Promise<void>): string {
    const id = randomUUID();
    this.sinks.set(id, sink);
    return id;
  }

  unsubscribe(id: string): void {
    this.sinks.delete(id);
  }

  publish(update: TaskEventUpdate): void {
    if (
      (update.kind === TeamEventKind.agentOutput || update.kind === TeamEventKind.agentTool) &&
      update.taskID != null
    ) {
      const now = update.createdAt;
      const previous = this.lastActivityAt.get(update.taskID);
      if (previous != null && now - previous < 0.25) {
        return;
      }
      this.lastActivityAt.set(update.taskID, now);
    }
    for (const sink of [...this.sinks.values()]) {
      void Promise.resolve(sink(update)).catch(() => {
        // A slow or failing live sink never blocks the audit path.
      });
    }
  }
}

/**
 * Deterministic JSON codec equivalent to the Swift `JSONEncoder.octoPunk`:
 * dates are already epoch-second numbers and keys are sorted so idempotency
 * replays stay byte-for-byte equal to the original command result.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",") + "}";
}
