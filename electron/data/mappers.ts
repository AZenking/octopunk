// Port of OctoPunk/OctoPunk/Data/Persistence/Database/{Records,Mappers}.

import type { SqliteDatabase } from "./database";
import type {
  ChildAgentKind,
  ChildTask,
  ChildTaskStatus,
  RelayEvent,
  ReviewCycle,
  ReviewFinding,
  ReviewFindingSeverity,
  ReviewVerdict,
  TaskAttempt,
  TaskAttemptStatus,
  TaskBatch,
  TaskDependency,
  TaskExecutionLog,
  TaskExecutionMode,
  TaskExecutionReport,
  TaskWorkspaceKind,
  TeamRun,
  TeamRunStatus,
} from "../domain/models";
import {
  CHILD_AGENT_KINDS,
  CHILD_TASK_STATUSES,
  makeChildTask,
  makeTaskBatch,
  makeTeamRun,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_VERDICTS,
  TASK_EXECUTION_MODES,
  TASK_WORKSPACE_KINDS,
  TEAM_RUN_STATUSES,
  TASK_ATTEMPT_STATUSES,
} from "../domain/models";

type Row = Record<string, unknown>;

function parseEnum<T extends string>(values: readonly T[], raw: unknown, fallback: T): T {
  return typeof raw === "string" && (values as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function optionalString(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function optionalUUID(row: Row, key: string): string | null {
  return optionalString(row, key);
}

function uuid(row: Row, key: string): string {
  return row[key] as string;
}

function date(row: Row, key: string): number {
  return typeof row[key] === "number" ? (row[key] as number) : Number(row[key] ?? 0);
}

function optionalDate(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}

function int(row: Row, key: string): number {
  return typeof row[key] === "number" ? (row[key] as number) : Number.parseInt(String(row[key] ?? 0), 10);
}

export const DatabaseMappers = {
  run(row: Row): TeamRun {
    return makeTeamRun({
      id: uuid(row, "id"),
      repositoryPath: row.repository_path as string,
      task: row.task as string,
      baselineCommit: row.baseline_commit as string,
      targetBranch: optionalString(row, "target_branch") ?? "",
      status: parseEnum<TeamRunStatus>(TEAM_RUN_STATUSES, row.status, "failed"),
      sessionId: optionalString(row, "session_id"),
      maxConcurrentTasks: int(row, "max_concurrent_tasks"),
      maxReviewRounds: int(row, "max_review_rounds"),
      currentReviewRound: int(row, "current_review_round"),
      revision: int(row, "revision"),
      createdAt: date(row, "created_at"),
      updatedAt: date(row, "updated_at"),
      archivedAt: optionalDate(row, "archived_at"),
    });
  },

  task(row: Row): ChildTask {
    return makeChildTask({
      id: uuid(row, "id"),
      runID: uuid(row, "run_id"),
      batchID: optionalUUID(row, "batch_id"),
      clientKey: optionalString(row, "client_key"),
      parentTaskID: optionalUUID(row, "parent_task_id"),
      title: row.title as string,
      prompt: row.prompt as string,
      agentKind: parseEnum<ChildAgentKind>(CHILD_AGENT_KINDS, row.agent_kind, "claude_code"),
      model: optionalString(row, "model"),
      executionMode: parseEnum<TaskExecutionMode>(TASK_EXECUTION_MODES, row.execution_mode, "workspace_write"),
      workspaceKind: parseEnum<TaskWorkspaceKind>(TASK_WORKSPACE_KINDS, row.workspace_kind, "isolated_write"),
      baselineCommit: row.baseline_commit as string,
      branchName: row.branch_name as string,
      worktreePath: row.worktree_path as string,
      contextSnapshot: optionalString(row, "context_snapshot") ?? "",
      sessionID: optionalString(row, "session_id"),
      currentAttemptID: optionalUUID(row, "current_attempt_id"),
      status: parseEnum<ChildTaskStatus>(CHILD_TASK_STATUSES, row.status, "blocked"),
      latestReport: optionalString(row, "latest_report"),
      latestError: optionalString(row, "latest_error"),
      reviewRound: int(row, "review_round"),
      revision: int(row, "revision"),
      createdAt: date(row, "created_at"),
      updatedAt: date(row, "updated_at"),
    });
  },

  batch(row: Row): TaskBatch {
    return makeTaskBatch({
      id: uuid(row, "id"),
      runID: uuid(row, "run_id"),
      contextSummary: row.context_summary as string,
      createdAt: date(row, "created_at"),
    });
  },

  dependency(row: Row): TaskDependency {
    return {
      id: uuid(row, "id"),
      runID: uuid(row, "run_id"),
      taskID: uuid(row, "task_id"),
      dependsOnTaskID: uuid(row, "depends_on_task_id"),
    };
  },

  cycle(row: Row): ReviewCycle {
    return {
      id: uuid(row, "id"),
      runID: uuid(row, "run_id"),
      taskID: optionalUUID(row, "task_id"),
      round: int(row, "round"),
      reviewer: row.reviewer as string,
      verdict: parseEnum<ReviewVerdict>(REVIEW_VERDICTS, row.verdict, "BLOCKED"),
      summary: row.summary as string,
      createdAt: date(row, "created_at"),
    };
  },

  finding(row: Row): ReviewFinding {
    return {
      id: uuid(row, "id"),
      taskID: optionalUUID(row, "task_id"),
      severity: parseEnum<ReviewFindingSeverity>(REVIEW_FINDING_SEVERITIES, row.severity, "info"),
      file: optionalString(row, "file"),
      line: row.line == null ? null : int(row, "line"),
      evidence: row.evidence as string,
      expectedFix: optionalString(row, "expected_fix"),
    };
  },

  event(row: Row): RelayEvent {
    return {
      id: uuid(row, "id"),
      runID: uuid(row, "run_id"),
      taskID: optionalUUID(row, "task_id"),
      sequence: int(row, "sequence"),
      kind: row.kind as string,
      payload: row.payload as string,
      createdAt: date(row, "created_at"),
    };
  },

  attempt(row: Row): TaskAttempt {
    return {
      id: uuid(row, "id"),
      runID: uuid(row, "run_id"),
      taskID: uuid(row, "task_id"),
      number: int(row, "attempt_number"),
      prompt: row.prompt as string,
      sessionID: optionalString(row, "session_id"),
      status: parseEnum<TaskAttemptStatus>(TASK_ATTEMPT_STATUSES, row.status, "failed"),
      startedAt: date(row, "started_at"),
      finishedAt: optionalDate(row, "finished_at"),
      failure: optionalString(row, "failure"),
    };
  },

  report(row: Row, tests: string[], changedFiles: string[]): TaskExecutionReport {
    return {
      id: uuid(row, "id"),
      runID: uuid(row, "run_id"),
      taskID: uuid(row, "task_id"),
      attemptID: uuid(row, "attempt_id"),
      sessionID: row.session_id as string,
      summary: row.summary as string,
      rawOutput: row.raw_output as string,
      tests,
      changedFiles,
      diffSummary: optionalString(row, "diff_summary"),
      blocker: optionalString(row, "blocker"),
      createdAt: date(row, "created_at"),
    };
  },

  executionLog(row: Row, toolSummary: string[]): TaskExecutionLog {
    return {
      id: uuid(row, "id"),
      runID: uuid(row, "run_id"),
      taskID: uuid(row, "task_id"),
      attemptID: uuid(row, "attempt_id"),
      stdoutTail: row.stdout_tail as string,
      stderrTail: row.stderr_tail as string,
      latestActivity: optionalString(row, "latest_activity"),
      toolSummary,
      updatedAt: date(row, "updated_at"),
    };
  },
};

/** Row helpers shared with the repository. */
export const DatabaseRecordMapper = { uuid, optionalUUID, date, optionalDate, optionalString, int };

export function allRows(db: SqliteDatabase, sql: string, ...args: unknown[]): Row[] {
  return db.prepare(sql).all(...args) as Row[];
}

export function oneRow(db: SqliteDatabase, sql: string, ...args: unknown[]): Row | undefined {
  return db.prepare(sql).get(...args) as Row | undefined;
}

export function parseStringArray(encoded: unknown): string[] | null {
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  try {
    const parsed = JSON.parse(encoded);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}
