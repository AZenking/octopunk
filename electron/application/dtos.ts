// Main-side DTO constructors (port of OctoPunk/OctoPunk/Application/DTOs/TeamDTOs.swift).
// The pure DTO types live in shared/dtos.ts so the renderer imports the same contract.

import type {
  ChildTaskDTO,
  DelegateTasksResultDTO,
  EventTailDTO,
  JoinTasksDTO,
  JoinedTaskDTO,
  RelayEventDTO,
  RunSummaryDTO,
  TaskBatchDTO,
  TaskExecutionLogDTO,
  TaskReportDTO,
  TeamReviewContextDTO,
  TeamStatusDTO,
  ReviewFindingDTO,
} from "../../shared/dtos";
import type {
  ChildTask,
  RelayEvent,
  ReviewFinding,
  RunSummary,
  TaskAttempt,
  TaskBatch,
  TaskDependency,
  TaskExecutionLog,
  TaskExecutionReport,
  TeamRun,
  TeamRunSnapshot,
} from "../domain/models";
import type { DelegateTasksResult } from "../domain/repositoryPort";

export function teamRunDTO(run: TeamRun): import("../../shared/dtos").TeamRunDTO {
  return {
    id: run.id,
    repositoryPath: run.repositoryPath,
    task: run.task,
    baselineCommit: run.baselineCommit,
    targetBranch: run.targetBranch,
    status: run.status,
    currentReviewRound: run.currentReviewRound,
    maxReviewRounds: run.maxReviewRounds,
    revision: run.revision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function childTaskDTO(task: ChildTask): ChildTaskDTO {
  return {
    id: task.id,
    runID: task.runID,
    batchID: task.batchID,
    clientKey: task.clientKey,
    parentTaskID: task.parentTaskID,
    title: task.title,
    status: task.status,
    agentKind: task.agentKind,
    executionMode: task.executionMode,
    workspaceKind: task.workspaceKind,
    sessionID: task.sessionID,
    currentAttemptID: task.currentAttemptID,
    branchName: task.branchName,
    worktreePath: task.worktreePath,
    baselineCommit: task.baselineCommit,
    contextSnapshot: task.contextSnapshot,
    latestReport: task.latestReport,
    latestError: task.latestError,
    reviewRound: task.reviewRound,
    updatedAt: task.updatedAt,
  };
}

export function taskBatchDTO(batch: TaskBatch, tasks: ChildTask[]): TaskBatchDTO {
  return {
    id: batch.id,
    runID: batch.runID,
    contextSummary: batch.contextSummary,
    createdAt: batch.createdAt,
    taskIDs: tasks.filter((task) => task.batchID === batch.id).map((task) => task.id),
  };
}

export function delegateTasksResultDTO(result: DelegateTasksResult): DelegateTasksResultDTO {
  return {
    batch: taskBatchDTO(result.batch, result.tasks),
    tasks: result.tasks.map(childTaskDTO),
    taskMapping: result.tasks
      .filter((task) => task.clientKey != null)
      .map((task) => ({ clientKey: task.clientKey as string, task: childTaskDTO(task) })),
  };
}

export function taskExecutionLogDTO(log: TaskExecutionLog): TaskExecutionLogDTO {
  return {
    id: log.id,
    runID: log.runID,
    taskID: log.taskID,
    attemptID: log.attemptID,
    stdoutTail: log.stdoutTail,
    stderrTail: log.stderrTail,
    latestActivity: log.latestActivity,
    toolSummary: log.toolSummary,
    updatedAt: log.updatedAt,
  };
}

export function reviewFindingDTO(finding: ReviewFinding): ReviewFindingDTO {
  return {
    id: finding.id,
    taskID: finding.taskID,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    evidence: finding.evidence,
    expectedFix: finding.expectedFix,
  };
}

export function relayEventDTO(event: RelayEvent): RelayEventDTO {
  return {
    id: event.id,
    runID: event.runID,
    taskID: event.taskID,
    sequence: event.sequence,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

function dependencyDTO(dependency: TaskDependency): import("../../shared/dtos").TaskDependencyDTO {
  return { ...dependency };
}

function attemptDTO(attempt: TaskAttempt): import("../../shared/dtos").TaskAttemptDTO {
  return { ...attempt };
}

function reportDTO(report: TaskExecutionReport): import("../../shared/dtos").TaskExecutionReportDTO {
  return { ...report };
}

/** Precomputes the O(n) tree-depth index capped at 8 (spec 001 US1). */
export function runSummaryDTO(summary: RunSummary): RunSummaryDTO {
  const parents = new Map<string, string | null>();
  for (const task of summary.tasks) {
    if (task.parentTaskID != null) {
      parents.set(task.id, task.parentTaskID);
    }
  }
  const depths: Record<string, number> = {};
  const depthOf = (id: string): number => {
    if (depths[id] != null) return depths[id];
    const parent = parents.get(id) ?? null;
    if (parent == null || parent === id) {
      depths[id] = 0;
      return 0;
    }
    const value = depthOf(parent) + 1;
    depths[id] = Math.min(value, 8);
    return depths[id];
  };
  for (const task of summary.tasks) {
    depths[task.id] = Math.min(depthOf(task.id), 8);
  }
  return {
    run: teamRunDTO(summary.run),
    batches: summary.batches.map((batch) => taskBatchDTO(batch, summary.tasks)),
    tasks: summary.tasks.map(childTaskDTO),
    dependencies: summary.dependencies.map(dependencyDTO),
    treeDepth: depths,
  };
}

export function eventTailDTO(events: RelayEvent[]): EventTailDTO {
  return {
    events: events.map(relayEventDTO),
    lastSequence: events.reduce((max, event) => Math.max(max, event.sequence), 0),
  };
}

export function teamStatusDTO(snapshot: TeamRunSnapshot): TeamStatusDTO {
  return {
    run: teamRunDTO(snapshot.run),
    batches: snapshot.batches.map((batch) => taskBatchDTO(batch, snapshot.tasks)),
    tasks: snapshot.tasks.map(childTaskDTO),
    dependencies: snapshot.dependencies.map(dependencyDTO),
    reviewCycles: snapshot.reviewCycles.map((cycle) => ({ ...cycle })),
    findings: snapshot.findings.map(reviewFindingDTO),
    attempts: snapshot.attempts.map(attemptDTO),
    reports: snapshot.reports.map(reportDTO),
    executionLogs: snapshot.executionLogs.map(taskExecutionLogDTO),
    events: snapshot.events.map(relayEventDTO),
  };
}

export function teamReviewContextDTO(snapshot: TeamRunSnapshot): TeamReviewContextDTO {
  const reports: Record<string, string> = {};
  for (const task of snapshot.tasks) {
    if (task.latestReport != null) {
      reports[task.id] = task.latestReport;
    }
  }
  return {
    run: teamRunDTO(snapshot.run),
    batches: snapshot.batches.map((batch) => taskBatchDTO(batch, snapshot.tasks)),
    tasks: snapshot.tasks.map(childTaskDTO),
    reports,
    findings: snapshot.findings.map(reviewFindingDTO),
    attempts: snapshot.attempts.map(attemptDTO),
    executionReports: snapshot.reports.map(reportDTO),
    executionLogs: snapshot.executionLogs.map(taskExecutionLogDTO),
    latestEvents: snapshot.events.slice(-50).map(relayEventDTO),
  };
}

export function taskReportDTO(task: ChildTask, executionReport: TaskExecutionReport | null): TaskReportDTO {
  return {
    task: childTaskDTO(task),
    report: task.latestReport,
    status: task.status,
    executionReport,
  };
}

export function joinedTaskDTO(
  task: ChildTask,
  report: TaskExecutionReport | null,
  now = Date.now() / 1000,
): JoinedTaskDTO {
  return {
    id: task.id,
    clientKey: task.clientKey,
    parentTaskID: task.parentTaskID,
    title: task.title,
    status: task.status,
    agentKind: task.agentKind,
    executionMode: task.executionMode,
    report: task.latestReport,
    latestError: task.latestError,
    executionReport: report,
    elapsedSeconds: Math.max(0, now - task.createdAt),
  };
}

export type { JoinTasksDTO };
