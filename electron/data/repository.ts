// Port of OctoPunk/OctoPunk/Data/Repositories/GRDBTeamRunRepository.swift.
// better-sqlite3 is synchronous and Node is single-threaded, so each write
// transaction is trivially atomic. ValueObservation is replaced by an
// explicit change-notification hub: every write transaction notifies the
// observers of the runs it touched (and the global run-list observers),
// which re-read their segmented query and emit only when the value changed.

import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database";
import { DatabaseMappers, allRows, oneRow, parseStringArray } from "./mappers";
import { sharedReadOnlyWorktreeURL, taskWorktreeRoot, integrationWorktreeURL } from "../platform/gitAdapter";
import { DomainError } from "../domain/models";
import type {
  Arbitration,
  ChildTask,
  ContextFetchDigest,
  ContextTaskDigest,
  DeliverySummary,
  DoctorCheckKey,
  DoctorCheckStatus,
  DoctorTriggeredBy,
  RelayEvent,
  ReviewComment,
  ReviewFinding,
  RunSummary,
  TaskAttempt,
  TaskBatch,
  TaskDependency,
  TaskExecutionLog,
  TaskExecutionReport,
  TeamRun,
  TeamRunSnapshot,
  TeamRunSummary,
} from "../domain/models";
import {
  canTransitionReviewComment,
  doctorOverallOf,
  isValidRunPriority,
  makeArbitration,
  makeDeliverySummary,
  makeReviewComment,
  renderTeamContextSummary,
  taskStatusIsTerminal,
  runStatusIsTerminal,
  makeChildTask,
  makeTaskBatch,
  makeTeamRun,
} from "../domain/models";
import { TeamRunPolicy } from "../domain/policy";
import { TeamEventKind, encodeTeamEventPayload, makeTeamEventPayload, stableStringify } from "../domain/events";
import { ChildAgentDiagnostics, type ChildAgentEventKind } from "../application/ports";
import {
  isExactlyOneReference,
  makeStream,
  type AsyncStream,
  type DelegateTaskInput,
  type DelegateTasksInput,
  type DelegateTasksResult,
  type DoctorReport,
  type DoctorReportItem,
  type GateEvaluation,
  type GateEvaluationItem,
  type PrLink,
  type ReviewCommentDraft,
  type ReviewDecisionInput,
  type StartTeamInput,
  type TaskExecutionEventInput,
  type TaskReportInput,
  type TeamRunRepository,
} from "../domain/repositoryPort";

type Row = Record<string, unknown>;

const nowSeconds = (): number => Date.now() / 1000;

export class SqliteTeamRunRepository implements TeamRunRepository {
  private readonly db: SqliteDatabase;
  private readonly runListeners = new Map<string, Set<() => void>>();
  private readonly globalListeners = new Set<() => void>();

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  // MARK: - Writes

  async startTeam(input: StartTeamInput): Promise<TeamRunSnapshot> {
    return this.write((db) => {
      const cached = cachedResponse<TeamRunSnapshot>(db, input.requestID);
      if (cached) return cached;
      TeamRunPolicy.validateStart({
        repositoryPath: input.repositoryPath,
        task: input.task,
        maxConcurrentTasks: input.maxConcurrentTasks,
        maxReviewRounds: input.maxReviewRounds,
      });
      const active = oneRow(
        db,
        "SELECT status FROM team_runs WHERE status IN (?, ?, ?) AND session_id = ? LIMIT 1",
        "running",
        "reviewing",
        "awaiting_final_review",
        input.sessionID,
      );
      if (active != null) throw DomainError.activeTeamRunExists();

      const run = makeTeamRun({
        repositoryPath: input.repositoryPath,
        task: input.task,
        baselineCommit: input.baselineCommit,
        targetBranch: input.targetBranch,
        status: "running",
        sessionId: input.sessionID,
        maxConcurrentTasks: input.maxConcurrentTasks,
        maxReviewRounds: input.maxReviewRounds,
        updatedAt: nowSeconds(),
      });
      db.prepare(
        `INSERT INTO team_runs(
            id, repository_path, task, baseline_commit, status,
            session_id, target_branch, max_concurrent_tasks, max_review_rounds, current_review_round,
            revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.repositoryPath,
        run.task,
        run.baselineCommit,
        run.status,
        run.sessionId,
        run.targetBranch,
        run.maxConcurrentTasks,
        run.maxReviewRounds,
        run.currentReviewRound,
        run.revision,
        run.createdAt,
        run.updatedAt,
      );
      appendEvent(db, {
        runID: run.id,
        taskID: null,
        kind: TeamEventKind.teamStarted,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload("TeamRun started", input.requestID, {
            baseline: run.baselineCommit,
            target_branch: run.targetBranch,
          }),
        ),
      });
      const result = snapshotSync(db, run.id);
      saveResponse(db, input.requestID, result);
      return result;
    }, [null]);
  }

  async delegateTask(input: DelegateTaskInput): Promise<ChildTask> {
    return this.write((db) => {
      const cachedTask = cachedResponse<ChildTask>(db, input.requestID);
      if (cachedTask) return cachedTask;
      const cachedResult = cachedResponse<DelegateTasksResult>(db, input.requestID);
      if (cachedResult) return cachedResult.tasks[0];
      const result = createTaskBatch(db, {
        requestID: input.requestID,
        runID: input.runID,
        contextSummary: "",
        tasks: [
          {
            clientKey: input.requestID,
            title: input.title,
            prompt: input.prompt,
            agentKind: input.agentKind,
            model: input.model,
            executionMode: input.executionMode,
            parentTask: null,
            dependencies: input.dependencies.map((taskID) => ({ taskID, clientKey: null })),
          },
        ],
      });
      const task = result.tasks[0];
      saveResponse(db, input.requestID, task);
      return task;
    }, [input.runID]);
  }

  async delegateTasks(input: DelegateTasksInput): Promise<DelegateTasksResult> {
    return this.write((db) => {
      const cached = cachedResponse<DelegateTasksResult>(db, input.requestID);
      if (cached) return cached;
      const result = createTaskBatch(db, input);
      saveResponse(db, input.requestID, result);
      return result;
    }, [input.runID]);
  }

  async setTaskBaseline(input: {
    requestID: string;
    runID: string;
    taskID: string;
    baselineCommit: string;
  }): Promise<ChildTask> {
    return this.write((db) => {
      const cached = cachedResponse<ChildTask>(db, input.requestID);
      if (cached) return cached;
      const task = requireTaskSync(db, input.taskID, input.runID);
      if (!(task.status === "queued" && task.sessionID == null && task.currentAttemptID == null)) {
        throw DomainError.invalidTransition("ChildTask", task.status, "baseline_prepared");
      }
      if (task.baselineCommit === input.baselineCommit) {
        saveResponse(db, input.requestID, task);
        return task;
      }
      const updatedWorktreePath =
        task.workspaceKind === "shared_read_only"
          ? sharedReadOnlyWorktreeURL(input.runID, input.baselineCommit)
          : task.worktreePath;
      const info = db
        .prepare(
          `UPDATE child_tasks
           SET baseline_commit = ?, worktree_path = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(input.baselineCommit, updatedWorktreePath, nowSeconds(), task.id, task.revision);
      if (info.changes !== 1) throw DomainError.optimisticLockFailed();
      const updated = requireTaskSync(db, input.taskID, input.runID);
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind: TeamEventKind.taskBaselinePrepared,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload("Child task baseline prepared", input.requestID, {
            baseline: input.baselineCommit,
          }),
        ),
      });
      saveResponse(db, input.requestID, updated);
      return updated;
    }, [input.runID]);
  }

  async markTaskRunning(input: {
    requestID: string;
    runID: string;
    taskID: string;
    sessionID: string | null;
  }): Promise<ChildTask> {
    return this.write((db) => {
      const cached = cachedResponse<ChildTask>(db, input.requestID);
      if (cached) return cached;
      const task = requireTaskSync(db, input.taskID, input.runID);
      if (!(task.status === "queued" || task.status === "rework_required" || task.status === "running")) {
        throw DomainError.invalidTransition("ChildTask", task.status, "running");
      }
      let attemptID: string;
      if (task.status === "running" && task.currentAttemptID != null) {
        attemptID = task.currentAttemptID;
      } else {
        attemptID = insertAttempt(db, task, input.sessionID);
      }
      const updated = updateTaskSync(db, task, {
        status: "running",
        sessionID: input.sessionID ?? task.sessionID,
        currentAttemptID: attemptID,
        latestReport: task.latestReport,
        latestError: task.latestError,
        reviewRound: task.reviewRound,
      });
      if (input.sessionID != null) {
        updateAttemptSession(db, attemptID, input.sessionID);
      }
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind: TeamEventKind.taskStarted,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload("Child agent started", input.requestID, {
            attempt_id: attemptID,
            agent_kind: task.agentKind,
            execution_mode: task.executionMode,
          }),
        ),
      });
      saveResponse(db, input.requestID, updated);
      return updated;
    }, [input.runID]);
  }

  async submitReport(input: TaskReportInput): Promise<ChildTask> {
    return this.write((db) => {
      const cached = cachedResponse<ChildTask>(db, input.requestID);
      if (cached) return cached;
      const task = requireTaskSync(db, input.taskID, input.runID);
      if (
        !(task.status === "running" || task.status === "queued" || task.status === "rework_required")
      ) {
        throw DomainError.invalidTransition("ChildTask", task.status, "awaiting_report");
      }
      const attemptID = ensureAttempt(db, task, input.sessionID);
      const updated = updateTaskSync(db, task, {
        status: "awaiting_report",
        sessionID: input.sessionID,
        currentAttemptID: attemptID,
        latestReport: input.report,
        latestError: null,
        reviewRound: task.reviewRound,
      });
      updateAttempt(db, {
        attemptID,
        sessionID: input.sessionID,
        status: "reported",
        finishedAt: nowSeconds(),
        failure: null,
      });
      insertTaskReport(db, input, attemptID);
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind: TeamEventKind.taskReported,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload("Child agent reported completion", input.requestID, {
            session_id: input.sessionID,
            attempt_id: attemptID,
          }),
        ),
      });
      saveResponse(db, input.requestID, updated);
      return updated;
    }, [input.runID]);
  }

  async recordTaskExecutionEvent(input: TaskExecutionEventInput): Promise<void> {
    this.write((db) => {
      const task = requireTaskSync(db, input.taskID, input.runID);
      const attemptID = task.currentAttemptID;
      if (attemptID == null) return;

      // Native streaming protocols may repeat the same session ID on every
      // partial message; persist it only when the task receives a new ID.
      if (input.event.kind === "session" && input.event.sessionID === task.sessionID) {
        return;
      }

      if (input.event.sessionID != null && input.event.sessionID !== task.sessionID) {
        updateTaskSync(db, task, {
          status: task.status,
          sessionID: input.event.sessionID,
          currentAttemptID: attemptID,
          latestReport: task.latestReport,
          latestError: task.latestError,
          reviewRound: task.reviewRound,
        });
        updateAttemptSession(db, attemptID, input.event.sessionID);
      }

      const existing = loadExecutionLogByAttempt(db, attemptID);
      const stdout = boundedDiagnosticTail(
        (existing?.stdoutTail ?? "") + ChildAgentDiagnostics.redact(input.event.stdout ?? ""),
        64 * 1024,
      );
      const stderr = boundedDiagnosticTail(
        (existing?.stderrTail ?? "") + ChildAgentDiagnostics.redact(input.event.stderr ?? ""),
        64 * 1024,
      );
      const tools = existing?.toolSummary ?? [];
      const tool =
        input.event.toolName != null ? ChildAgentDiagnostics.redact(input.event.toolName) : null;
      if (tool != null && tool.length > 0 && !tools.includes(tool)) {
        tools.push(tool);
        if (tools.length > 50) tools.splice(0, tools.length - 50);
      }
      const previewSource =
        input.event.message ?? input.event.stdout ?? input.event.stderr ?? input.event.toolName;
      const latestActivity =
        previewSource != null ? ChildAgentDiagnostics.redact(previewSource, 512) : null;
      const toolJSON = stableStringify(tools);
      db.prepare(
        `INSERT INTO task_execution_logs(
            id, run_id, task_id, attempt_id, stdout_tail, stderr_tail,
            latest_activity, tool_summary_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(attempt_id) DO UPDATE SET
            stdout_tail = excluded.stdout_tail,
            stderr_tail = excluded.stderr_tail,
            latest_activity = excluded.latest_activity,
            tool_summary_json = excluded.tool_summary_json,
            updated_at = excluded.updated_at`,
      ).run(
        existing?.id ?? randomUUID(),
        input.runID,
        input.taskID,
        attemptID,
        stdout,
        stderr,
        latestActivity,
        toolJSON,
        nowSeconds(),
      );

      const kind = relayEventKind(input.event.kind);
      if (kind == null) return;
      if (input.event.kind === "output" || input.event.kind === "tool") {
        const lastRow = oneRow(
          db,
          `SELECT created_at FROM relay_events
           WHERE run_id = ? AND task_id = ? AND kind IN (?, ?)
           ORDER BY sequence DESC LIMIT 1`,
          input.runID,
          input.taskID,
          TeamEventKind.agentOutput,
          TeamEventKind.agentTool,
        );
        if (lastRow != null && nowSeconds() - (lastRow.created_at as number) < 0.25) {
          return;
        }
      }
      const metadata: Record<string, string> = {
        attempt_id: attemptID,
        agent_kind: task.agentKind,
        execution_mode: task.executionMode,
      };
      if (input.event.kind === "failed" && latestActivity != null) {
        metadata.failure_kind = ChildAgentDiagnostics.failureKind(latestActivity);
      }
      if (input.event.kind === "output" && latestActivity != null) {
        metadata.output_preview = latestActivity;
      }
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload(latestActivity ?? input.event.kind, null, metadata),
        ),
      });
    }, [input.runID]);
  }

  async requestRework(input: ReviewDecisionInput): Promise<ChildTask> {
    return this.write((db) => {
      const cached = cachedResponse<ChildTask>(db, input.requestID);
      if (cached) return cached;
      if (input.verdict !== "REWORK") throw DomainError.invalidTask("request_rework requires REWORK.");
      const run = requireRunSync(db, input.runID);
      TeamRunPolicy.validateReviewRound(run);
      const task = requireTaskSync(db, input.taskID, input.runID);
      if (!(task.status === "awaiting_report" || task.status === "rework_required")) {
        throw DomainError.taskNotReady(task.id);
      }
      const nextRound = task.reviewRound + 1;
      const updated = updateTaskSync(db, task, {
        status: "rework_required",
        sessionID: task.sessionID,
        currentAttemptID: task.currentAttemptID,
        latestReport: task.latestReport,
        latestError: input.summary,
        reviewRound: nextRound,
      });
      insertReview(db, input, nextRound);
      updateRunSync(db, run, "reviewing", Math.max(run.currentReviewRound, nextRound));
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind: TeamEventKind.reviewRework,
        payload: encodeTeamEventPayload(makeTeamEventPayload(input.summary, input.requestID)),
      });
      saveResponse(db, input.requestID, updated);
      return updated;
    }, [input.runID]);
  }

  async acceptTask(input: ReviewDecisionInput): Promise<ChildTask> {
    return this.write((db) => {
      const cached = cachedResponse<ChildTask>(db, input.requestID);
      if (cached) return cached;
      if (input.verdict !== "PASS") throw DomainError.invalidTask("accept_task requires PASS.");
      const task = requireTaskSync(db, input.taskID, input.runID);
      if (!(task.status === "awaiting_report" || task.status === "rework_required")) {
        throw DomainError.taskNotReady(task.id);
      }
      const updated = updateTaskSync(db, task, {
        status: "accepted",
        sessionID: task.sessionID,
        currentAttemptID: task.currentAttemptID,
        latestReport: task.latestReport,
        latestError: null,
        reviewRound: task.reviewRound,
      });
      insertReview(db, input, Math.max(task.reviewRound, 1));
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind: TeamEventKind.taskAccepted,
        payload: encodeTeamEventPayload(makeTeamEventPayload(input.summary, input.requestID)),
      });
      const remainingRow = oneRow(
        db,
        "SELECT COUNT(*) AS count FROM child_tasks WHERE run_id = ? AND status NOT IN (?, ?, ?)",
        input.runID,
        "accepted",
        "blocked",
        "cancelled",
      );
      const remaining = remainingRow ? (remainingRow.count as number) : 0;
      const run = requireRunSync(db, input.runID);
      if (remaining === 0) {
        updateRunSync(db, run, "awaiting_final_review");
      }
      saveResponse(db, input.requestID, updated);
      return updated;
    }, [input.runID]);
  }

  async blockTask(input: ReviewDecisionInput): Promise<ChildTask> {
    return this.write((db) => {
      const cached = cachedResponse<ChildTask>(db, input.requestID);
      if (cached) return cached;
      const task = requireTaskSync(db, input.taskID, input.runID);
      if (taskStatusIsTerminal(task.status)) return task;
      const updated = updateTaskSync(db, task, {
        status: "blocked",
        sessionID: task.sessionID,
        currentAttemptID: task.currentAttemptID,
        latestReport: task.latestReport,
        latestError: input.summary,
        reviewRound: task.reviewRound,
      });
      insertReview(db, input, Math.max(task.reviewRound, 1));
      const run = requireRunSync(db, input.runID);
      updateRunSync(db, run, "blocked");
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind: TeamEventKind.taskBlocked,
        payload: encodeTeamEventPayload(makeTeamEventPayload(input.summary, input.requestID)),
      });
      saveResponse(db, input.requestID, updated);
      return updated;
    }, [input.runID]);
  }

  async failTask(input: {
    requestID: string;
    runID: string;
    taskID: string;
    summary: string;
    /** False when an automatic retry is pending: the task failed but the run keeps draining siblings. */
    blockRun?: boolean;
  }): Promise<ChildTask> {
    return this.write((db) => {
      const cached = cachedResponse<ChildTask>(db, input.requestID);
      if (cached) return cached;
      const task = requireTaskSync(db, input.taskID, input.runID);
      if (taskStatusIsTerminal(task.status)) return task;
      const updated = updateTaskSync(db, task, {
        status: "failed",
        sessionID: task.sessionID,
        currentAttemptID: task.currentAttemptID,
        latestReport: task.latestReport,
        latestError: input.summary,
        reviewRound: task.reviewRound,
      });
      if (task.currentAttemptID != null) {
        updateAttempt(db, {
          attemptID: task.currentAttemptID,
          sessionID: task.sessionID,
          status: "failed",
          finishedAt: nowSeconds(),
          failure: input.summary,
        });
      }
      if (input.blockRun !== false) {
        const run = requireRunSync(db, input.runID);
        updateRunSync(db, run, "blocked");
      }
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind: TeamEventKind.taskFailed,
        payload: encodeTeamEventPayload(makeTeamEventPayload(input.summary, input.requestID)),
      });
      saveResponse(db, input.requestID, updated);
      return updated;
    }, [input.runID]);
  }

  async resumeTask(input: {
    requestID: string;
    runID: string;
    taskID: string;
  }): Promise<ChildTask> {
    return this.write((db) => {
      const cached = cachedResponse<ChildTask>(db, input.requestID);
      if (cached) return cached;
      const task = requireTaskSync(db, input.taskID, input.runID);
      if (!(task.status === "blocked" || task.status === "cancelled" || task.status === "failed")) {
        throw DomainError.taskNotReady(task.id);
      }
      const updated = updateTaskSync(db, task, {
        status: task.sessionID == null ? "queued" : "rework_required",
        sessionID: task.sessionID,
        currentAttemptID: task.currentAttemptID,
        latestReport: task.latestReport,
        latestError: null,
        reviewRound: task.reviewRound,
      });
      const run = requireRunSync(db, input.runID);
      updateRunSync(db, run, "running");
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind: TeamEventKind.taskResumed,
        payload: encodeTeamEventPayload(makeTeamEventPayload("Task resumed", input.requestID)),
      });
      saveResponse(db, input.requestID, updated);
      return updated;
    }, [input.runID]);
  }

  async cancelTask(input: { requestID: string; runID: string; taskID: string }): Promise<ChildTask> {
    return this.write((db) => {
      const cached = cachedResponse<ChildTask>(db, input.requestID);
      if (cached) return cached;
      const task = requireTaskSync(db, input.taskID, input.runID);
      if (taskStatusIsTerminal(task.status)) return task;
      const updated = updateTaskSync(db, task, {
        status: "cancelled",
        sessionID: task.sessionID,
        currentAttemptID: task.currentAttemptID,
        latestReport: task.latestReport,
        latestError: "Cancelled by Codex",
        reviewRound: task.reviewRound,
      });
      if (task.currentAttemptID != null) {
        updateAttempt(db, {
          attemptID: task.currentAttemptID,
          sessionID: task.sessionID,
          status: "cancelled",
          finishedAt: nowSeconds(),
          failure: "Cancelled by Codex",
        });
      }
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind: TeamEventKind.taskCancelled,
        payload: encodeTeamEventPayload(makeTeamEventPayload("Task cancelled", input.requestID)),
      });
      saveResponse(db, input.requestID, updated);
      return updated;
    }, [input.runID]);
  }

  async completeTeam(input: {
    requestID: string;
    runID: string;
    finalVerdict: "PASS" | "REWORK" | "BLOCKED";
    summary: string;
  }): Promise<TeamRunSnapshot> {
    return this.write((db) => {
      const cached = cachedResponse<TeamRunSnapshot>(db, input.requestID);
      if (cached) return cached;
      if (input.finalVerdict !== "PASS") throw DomainError.finalReviewRequired();
      const run = requireRunSync(db, input.runID);
      const remainingRow = oneRow(
        db,
        "SELECT COUNT(*) AS count FROM child_tasks WHERE run_id = ? AND status != ?",
        input.runID,
        "accepted",
      );
      const remaining = remainingRow ? (remainingRow.count as number) : 0;
      if (remaining !== 0) throw DomainError.taskNotReady(input.runID);
      insertTeamReview(db, {
        runID: input.runID,
        reviewer: "codex.final",
        summary: input.summary,
        round: Math.max(run.currentReviewRound + 1, 1),
      });
      updateRunSync(db, run, "completed", Math.max(run.currentReviewRound, 1));
      appendEvent(db, {
        runID: input.runID,
        taskID: null,
        kind: TeamEventKind.teamCompleted,
        payload: encodeTeamEventPayload(makeTeamEventPayload(input.summary, input.requestID)),
      });
      const result = snapshotSync(db, input.runID);
      saveResponse(db, input.requestID, result);
      return result;
    }, [input.runID]);
  }

  async cancelTeam(input: { requestID: string; runID: string }): Promise<TeamRunSnapshot> {
    return this.write((db) => {
      const cached = cachedResponse<TeamRunSnapshot>(db, input.requestID);
      if (cached) return cached;
      const run = requireRunSync(db, input.runID);
      db.prepare(
        `UPDATE child_tasks SET status = ?, latest_error = ?, revision = revision + 1, updated_at = ?
         WHERE run_id = ? AND status NOT IN (?, ?, ?, ?)`,
      ).run(
        "cancelled",
        "Cancelled with team",
        nowSeconds(),
        input.runID,
        "accepted",
        "blocked",
        "cancelled",
        "failed",
      );
      db.prepare(
        `UPDATE task_attempts
         SET status = ?, finished_at = ?, failure = ?
         WHERE run_id = ? AND status = ?`,
      ).run("cancelled", nowSeconds(), "Cancelled with team", input.runID, "running");
      updateRunSync(db, run, "cancelled");
      appendEvent(db, {
        runID: input.runID,
        taskID: null,
        kind: TeamEventKind.teamCancelled,
        payload: encodeTeamEventPayload(makeTeamEventPayload("TeamRun cancelled", input.requestID)),
      });
      const result = snapshotSync(db, input.runID);
      saveResponse(db, input.requestID, result);
      return result;
    }, [input.runID]);
  }

  async hideRun(input: { requestID: string; runID: string }): Promise<void> {
    this.write((db) => {
      if (cachedResponse<unknown>(db, input.requestID) !== null) {
        return;
      }
      const run = requireRunSync(db, input.runID);
      if (!runStatusIsTerminal(run.status)) {
        throw DomainError.invalidTask(
          "Only finished TeamRuns (completed, blocked, cancelled, or failed) can be removed from the list.",
        );
      }
      const now = nowSeconds();
      db.prepare(
        "UPDATE team_runs SET hidden_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      ).run(now, now, input.runID);
      appendEvent(db, {
        runID: input.runID,
        taskID: null,
        kind: TeamEventKind.runHidden,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload("TeamRun removed from the list (audit record retained)", input.requestID),
        ),
      });
      saveResponse(db, input.requestID, {});
    }, [null, input.runID]);
  }

  async archiveRun(input: { requestID: string; runID: string }): Promise<void> {
    this.write((db) => {
      if (cachedResponse<unknown>(db, input.requestID) !== null) {
        return;
      }
      const run = requireRunSync(db, input.runID);
      if (!runStatusIsTerminal(run.status)) {
        throw DomainError.invalidTask("Only finished TeamRuns can be archived.");
      }
      const now = nowSeconds();
      db.prepare(
        "UPDATE team_runs SET archived_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      ).run(now, now, input.runID);
      appendEvent(db, {
        runID: input.runID,
        taskID: null,
        kind: TeamEventKind.runArchived,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload("TeamRun archived (restorable from the archived section)", input.requestID),
        ),
      });
      saveResponse(db, input.requestID, {});
    }, [null, input.runID]);
  }

  async unarchiveRun(input: { requestID: string; runID: string }): Promise<void> {
    this.write((db) => {
      if (cachedResponse<unknown>(db, input.requestID) !== null) {
        return;
      }
      const run = requireRunSync(db, input.runID);
      if (run.archivedAt == null) {
        return;
      }
      db.prepare(
        "UPDATE team_runs SET archived_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?",
      ).run(nowSeconds(), input.runID);
      appendEvent(db, {
        runID: input.runID,
        taskID: null,
        kind: TeamEventKind.runUnarchived,
        payload: encodeTeamEventPayload(makeTeamEventPayload("TeamRun restored from the archive", input.requestID)),
      });
      saveResponse(db, input.requestID, {});
    }, [null, input.runID]);
  }

  // MARK: - Reads

  async snapshot(runID: string): Promise<TeamRunSnapshot> {
    return snapshotSync(this.db, runID);
  }

  async activeRun(sessionID?: string): Promise<TeamRunSnapshot | null> {
    const row =
      sessionID == null
        ? oneRow(
            this.db,
            "SELECT id FROM team_runs WHERE status IN (?, ?, ?) ORDER BY updated_at DESC LIMIT 1",
            "running",
            "reviewing",
            "awaiting_final_review",
          )
        : oneRow(
            this.db,
            "SELECT id FROM team_runs WHERE status IN (?, ?, ?) AND session_id = ? ORDER BY updated_at DESC LIMIT 1",
            "running",
            "reviewing",
            "awaiting_final_review",
            sessionID,
          );
    if (row == null) return null;
    return snapshotSync(this.db, row.id as string);
  }

  /**
   * Session teardown: flips every still-active run of the session to `failed`
   * (best effort — called from process-exit hooks). Returns the failed run IDs.
   */
  async failActiveRunsForSession(input: { sessionID: string; reason: string }): Promise<string[]> {
    const notify = allRows(
      this.db,
      "SELECT id FROM team_runs WHERE session_id = ? AND status IN (?, ?, ?)",
      input.sessionID,
      "running",
      "reviewing",
      "awaiting_final_review",
    ).map((row) => row.id as string);
    if (notify.length === 0) return [];
    return this.write((db) => {
      const rows = allRows(
        db,
        "SELECT id FROM team_runs WHERE session_id = ? AND status IN (?, ?, ?)",
        input.sessionID,
        "running",
        "reviewing",
        "awaiting_final_review",
      );
      const failed: string[] = [];
      for (const row of rows) {
        const runID = row.id as string;
        const run = requireRunSync(db, runID);
        db.prepare(
          `UPDATE child_tasks SET status = ?, latest_error = ?, revision = revision + 1, updated_at = ?
           WHERE run_id = ? AND status NOT IN (?, ?, ?, ?)`,
        ).run(
          "failed",
          input.reason,
          nowSeconds(),
          runID,
          "accepted",
          "blocked",
          "cancelled",
          "failed",
        );
        db.prepare(
          `UPDATE task_attempts
           SET status = ?, finished_at = ?, failure = ?
           WHERE run_id = ? AND status = ?`,
        ).run("failed", nowSeconds(), input.reason, runID, "running");
        updateRunSync(db, run, "failed");
        appendEvent(db, {
          runID,
          taskID: null,
          kind: TeamEventKind.teamFailed,
          payload: encodeTeamEventPayload(
            makeTeamEventPayload(`TeamRun failed: ${input.reason}`, `session-${input.sessionID}`),
          ),
        });
        failed.push(runID);
      }
      return failed;
    }, [...notify, null]);
  }

  /** All workspaces incl. hidden runs — input for worktree maintenance. */
  allRunWorkspaces(): import("../platform/worktreeMaintenance").KnownWorkspace[] {
    const rows = allRows(this.db, "SELECT id, status FROM team_runs");
    const statusByRun = new Map(rows.map((row) => [row.id as string, row.status as string]));
    const tasks = allRows(this.db, "SELECT run_id, worktree_path, branch_name, workspace_kind FROM child_tasks");
    const result: import("../platform/worktreeMaintenance").KnownWorkspace[] = [];
    for (const task of tasks) {
      const runStatus = statusByRun.get(task.run_id as string);
      if (runStatus == null) continue;
      result.push({
        worktreePath: task.worktree_path as string,
        branchName: task.branch_name as string,
        workspaceKind: task.workspace_kind as string,
        runStatus,
      });
    }
    for (const [runID, runStatus] of statusByRun) {
      result.push({
        worktreePath: integrationWorktreeURL(runID),
        branchName: `octopunk/${runID}/integration`,
        workspaceKind: "isolated_write",
        runStatus,
      });
    }
    return result;
  }

  async listRuns(): Promise<TeamRunSummary[]> {
    return runSummariesSync(this.db);
  }

  async events(runID: string, after: number | null): Promise<RelayEvent[]> {
    if (after == null) {
      return allRows(this.db, "SELECT * FROM relay_events WHERE run_id = ? ORDER BY sequence", runID).map(
        DatabaseMappers.event,
      );
    }
    return allRows(
      this.db,
      "SELECT * FROM relay_events WHERE run_id = ? AND sequence > ? ORDER BY sequence",
      runID,
      after,
    ).map(DatabaseMappers.event);
  }

  async executionLog(runID: string, taskID: string): Promise<TaskExecutionLog | null> {
    if (requireTaskSync(this.db, taskID, runID).currentAttemptID == null) return null;
    const row = oneRow(
      this.db,
      "SELECT * FROM task_execution_logs WHERE run_id = ? AND task_id = ? ORDER BY updated_at DESC LIMIT 1",
      runID,
      taskID,
    );
    if (row == null) return null;
    const tools = parseStringArray(row.tool_summary_json);
    if (tools == null) return null;
    return DatabaseMappers.executionLog(row, tools);
  }

  observe(runID: string): AsyncStream<TeamRunSnapshot> {
    return this.observeValue(runID, (db) => snapshotSync(db, runID));
  }

  // MARK: - Segmented queries and observations

  async runSummary(runID: string): Promise<RunSummary> {
    return runSummarySync(this.db, runID);
  }

  observeRunSummary(runID: string): AsyncStream<RunSummary> {
    return this.observeValue(runID, (db) => runSummarySync(db, runID));
  }

  async eventTail(runID: string, limit: number): Promise<RelayEvent[]> {
    return eventTailSync(this.db, runID, limit);
  }

  async eventPage(runID: string, before: number, limit: number): Promise<RelayEvent[]> {
    return allRows(
      this.db,
      "SELECT * FROM relay_events WHERE run_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?",
      runID,
      before,
      limit,
    )
      .map(DatabaseMappers.event)
      .reverse();
  }

  observeExecutionLog(runID: string, taskID: string): AsyncStream<TaskExecutionLog | null> {
    return this.observeValue(runID, (db) => {
      try {
        return requireTaskSync(db, taskID, runID).currentAttemptID == null
          ? null
          : executionLogSync(db, runID, taskID);
      } catch {
        return null;
      }
    });
  }

  observeEventTail(runID: string, limit: number): AsyncStream<RelayEvent[]> {
    return this.observeValue(runID, (db) => eventTailSync(db, runID, limit));
  }

  observeRunSummaries(): AsyncStream<TeamRunSummary[]> {
    return makeStream((emit, fail) => {
      let last = "";
      const compute = (): void => {
        try {
          const value = runSummariesSync(this.db);
          const encoded = stableStringify(value);
          if (encoded !== last) {
            last = encoded;
            emit(value);
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      compute();
      this.globalListeners.add(compute);
      return () => {
        this.globalListeners.delete(compute);
      };
    });
  }

  // MARK: - Read-only live context (constitution II/IV)

  async fetchTeamContext(input: {
    requestID: string;
    runID: string;
    requesterTaskID: string;
  }): Promise<ContextFetchDigest> {
    return this.write((db) => {
      const cached = cachedResponse<ContextFetchDigest>(db, input.requestID);
      if (cached) return cached;
      const summary = runSummarySync(db, input.runID);
      if (!summary.tasks.some((task) => task.id === input.requesterTaskID)) {
        throw DomainError.taskNotFound(input.requesterTaskID);
      }
      const digest = renderContextDigest(summary);
      appendEvent(db, {
        runID: input.runID,
        taskID: input.requesterTaskID,
        kind: TeamEventKind.contextFetched,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload("Sub-agent fetched live team context", input.requestID, {
            fetch_kind: "team_context",
            requester_task_id: input.requesterTaskID,
            returned_bytes: String(Buffer.byteLength(digest.summary, "utf8")),
          }),
        ),
      });
      saveResponse(db, input.requestID, digest);
      return digest;
    }, [input.runID]);
  }

  async fetchTaskReport(input: {
    requestID: string;
    runID: string;
    requesterTaskID: string;
    targetTaskID: string;
  }): Promise<{ taskID: string; report: string; truncated: boolean }> {
    return this.write((db) => {
      const cached = cachedResponse<{ taskID: string; report: string; truncated: boolean }>(
        db,
        input.requestID,
      );
      if (cached) return cached;
      const tasks = loadTasksSync(db, input.runID);
      if (!tasks.some((task) => task.id === input.requesterTaskID)) {
        throw DomainError.taskNotFound(input.requesterTaskID);
      }
      const target = tasks.find((task) => task.id === input.targetTaskID);
      if (target == null) {
        throw DomainError.taskNotFound(input.targetTaskID);
      }
      if (target.latestReport == null || target.latestReport.length === 0) {
        throw DomainError.reportNotAvailable(input.targetTaskID);
      }
      const redacted = ChildAgentDiagnostics.redact(target.latestReport);
      const limit = 64 * 1024;
      const truncated = Buffer.byteLength(redacted, "utf8") > limit;
      const bounded = truncated ? suffixUTF8(redacted, limit) : redacted;
      const payload = { taskID: input.targetTaskID, report: bounded, truncated };
      appendEvent(db, {
        runID: input.runID,
        taskID: input.requesterTaskID,
        kind: TeamEventKind.contextFetched,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload("Sub-agent fetched a dependency report", input.requestID, {
            fetch_kind: "task_report",
            requester_task_id: input.requesterTaskID,
            target_task_id: input.targetTaskID,
            returned_bytes: String(Buffer.byteLength(bounded, "utf8")),
          }),
        ),
      });
      saveResponse(db, input.requestID, payload);
      return payload;
    }, [input.runID]);
  }

  // MARK: - v0.4 review center & quality gates (specs/002-v04-review-center-gates)

  async addReviewComments(input: {
    requestID: string;
    runID: string;
    taskID: string;
    comments: ReviewCommentDraft[];
  }): Promise<ReviewComment[]> {
    return this.write((db) => {
      const cached = cachedResponse<ReviewComment[]>(db, input.requestID);
      if (cached) return cached;
      // Stamps the review round; anchor-in-diff validation stays in the service.
      const task = requireTaskSync(db, input.taskID, input.runID);
      const created = input.comments.map((comment) =>
        makeReviewComment({
          runID: input.runID,
          taskID: input.taskID,
          reviewRound: task.reviewRound,
          filePath: comment.filePath,
          lineStart: comment.lineStart,
          lineEnd: comment.lineEnd,
          contextSnapshot: comment.contextSnapshot,
          body: comment.body,
          severity: comment.severity,
          author: comment.author,
        }),
      );
      const insert = db.prepare(
        `INSERT INTO review_comments(
            id, run_id, task_id, review_round, file_path, line_start, line_end,
            context_snapshot, body, severity, author, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const comment of created) {
        insert.run(
          comment.id,
          comment.runID,
          comment.taskID,
          comment.reviewRound,
          comment.filePath,
          comment.lineStart,
          comment.lineEnd,
          comment.contextSnapshot,
          comment.body,
          comment.severity,
          comment.author,
          comment.status,
          comment.createdAt,
          comment.updatedAt,
        );
      }
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind: TeamEventKind.reviewCommentAdded,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload(`Added ${created.length} review comment(s)`, input.requestID, {
            task_id: input.taskID,
            count: String(created.length),
          }),
        ),
      });
      saveResponse(db, input.requestID, created);
      return created;
    }, [input.runID]);
  }

  async listReviewComments(runID: string, taskID: string): Promise<ReviewComment[]> {
    return allRows(
      this.db,
      "SELECT * FROM review_comments WHERE run_id = ? AND task_id = ? ORDER BY created_at, rowid",
      runID,
      taskID,
    ).map(DatabaseMappers.reviewComment);
  }

  async listOpenReviewComments(runID: string): Promise<ReviewComment[]> {
    // risk severity sorts above info (spec: risk findings stay on top).
    return allRows(
      this.db,
      "SELECT * FROM review_comments WHERE run_id = ? AND status = ? ORDER BY severity DESC, created_at, rowid",
      runID,
      "open",
    ).map(DatabaseMappers.reviewComment);
  }

  async setReviewCommentStatus(input: {
    requestID: string;
    runID: string;
    commentID: string;
    status: "resolved" | "dismissed" | "line_changed";
  }): Promise<ReviewComment> {
    return this.write((db) => {
      const cached = cachedResponse<ReviewComment>(db, input.requestID);
      if (cached) return cached;
      const comment = reviewCommentSync(db, input.runID, input.commentID);
      if (!canTransitionReviewComment(comment.status, input.status)) {
        // Terminal states are irreversible (specs/002 data-model).
        throw DomainError.invalidTransition("ReviewComment", comment.status, input.status);
      }
      db.prepare("UPDATE review_comments SET status = ?, updated_at = ? WHERE id = ?").run(
        input.status,
        nowSeconds(),
        input.commentID,
      );
      appendEvent(db, {
        runID: input.runID,
        taskID: comment.taskID,
        kind: TeamEventKind.reviewCommentStatusChanged,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload(`Review comment ${comment.id} → ${input.status}`, input.requestID, {
            comment_id: comment.id,
            from: comment.status,
            to: input.status,
          }),
        ),
      });
      const updated = reviewCommentSync(db, input.runID, input.commentID);
      saveResponse(db, input.requestID, updated);
      return updated;
    }, [input.runID]);
  }

  async getGateConfig(repositoryPath: string): Promise<{ configJson: string; updatedAt: number } | null> {
    const row = oneRow(
      this.db,
      "SELECT config_json, updated_at FROM project_gate_configs WHERE repository_path = ?",
      repositoryPath,
    );
    return row == null ? null : DatabaseMappers.gateConfig(row);
  }

  async saveGateConfig(input: {
    repositoryPath: string;
    configJson: string;
    updatedAt: number;
  }): Promise<void> {
    // Structure/contradiction validation happens in the service (policy); the
    // repository persists the opaque JSON document as-is.
    this.write((db) => {
      db.prepare(
        `INSERT INTO project_gate_configs(repository_path, config_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(repository_path) DO UPDATE SET
            config_json = excluded.config_json,
            updated_at = excluded.updated_at`,
      ).run(input.repositoryPath, input.configJson, input.updatedAt);
    }, []);
  }

  async recordGateEvaluation(input: {
    requestID: string;
    runID: string;
    taskID: string;
    overall: GateEvaluation["overall"];
    items: {
      checkKey: GateEvaluationItem["checkKey"];
      status: GateEvaluationItem["status"];
      detail: string;
      fixSuggestion?: string | null;
    }[];
  }): Promise<GateEvaluation> {
    return this.write((db) => {
      const cached = cachedResponse<GateEvaluation>(db, input.requestID);
      if (cached) return cached;
      requireTaskSync(db, input.taskID, input.runID);
      const evaluationID = randomUUID();
      const evaluatedAt = nowSeconds();
      db.prepare(
        `INSERT INTO gate_evaluations(id, run_id, task_id, request_id, overall, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(evaluationID, input.runID, input.taskID, input.requestID, input.overall, evaluatedAt);
      const insertItem = db.prepare(
        `INSERT INTO gate_evaluation_items(id, evaluation_id, check_key, status, detail, fix_suggestion)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const items: GateEvaluationItem[] = input.items.map((item) => {
        const itemID = randomUUID();
        insertItem.run(itemID, evaluationID, item.checkKey, item.status, item.detail, item.fixSuggestion ?? null);
        return {
          id: itemID,
          evaluationID,
          checkKey: item.checkKey,
          status: item.status,
          detail: item.detail,
          fixSuggestion: item.fixSuggestion ?? null,
          waivedBy: null,
          waivedReason: null,
          waivedAt: null,
        };
      });
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind: TeamEventKind.gateEvaluated,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload(`Quality gate ${input.overall}`, input.requestID, {
            overall: input.overall,
            item_count: String(items.length),
          }),
        ),
      });
      const result: GateEvaluation = {
        id: evaluationID,
        runID: input.runID,
        taskID: input.taskID,
        requestID: input.requestID,
        overall: input.overall,
        evaluatedAt,
        items,
      };
      saveResponse(db, input.requestID, result);
      return result;
    }, [input.runID]);
  }

  async getLatestGateEvaluation(runID: string, taskID: string): Promise<GateEvaluation | null> {
    const row = oneRow(
      this.db,
      "SELECT * FROM gate_evaluations WHERE run_id = ? AND task_id = ? ORDER BY evaluated_at DESC, rowid DESC LIMIT 1",
      runID,
      taskID,
    );
    if (row == null) return null;
    return DatabaseMappers.gateEvaluation(row, gateItemsSync(this.db, row.id as string));
  }

  async listGateEvaluationItems(evaluationID: string): Promise<GateEvaluationItem[]> {
    return gateItemsSync(this.db, evaluationID);
  }

  async waiveGateItem(input: {
    requestID: string;
    evaluationID: string;
    itemID: string;
    waivedBy: string;
    waivedReason: string;
  }): Promise<GateEvaluationItem> {
    // Notification scope needs the owning run before the transaction opens.
    const evaluationRow = oneRow(
      this.db,
      "SELECT run_id FROM gate_evaluations WHERE id = ?",
      input.evaluationID,
    );
    if (evaluationRow == null) {
      throw DomainError.invalidTask(`Gate evaluation not found: ${input.evaluationID}`);
    }
    return this.write((db) => {
      const cached = cachedResponse<GateEvaluationItem>(db, input.requestID);
      if (cached) return cached;
      const itemRow = oneRow(
        db,
        "SELECT * FROM gate_evaluation_items WHERE id = ? AND evaluation_id = ?",
        input.itemID,
        input.evaluationID,
      );
      if (itemRow == null) {
        throw DomainError.invalidTask(`Gate evaluation item not found: ${input.itemID}`);
      }
      // Keep the original verdict visible: the trail records who/when/why while
      // the service layer recalculates `overall` from the full item list.
      db.prepare(
        `UPDATE gate_evaluation_items
         SET status = 'waived', waived_by = ?, waived_reason = ?, waived_at = ?
         WHERE id = ?`,
      ).run(input.waivedBy, input.waivedReason, nowSeconds(), input.itemID);
      const evaluation = oneRow(db, "SELECT * FROM gate_evaluations WHERE id = ?", input.evaluationID);
      appendEvent(db, {
        runID: (evaluation?.run_id as string) ?? "",
        taskID: (evaluation?.task_id as string) ?? null,
        kind: TeamEventKind.gateItemWaived,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload(`Waived gate item ${input.itemID}`, input.requestID, {
            evaluation_id: input.evaluationID,
            item_id: input.itemID,
            check_key: itemRow.check_key as string,
            waived_by: input.waivedBy,
          }),
        ),
      });
      const updated = oneRow(db, "SELECT * FROM gate_evaluation_items WHERE id = ?", input.itemID);
      const result = DatabaseMappers.gateEvaluationItem(updated as Row);
      saveResponse(db, input.requestID, result);
      return result;
    }, [evaluationRow.run_id as string]);
  }

  async updateGateEvaluationOverall(input: {
    evaluationID: string;
    overall: GateEvaluation["overall"];
  }): Promise<GateEvaluation> {
    // Notification scope needs the owning run before the transaction opens.
    const evaluationRow = oneRow(
      this.db,
      "SELECT run_id FROM gate_evaluations WHERE id = ?",
      input.evaluationID,
    );
    if (evaluationRow == null) {
      throw DomainError.invalidTask(`Gate evaluation not found: ${input.evaluationID}`);
    }
    return this.write((db) => {
      const row = oneRow(db, "SELECT * FROM gate_evaluations WHERE id = ?", input.evaluationID);
      if (row == null) {
        throw DomainError.invalidTask(`Gate evaluation not found: ${input.evaluationID}`);
      }
      // Persist + audit only on an actual change: an idempotent waive replay
      // recomputes the same overall and must not spam duplicate gate events.
      if (row.overall !== input.overall) {
        db.prepare("UPDATE gate_evaluations SET overall = ? WHERE id = ?").run(
          input.overall,
          input.evaluationID,
        );
        appendEvent(db, {
          runID: row.run_id as string,
          taskID: row.task_id as string,
          kind: TeamEventKind.gateEvaluated,
          payload: encodeTeamEventPayload(
            makeTeamEventPayload(`Quality gate ${input.overall} (recalculated after waiver)`, null, {
              evaluation_id: input.evaluationID,
            }),
          ),
        });
      }
      const updated = oneRow(db, "SELECT * FROM gate_evaluations WHERE id = ?", input.evaluationID);
      return DatabaseMappers.gateEvaluation(updated as Row, gateItemsSync(db, input.evaluationID));
    }, [evaluationRow.run_id as string]);
  }

  async recordArbitration(input: {
    runID: string;
    taskID: string;
    consensus: string;
    disagreements: Arbitration["disagreements"];
    toVerify: Arbitration["toVerify"];
    autoPassed: boolean;
  }): Promise<Arbitration> {
    return this.write((db) => {
      requireTaskSync(db, input.taskID, input.runID);
      const record = makeArbitration({
        runID: input.runID,
        taskID: input.taskID,
        consensus: input.consensus,
        disagreements: input.disagreements,
        toVerify: input.toVerify,
        autoPassed: input.autoPassed,
      });
      db.prepare(
        `INSERT INTO arbitrations(
            id, run_id, task_id, consensus, disagreements_json, to_verify_json, auto_passed, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.runID,
        record.taskID,
        record.consensus,
        stableStringify(record.disagreements),
        stableStringify(record.toVerify),
        record.autoPassed ? 1 : 0,
        record.createdAt,
      );
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind: TeamEventKind.arbitrationRecorded,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload("Arbitration outcome recorded", null, {
            task_id: input.taskID,
            disagreement_count: String(record.disagreements.length),
            auto_passed: String(record.autoPassed),
          }),
        ),
      });
      return record;
    }, [input.runID]);
  }

  async getArbitration(runID: string, taskID: string): Promise<Arbitration | null> {
    const row = oneRow(
      this.db,
      "SELECT * FROM arbitrations WHERE run_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      runID,
      taskID,
    );
    return row == null ? null : DatabaseMappers.arbitration(row);
  }

  async recordDeliverySummary(input: {
    runID: string;
    taskID: string | null;
    verdict: DeliverySummary["verdict"];
    summaryMd: string;
    evidence: string[];
  }): Promise<DeliverySummary> {
    return this.write((db) => {
      requireRunSync(db, input.runID);
      if (input.taskID != null) requireTaskSync(db, input.taskID, input.runID);
      const record = makeDeliverySummary({
        runID: input.runID,
        taskID: input.taskID,
        verdict: input.verdict,
        summaryMD: input.summaryMd,
        evidence: input.evidence,
      });
      db.prepare(
        `INSERT INTO delivery_summaries(id, run_id, task_id, verdict, summary_md, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.runID,
        record.taskID,
        record.verdict,
        record.summaryMD,
        stableStringify(record.evidence),
        record.createdAt,
      );
      appendEvent(db, {
        runID: input.runID,
        taskID: input.taskID,
        kind: TeamEventKind.summaryGenerated,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload(`Delivery summary generated: ${record.verdict}`, null, {
            verdict: record.verdict,
            evidence_count: String(record.evidence.length),
          }),
        ),
      });
      return record;
    }, [input.runID]);
  }

  async getDeliverySummary(runID: string, taskID: string | null): Promise<DeliverySummary | null> {
    // `IS ?` matches NULL task ids for the run-level final summary.
    const row = oneRow(
      this.db,
      "SELECT * FROM delivery_summaries WHERE run_id = ? AND task_id IS ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      runID,
      taskID,
    );
    if (row == null) return null;
    return DatabaseMappers.deliverySummary(row, parseStringArray(row.evidence_json) ?? []);
  }

  async savePrLink(input: {
    runID: string;
    taskID: string;
    prURL: string;
    prNumber: number;
    lastSyncedAt?: number;
  }): Promise<PrLink> {
    return this.write((db) => {
      requireTaskSync(db, input.taskID, input.runID);
      const lastSyncedAt = input.lastSyncedAt ?? nowSeconds();
      const existing = oneRow(
        db,
        "SELECT id FROM pr_links WHERE run_id = ? AND task_id = ?",
        input.runID,
        input.taskID,
      );
      if (existing != null) {
        db.prepare(
          "UPDATE pr_links SET pr_url = ?, pr_number = ?, last_synced_at = ? WHERE id = ?",
        ).run(input.prURL, input.prNumber, lastSyncedAt, existing.id);
      } else {
        db.prepare(
          `INSERT INTO pr_links(id, run_id, task_id, pr_url, pr_number, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), input.runID, input.taskID, input.prURL, input.prNumber, lastSyncedAt);
      }
      const saved = oneRow(
        db,
        "SELECT * FROM pr_links WHERE run_id = ? AND task_id = ?",
        input.runID,
        input.taskID,
      );
      return DatabaseMappers.prLink(saved as Row);
    }, [input.runID]);
  }

  async getPrLink(runID: string, taskID: string): Promise<PrLink | null> {
    const row = oneRow(
      this.db,
      "SELECT * FROM pr_links WHERE run_id = ? AND task_id = ?",
      runID,
      taskID,
    );
    return row == null ? null : DatabaseMappers.prLink(row);
  }

  async getRunGateSnapshot(runID: string): Promise<string | null> {
    const row = oneRow(this.db, "SELECT gate_snapshot_json FROM team_runs WHERE id = ?", runID);
    if (row == null) throw DomainError.runNotFound(runID);
    const value = row.gate_snapshot_json;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  async saveRunGateSnapshot(runID: string, snapshotJson: string): Promise<void> {
    this.write((db) => {
      requireRunSync(db, runID);
      // Written once when the run starts; frozen for the run's lifetime.
      db.prepare(
        "UPDATE team_runs SET gate_snapshot_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      ).run(snapshotJson, nowSeconds(), runID);
    }, [runID]);
  }

  // ---- v0.3 stability & multi-run (specs/001-v03-stability-multi-teamrun) ----

  async setRunPriority(input: { requestID: string; runID: string; priority: number }): Promise<TeamRun> {
    return this.write((db) => {
      const cached = cachedResponse<TeamRun>(db, input.requestID);
      if (cached) return cached;
      if (!isValidRunPriority(input.priority)) {
        throw DomainError.invalidTask(
          `Run priority must be an integer between -5 and 5 (got ${input.priority}).`,
        );
      }
      const run = requireRunSync(db, input.runID);
      if (run.priority === input.priority) {
        // No-op change: return the current run without spamming duplicate events.
        saveResponse(db, input.requestID, run);
        return run;
      }
      const info = db
        .prepare(
          `UPDATE team_runs
           SET priority = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(input.priority, nowSeconds(), run.id, run.revision);
      if (info.changes !== 1) throw DomainError.optimisticLockFailed();
      appendEvent(db, {
        runID: input.runID,
        taskID: null,
        kind: TeamEventKind.runPriorityChanged,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload(`TeamRun priority ${run.priority} → ${input.priority}`, input.requestID, {
            from: String(run.priority),
            to: String(input.priority),
          }),
        ),
      });
      const updated = requireRunSync(db, input.runID);
      saveResponse(db, input.requestID, updated);
      return updated;
    }, [input.runID]);
  }

  async pauseRun(input: { requestID: string; runID: string }): Promise<TeamRun> {
    return this.write((db) => {
      const cached = cachedResponse<TeamRun>(db, input.requestID);
      if (cached) return cached;
      const run = requireRunSync(db, input.runID);
      if (run.pausedAt != null) {
        // Idempotent: pausing an already-paused run returns the current state.
        saveResponse(db, input.requestID, run);
        return run;
      }
      const now = nowSeconds();
      const info = db
        .prepare(
          `UPDATE team_runs
           SET paused_at = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(now, now, run.id, run.revision);
      if (info.changes !== 1) throw DomainError.optimisticLockFailed();
      appendEvent(db, {
        runID: input.runID,
        taskID: null,
        kind: TeamEventKind.runPaused,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload(
            "TeamRun paused: new quota grants stop, in-flight tasks continue",
            input.requestID,
          ),
        ),
      });
      const updated = requireRunSync(db, input.runID);
      saveResponse(db, input.requestID, updated);
      return updated;
    }, [input.runID]);
  }

  async resumeRun(input: { requestID: string; runID: string }): Promise<TeamRun> {
    return this.write((db) => {
      const cached = cachedResponse<TeamRun>(db, input.requestID);
      if (cached) return cached;
      const run = requireRunSync(db, input.runID);
      if (run.pausedAt == null) {
        // Idempotent: resuming a running run returns the current state.
        saveResponse(db, input.requestID, run);
        return run;
      }
      const info = db
        .prepare(
          `UPDATE team_runs
           SET paused_at = NULL, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(nowSeconds(), run.id, run.revision);
      if (info.changes !== 1) throw DomainError.optimisticLockFailed();
      appendEvent(db, {
        runID: input.runID,
        taskID: null,
        kind: TeamEventKind.runResumed,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload("TeamRun resumed: queued tasks continue by priority", input.requestID),
        ),
      });
      const updated = requireRunSync(db, input.runID);
      saveResponse(db, input.requestID, updated);
      return updated;
    }, [input.runID]);
  }

  async recordDoctorReport(input: {
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
  }): Promise<DoctorReport> {
    // Doctor tables are run-independent: no run observers to notify.
    return this.write((db) => {
      const cached = cachedResponse<DoctorReport>(db, input.requestID);
      if (cached) return cached;
      // The overall is derived in the domain, never trusted from the caller.
      const overall = doctorOverallOf(input.items);
      const reportID = randomUUID();
      const createdAt = nowSeconds();
      db.prepare(
        `INSERT INTO doctor_reports(id, triggered_by, repository_path, overall, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(reportID, input.triggeredBy, input.repositoryPath, overall, createdAt);
      const insertItem = db.prepare(
        `INSERT INTO doctor_check_items(
            id, report_id, check_key, status, detail, impact, suggestion, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const items: DoctorReportItem[] = input.items.map((item) => {
        const itemID = randomUUID();
        insertItem.run(
          itemID,
          reportID,
          item.checkKey,
          item.status,
          item.detail,
          item.impact,
          item.suggestion,
          item.durationMs,
        );
        return {
          id: itemID,
          reportID,
          checkKey: item.checkKey,
          status: item.status,
          detail: item.detail,
          impact: item.impact,
          suggestion: item.suggestion,
          durationMs: item.durationMs,
        };
      });
      const result: DoctorReport = {
        id: reportID,
        triggeredBy: input.triggeredBy,
        repositoryPath: input.repositoryPath,
        overall,
        items,
        createdAt,
      };
      saveResponse(db, input.requestID, result);
      return result;
    }, []);
  }

  async getLatestDoctorReport(repositoryPath: string | null): Promise<DoctorReport | null> {
    // `IS ?` matches NULL repository paths for the global reports, exactly
    // like the run-level delivery summary lookup.
    const row = oneRow(
      this.db,
      "SELECT * FROM doctor_reports WHERE repository_path IS ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      repositoryPath,
    );
    if (row == null) return null;
    return DatabaseMappers.doctorReport(row, doctorItemsSync(this.db, row.id as string));
  }

  async rerunDoctorCheckItem(input: {
    requestID: string;
    reportID: string;
    checkKey: DoctorCheckKey;
    status: DoctorCheckStatus;
    detail: string;
    impact: string;
    suggestion: string;
    durationMs: number;
  }): Promise<DoctorReport> {
    return this.write((db) => {
      const cached = cachedResponse<DoctorReport>(db, input.requestID);
      if (cached) return cached;
      const reportRow = oneRow(db, "SELECT id FROM doctor_reports WHERE id = ?", input.reportID);
      if (reportRow == null) {
        throw DomainError.invalidTask(`Doctor report not found: ${input.reportID}`);
      }
      const itemRow = oneRow(
        db,
        "SELECT id FROM doctor_check_items WHERE report_id = ? AND check_key = ?",
        input.reportID,
        input.checkKey,
      );
      if (itemRow == null) {
        throw DomainError.invalidTask(`Doctor check item not found: ${input.checkKey}`);
      }
      db.prepare(
        `UPDATE doctor_check_items
         SET status = ?, detail = ?, impact = ?, suggestion = ?, duration_ms = ?
         WHERE id = ?`,
      ).run(
        input.status,
        input.detail,
        input.impact,
        input.suggestion,
        input.durationMs,
        itemRow.id,
      );
      // Recompute the overall from the persisted rows, never from input.
      const overall = doctorOverallOf(doctorItemsSync(db, input.reportID));
      db.prepare("UPDATE doctor_reports SET overall = ?, created_at = ? WHERE id = ?").run(
        overall,
        nowSeconds(),
        input.reportID,
      );
      const updated = oneRow(db, "SELECT * FROM doctor_reports WHERE id = ?", input.reportID);
      const result = DatabaseMappers.doctorReport(
        updated as Row,
        doctorItemsSync(db, input.reportID),
      );
      saveResponse(db, input.requestID, result);
      return result;
    }, []);
  }

  async updateAttemptPid(input: {
    runID: string;
    taskID: string;
    attemptID: string;
    pid: number | null;
  }): Promise<void> {
    this.write((db) => {
      // Ownership: the attempt row only matches when it belongs to the task.
      const info = db
        .prepare("UPDATE task_attempts SET pid = ? WHERE id = ? AND task_id = ?")
        .run(input.pid, input.attemptID, input.taskID);
      if (info.changes !== 1) {
        throw DomainError.invalidTask(
          `Attempt ${input.attemptID} does not belong to task ${input.taskID}.`,
        );
      }
    }, [input.runID]);
  }

  async importLegacySnapshot(data: Buffer, sourceURL: string): Promise<TeamRunSnapshot | null> {
    return this.write((db) => {
      const imported = oneRow(
        db,
        "SELECT value FROM app_metadata WHERE key = ?",
        "legacy_session_imported",
      );
      if (imported != null) return null;
      let object: Record<string, unknown>;
      try {
        object = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      } catch {
        throw DomainError.invalidTask("The legacy last-session.json format is not supported.");
      }
      const repositoryPath = typeof object.repositoryPath === "string" ? object.repositoryPath : null;
      const taskText = typeof object.task === "string" ? object.task : null;
      const runIDString = typeof object.runID === "string" ? object.runID : null;
      if (repositoryPath == null || taskText == null || runIDString == null || !isUUID(runIDString)) {
        throw DomainError.invalidTask("The legacy last-session.json format is not supported.");
      }
      const legacyUpdatedAt = legacyDate(object.updatedAt) ?? nowSeconds();
      const run = makeTeamRun({
        id: runIDString,
        repositoryPath,
        task: taskText,
        baselineCommit: "legacy-import",
        status: "completed",
        maxConcurrentTasks: 1,
        maxReviewRounds: numberOr(object.maxRounds, 5),
        currentReviewRound: numberOr(object.round, 0),
        createdAt: legacyUpdatedAt,
        updatedAt: legacyUpdatedAt,
      });
      db.prepare(
        `INSERT OR IGNORE INTO team_runs(
            id, repository_path, task, baseline_commit, status,
            target_branch, max_concurrent_tasks, max_review_rounds, current_review_round,
            revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.repositoryPath,
        run.task,
        run.baselineCommit,
        run.status,
        run.targetBranch,
        run.maxConcurrentTasks,
        run.maxReviewRounds,
        run.currentReviewRound,
        run.revision,
        run.createdAt,
        run.updatedAt,
      );
      appendEvent(db, {
        runID: run.id,
        taskID: null,
        kind: TeamEventKind.migrationImported,
        payload: encodeTeamEventPayload(
          makeTeamEventPayload("Imported legacy last-session.json as read-only history", null, {
            source: sourceURL,
          }),
        ),
      });
      db.prepare("INSERT INTO app_metadata(key, value, updated_at) VALUES (?, ?, ?)").run(
        "legacy_session_imported",
        sourceURL,
        nowSeconds(),
      );
      return snapshotSync(db, run.id);
    }, [null]);
  }

  // MARK: - Change notification

  private write<T>(fn: (db: SqliteDatabase) => T, runs: (string | null)[]): T {
    const transaction = this.db.transaction(fn);
    const result = transaction.immediate(this.db) as T;
    for (const runID of runs) {
      if (runID == null) {
        for (const listener of this.globalListeners) listener();
      } else {
        const listeners = this.runListeners.get(runID);
        if (listeners) {
          for (const listener of listeners) listener();
        }
        for (const listener of this.globalListeners) listener();
      }
    }
    return result;
  }

  /**
   * Cross-process live updates: `PRAGMA data_version` bumps whenever another
   * connection commits (WAL). On change, all observers recompute — the
   * value-dedupe keeps silent periods emission-free.
   */
  watchExternalChanges(intervalMs = 2000): () => void {
    let last = this.db.pragma("data_version", { simple: true }) as number;
    const timer = setInterval(() => {
      const current = this.db.pragma("data_version", { simple: true }) as number;
      if (current === last) return;
      last = current;
      for (const listener of this.globalListeners) listener();
      for (const listeners of this.runListeners.values()) {
        for (const listener of listeners) listener();
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }

  private observeValue<T>(runID: string, compute: (db: SqliteDatabase) => T): AsyncStream<T> {    return makeStream((emit, fail) => {
      let last = "";
      const listener = (): void => {
        try {
          const value = compute(this.db);
          const encoded = stableStringify(value);
          if (encoded !== last) {
            last = encoded;
            emit(value);
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      listener();
      let listeners = this.runListeners.get(runID);
      if (listeners == null) {
        listeners = new Set();
        this.runListeners.set(runID, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });
  }
}

// MARK: - Synchronous helpers (private to this module)

function snapshotSync(db: SqliteDatabase, runID: string): TeamRunSnapshot {
  return {
    run: requireRunSync(db, runID),
    batches: loadBatchesSync(db, runID),
    tasks: loadTasksSync(db, runID),
    dependencies: loadDependenciesSync(db, runID),
    reviewCycles: loadCyclesSync(db, runID),
    findings: loadFindingsSync(db, runID),
    attempts: loadAttemptsSync(db, runID),
    reports: loadReportsSync(db, runID),
    executionLogs: loadExecutionLogsSync(db, runID),
    events: allRows(db, "SELECT * FROM relay_events WHERE run_id = ? ORDER BY sequence", runID).map(
      DatabaseMappers.event,
    ),
  };
}

function runSummarySync(db: SqliteDatabase, runID: string): RunSummary {
  return {
    run: requireRunSync(db, runID),
    batches: loadBatchesSync(db, runID),
    tasks: loadTasksSync(db, runID),
    dependencies: loadDependenciesSync(db, runID),
  };
}

function eventTailSync(db: SqliteDatabase, runID: string, limit: number): RelayEvent[] {
  return allRows(
    db,
    "SELECT * FROM relay_events WHERE run_id = ? ORDER BY sequence DESC LIMIT ?",
    runID,
    limit,
  )
    .map(DatabaseMappers.event)
    .reverse();
}

function runSummariesSync(db: SqliteDatabase): TeamRunSummary[] {
  return allRows(
    db,
    `SELECT r.*, COUNT(t.id) AS task_count,
        SUM(CASE WHEN t.status = 'accepted' THEN 1 ELSE 0 END) AS accepted_count
    FROM team_runs r
    LEFT JOIN child_tasks t ON t.run_id = r.id
    WHERE r.hidden_at IS NULL
    GROUP BY r.id
    ORDER BY r.updated_at DESC`,
  ).map((row) => ({
    id: row.id as string,
    repositoryPath: row.repository_path as string,
    task: row.task as string,
    status: DatabaseMappers.run(row).status,
    priority: DatabaseMappers.run(row).priority,
    taskCount: row.task_count as number,
    acceptedTaskCount: (row.accepted_count as number | null) ?? 0,
    updatedAt: DatabaseMappers.run(row).updatedAt,
    archivedAt: DatabaseMappers.run(row).archivedAt,
  }));
}

function requireRunSync(db: SqliteDatabase, id: string): TeamRun {
  const row = oneRow(db, "SELECT * FROM team_runs WHERE id = ?", id);
  if (row == null) throw DomainError.runNotFound(id);
  return DatabaseMappers.run(row);
}

function requireTaskSync(db: SqliteDatabase, id: string, runID: string): ChildTask {
  const row = oneRow(db, "SELECT * FROM child_tasks WHERE id = ? AND run_id = ?", id, runID);
  if (row == null) throw DomainError.taskNotFound(id);
  return DatabaseMappers.task(row);
}

function reviewCommentSync(db: SqliteDatabase, runID: string, commentID: string): ReviewComment {
  const row = oneRow(db, "SELECT * FROM review_comments WHERE id = ? AND run_id = ?", commentID, runID);
  if (row == null) throw DomainError.invalidTask(`Review comment not found: ${commentID}`);
  return DatabaseMappers.reviewComment(row);
}

function gateItemsSync(db: SqliteDatabase, evaluationID: string): GateEvaluationItem[] {
  return allRows(
    db,
    "SELECT * FROM gate_evaluation_items WHERE evaluation_id = ? ORDER BY rowid",
    evaluationID,
  ).map(DatabaseMappers.gateEvaluationItem);
}

function doctorItemsSync(db: SqliteDatabase, reportID: string): DoctorReportItem[] {
  return allRows(
    db,
    "SELECT * FROM doctor_check_items WHERE report_id = ? ORDER BY rowid",
    reportID,
  ).map(DatabaseMappers.doctorReportItem);
}

function loadTasksSync(db: SqliteDatabase, runID: string): ChildTask[] {
  return allRows(db, "SELECT * FROM child_tasks WHERE run_id = ? ORDER BY created_at", runID).map(
    DatabaseMappers.task,
  );
}

function loadBatchesSync(db: SqliteDatabase, runID: string): TaskBatch[] {
  return allRows(db, "SELECT * FROM task_batches WHERE run_id = ? ORDER BY created_at", runID).map(
    DatabaseMappers.batch,
  );
}

function loadDependenciesSync(db: SqliteDatabase, runID: string): TaskDependency[] {
  return allRows(db, "SELECT * FROM task_dependencies WHERE run_id = ? ORDER BY rowid", runID).map(
    DatabaseMappers.dependency,
  );
}

function loadCyclesSync(db: SqliteDatabase, runID: string): ReviewCycleRow[] {
  return allRows(db, "SELECT * FROM review_cycles WHERE run_id = ? ORDER BY created_at", runID).map(
    DatabaseMappers.cycle,
  );
}

type ReviewCycleRow = ReturnType<typeof DatabaseMappers.cycle>;

function loadFindingsSync(db: SqliteDatabase, runID: string): ReviewFinding[] {
  return allRows(
    db,
    `SELECT f.* FROM review_findings f
     JOIN review_cycles c ON c.id = f.review_cycle_id
     WHERE c.run_id = ? ORDER BY c.created_at, f.rowid`,
    runID,
  ).map(DatabaseMappers.finding);
}

function loadAttemptsSync(db: SqliteDatabase, runID: string): TaskAttempt[] {
  return allRows(
    db,
    "SELECT * FROM task_attempts WHERE run_id = ? ORDER BY started_at, attempt_number",
    runID,
  ).map(DatabaseMappers.attempt);
}

function loadReportsSync(db: SqliteDatabase, runID: string): TaskExecutionReport[] {
  return allRows(db, "SELECT * FROM task_reports WHERE run_id = ? ORDER BY created_at", runID)
    .map((row) => {
      const tests = parseStringArray(row.tests_json);
      const changedFiles = parseStringArray(row.changed_files_json);
      if (tests == null || changedFiles == null) return null;
      return DatabaseMappers.report(row, tests, changedFiles);
    })
    .filter((row): row is TaskExecutionReport => row != null);
}

function loadExecutionLogsSync(db: SqliteDatabase, runID: string): TaskExecutionLog[] {
  return allRows(db, "SELECT * FROM task_execution_logs WHERE run_id = ? ORDER BY updated_at", runID)
    .map((row) => {
      const tools = parseStringArray(row.tool_summary_json);
      if (tools == null) return null;
      return DatabaseMappers.executionLog(row, tools);
    })
    .filter((row): row is TaskExecutionLog => row != null);
}

function executionLogSync(db: SqliteDatabase, runID: string, taskID: string): TaskExecutionLog | null {
  const row = oneRow(
    db,
    "SELECT * FROM task_execution_logs WHERE run_id = ? AND task_id = ? ORDER BY updated_at DESC LIMIT 1",
    runID,
    taskID,
  );
  if (row == null) return null;
  const tools = parseStringArray(row.tool_summary_json);
  if (tools == null) return null;
  return DatabaseMappers.executionLog(row, tools);
}

function loadExecutionLogByAttempt(db: SqliteDatabase, attemptID: string): TaskExecutionLog | null {
  const row = oneRow(db, "SELECT * FROM task_execution_logs WHERE attempt_id = ?", attemptID);
  if (row == null) return null;
  const tools = parseStringArray(row.tool_summary_json);
  if (tools == null) return null;
  return DatabaseMappers.executionLog(row, tools);
}

function updateRunSync(db: SqliteDatabase, run: TeamRun, status: TeamRun["status"], currentReviewRound?: number): void {
  const info = db
    .prepare(
      `UPDATE team_runs
       SET status = ?, current_review_round = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
    )
    .run(status, currentReviewRound ?? run.currentReviewRound, nowSeconds(), run.id, run.revision);
  if (info.changes !== 1) throw DomainError.optimisticLockFailed();
}

function updateTaskSync(
  db: SqliteDatabase,
  task: ChildTask,
  changes: {
    status: ChildTask["status"];
    sessionID: string | null;
    currentAttemptID: string | null;
    latestReport: string | null;
    latestError: string | null;
    reviewRound: number;
  },
): ChildTask {
  const info = db
    .prepare(
      `UPDATE child_tasks
       SET session_id = ?, current_attempt_id = ?, status = ?, latest_report = ?, latest_error = ?,
           review_round = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
    )
    .run(
      changes.sessionID,
      changes.currentAttemptID,
      changes.status,
      changes.latestReport,
      changes.latestError,
      changes.reviewRound,
      nowSeconds(),
      task.id,
      task.revision,
    );
  if (info.changes !== 1) throw DomainError.optimisticLockFailed();
  return requireTaskSync(db, task.id, task.runID);
}

function insertAttempt(db: SqliteDatabase, task: ChildTask, sessionID: string | null): string {
  const attemptID = randomUUID();
  const row = oneRow(
    db,
    "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM task_attempts WHERE task_id = ?",
    task.id,
  );
  const nextNumber = row ? (row.next as number) : 1;
  db.prepare(
    `INSERT INTO task_attempts(
        id, run_id, task_id, attempt_number, prompt, session_id, status,
        started_at, finished_at, failure
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(attemptID, task.runID, task.id, nextNumber, task.prompt, sessionID, "running", nowSeconds());
  return attemptID;
}

function ensureAttempt(db: SqliteDatabase, task: ChildTask, sessionID: string): string {
  if (task.currentAttemptID != null) {
    return task.currentAttemptID;
  }
  return insertAttempt(db, task, sessionID);
}

function updateAttemptSession(db: SqliteDatabase, attemptID: string, sessionID: string): void {
  db.prepare("UPDATE task_attempts SET session_id = ? WHERE id = ?").run(sessionID, attemptID);
}

function updateAttempt(db: SqliteDatabase, input: {
  attemptID: string;
  sessionID: string | null;
  status: TaskAttempt["status"];
  finishedAt: number | null;
  failure: string | null;
}): void {
  db.prepare(
    `UPDATE task_attempts
     SET session_id = COALESCE(?, session_id), status = ?, finished_at = ?, failure = ?
     WHERE id = ?`,
  ).run(input.sessionID, input.status, input.finishedAt, input.failure, input.attemptID);
}

function insertTaskReport(db: SqliteDatabase, input: TaskReportInput, attemptID: string): void {
  db.prepare(
    `INSERT INTO task_reports(
        id, run_id, task_id, attempt_id, session_id, summary, raw_output,
        tests_json, changed_files_json, diff_summary, blocker, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.runID,
    input.taskID,
    attemptID,
    input.sessionID,
    input.report,
    input.rawOutput,
    stableStringify(input.tests),
    stableStringify(input.changedFiles),
    input.diffSummary,
    input.blocker,
    nowSeconds(),
  );
}

function insertReview(db: SqliteDatabase, input: ReviewDecisionInput, round: number): void {
  const cycleID = randomUUID();
  db.prepare(
    `INSERT INTO review_cycles(id, run_id, task_id, round, reviewer, verdict, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cycleID,
    input.runID,
    input.taskID,
    round,
    input.reviewer,
    input.verdict,
    input.summary,
    nowSeconds(),
  );
  for (const finding of input.findings) {
    db.prepare(
      `INSERT INTO review_findings(
          id, review_cycle_id, task_id, severity, file, line, evidence, expected_fix
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      finding.id,
      cycleID,
      input.taskID,
      finding.severity,
      finding.file,
      finding.line,
      finding.evidence,
      finding.expectedFix,
    );
  }
}

function insertTeamReview(db: SqliteDatabase, input: {
  runID: string;
  reviewer: string;
  summary: string;
  round: number;
}): void {
  db.prepare(
    `INSERT INTO review_cycles(id, run_id, task_id, round, reviewer, verdict, summary, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), input.runID, input.round, input.reviewer, "PASS", input.summary, nowSeconds());
}

function appendEvent(db: SqliteDatabase, input: {
  runID: string;
  taskID: string | null;
  kind: string;
  payload: string;
}): void {
  const row = oneRow(
    db,
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM relay_events WHERE run_id = ?",
    input.runID,
  );
  const sequence = row ? (row.next as number) : 1;
  db.prepare(
    `INSERT INTO relay_events(id, run_id, task_id, sequence, kind, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), input.runID, input.taskID, sequence, input.kind, input.payload, nowSeconds());
}

function cachedResponse<T>(db: SqliteDatabase, requestID: string): T | null {
  const row = oneRow(
    db,
    "SELECT response_json FROM idempotency_requests WHERE request_id = ?",
    requestID,
  );
  if (row == null) return null;
  try {
    return JSON.parse(row.response_json as string) as T;
  } catch {
    return null;
  }
}

function saveResponse(db: SqliteDatabase, requestID: string, value: unknown): void {
  db.prepare(
    "INSERT INTO idempotency_requests(request_id, response_json, created_at) VALUES (?, ?, ?)",
  ).run(requestID, stableStringify(value), nowSeconds());
}

function relayEventKind(kind: ChildAgentEventKind): string | null {
  switch (kind) {
    case "started":
      return TeamEventKind.taskStarted;
    case "session":
      return TeamEventKind.agentSession;
    case "output":
      return TeamEventKind.agentOutput;
    case "tool":
      return TeamEventKind.agentTool;
    case "completed":
      return TeamEventKind.agentCompleted;
    case "failed":
      return TeamEventKind.agentFailed;
    case "cancelled":
      return TeamEventKind.agentCancelled;
  }
}

function boundedDiagnosticTail(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(value.length - limit);
}

export function renderContextDigest(summary: RunSummary): ContextFetchDigest {
  // Idempotency replays decode timestamps as whole seconds; the first
  // response carries the same precision to stay equal to it.
  const now = Math.floor(nowSeconds());
  const rendered = renderTeamContextSummary(summary, now);
  const redacted = ChildAgentDiagnostics.redact(rendered);
  const limit = 16 * 1024;
  const bounded = Buffer.byteLength(redacted, "utf8") > limit ? suffixUTF8(redacted, limit) : redacted;
  const digests: ContextTaskDigest[] = summary.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    agentKind: task.agentKind,
    executionMode: task.executionMode,
    hasReport: task.latestReport != null,
    reportBytes: task.latestReport != null ? Buffer.byteLength(task.latestReport, "utf8") : 0,
  }));
  return { summary: bounded, tasks: digests, generatedAt: now };
}

/** Caps by UTF-8 bytes (String.slice counts UTF-16 units). */
export function suffixUTF8(value: string, byteLimit: number): string {
  const data = Buffer.from(value, "utf8");
  if (data.length <= byteLimit) return value;
  return data.subarray(data.length - byteLimit).toString("utf8");
}

/** Mirrors the Settings child-model cap: trim, empty → null, 100 chars. */
function normalizeTaskModel(model: string | null | undefined): string | null {
  const trimmed = (model ?? "").trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 100);
}

function createTaskBatch(db: SqliteDatabase, input: DelegateTasksInput): DelegateTasksResult {
  if (input.tasks.length === 0) {
    throw DomainError.invalidTask("At least one child task is required.");
  }
  const run = requireRunSync(db, input.runID);
  const currentTasks = loadTasksSync(db, input.runID);
  const currentDependencies = loadDependenciesSync(db, input.runID);
  TeamRunPolicy.validateCanDelegate(run, currentTasks, currentDependencies);

  const sanitizedContext = ChildAgentDiagnostics.redact(input.contextSummary);
  if (Buffer.byteLength(sanitizedContext, "utf8") > 16 * 1024) {
    throw DomainError.contextTooLarge();
  }
  const keys = new Set<string>();
  for (const item of input.tasks) {
    const key = item.clientKey.trim();
    if (key.length === 0) throw DomainError.invalidTask("A batch client_key is required.");
    if (keys.has(key)) throw DomainError.duplicateClientKey(key);
    keys.add(key);
    if (item.title.trim().length === 0) {
      throw DomainError.invalidTask("A child task title is required.");
    }
    if (item.prompt.trim().length === 0) {
      throw DomainError.invalidTask("A child task prompt is required.");
    }
  }

  const batchID = randomUUID();
  const newIDs = new Map<string, string>();
  for (const item of input.tasks) {
    newIDs.set(item.clientKey.trim(), randomUUID());
  }
  const existingIDs = new Set(currentTasks.map((task) => task.id));
  const resolve = (reference: { taskID: string | null; clientKey: string | null }): string => {
    if (!isExactlyOneReference(reference)) {
      throw DomainError.invalidTaskReference("exactly one of task_id or client_key is required");
    }
    if (reference.taskID != null) {
      if (!existingIDs.has(reference.taskID)) throw DomainError.missingDependency(reference.taskID);
      return reference.taskID;
    }
    const taskID = newIDs.get(reference.clientKey ?? "");
    if (taskID == null) {
      throw DomainError.invalidTaskReference(`unknown client_key ${reference.clientKey ?? ""}`);
    }
    return taskID;
  };

  const tasks: ChildTask[] = [];
  const newDependencies: TaskDependency[] = [];
  const shortRun = run.id.replaceAll("-", "").slice(0, 8);
  const worktreeRoot = taskWorktreeRoot(run.id);
  for (const item of input.tasks) {
    const clientKey = item.clientKey.trim();
    const taskID = newIDs.get(clientKey) as string;
    const workspaceKind: ChildTask["workspaceKind"] =
      item.executionMode === "read_only" ? "shared_read_only" : "isolated_write";
    const shortTask = taskID.replaceAll("-", "").slice(0, 8);
    const branch =
      workspaceKind === "shared_read_only"
        ? `readonly/${shortRun}/${shortTask}`
        : `octopunk/${shortRun}/${shortTask}`;
    const worktreePath =
      workspaceKind === "shared_read_only"
        ? sharedReadOnlyWorktreeURL(run.id, run.baselineCommit)
        : `${worktreeRoot}/${taskID}`;
    const parentTaskID = item.parentTask ? resolve(item.parentTask) : null;
    tasks.push(
      makeChildTask({
        id: taskID,
        runID: run.id,
        batchID,
        clientKey,
        parentTaskID,
        title: item.title,
        prompt: item.prompt,
        agentKind: item.agentKind,
        model: normalizeTaskModel(item.model),
        executionMode: item.executionMode,
        workspaceKind,
        baselineCommit: run.baselineCommit,
        branchName: branch,
        worktreePath,
        contextSnapshot: sanitizedContext,
      }),
    );
    for (const dependency of item.dependencies) {
      const dependencyID = resolve(dependency);
      newDependencies.push({
        id: randomUUID(),
        runID: run.id,
        taskID,
        dependsOnTaskID: dependencyID,
      });
    }
  }

  const allTasks = currentTasks.concat(tasks);
  const allDependencies = currentDependencies.concat(newDependencies);
  TeamRunPolicy.validateAcyclic(allTasks, allDependencies);
  validateParentAcyclic(allTasks);

  const batch = makeTaskBatch({ id: batchID, runID: run.id, contextSummary: sanitizedContext });
  db.prepare(
    "INSERT INTO task_batches(id, run_id, context_summary, created_at) VALUES (?, ?, ?, ?)",
  ).run(batch.id, batch.runID, batch.contextSummary, batch.createdAt);
  for (const task of tasks) {
    db.prepare(
      `INSERT INTO child_tasks(
          id, run_id, batch_id, client_key, parent_task_id, title, prompt,
          agent_kind, model, execution_mode, workspace_kind, baseline_commit,
          branch_name, worktree_path, context_snapshot, session_id,
          current_attempt_id, status, latest_report, latest_error,
          review_round, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      task.id,
      task.runID,
      task.batchID,
      task.clientKey,
      task.parentTaskID,
      task.title,
      task.prompt,
      task.agentKind,
      task.model,
      task.executionMode,
      task.workspaceKind,
      task.baselineCommit,
      task.branchName,
      task.worktreePath,
      task.contextSnapshot,
      task.sessionID,
      task.currentAttemptID,
      task.status,
      task.latestReport,
      task.latestError,
      task.reviewRound,
      task.revision,
      task.createdAt,
      task.updatedAt,
    );
  }
  for (const dependency of newDependencies) {
    db.prepare(
      "INSERT INTO task_dependencies(id, run_id, task_id, depends_on_task_id) VALUES (?, ?, ?, ?)",
    ).run(dependency.id, dependency.runID, dependency.taskID, dependency.dependsOnTaskID);
  }
  updateRunSync(db, run, "running");
  for (const task of tasks) {
    appendEvent(db, {
      runID: run.id,
      taskID: task.id,
      kind: TeamEventKind.taskDelegated,
      payload: encodeTeamEventPayload(
        makeTeamEventPayload("Child task delegated", input.requestID, {
          batch_id: batch.id,
          client_key: task.clientKey ?? "",
          parent_task_id: task.parentTaskID ?? "",
          title: task.title,
          agent_kind: task.agentKind,
          model: task.model ?? "",
          execution_mode: task.executionMode,
          workspace_kind: task.workspaceKind,
        }),
      ),
    });
  }
  // Return the same SQLite-normalized values the idempotency replay decodes.
  const persistedBatch = loadBatchesSync(db, run.id).find((b) => b.id === batch.id) ?? batch;
  const persistedTasksByID = new Map(
    loadTasksSync(db, run.id)
      .filter((task) => task.batchID === batch.id)
      .map((task) => [task.id, task] as const),
  );
  const persistedTasks = tasks.map((task) => persistedTasksByID.get(task.id)).filter((t): t is ChildTask => t != null);
  return { batch: persistedBatch, tasks: persistedTasks };
}

function validateParentAcyclic(tasks: ChildTask[]): void {
  const parents = new Map<string, string | null>();
  for (const task of tasks) {
    parents.set(task.id, task.parentTaskID);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw DomainError.invalidTaskReference("parent_task_id contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    const parent = parents.get(id) ?? null;
    if (parent != null) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) {
    visit(task.id);
  }
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function legacyDate(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed / 1000;
  }
  return null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
