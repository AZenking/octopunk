// Port of OctoPunk/OctoPunk/Application/Services/AgentTeamApplicationService.swift.

import { randomUUID } from "node:crypto";
import type {
  JoinTasksDTO,
  JoinedTaskDTO,
} from "../../shared/dtos";
import {
  DomainError,
  runStatusIsTerminal,
  taskStatusIsTerminal,
} from "../domain/models";
import type { ChildTask, ReviewFeedback, TeamRun } from "../domain/models";
import { TaskEventHub } from "../domain/events";
import type { TaskEventUpdate } from "../domain/events";
import {
  ChildAgentDiagnostics,
  CancellationError,
  type ChildAgentKind,
} from "./ports";
import {
  joinedTaskDTO,
  taskReportDTO,
  teamReviewContextDTO,
  teamStatusDTO,
  childTaskDTO,
  delegateTasksResultDTO,
  eventTailDTO,
  runSummaryDTO,
  taskExecutionLogDTO,
} from "./dtos";
import type {
  DelegateTaskInput,
  DelegateTasksInput,
  JoinTasksInput,
  ReviewDecisionInput,
  StartTeamInput,
  TeamRunRepository,
} from "../domain/repositoryPort";
import type { ChildExecutionService } from "./childExecutionService";
import type { TaskIntegrationService } from "./taskIntegrationService";

interface ChildWork {
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Task metadata mirror for event-monitor enrichment; refreshed from the light
 * run-summary observation so notification extras never require the full
 * aggregate snapshot.
 */
class TaskMetadataCache {
  private entries = new Map<
    string,
    { batchID: string | null; parentTaskID: string | null; status: string }
  >();

  update(tasks: ChildTask[]): void {
    for (const task of tasks) {
      this.entries.set(task.id, {
        batchID: task.batchID,
        parentTaskID: task.parentTaskID,
        status: task.status,
      });
    }
  }

  task(id: string | null): { batchID: string | null; parentTaskID: string | null; status: string } | null {
    if (id == null) return null;
    return this.entries.get(id) ?? null;
  }
}

export class AgentTeamApplicationService {
  private readonly repository: TeamRunRepository;
  private readonly childExecution: ChildExecutionService;
  private readonly integration: TaskIntegrationService;
  private readonly eventHub: TaskEventHub | null;
  private childWork = new Map<string, ChildWork>();
  /** Includes a reservation while `launch` is awaiting the database write. */
  private childRunIDs = new Map<string, string>();
  private eventMonitors = new Map<string, { cancel: () => void }>();

  constructor(input: {
    repository: TeamRunRepository;
    childExecution: ChildExecutionService;
    integration: TaskIntegrationService;
    eventHub?: TaskEventHub | null;
  }) {
    this.repository = input.repository;
    this.childExecution = input.childExecution;
    this.integration = input.integration;
    this.eventHub = input.eventHub ?? null;
  }

  async startTeam(input: StartTeamInput): Promise<import("../../shared/dtos").TeamStatusDTO> {
    const result = await this.repository.startTeam(input);
    this.startEventMonitor(result.run.id);
    return teamStatusDTO(result);
  }

  async activeRunIDForSession(sessionID: string): Promise<string | null> {
    const snapshot = await this.repository.activeRun(sessionID);
    return snapshot?.run.id ?? null;
  }

  async failActiveRunsForSession(input: { sessionID: string; reason: string }): Promise<void> {
    const runIDs = await this.repository.failActiveRunsForSession(input);
    for (const runID of runIDs) {
      const snapshot = await this.repository.snapshot(runID);
      for (const task of snapshot.tasks) {
        await this.stop(task);
      }
    }
  }

  async delegateTask(input: DelegateTaskInput): Promise<import("../../shared/dtos").ChildTaskDTO> {
    const task = await this.repository.delegateTask(input);
    this.startEventMonitor(input.runID);
    await this.launchReadyTasks(input.runID);
    return childTaskDTO(task);
  }

  async delegateTasks(input: DelegateTasksInput): Promise<import("../../shared/dtos").DelegateTasksResultDTO> {
    const result = await this.repository.delegateTasks(input);
    this.startEventMonitor(input.runID);
    await this.launchReadyTasks(input.runID);
    return delegateTasksResultDTO(result);
  }

  async joinTasks(input: JoinTasksInput): Promise<JoinTasksDTO> {
    const exclusive = (input.batchID != null) === (input.taskIDs.length === 0);
    if (!exclusive) {
      throw DomainError.invalidTask("join_tasks requires exactly one of batch_id or task_ids.");
    }
    const timeoutSeconds = Math.min(Math.max(input.timeoutSeconds, 0), 45);
    const initial = await this.repository.snapshot(input.runID);
    const selectedIDs = selectedTaskIDs(input, initial);
    const initialReady = allTasksJoinable(initial, selectedIDs);
    let snapshot = initial;
    if (!initialReady) {
      const observed = await Promise.race([
        (async (): Promise<import("../domain/models").TeamRunSnapshot | null> => {
          const stream = this.repository.observe(input.runID);
          try {
            for await (const value of stream) {
              if (allTasksJoinable(value, selectedIDs)) {
                return value;
              }
            }
            return null;
          } finally {
            stream.cancel();
          }
        })(),
        (async (): Promise<null> => {
          await sleep(timeoutSeconds * 1000);
          return null;
        })(),
      ]);
      snapshot = observed ?? (await this.repository.snapshot(input.runID));
    }

    const tasks = selectedIDs
      .map((taskID) => snapshot.tasks.find((task) => task.id === taskID))
      .filter((task): task is ChildTask => task != null);
    const joined = tasks.map((task) =>
      joinedTaskDTO(
        task,
        [...snapshot.reports].reverse().find((report) => report.taskID === task.id) ?? null,
      ),
    );
    const pending = tasks
      .filter((task) => !taskStatusIsTerminal(task.status) && task.status !== "awaiting_report")
      .map((task) => task.id);
    const latestSequence = snapshot.events.reduce((max, event) => Math.max(max, event.sequence), 0);
    return {
      runID: input.runID,
      batchID: input.batchID,
      tasks: joined,
      pendingTaskIDs: pending,
      timedOut: pending.length > 0,
      latestEventSequence: latestSequence,
      markdownSummary: markdownSummary(joined, pending),
    };
  }

  async waitForReport(
    runID: string,
    taskID: string,
    timeoutSeconds = 45,
  ): Promise<import("../../shared/dtos").TaskReportDTO> {
    const result = await Promise.race([
      (async (): Promise<import("../../shared/dtos").TaskReportDTO | null> => {
        const stream = this.repository.observe(runID);
        try {
          for await (const value of stream) {
            const task = value.tasks.find((candidate) => candidate.id === taskID);
            if (task == null) throw DomainError.taskNotFound(taskID);
            if (
              task.status === "awaiting_report" ||
              task.status === "rework_required" ||
              task.status === "accepted" ||
              task.status === "blocked" ||
              task.status === "cancelled" ||
              task.status === "failed"
            ) {
              return taskReportDTO(
                task,
                [...value.reports].reverse().find((report) => report.taskID === taskID) ?? null,
              );
            }
          }
          return null;
        } finally {
          stream.cancel();
        }
      })(),
      (async (): Promise<null> => {
        await sleep(timeoutSeconds * 1000);
        return null;
      })(),
    ]);
    if (result != null) return result;
    const snapshot = await this.repository.snapshot(runID);
    const task = snapshot.tasks.find((candidate) => candidate.id === taskID);
    if (task == null) throw DomainError.taskNotFound(taskID);
    return taskReportDTO(
      task,
      [...snapshot.reports].reverse().find((report) => report.taskID === taskID) ?? null,
    );
  }

  async getTaskReviewContext(
    runID: string,
    taskID: string,
  ): Promise<import("../../shared/dtos").TeamReviewContextDTO> {
    const context = await this.getTeamReviewContext(runID);
    if (!context.tasks.some((task) => task.id === taskID)) {
      throw DomainError.taskNotFound(taskID);
    }
    return context;
  }

  async getTaskExecutionLog(
    runID: string,
    taskID: string,
    afterSequence: number | null,
  ): Promise<import("../../shared/dtos").TaskExecutionLogSliceDTO> {
    const snapshot = await this.repository.snapshot(runID);
    if (!snapshot.tasks.some((task) => task.id === taskID)) {
      throw DomainError.taskNotFound(taskID);
    }
    const log = await this.repository.executionLog(runID, taskID);
    const events = (await this.repository.events(runID, afterSequence)).filter(
      (event) => event.taskID === taskID,
    );
    return {
      taskID,
      log: log ? taskExecutionLogDTO(log) : null,
      events: events.map((event) => ({ ...event })),
    };
  }

  async requestRework(input: ReviewDecisionInput): Promise<import("../../shared/dtos").ChildTaskDTO> {
    const task = await this.repository.requestRework(input);
    await this.launchReadyTasks(task.runID);
    return childTaskDTO(task);
  }

  async acceptTask(input: ReviewDecisionInput): Promise<import("../../shared/dtos").ChildTaskDTO> {
    const snapshot = await this.repository.snapshot(input.runID);
    const task = snapshot.tasks.find((candidate) => candidate.id === input.taskID);
    if (task == null) throw DomainError.taskNotFound(input.taskID);
    if (task.executionMode !== "workspace_write") {
      const accepted = await this.repository.acceptTask(input);
      await this.launchReadyTasks(input.runID);
      return childTaskDTO(accepted);
    }
    const result = await this.integration.integrate(snapshot.run, task);
    if (result.integrated) {
      const accepted = await this.repository.acceptTask(input);
      await this.launchReadyTasks(input.runID);
      return childTaskDTO(accepted);
    }
    await this.repository
      .blockTask({
        requestID: input.requestID + ":conflict",
        runID: input.runID,
        taskID: input.taskID,
        reviewer: "octopunk.git",
        verdict: "BLOCKED",
        summary: result.details,
        findings: [],
      })
      .catch(() => null);
    throw DomainError.invalidTask(`Integration conflict: ${result.details}`);
  }

  async blockTask(input: ReviewDecisionInput): Promise<import("../../shared/dtos").ChildTaskDTO> {
    return childTaskDTO(await this.repository.blockTask(input));
  }

  async resumeTask(input: { requestID: string; runID: string; taskID: string }): Promise<import("../../shared/dtos").ChildTaskDTO> {
    const task = await this.repository.resumeTask(input);
    await this.launchReadyTasks(task.runID);
    return childTaskDTO(task);
  }

  async getTeamStatus(runID: string): Promise<import("../../shared/dtos").TeamStatusDTO> {
    this.startEventMonitor(runID);
    return teamStatusDTO(await this.repository.snapshot(runID));
  }

  async getTeamReviewContext(runID: string): Promise<import("../../shared/dtos").TeamReviewContextDTO> {
    this.startEventMonitor(runID);
    return teamReviewContextDTO(await this.repository.snapshot(runID));
  }

  async completeTeam(input: {
    requestID: string;
    runID: string;
    finalVerdict: "PASS" | "REWORK" | "BLOCKED";
    summary: string;
  }): Promise<import("../../shared/dtos").TeamStatusDTO> {
    if (input.finalVerdict === "PASS") {
      const snapshot = await this.repository.snapshot(input.runID);
      if (!snapshot.tasks.every((task) => task.status === "accepted")) {
        throw DomainError.taskNotReady(input.runID);
      }
      if (snapshot.tasks.some((task) => task.executionMode === "workspace_write")) {
        await this.integration.applyToTarget(snapshot.run);
      }
    }
    const result = await this.repository.completeTeam(input);
    if (input.finalVerdict === "PASS") {
      await this.integration.cleanup(result.run, result.tasks, "deleteBranch");
    }
    return teamStatusDTO(result);
  }

  async cancelTask(input: { requestID: string; runID: string; taskID: string }): Promise<import("../../shared/dtos").ChildTaskDTO> {
    const snapshot = await this.repository.snapshot(input.runID);
    const task = snapshot.tasks.find((candidate) => candidate.id === input.taskID) ?? null;
    const cancelled = await this.repository.cancelTask(input);
    if (task) {
      await this.stop(task);
    }
    return childTaskDTO(cancelled);
  }

  async cancelTeam(input: { requestID: string; runID: string }): Promise<import("../../shared/dtos").TeamStatusDTO> {
    const snapshot = await this.repository.snapshot(input.runID);
    const cancelled = await this.repository.cancelTeam(input);
    for (const task of snapshot.tasks) {
      await this.stop(task);
    }
    return teamStatusDTO(cancelled);
  }

  async discardTask(input: { requestID: string; runID: string; taskID: string }): Promise<import("../../shared/dtos").ChildTaskDTO> {
    const snapshot = await this.repository.snapshot(input.runID);
    const task = snapshot.tasks.find((candidate) => candidate.id === input.taskID);
    if (task == null) throw DomainError.taskNotFound(input.taskID);
    if (task.status === "accepted") {
      throw DomainError.invalidTask("An accepted task cannot be discarded before the TeamRun is discarded.");
    }
    const cancelled = await this.repository.cancelTask(input);
    await this.stop(task);
    const sharesWorktree = snapshot.tasks.some(
      (other) => other.id !== task.id && other.worktreePath === task.worktreePath,
    );
    if (!sharesWorktree) {
      await this.integration.cleanup(snapshot.run, cancelled, "discard");
    }
    return childTaskDTO(cancelled);
  }

  async discardTeam(input: { requestID: string; runID: string }): Promise<import("../../shared/dtos").TeamStatusDTO> {
    const snapshot = await this.repository.snapshot(input.runID);
    if (snapshot.run.status === "completed") {
      // The result was already applied and cleaned at completion; sweep any
      // leftovers without rewriting the run's terminal status.
      await this.integration.cleanup(snapshot.run, snapshot.tasks, "discard");
      return teamStatusDTO(snapshot);
    }
    const cancelled = await this.repository.cancelTeam(input);
    for (const task of snapshot.tasks) {
      await this.stop(task);
    }
    await this.integration.cleanup(cancelled.run, cancelled.tasks, "discard");
    return teamStatusDTO(cancelled);
  }

  async archiveTeam(input: { requestID: string; runID: string }): Promise<void> {
    await this.repository.archiveRun(input);
  }

  async unarchiveTeam(input: { requestID: string; runID: string }): Promise<void> {
    await this.repository.unarchiveRun(input);
  }

  private async launchReadyTasks(runID: string): Promise<void> {
    const snapshot = await this.repository.snapshot(runID);
    if (runStatusIsTerminal(snapshot.run.status)) return;
    for (const task of snapshot.tasks) {
      if (task.status !== "queued" && task.status !== "rework_required") continue;
      const dependencies = snapshot.dependencies.filter((dependency) => dependency.taskID === task.id);
      const ready = dependencies.every((dependency) => {
        const dependencyTask = snapshot.tasks.find((candidate) => candidate.id === dependency.dependsOnTaskID);
        return dependencyTask?.status === "accepted";
      });
      if (!ready) continue;
      if (!(this.activeChildCount(runID) < snapshot.run.maxConcurrentTasks)) break;
      const preparedTask = await this.prepareBaselineIfNeeded(
        task,
        snapshot.run,
        dependencies,
        snapshot.tasks,
      );
      await this.launch(preparedTask, snapshot.run);
    }
  }

  /**
   * Consumes two light observations instead of the full aggregate snapshot:
   * the tail stream supplies incremental events by sequence watermark, and
   * the summary stream refreshes task metadata for notification enrichment.
   */
  private startEventMonitor(runID: string): void {
    if (this.eventHub == null || this.eventMonitors.has(runID)) return;
    let cancelled = false;
    const metadata = new TaskMetadataCache();
    const summaryStream = this.repository.observeRunSummary(runID);
    const tailStream = this.repository.observeEventTail(runID, 100);
    const pumpSummary = (async () => {
      try {
        for await (const summary of summaryStream) {
          if (cancelled) return;
          metadata.update(summary.tasks);
          if (runStatusIsTerminal(summary.run.status)) return;
        }
      } catch {
        // Observation restarts only with a new service instance.
      }
    })();
    const pumpTail = (async () => {
      try {
        let lastSequence: number | null = null;
        for await (const tail of tailStream) {
          if (cancelled) return;
          if (lastSequence == null) {
            lastSequence = tail.reduce((max, event) => Math.max(max, event.sequence), 0);
            continue;
          }
          for (const event of tail) {
            if (event.sequence <= lastSequence) continue;
            const task = metadata.task(event.taskID);
            const update: TaskEventUpdate = {
              runID,
              batchID: task?.batchID ?? null,
              taskID: event.taskID,
              parentTaskID: task?.parentTaskID ?? null,
              sequence: event.sequence,
              kind: event.kind,
              status: task?.status ?? null,
              activityPreview: ChildAgentDiagnostics.redact(event.payload, 512),
              createdAt: event.createdAt,
            };
            this.eventHub?.publish(update);
            lastSequence = Math.max(lastSequence, event.sequence);
          }
        }
      } catch {
        // The persisted relay log and join_tasks remain authoritative.
      }
    })();
    this.eventMonitors.set(runID, {
      cancel: () => {
        cancelled = true;
        summaryStream.cancel();
        tailStream.cancel();
      },
    });
    void pumpSummary;
    void pumpTail;
  }

  private async prepareBaselineIfNeeded(
    task: ChildTask,
    run: TeamRun,
    dependencies: import("../domain/models").TaskDependency[],
    tasks: ChildTask[],
  ): Promise<ChildTask> {
    if (dependencies.length === 0 || task.sessionID != null || task.currentAttemptID != null) {
      return task;
    }
    // Read-only prerequisites carry findings, not commits.
    const hasWriteDependency = dependencies.some((dependency) => {
      const dependencyTask = tasks.find((candidate) => candidate.id === dependency.dependsOnTaskID);
      return dependencyTask?.executionMode === "workspace_write";
    });
    if (!hasWriteDependency) return task;
    const baseline = await this.integration.dependentBaseCommit(run);
    return await this.repository.setTaskBaseline({
      requestID: `task-baseline:${task.id}:${baseline}`,
      runID: task.runID,
      taskID: task.id,
      baselineCommit: baseline,
    });
  }

  private async launch(task: ChildTask, run: TeamRun): Promise<void> {
    if (this.childRunIDs.has(task.id)) return;
    this.ensureCapacity(run.id, run.maxConcurrentTasks);

    this.childRunIDs.set(task.id, run.id);
    const repository = this.repository;
    const childExecution = this.childExecution;
    const taskID = task.id;
    const controller = new AbortController();
    try {
      const startedTask = await repository.markTaskRunning({
        requestID: `execution-start:${taskID}:${randomUUID()}`,
        runID: task.runID,
        taskID,
        sessionID: task.sessionID,
      });
      const done = (async (): Promise<void> => {
        try {
          const snapshot = await repository.snapshot(startedTask.runID);
          let reviewFeedback: ReviewFeedback | null = null;
          if (startedTask.reviewRound > 0 && startedTask.latestError != null) {
            reviewFeedback = {
              summary: startedTask.latestError,
              findings: snapshot.findings.filter((finding) => finding.taskID === taskID),
            };
          }
          const report = await childExecution.execute(
            snapshot.run,
            startedTask,
            snapshot.run.repositoryPath,
            reviewFeedback,
            controller.signal,
          );
          await repository.submitReport({
            requestID: `execution-report:${taskID}:${randomUUID()}`,
            runID: startedTask.runID,
            taskID,
            sessionID: report.sessionID,
            report: report.message,
            rawOutput: report.rawOutput,
            tests: report.tests,
            changedFiles: report.changedFiles,
            diffSummary: report.diffSummary,
            blocker: report.blocker,
          });
          await this.removeWork(taskID, startedTask.runID);
        } catch (error) {
          if (error instanceof CancellationError || controller.signal.aborted) {
            await this.removeWork(taskID, startedTask.runID);
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          await repository
            .recordTaskExecutionEvent({
              runID: startedTask.runID,
              taskID,
              event: {
                kind: "failed",
                message: ChildAgentDiagnostics.redact(message, 512),
              },
            })
            .catch(() => {});
          await repository
            .failTask({
              requestID: `execution-error:${taskID}:${randomUUID()}`,
              runID: startedTask.runID,
              taskID,
              summary: message,
            })
            .catch(() => {});
          await this.removeWork(taskID, startedTask.runID);
        }
      })();
      this.childWork.set(task.id, { controller, done });
      void done.catch(() => {});
    } catch (error) {
      this.childRunIDs.delete(task.id);
      throw error;
    }
  }

  private async removeWork(taskID: string, runID: string): Promise<void> {
    this.childWork.delete(taskID);
    this.childRunIDs.delete(taskID);
    await this.launchReadyTasks(runID).catch(() => {});
  }

  private activeChildCount(runID: string): number {
    let count = 0;
    for (const value of this.childRunIDs.values()) {
      if (value === runID) count += 1;
    }
    return count;
  }

  private ensureCapacity(runID: string, limit: number): void {
    if (!(this.activeChildCount(runID) < limit)) {
      throw DomainError.concurrencyLimitReached();
    }
  }

  private async stop(task: ChildTask): Promise<void> {
    if (task.sessionID != null) {
      await this.childExecution.cancel(task.sessionID, task.agentKind as ChildAgentKind);
    }
    const work = this.childWork.get(task.id);
    work?.controller.abort();
    if (work) {
      await work.done;
    }
    this.childWork.delete(task.id);
    this.childRunIDs.delete(task.id);
  }
}

function selectedTaskIDs(
  input: JoinTasksInput,
  snapshot: import("../domain/models").TeamRunSnapshot,
): string[] {
  if (input.batchID != null) {
    if (!snapshot.batches.some((batch) => batch.id === input.batchID)) {
      throw DomainError.batchNotFound(input.batchID);
    }
    const taskIDs = snapshot.tasks.filter((task) => task.batchID === input.batchID).map((task) => task.id);
    if (taskIDs.length === 0) throw DomainError.invalidTask("The selected batch has no tasks.");
    return taskIDs;
  }
  const seen = new Set<string>();
  const uniqueIDs = input.taskIDs.filter((taskID) => {
    if (seen.has(taskID)) return false;
    seen.add(taskID);
    return true;
  });
  if (uniqueIDs.length === 0) throw DomainError.invalidTask("At least one task_id is required.");
  for (const taskID of uniqueIDs) {
    if (!snapshot.tasks.some((task) => task.id === taskID)) {
      throw DomainError.taskNotFound(taskID);
    }
  }
  return uniqueIDs;
}

function allTasksJoinable(
  snapshot: import("../domain/models").TeamRunSnapshot,
  taskIDs: string[],
): boolean {
  return taskIDs.every((taskID) => {
    const task = snapshot.tasks.find((candidate) => candidate.id === taskID);
    if (task == null) return false;
    return taskStatusIsTerminal(task.status) || task.status === "awaiting_report";
  });
}

function markdownSummary(tasks: JoinedTaskDTO[], pendingTaskIDs: string[]): string {
  const lines = ["## SubAgent Join Summary", ""];
  for (const task of tasks) {
    const elapsed = task.elapsedSeconds.toFixed(1) + "s";
    lines.push(`- **${task.title}** [${task.status}] · ${elapsed} · ${task.agentKind}/${task.executionMode}`);
    if (task.report != null && task.report.length > 0) {
      lines.push(`  - Report: ${ChildAgentDiagnostics.redact(task.report, 2000).replaceAll("\n", " ")}`);
    }
    if (task.latestError != null && task.latestError.length > 0) {
      lines.push(`  - Error: ${ChildAgentDiagnostics.redact(task.latestError, 1000).replaceAll("\n", " ")}`);
    }
  }
  if (pendingTaskIDs.length > 0) {
    lines.push("");
    lines.push(`Pending: ${pendingTaskIDs.join(", ")}`);
  }
  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { runSummaryDTO, eventTailDTO, teamStatusDTO };
