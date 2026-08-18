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
