// Central concurrency budget (specs/001-v03 T008, research R2/R6).
//
// Four-level gate checked before EVERY child launch, whichever of the four
// launch paths (initial drain / automatic retry / review recovery / the future
// recovery service) is about to fire:
//
//     effective = min(global, per-repository, per-agent-kind, run.maxConcurrentTasks)
//
// A denial never reclaims running work (red line): the task simply stays
// queued with a recorded reason, and capacity-freed events re-drain the queue.
// The budget owns the ledger, so the per-run count here replaces the caller's
// duplicated activeChildCount gate (the service keeps its method only as a
// legacy fallback when no budget is injected).

import type { QueueReasonDTO } from "../../shared/dtos";
import {
  clampGlobalMaxChildren,
  clampPerKindMaxChildren,
  clampPerProjectMaxChildren,
  DEFAULT_GLOBAL_MAX_CHILDREN,
  DEFAULT_PER_KIND_MAX_CHILDREN,
  DEFAULT_PER_PROJECT_MAX_CHILDREN,
} from "../../shared/ipc";
import type { ChildAgentKind } from "../domain/models";
import {
  GLOBAL_MAX_CHILDREN_KEY,
  INTERACTIVE_SLOT_RESERVED_KEY,
  PER_KIND_MAX_CHILDREN_KEY,
  PER_PROJECT_MAX_CHILDREN_KEY,
  RESOURCE_PAUSE_ENABLED_KEY,
} from "../settingsStore";

/** Settings slice the budget consumes (SchedulerSettingsPayload satisfies this structurally). */
export interface ConcurrencyBudgetSettings {
  globalMaxChildren: number;
  perProjectMaxChildren: number;
  perKindMaxChildren: number;
  resourcePauseEnabled: boolean;
  interactiveSlotReserved: boolean;
}

const DEFAULT_BUDGET_SETTINGS: ConcurrencyBudgetSettings = {
  globalMaxChildren: DEFAULT_GLOBAL_MAX_CHILDREN,
  perProjectMaxChildren: DEFAULT_PER_PROJECT_MAX_CHILDREN,
  perKindMaxChildren: DEFAULT_PER_KIND_MAX_CHILDREN,
  resourcePauseEnabled: true,
  interactiveSlotReserved: true,
};

/** Task descriptor for a quota request; `runMaxConcurrentTasks` is the run-level leg of the four-level check. */
export interface ConcurrencyBudgetTask {
  taskID: string;
  runID: string;
  repositoryPath: string;
  agentKind: ChildAgentKind;
  runMaxConcurrentTasks: number;
  /** Reserved interactive slot eligible (delegation-time flag, specs/001 T026). */
  interactive?: boolean;
}

/**
 * Denial verdict. `reason: null` on a denial means run-level saturation —
 * ordinary in-run queuing that predates the budget, not a gate failure —
 * so no QueueReasonDTO value exists for it.
 */
export interface ConcurrencyDecision {
  granted: boolean;
  reason: QueueReasonDTO | null;
}

interface ConcurrencyLedgerEntry {
  runID: string;
  repositoryPath: string;
  agentKind: ChildAgentKind;
  interactive: boolean;
}

/** Read-only projection for UI/tests: active counts vs effective limits per dimension. */
export interface ConcurrencyActiveCounts {
  global: { active: number; limit: number; interactiveReserved: boolean };
  projects: Array<{ repositoryPath: string; active: number; limit: number }>;
  kinds: Array<{ agentKind: ChildAgentKind; active: number; limit: number }>;
  runs: Array<{ runID: string; active: number; limit: number; paused: boolean }>;
  /** null = probe unknown (never blocks; R6 "探测尽力而为"). */
  resourcePressure: boolean | null;
  pausedRunIDs: string[];
}

function deny(reason: QueueReasonDTO): ConcurrencyDecision {
  return { granted: false, reason };
}

/**
 * Composition-root convenience: reads the six scheduler settings keys from a
 * SettingsStore-shaped reader and clamps every value, so the budget callback is
 * a one-liner: `settings: () => makeSettingsStoreBudgetSettings(settings.string)`.
 * Boolean keys follow the settingsStore convention: absent or "true" = enabled.
 */
export function makeSettingsStoreBudgetSettings(
  read: (key: string) => string | undefined,
): ConcurrencyBudgetSettings {
  return {
    globalMaxChildren: clampGlobalMaxChildren(read(GLOBAL_MAX_CHILDREN_KEY)),
    perProjectMaxChildren: clampPerProjectMaxChildren(read(PER_PROJECT_MAX_CHILDREN_KEY)),
    perKindMaxChildren: clampPerKindMaxChildren(read(PER_KIND_MAX_CHILDREN_KEY)),
    resourcePauseEnabled: read(RESOURCE_PAUSE_ENABLED_KEY) !== "false",
    interactiveSlotReserved: read(INTERACTIVE_SLOT_RESERVED_KEY) !== "false",
  };
}

export class ConcurrencyBudget {
  private readonly settingsProvider: () => ConcurrencyBudgetSettings;
  /** taskID → granted slot; the single source of truth for all four counters. */
  private readonly entries = new Map<string, ConcurrencyLedgerEntry>();
  /** runID → latest known run.maxConcurrentTasks (display mirror for activeCounts). */
  private readonly runLimits = new Map<string, number>();
  private readonly pausedRuns = new Set<string>();
  private resourcePressure: boolean | null = null;
  private onCapacityFreed?: (runID: string | null) => void;

  constructor(input: {
    settings: () => ConcurrencyBudgetSettings;
    /**
     * Fired when capacity becomes usable again so the scheduler can re-drain.
     * `runID` = only that run became eligible (pause lifted); `null` = a slot
     * freed globally (release / pressure cleared) → drain every known run.
     */
    onCapacityFreed?: (runID: string | null) => void;
  }) {
    this.settingsProvider = input.settings;
    this.onCapacityFreed = input.onCapacityFreed;
  }

  /**
   * Late binding for the capacity-freed handler: it closes over the
   * AgentTeamApplicationService that is constructed WITH this budget, so the
   * composition root cannot pass it here without a temporal dead zone.
   * `ifAbsent: true` keeps an explicitly injected handler authoritative
   * (tests may pass their own spy via the constructor).
   */
  setCapacityFreedHandler(
    handler: ((runID: string | null) => void) | null,
    options?: { ifAbsent?: boolean },
  ): void {
    if (options?.ifAbsent === true && this.onCapacityFreed != null) return;
    this.onCapacityFreed = handler ?? undefined;
  }

  /**
   * Requests a slot. Re-entrant per task: a task already holding a slot stays
   * granted without double-counting (concurrent drain retries are idempotent).
   */
  tryAcquire(task: ConcurrencyBudgetTask): ConcurrencyDecision {
    if (this.entries.has(task.taskID)) return { granted: true, reason: null };
    const decision = this.evaluate(task);
    if (!decision.granted) return decision;
    this.entries.set(task.taskID, {
      runID: task.runID,
      repositoryPath: task.repositoryPath,
      agentKind: task.agentKind,
      interactive: task.interactive === true,
    });
    return decision;
  }

  /** Pure peek sharing tryAcquire's semantics; lets a drain skip stagger waits without reserving. */
  wouldGrant(task: ConcurrencyBudgetTask): ConcurrencyDecision {
    if (this.entries.has(task.taskID)) return { granted: true, reason: null };
    return this.evaluate(task);
  }

  /**
   * Frees a task's slot. Unknown taskIDs are a no-op (stop/discard paths call
   * release for tasks that never launched). Never touches running tasks other
   * than the one named.
   */
  release(runID: string, taskID: string): void {
    void runID; // Ledger is keyed by taskID alone; runID kept for call-site clarity.
    if (!this.entries.delete(taskID)) return;
    this.onCapacityFreed?.(null);
  }

  /**
   * Pauses a run: NEW quota requests for it are denied with `run_paused`;
   * already-granted slots (running tasks) are never reclaimed (red line).
   * Lifting the pause re-drains the run.
   */
  setPaused(runID: string, paused: boolean): void {
    const was = this.pausedRuns.has(runID);
    if (paused === was) return;
    if (paused) {
      this.pausedRuns.add(runID);
      return;
    }
    this.pausedRuns.delete(runID);
    this.onCapacityFreed?.(runID);
  }

  /** `true` = withhold new quotas (resource_pressure); `false` = resumed; `null` = probe unknown, never blocks. */
  setResourcePressure(active: boolean | null): void {
    const was = this.resourcePressure;
    this.resourcePressure = active;
    if (was === true && active !== true) this.onCapacityFreed?.(null);
  }

  activeCounts(): ConcurrencyActiveCounts {
    const settings = this.readSettings();
    const projects = new Map<string, number>();
    const kinds = new Map<string, number>();
    const runs = new Map<string, number>();
    for (const entry of this.entries.values()) {
      projects.set(entry.repositoryPath, (projects.get(entry.repositoryPath) ?? 0) + 1);
      kinds.set(entry.agentKind, (kinds.get(entry.agentKind) ?? 0) + 1);
      runs.set(entry.runID, (runs.get(entry.runID) ?? 0) + 1);
    }
    return {
      global: {
        active: this.entries.size,
        limit: settings.globalMaxChildren,
        interactiveReserved: settings.interactiveSlotReserved,
      },
      projects: [...projects.entries()]
        .map(([repositoryPath, active]) => ({ repositoryPath, active, limit: settings.perProjectMaxChildren }))
        .sort((a, b) => a.repositoryPath.localeCompare(b.repositoryPath)),
      kinds: [...kinds.entries()]
        .map(([agentKind, active]) => ({ agentKind: agentKind as ChildAgentKind, active, limit: settings.perKindMaxChildren }))
        .sort((a, b) => a.agentKind.localeCompare(b.agentKind)),
      runs: [...this.runLimits.entries()]
        .map(([runID, limit]) => ({ runID, active: runs.get(runID) ?? 0, limit, paused: this.pausedRuns.has(runID) }))
        .sort((a, b) => a.runID.localeCompare(b.runID)),
      resourcePressure: this.resourcePressure,
      pausedRunIDs: [...this.pausedRuns],
    };
  }

  /**
   * Four-level evaluation, strictest-first reporting. Check order is
   * deterministic (paused → pressure → global → project → kind → run) so a
   * denial names the level the caller can actually act on. The interactive
   * reservation shrinks the global limit for non-interactive tasks by one.
   */
  private evaluate(task: ConcurrencyBudgetTask): ConcurrencyDecision {
    const settings = this.readSettings();
    const runLimit = Math.max(1, Math.round(task.runMaxConcurrentTasks) || 1);
    this.runLimits.set(task.runID, runLimit);
    if (this.pausedRuns.has(task.runID)) return deny("run_paused");
    if (settings.resourcePauseEnabled && this.resourcePressure === true) {
      return deny("resource_pressure");
    }
    const interactive = task.interactive === true;
    const globalLimit = Math.max(
      0,
      settings.globalMaxChildren - (settings.interactiveSlotReserved && !interactive ? 1 : 0),
    );
    if (this.countBy((entry) => true) >= globalLimit) return deny("global_budget");
    if (this.countBy((entry) => entry.repositoryPath === task.repositoryPath) >= settings.perProjectMaxChildren) {
      return deny("project_budget");
    }
    if (this.countBy((entry) => entry.agentKind === task.agentKind) >= settings.perKindMaxChildren) {
      return deny("kind_budget");
    }
    if (this.countBy((entry) => entry.runID === task.runID) >= runLimit) {
      // Run-level saturation = ordinary in-run queuing (pre-budget behaviour);
      // no gate reason is recorded for it.
      return { granted: false, reason: null };
    }
    return { granted: true, reason: null };
  }

  private countBy(predicate: (entry: ConcurrencyLedgerEntry) => boolean): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (predicate(entry)) count += 1;
    }
    return count;
  }

  /** Clamps whatever the callback returns (or fails to return) into safe bounds. */
  private readSettings(): ConcurrencyBudgetSettings {
    let raw: ConcurrencyBudgetSettings | null = null;
    try {
      raw = this.settingsProvider() ?? null;
    } catch {
      raw = null;
    }
    if (raw == null) return DEFAULT_BUDGET_SETTINGS;
    return {
      globalMaxChildren: clampGlobalMaxChildren(raw.globalMaxChildren),
      perProjectMaxChildren: clampPerProjectMaxChildren(raw.perProjectMaxChildren),
        perKindMaxChildren: clampPerKindMaxChildren(raw.perKindMaxChildren),
      resourcePauseEnabled: raw.resourcePauseEnabled !== false,
      interactiveSlotReserved: raw.interactiveSlotReserved !== false,
    };
  }
}
