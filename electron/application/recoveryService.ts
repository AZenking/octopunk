// Crash-recovery orchestration (specs/001-v03-stability-multi-teamrun US2 /
// research R4 / v0.3 T018). Honest-degradation semantics throughout:
//
// - Process reconciliation only trusts marker-carrying probe results
//   (constitution IV): a live PID without the octopunk marker is treated as
//   "reused by another process", never adopted; an unrunnable probe yields
//   "状态未知" instead of a fabricated verdict.
// - Orphan scans compare the managed worktree roots / `octopunk/*` branches
//   against everything any known run (terminal included) ever registered —
//   known-run leftovers are NOT orphans (误判防护: a blocked run may hold
//   unmerged work deliberately); only 来源不明 residue surfaces.
// - Every section is best effort: a single failing run / repository / probe
//   is skipped, never fatal to the whole scan.
//
// Application layer stays free of node:fs / subprocess calls: worktree roots
// come from the pure gitAdapter path builders, probes run through the
// injected ProcessPort, and destructive cleanup goes through the platform
// cleanup port wired by the composition root (Wave 8).

import type { RecoveryItemDTO, RecoveryStatusDTO } from "../../shared/dtos";
import { DomainError, makeRecoveryItem } from "../domain/models";
import type {
  ChildTask,
  RecoveryActionKind,
  RecoveryItem,
  TaskDependency,
} from "../domain/models";
import type { TeamRunRepository } from "../domain/repositoryPort";
import type { DiagnosticsProbePort } from "../platform/diagnosticsProbes";
import {
  integrationWorktreeURL,
  sharedReadOnlyWorktreeURL,
  taskWorktreeRoot,
} from "../platform/gitAdapter";
import type { ProcessPort } from "./ports";

// ---------------------------------------------------------------------------
// Ports (defined here; concrete wiring lands with the composition root)
// ---------------------------------------------------------------------------

/**
 * Repository slice recovery needs. `TeamRunRepository` covers reads and the
 * failTask/resumeTask writes; `attemptPid` is the missing READ side of the
 * v11 `task_attempts.pid` column (updateAttemptPid only writes it today —
 * the domain TaskAttempt model does not carry pid). Returns the pid of the
 * task's current attempt, or null when the task has no attempt / no pid
 * recorded. Wave 8 adds the trivial SELECT to SqliteTeamRunRepository.
 */
export interface RecoveryRepositoryPort extends TeamRunRepository {
  attemptPid(input: { runID: string; taskID: string }): Promise<number | null>;
}

/** Scheduler entry point recovery reuses (agentTeamService.drainReadyTasks). */
export interface RecoveryTeamServicePort {
  drainReadyTasks(runID: string): Promise<void>;
}

/**
 * Destructive platform helpers for explicit-confirm cleanup. Implementations
 * (Wave 8 composition root) must guard `removePath` to the managed roots and
 * must only delete `octopunk/*` branches; the service itself stays fs-free.
 */
export interface RecoveryCleanupPort {
  removePath(target: string): Promise<void>;
  deleteBranch(repositoryURL: string, branch: string): Promise<void>;
}

/** One cleanup target as rendered by the recovery view. */
export interface RecoveryCleanupTarget {
  kind: RecoveryActionKind;
  path?: string;
  repositoryURL?: string;
  branchName?: string;
}

/** Non-terminal run statuses whose tasks get process reconciliation. */
const RECOVERY_SCANNABLE_RUN_STATUSES: readonly string[] = [
  "running",
  "reviewing",
  "awaiting_final_review",
];

/** Placeholder run id — the path builders are pure string joins (no fs). */
const PLACEHOLDER_RUN_ID = "00000000-0000-0000-0000-000000000000";

/** POSIX parent directory without node:path (application-layer convention). */
function parentDirectory(target: string): string {
  const index = target.lastIndexOf("/");
  return index > 0 ? target.slice(0, index) : target;
}

/** Managed worktree roots: parents of the gitAdapter per-run path builders. */
function managedWorktreeRoots(): string[] {
  return [
    parentDirectory(taskWorktreeRoot(PLACEHOLDER_RUN_ID)),
    parentDirectory(integrationWorktreeURL(PLACEHOLDER_RUN_ID)),
  ];
}

/** Short run id used inside task branch names (repository.ts convention). */
function shortRunID(runID: string): string {
  return runID.replaceAll("-", "").slice(0, 8);
}

function toDTO(item: RecoveryItem): RecoveryItemDTO {
  return {
    kind: item.kind,
    runID: item.runID,
    taskID: item.taskID,
    detail: item.detail,
    suggestion: item.suggestion,
  };
}

function recoveryItem(init: {
  kind: RecoveryActionKind;
  runID?: string | null;
  taskID?: string | null;
  target: string;
  detail: string;
  suggestion: string;
}): RecoveryItemDTO {
  return toDTO(makeRecoveryItem(init));
}

export class RecoveryService {
  private readonly repository: RecoveryRepositoryPort;
  private readonly probes: DiagnosticsProbePort;
  private readonly processPort: ProcessPort;
  private readonly teamService: RecoveryTeamServicePort;
  private readonly cleanup: RecoveryCleanupPort;

  constructor(input: {
    repository: RecoveryRepositoryPort;
    probes: DiagnosticsProbePort;
    processPort: ProcessPort;
    teamService: RecoveryTeamServicePort;
    cleanup: RecoveryCleanupPort;
  }) {
    this.repository = input.repository;
    this.probes = input.probes;
    this.processPort = input.processPort;
    this.teamService = input.teamService;
    this.cleanup = input.cleanup;
  }

  // ---- 1. Scan -----------------------------------------------------------

  /**
   * Recovery view (启动时与手动刷新): non-terminal runs' running tasks ×
   * process check + orphan worktree / branch scans. `runID` narrows the
   * process check (and the branch repositories scanned) to one run; the
   * worktree diff always compares against every run's registered paths.
   * Best effort per section — failures skip, never throw.
   */
  async scan(input?: { runID?: string }): Promise<RecoveryStatusDTO> {
    const runID = input?.runID;
    const items: RecoveryItemDTO[] = [];
    items.push(...(await this.scanProcesses(runID)));
    items.push(...(await this.scanOrphanWorktrees()));
    items.push(...(await this.scanOrphanBranches(runID)));
    return { items, scannedAt: Date.now() / 1000 };
  }

  /** Convenience subset for the rerun UI: interrupted tasks only. */
  async interruptedTasks(runID?: string): Promise<RecoveryItemDTO[]> {
    const status = await this.scan(runID == null ? undefined : { runID });
    return status.items.filter((item) => item.kind === "interrupted");
  }

  // ---- 2. Mark dead task failed ------------------------------------------

  /**
   * Marks a running-but-dead task failed via repository.failTask (idempotent
   * through the requestID cache / terminal-task no-op). The summary text
   * carries the failure_kind=system semantics (spec R4) since no dedicated
   * column exists. failTask's default blockRun keeps the run blocked until a
   * human reruns — deliberately conservative, nothing auto-reruns here.
   */
  async markInterruptedFailed(input: {
    requestID: string;
    runID: string;
    taskID: string;
    reason: string;
  }): Promise<ChildTask> {
    const summary = await this.repository.runSummary(input.runID);
    const task = summary.tasks.find((candidate) => candidate.id === input.taskID);
    if (task == null) throw DomainError.taskNotFound(input.taskID);
    if (task.status !== "running" && task.status !== "failed") {
      // failed = already marked (idempotent re-call); anything else is a
      // caller mix-up the user must see, not silently coerced.
      throw DomainError.taskNotReady(input.taskID);
    }
    return await this.repository.failTask({
      requestID: input.requestID,
      runID: input.runID,
      taskID: input.taskID,
      summary: `系统错误(failure_kind=system):${input.reason}`,
    });
  }

  // ---- 3. Rerun node -----------------------------------------------------

  /**
   * Rerun from a failed/blocked/cancelled node: repository.resumeTask
   * (idempotent via requestID) flips the task to queued/rework_required and
   * the run back to running.
   *
   * Downstream semantics (minimal, per R4): queued descendants need NO reset
   * — they are already queued and the dependency gate simply schedules them
   * once the rerun target reaches accepted; the only actionable descendants
   * are ones explicitly blocked (dependency-failure propagation), which are
   * resumed one by one with derived idempotent requestIDs
   * (`${requestID}:${taskID}`). Failed/cancelled descendants are left for an
   * explicit human decision. Audit rides on the per-task taskResumed events
   * resumeTask already appends (the repository port exposes no bare event
   * writer). drainReadyTasks relaunches through the normal budget gate.
   */
  async rerunTask(input: {
    requestID: string;
    runID: string;
    taskID: string;
    includeDownstream: boolean;
  }): Promise<ChildTask[]> {
    const summary = await this.repository.runSummary(input.runID);
    const target = summary.tasks.find((candidate) => candidate.id === input.taskID);
    if (target == null) throw DomainError.taskNotFound(input.taskID);
    if (target.status !== "failed" && target.status !== "blocked" && target.status !== "cancelled") {
      throw DomainError.taskNotReady(input.taskID);
    }
    const affected: ChildTask[] = [
      await this.repository.resumeTask({
        requestID: input.requestID,
        runID: input.runID,
        taskID: input.taskID,
      }),
    ];
    if (input.includeDownstream) {
      for (const taskID of this.descendantsOf(input.taskID, summary.dependencies)) {
        const task = summary.tasks.find((candidate) => candidate.id === taskID);
        if (task?.status !== "blocked") continue;
        try {
          affected.push(
            await this.repository.resumeTask({
              requestID: `${input.requestID}:${taskID}`,
              runID: input.runID,
              taskID,
            }),
          );
        } catch {
          // Best effort per descendant: one stale row must not sink the rerun.
        }
      }
    }
    await this.teamService.drainReadyTasks(input.runID).catch(() => {});
    return affected;
  }

  // ---- 4. Orphan cleanup -------------------------------------------------

  /**
   * Explicit-confirm cleanup of scan results. confirmed=false always throws
   * (人可控 red line). Per item, best effort: failures and non-cleanable
   * kinds land in `skipped` with a reason instead of aborting the batch.
   * Worktree/lock removal goes through removePath, branch deletion through
   * deleteBranch — both platform-side, never raw fs here.
   */
  async cleanupOrphans(input: {
    requestID: string;
    targets: RecoveryCleanupTarget[];
    confirmed: boolean;
  }): Promise<{ cleaned: string[]; skipped: string[] }> {
    if (!input.confirmed) {
      throw new Error("清理孤儿资源必须显式确认(confirmed=true):恢复操作不允许静默执行。");
    }
    const cleaned: string[] = [];
    const skipped: string[] = [];
    for (const target of input.targets) {
      const label = describeTarget(target);
      try {
        if (target.kind === "orphan_worktree" || target.kind === "stale_lock") {
          if (target.path == null || target.path.length === 0) {
            skipped.push(`${label}(缺少 path)`);
            continue;
          }
          await this.cleanup.removePath(target.path);
          cleaned.push(label);
        } else if (target.kind === "orphan_branch") {
          if (target.repositoryURL == null || target.branchName == null) {
            skipped.push(`${label}(缺少 repositoryURL/branchName)`);
            continue;
          }
          await this.cleanup.deleteBranch(target.repositoryURL, target.branchName);
          cleaned.push(label);
        } else {
          skipped.push(`${label}(该类别不是可清理资源)`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        skipped.push(`${label}(${message})`);
      }
    }
    return { cleaned, skipped };
  }

  // ---- scan sections (each best effort) ----------------------------------

  /**
   * Process reconciliation over the scannable non-terminal runs
   * (running/reviewing/awaiting_final_review — blocked/cancelled are run
   * terminal states per T014 and hold no live orchestration). Per running
   * task: pid lookup → probeProcess classification (R4 honest semantics).
   */
  private async scanProcesses(runID: string | undefined): Promise<RecoveryItemDTO[]> {
    const runs = (await this.repository.listRuns().catch(() => []))
      .filter((run) => RECOVERY_SCANNABLE_RUN_STATUSES.includes(run.status))
      .filter((run) => runID == null || run.id === runID);
    const items: RecoveryItemDTO[] = [];
    for (const runSummaryRow of runs) {
      let tasks: ChildTask[];
      try {
        tasks = (await this.repository.runSummary(runSummaryRow.id)).tasks;
      } catch {
        continue; // One unreadable run must not fail the scan.
      }
      for (const task of tasks) {
        if (task.status !== "running") continue;
        items.push(await this.classifyProcess(runSummaryRow.id, task));
      }
    }
    return items;
  }

  /** Single-task classification (see class comment for the honest rules). */
  private async classifyProcess(runID: string, task: ChildTask): Promise<RecoveryItemDTO> {
    const pid =
      task.currentAttemptID == null
        ? null
        : await this.repository.attemptPid({ runID, taskID: task.id }).catch(() => null);
    if (pid == null) {
      return recoveryItem({
        kind: "interrupted",
        runID,
        taskID: task.id,
        target: task.worktreePath,
        detail: `任务 ${task.id} 处于 running 但无 PID 记录(任务未上报 pid 或由旧版本启动)。`,
        suggestion: "无法核对进程,请人工确认后经 markInterruptedFailed 标记失败并重跑。",
      });
    }
    const probe = await this.probes
      .probeProcess(pid, this.processPort)
      .catch((): null => null);
    if (probe == null || probe.detail != null) {
      // Probe could not run: 状态未知, not "已死" — never fabricate a verdict.
      const detail = probe?.detail ?? `无法探测进程 ${pid},状态未知。`;
      return recoveryItem({
        kind: "interrupted",
        runID,
        taskID: task.id,
        target: task.worktreePath,
        detail: `任务 ${task.id}(PID ${pid})进程状态未知:${detail}`,
        suggestion: "探测失败不等于进程已死,请人工核对后再决定标记失败或重跑。",
      });
    }
    if (probe.alive && probe.octopunkOwned) {
      return recoveryItem({
        kind: "process_alive",
        runID,
        taskID: task.id,
        target: task.worktreePath,
        detail: `任务 ${task.id} 的进程(PID ${pid})仍在运行:${probe.command ?? "命令行不可用"}`,
        suggestion:
          "进程仍在但已脱离本应用管理(重启后输出管道不可恢复);建议等待观察或人工接管,不要直接重跑。",
      });
    }
    if (probe.alive) {
      return recoveryItem({
        kind: "interrupted",
        runID,
        taskID: task.id,
        target: task.worktreePath,
        detail: `PID ${pid} 已被其他非 OctoPunk 进程复用(${probe.command ?? "命令行不可用"}),原任务进程已消失。`,
        suggestion: "进程被复用,建议经 markInterruptedFailed 标记失败后重跑。",
      });
    }
    return recoveryItem({
      kind: "interrupted",
      runID,
      taskID: task.id,
      target: task.worktreePath,
      detail: `任务 ${task.id} 的进程(PID ${pid})已不存在。`,
      suggestion: "进程已死,建议经 markInterruptedFailed 标记失败后重跑。",
    });
  }

  /**
   * Orphan worktrees: leaf directories under the managed roots minus every
   * path any known run (terminal included) ever registered. Besides the task
   * table's worktree_path全集, the deterministic per-run integration and
   * shared-readonly paths are registered too — a leftover under a KNOWN run's
   * directory is OctoPunk-owned residue (worktreeMaintenance territory), not
   * a 来源不明 orphan, and must not be flagged (误判防护).
   */
  private async scanOrphanWorktrees(): Promise<RecoveryItemDTO[]> {
    try {
      const runs = await this.repository.listRuns();
      const registered = new Set<string>();
      for (const run of runs) {
        try {
          const summary = await this.repository.runSummary(run.id);
          for (const task of summary.tasks) registered.add(task.worktreePath);
          registered.add(integrationWorktreeURL(run.id));
          registered.add(sharedReadOnlyWorktreeURL(run.id, summary.run.baselineCommit));
        } catch {
          // Unreadable run: its worktrees stay unknown → cannot prove orphan.
        }
      }
      const orphans = await this.probes.scanOrphanWorktrees({
        managedRoots: managedWorktreeRoots(),
        registeredPaths: [...registered],
      });
      return orphans.map((orphan) =>
        recoveryItem({
          kind: "orphan_worktree",
          target: orphan.path,
          detail: `${orphan.path}:${orphan.detail}`,
          suggestion: orphan.suggestion,
        }),
      );
    } catch {
      return [];
    }
  }

  /**
   * Orphan branches grouped by repository: `octopunk/*` branches under no
   * known run's prefix (full run id for integration branches, 8-char short
   * id for task branches — both repository.ts conventions). With `runID`,
   * only that run's repositories are scanned, but keep prefixes still cover
   * every run of the repository so sibling runs never false-positive.
   */
  private async scanOrphanBranches(runID: string | undefined): Promise<RecoveryItemDTO[]> {
    try {
      const runs = await this.repository.listRuns();
      const scopeRepositories =
        runID == null
          ? null
          : new Set(runs.filter((run) => run.id === runID).map((run) => run.repositoryPath));
      const byRepository = new Map<string, string[]>();
      for (const run of runs) {
        if (scopeRepositories != null && !scopeRepositories.has(run.repositoryPath)) continue;
        const prefixes = byRepository.get(run.repositoryPath) ?? [];
        prefixes.push(`octopunk/${run.id}/`, `octopunk/${shortRunID(run.id)}/`);
        byRepository.set(run.repositoryPath, prefixes);
      }
      const items: RecoveryItemDTO[] = [];
      for (const [repositoryURL, keepPrefixes] of byRepository) {
        const orphans = await this.probes
          .scanOrphanBranches({ repositoryURL, keepPrefixes, processPort: this.processPort })
          .catch(() => []);
        for (const orphan of orphans) {
          items.push(
            recoveryItem({
              kind: "orphan_branch",
              target: orphan.branch,
              detail: `仓库 ${repositoryURL} 分支 ${orphan.branch}:${orphan.detail}`,
              suggestion: orphan.suggestion,
            }),
          );
        }
      }
      return items;
    } catch {
      return [];
    }
  }

  // ---- helpers -----------------------------------------------------------

  /** Direct-or-transitive dependents of a task (DAG descendants). */
  private descendantsOf(taskID: string, dependencies: readonly TaskDependency[]): Set<string> {
    const dependents = new Map<string, string[]>();
    for (const dependency of dependencies) {
      const list = dependents.get(dependency.dependsOnTaskID) ?? [];
      list.push(dependency.taskID);
      dependents.set(dependency.dependsOnTaskID, list);
    }
    const seen = new Set<string>();
    const queue = [...(dependents.get(taskID) ?? [])];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of dependents.get(current) ?? []) queue.push(next);
    }
    return seen;
  }
}

/** Stable human-readable label for cleanup result reporting. */
function describeTarget(target: RecoveryCleanupTarget): string {
  if (target.kind === "orphan_branch") {
    return `orphan_branch ${target.repositoryURL ?? "?"}#${target.branchName ?? "?"}`;
  }
  return `${target.kind} ${target.path ?? "?"}`;
}
