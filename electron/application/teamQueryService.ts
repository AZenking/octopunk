// Port of OctoPunk/OctoPunk/Application/Services/TeamQueryService.swift.

import type {
  EventTailDTO,
  RunSummaryDTO,
  TeamReviewContextDTO,
  TeamStatusDTO,
} from "../../shared/dtos";
import { DomainError } from "../domain/models";
import type { TeamRunSummary } from "../domain/models";
import type { AsyncStream, TeamRunRepository } from "../domain/repositoryPort";
import { makeStream } from "../domain/repositoryPort";
import { eventTailDTO, runSummaryDTO, taskExecutionLogDTO, teamReviewContextDTO, teamStatusDTO, childTaskDTO } from "./dtos";

function mapStream<Source, Target>(
  source: AsyncStream<Source>,
  transform: (value: Source) => Target,
): AsyncStream<Target> {
  return makeStream<Target>((emit, fail) => {
    let cancelled = false;
    void (async () => {
      try {
        for await (const value of source) {
          if (cancelled) return;
          emit(transform(value));
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    })();
    return () => {
      cancelled = true;
      source.cancel();
    };
  });
}

export class TeamQueryService {
  private readonly repository: TeamRunRepository;

  constructor(repository: TeamRunRepository) {
    this.repository = repository;
  }

  async status(runID: string): Promise<TeamStatusDTO> {
    return teamStatusDTO(await this.repository.snapshot(runID));
  }

  async reviewContext(runID: string): Promise<TeamReviewContextDTO> {
    return teamReviewContextDTO(await this.repository.snapshot(runID));
  }

  async summaries(): Promise<TeamRunSummary[]> {
    return await this.repository.listRuns();
  }

  // Segmented queries (spec 001 US1).

  async runSummary(runID: string): Promise<RunSummaryDTO> {
    return runSummaryDTO(await this.repository.runSummary(runID));
  }

  observeRunSummary(runID: string): AsyncStream<RunSummaryDTO> {
    return mapStream(this.repository.observeRunSummary(runID), runSummaryDTO);
  }

  observeEventTail(runID: string, limit = 100): AsyncStream<EventTailDTO> {
    return mapStream(this.repository.observeEventTail(runID, limit), eventTailDTO);
  }

  async eventPage(runID: string, before: number, limit = 100): Promise<EventTailDTO> {
    return eventTailDTO(await this.repository.eventPage(runID, before, limit));
  }

  async executionLogDetail(runID: string, taskID: string): Promise<import("../../shared/dtos").TaskExecutionLogDTO | null> {
    const log = await this.repository.executionLog(runID, taskID);
    return log == null ? null : taskExecutionLogDTO(log);
  }

  observeSummaries(): AsyncStream<TeamRunSummary[]> {
    return this.repository.observeRunSummaries();
  }

  observe(runID: string): AsyncStream<TeamStatusDTO> {
    return mapStream(this.repository.observe(runID), teamStatusDTO);
  }

  async waitForReport(
    runID: string,
    taskID: string,
    timeoutSeconds = 45,
  ): Promise<import("../../shared/dtos").TaskReportDTO> {
    const result = await Promise.race([
      (async (): Promise<import("../../shared/dtos").TaskReportDTO | null> => {
        const stream = this.observe(runID);
        try {
          for await (const status of stream) {
            const task = status.tasks.find((candidate) => candidate.id === taskID);
            if (task == null) throw DomainError.taskNotFound(taskID);
            if (
              task.status === "awaiting_report" ||
              task.status === "rework_required" ||
              task.status === "accepted" ||
              task.status === "blocked" ||
              task.status === "cancelled" ||
              task.status === "failed"
            ) {
              const snapshotTask = task;
              const executionReport =
                [...status.reports].reverse().find((report) => report.taskID === taskID) ?? null;
              return {
                task: snapshotTask,
                report: snapshotTask.latestReport,
                status: snapshotTask.status,
                executionReport,
              };
            }
          }
          return null;
        } finally {
          stream.cancel();
        }
      })(),
      (async (): Promise<null> => {
        await new Promise((resolve) => setTimeout(resolve, timeoutSeconds * 1000));
        return null;
      })(),
    ]);
    if (result != null) return result;
    const snapshot = await this.repository.snapshot(runID);
    const task = snapshot.tasks.find((candidate) => candidate.id === taskID);
    if (task == null) throw DomainError.taskNotFound(taskID);
    return {
      task: childTaskDTO(task),
      report: task.latestReport,
      status: task.status,
      executionReport:
        [...snapshot.reports].reverse().find((report) => report.taskID === taskID) ?? null,
    };
  }
}
