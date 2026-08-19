// Global workbench aggregation (specs/001-v03-stability-multi-teamrun US2 /
// interfaces.md A 节 get_workbench / research R3).
//
// Six-section derived view over the existing read models — no new tables, no
// second source of truth (constitution III): listRuns selects the non-terminal
// runs, each run's light runSummary supplies the task projection, and the
// scheduler's in-memory queueReasons explain the queued section. GUI (IPC
// workbench:summary) and MCP (get_workbench) share this service (constitution II).

import type {
  QueueReasonDTO,
  WorkbenchEntryDTO,
  WorkbenchSectionDTO,
} from "../../shared/dtos";
import { runStatusIsTerminal } from "../domain/models";
import type { ChildTask, TeamRunSummary } from "../domain/models";
import type { TeamRunRepository } from "../domain/repositoryPort";
import { ChildAgentDiagnostics } from "./ports";

/** The scheduler slice the workbench needs: why queued tasks are still waiting. */
export interface WorkbenchSchedulerPort {
  getQueueReasons(runID: string): Array<{ taskID: string; reason: QueueReasonDTO }>;
}

/**
 * WorkbenchEntryDTO declares no failure-note field; a run whose runSummary
 * failed surfaces one run-level synthetic entry whose `detail` rides along as
 * a structural extra (renderers ignore unknown fields; the shared contract
 * stays untouched). Best effort by design — one unreadable run must never
 * fail the whole aggregation.
 */
type WorkbenchEntry = WorkbenchEntryDTO & { detail?: string };

/** Canonical section order of the aggregation output (stable contract). */
const SECTION_ORDER: WorkbenchSectionDTO["section"][] = [
  "running",
  "queued",
  "awaiting_input",
  "failed",
  "awaiting_review",
  "integratable",
];

/** Task status → section; null = not shown (cancelled and future statuses). */
function sectionForStatus(status: string): WorkbenchSectionDTO["section"] | null {
  switch (status) {
    case "running":
      return "running";
    case "queued":
      return "queued";
    case "blocked":
      return "awaiting_input";
    case "failed":
      return "failed";
    case "awaiting_report":
    case "rework_required":
      return "awaiting_review";
    case "accepted":
      return "integratable";
    default:
      return null;
  }
}

/** One run's contribution to the aggregation. */
interface WorkbenchRunProjection {
  runID: string;
  runTitle: string;
  repositoryPath: string;
  status: string;
  /** Quota ordering (priority DESC, created_at ASC) — the per-section sort key. */
  priority: number;
  createdAt: number;
  updatedAt: number;
  /** null = the run's light summary could not be read. */
  tasks: ChildTask[] | null;
  error: string | null;
}

export class WorkbenchService {
  private readonly repository: TeamRunRepository;
  private readonly scheduler: WorkbenchSchedulerPort;

  constructor(input: {
    repository: TeamRunRepository;
    agentTeamService: WorkbenchSchedulerPort;
  }) {
    this.repository = input.repository;
    this.scheduler = input.agentTeamService;
  }

  /**
   * Six-section aggregation over the non-terminal runs (get_workbench /
   * workbench:summary). Sections always come back in canonical order, each
   * sorted by owning run priority DESC (created_at ASC tie-break, mirroring
   * the scheduler's quota ordering); tasks keep their run order within a run.
   * `integratable` = accepted tasks of a run that is not terminal yet. A run
   * whose runSummary fails is skipped task-wise and noted via one run-level
   * entry in awaiting_input (best effort).
   */
  async summary(): Promise<WorkbenchSectionDTO[]> {
    const buckets = new Map<WorkbenchSectionDTO["section"], WorkbenchEntry[]>(
      SECTION_ORDER.map((section) => [section, [] as WorkbenchEntry[]]),
    );
    const summaries: TeamRunSummary[] = await this.repository.listRuns();
    const projections: WorkbenchRunProjection[] = [];
    for (const summary of summaries) {
      if (runStatusIsTerminal(summary.status)) continue;
      try {
        const detail = await this.repository.runSummary(summary.id);
        projections.push({
          runID: detail.run.id,
          runTitle: detail.run.task,
          repositoryPath: detail.run.repositoryPath,
          status: detail.run.status,
          priority: detail.run.priority,
          createdAt: detail.run.createdAt,
          updatedAt: detail.run.updatedAt,
          tasks: detail.tasks,
          error: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        projections.push({
          runID: summary.id,
          runTitle: summary.task,
          repositoryPath: summary.repositoryPath,
          status: summary.status,
          priority: summary.priority,
          // TeamRunSummary carries no created_at; updated_at is the best
          // available tie-break for a run we could not read in full.
          createdAt: summary.updatedAt,
          updatedAt: summary.updatedAt,
          tasks: null,
          error: ChildAgentDiagnostics.redact(message, 512),
        });
      }
    }
    projections.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

    for (const projection of projections) {
      if (projection.tasks == null) {
        const bucket = buckets.get("awaiting_input");
        bucket?.push({
          runID: projection.runID,
          runTitle: projection.runTitle,
          repositoryPath: projection.repositoryPath,
          // Run-level synthetic entry: taskID carries the runID so the row
          // stays traceable without inventing a task identity.
          taskID: projection.runID,
          title: "Run summary unavailable",
          agentKind: "unknown",
          status: projection.status,
          queueReason: null,
          updatedAt: projection.updatedAt,
          detail: projection.error ?? undefined,
        });
        continue;
      }
      const reasons = new Map(
        this.scheduler.getQueueReasons(projection.runID).map((entry) => [entry.taskID, entry.reason]),
      );
      for (const task of projection.tasks) {
        const section = sectionForStatus(task.status);
        if (section == null) continue;
        buckets.get(section)?.push({
          runID: projection.runID,
          runTitle: projection.runTitle,
          repositoryPath: projection.repositoryPath,
          taskID: task.id,
          title: task.title,
          agentKind: task.agentKind,
          status: task.status,
          // Queue reasons only decorate tasks that are actually queued.
          queueReason: task.status === "queued" ? reasons.get(task.id) ?? null : null,
          updatedAt: task.updatedAt,
        });
      }
    }

    return SECTION_ORDER.map((section) => ({
      section,
      entries: buckets.get(section) ?? [],
    }));
  }
}
