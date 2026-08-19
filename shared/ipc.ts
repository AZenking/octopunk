// Shared IPC payload contracts between preload and renderer.

import type {
  ChildTaskDTO,
  RunSummaryDTO,
  TeamRunDTO,
  TeamRunSummaryDTO,
  EventTailDTO,
  JoinTasksDTO,
  ContextFetchDigestDTO,
} from "./dtos";

export type { ChildTaskDTO, RunSummaryDTO, TeamRunDTO, TeamRunSummaryDTO, EventTailDTO, JoinTasksDTO };

export interface DelegateTaskItemPayload {
  clientKey: string;
  title: string;
  prompt: string;
  agentKind: "claude_code" | "codex" | "pi";
  /** Per-task model override; null/empty falls back to the per-kind setting. */
  model: string | null;
  executionMode: "read_only" | "workspace_write";
  parentTask: { taskID: string | null; clientKey: string | null } | null;
  dependencies: { taskID: string | null; clientKey: string | null }[];
}

export interface GitInspectResult {
  repositoryURL: string;
  head: string;
  hasUncommittedChanges: boolean;
  branchName: string | null;
}

export interface StartTeamResult {
  run: TeamRunDTO;
  inspection: GitInspectResult;
}

export interface ExecutablesPayload {
  claudeExecutable: string;
  codexExecutable: string;
  resolved: { claudeExecutable: string; codexExecutable: string };
}

/** Host-wide custom instructions injected into every child agent prompt. */
export interface CustomInstructionsPayload {
  customInstructions: string;
}

/** Agent kinds hidden from delegation UI (JSON string array persisted in settings.json). */
export interface DisabledAgentsPayload {
  disabledAgents: string[];
}

/** Hard upper bound for a run's concurrent child-agent tasks (Settings → General). */
export const MAX_CONCURRENT_TASKS_LIMIT = 10;

/** Default/new-run concurrent child-agent tasks when no setting is stored. */
export const DEFAULT_MAX_CONCURRENT_TASKS = 3;

export interface MaxConcurrentTasksPayload {
  maxConcurrentTasks: number;
}

/** Automatic retry budget for transient child failures (0 disables). */
export const DEFAULT_TASK_RETRY_LIMIT = 2;
export const TASK_RETRY_LIMIT_MAX = 5;

/** Minimum seconds between consecutive child launches (0 disables pacing). */
export const DEFAULT_LAUNCH_STAGGER_SECONDS = 3;
export const LAUNCH_STAGGER_SECONDS_MAX = 30;

export interface ExecutionPolicyPayload {
  taskRetryLimit: number;
  launchStaggerSeconds: number;
}

export function clampTaskRetryLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TASK_RETRY_LIMIT;
  return Math.min(TASK_RETRY_LIMIT_MAX, Math.max(0, Math.round(parsed)));
}

export function clampLaunchStaggerSeconds(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LAUNCH_STAGGER_SECONDS;
  return Math.min(LAUNCH_STAGGER_SECONDS_MAX, Math.max(0, Math.round(parsed)));
}

// ---- Scheduler concurrency & resource settings (specs/001-v03 T004) ----

/** Global cap on concurrent child-agent processes across all runs (default 6, range 1–20). */
export const DEFAULT_GLOBAL_MAX_CHILDREN = 6;
export const GLOBAL_MAX_CHILDREN_MAX = 20;

/** Per-repository cap on concurrent child-agent processes (default 3, range 1–10). */
export const DEFAULT_PER_PROJECT_MAX_CHILDREN = 3;
export const PER_PROJECT_MAX_CHILDREN_MAX = 10;

/** Per-agent-kind cap on concurrent child-agent processes (default 3, range 1–10). */
export const DEFAULT_PER_KIND_MAX_CHILDREN = 3;
export const PER_KIND_MAX_CHILDREN_MAX = 10;

/** Minimum free disk bytes before resource pressure pauses new launches (default 1 GiB). */
export const DEFAULT_MIN_FREE_DISK_BYTES = 1073741824;
/** Lower bound for a configurable disk threshold: 100 MiB. */
export const MIN_FREE_DISK_BYTES_FLOOR = 104857600;

/** scheduler:settings 读写载荷(设置页三级并发与资源阈值,specs/001-v03 B 节)。 */
export interface SchedulerSettingsPayload {
  globalMaxChildren: number;
  perProjectMaxChildren: number;
  perKindMaxChildren: number;
  resourcePauseEnabled: boolean;
  minFreeDiskBytes: number;
  interactiveSlotReserved: boolean;
}

export function clampGlobalMaxChildren(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_GLOBAL_MAX_CHILDREN;
  return Math.min(GLOBAL_MAX_CHILDREN_MAX, Math.max(1, Math.round(parsed)));
}

export function clampPerProjectMaxChildren(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PER_PROJECT_MAX_CHILDREN;
  return Math.min(PER_PROJECT_MAX_CHILDREN_MAX, Math.max(1, Math.round(parsed)));
}

export function clampPerKindMaxChildren(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PER_KIND_MAX_CHILDREN;
  return Math.min(PER_KIND_MAX_CHILDREN_MAX, Math.max(1, Math.round(parsed)));
}

/** Disk threshold has no upper bound (only the 100 MiB floor keeps it meaningful). */
export function clampMinFreeDiskBytes(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MIN_FREE_DISK_BYTES;
  return Math.max(MIN_FREE_DISK_BYTES_FLOOR, Math.round(parsed));
}

export interface ChildModelsPayload {
  claudeModel: string;
  codexModel: string;
  piModel: string;
}

export type SkillInstallStateValue = "not_installed" | "installed" | "update_available";

export interface SkillInstallStatusPayload {
  kind: "claude_code" | "codex" | "pi";
  state: SkillInstallStateValue;
  path: string;
}

export interface SkillInstallResultPayload {
  path: string;
  backupPath: string | null;
}

export interface AvailabilityPayload {
  kind: "claude_code" | "codex" | "pi";
  executable: string;
  isAvailable: boolean;
  detail: string;
}

export interface RunSummaryChangedPayload {
  runID: string;
  summary: RunSummaryDTO;
}

export interface EventTailChangedPayload {
  runID: string;
  tail: EventTailDTO;
}

export type { ContextFetchDigestDTO };
