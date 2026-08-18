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
  agentKind: "claude_code" | "codex";
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

export type SkillInstallStateValue = "not_installed" | "installed" | "update_available";

export interface SkillInstallStatusPayload {
  kind: "claude_code" | "codex";
  state: SkillInstallStateValue;
  path: string;
}

export interface SkillInstallResultPayload {
  path: string;
  backupPath: string | null;
}

export interface AvailabilityPayload {
  kind: "claude_code" | "codex";
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
