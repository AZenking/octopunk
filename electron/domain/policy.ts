// Port of OctoPunk/OctoPunk/Domain/Policies/TeamRunPolicy.swift.

import { CHILD_AGENT_KINDS, DomainError, GATE_REVIEW_MODES, runStatusIsTerminal } from "./models";
import type {
  ChildTask,
  GateCheckKey,
  GateReviewMode,
  ReviewVerdict,
  TaskDependency,
  TeamRun,
  TeamRunStatus,
} from "./models";
import { MAX_CONCURRENT_TASKS_LIMIT } from "../../shared/ipc";

export const TeamRunPolicy = {
  defaultMaxConcurrentTasks: 3,
  defaultMaxReviewRounds: 5,

  validateStart(input: {
    repositoryPath: string;
    task: string;
    maxConcurrentTasks: number;
    maxReviewRounds: number;
  }): void {
    if (input.repositoryPath.trim().length === 0) {
      throw DomainError.invalidTask("A repository path is required.");
    }
    if (input.task.trim().length === 0) {
      throw DomainError.invalidTask("A team task is required.");
    }
    if (
      input.maxConcurrentTasks < 1 ||
      input.maxConcurrentTasks > MAX_CONCURRENT_TASKS_LIMIT
    ) {
      throw DomainError.invalidTask(
        `Concurrency must be between 1 and ${MAX_CONCURRENT_TASKS_LIMIT}.`,
      );
    }
    if (input.maxReviewRounds <= 0) {
      throw DomainError.invalidTask("Review rounds must be positive.");
    }
  },

  validateCanDelegate(run: TeamRun, tasks: ChildTask[], dependencies: TaskDependency[]): void {
    if (runStatusIsTerminal(run.status)) {
      throw DomainError.invalidTransition("TeamRun", run.status, "running");
    }
    const taskIDs = new Set(tasks.map((task) => task.id));
    for (const dependency of dependencies) {
      if (!taskIDs.has(dependency.dependsOnTaskID)) {
        throw DomainError.missingDependency(dependency.dependsOnTaskID);
      }
    }
    TeamRunPolicy.validateAcyclic(tasks, dependencies);
  },

  validateAcyclic(tasks: ChildTask[], dependencies: TaskDependency[]): void {
    const taskIDs = new Set(tasks.map((task) => task.id));
    const graph = new Map<string, string[]>();
    for (const dependency of dependencies) {
      if (!taskIDs.has(dependency.taskID) || !taskIDs.has(dependency.dependsOnTaskID)) {
        continue;
      }
      const list = graph.get(dependency.taskID) ?? [];
      list.push(dependency.dependsOnTaskID);
      graph.set(dependency.taskID, list);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw DomainError.dependencyCycle();
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of graph.get(id) ?? []) {
        visit(dependency);
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const task of tasks) {
      visit(task.id);
    }
  },

  nextRunStatus(verdict: ReviewVerdict): TeamRunStatus {
    switch (verdict) {
      case "PASS":
        return "awaiting_final_review";
      case "REWORK":
        return "reviewing";
      case "BLOCKED":
        return "blocked";
    }
  },

  validateReviewRound(run: TeamRun): void {
    if (!(run.currentReviewRound < run.maxReviewRounds)) {
      throw DomainError.reviewLimitReached();
    }
  },
};

// ---- v0.4 quality gates (specs/002-v04-review-center-gates) ----

/** The shell-command subset of GateCheckKey that gate configs may define. */
export const GATE_COMMAND_KEYS = ["tests", "lint", "typecheck", "build"] as const;
export type GateCommandKey = Extract<GateCheckKey, (typeof GATE_COMMAND_KEYS)[number]>;

export interface GateCheckCommandInput {
  command: string;
  timeoutSeconds: number;
}

/**
 * Gate configuration as persisted in project_gate_configs.config_json (and
 * frozen into team_runs.gate_snapshot_json). Fields are optional so partial
 * user overrides can be validated before merging onto project defaults;
 * absent fields keep the caller-normalized defaults (spec: review_mode
 * defaults to `standard`, max_risk_findings to 0, lists to empty). The shape
 * intentionally accepts shared/dtos' GateConfigDTO as-is (null check values
 * mean "not enabled"; reviewers are loose strings narrowed by this validator).
 */
export interface GateConfigInput {
  reviewMode?: GateReviewMode;
  checks?: Partial<Record<GateCommandKey, GateCheckCommandInput | null>>;
  maxRiskFindings?: number;
  scopeAllowedPaths?: string[];
  requireDependenciesAccepted?: boolean;
  requireTargetBaselineSafe?: boolean;
  requiredReviewers?: string[];
  manualConfirmHighRisk?: boolean;
  requireTodoClean?: boolean;
}

export const GATE_MAX_CHECK_COMMANDS = 8;
export const GATE_MAX_SCOPE_PATHS = 64;
export const GATE_CHECK_TIMEOUT_SECONDS_MIN = 1;
export const GATE_CHECK_TIMEOUT_SECONDS_MAX = 600;

/**
 * Save-time validation of a gate config (spec FR-007 / data-model: "校验(保存时
 * 拒绝)"). Throws DomainError.invalidTask on the first violation. Pure; runtime
 * guards matter because callers pass JSON-parsed config_json that has only been
 * asserted, not verified, to match GateConfigInput.
 */
export function validateGateConfig(config: GateConfigInput): void {
  if (
    config.reviewMode !== undefined &&
    !(GATE_REVIEW_MODES as readonly string[]).includes(config.reviewMode)
  ) {
    throw DomainError.invalidTask(`Unknown review mode: ${String(config.reviewMode)}`);
  }

  validateGateChecks(config.checks);

  if (
    config.maxRiskFindings !== undefined &&
    (typeof config.maxRiskFindings !== "number" ||
      !Number.isFinite(config.maxRiskFindings) ||
      config.maxRiskFindings < 0)
  ) {
    throw DomainError.invalidTask("max_risk_findings must be a number of 0 or greater.");
  }

  validateScopeAllowedPaths(config.scopeAllowedPaths);
  validateRequiredReviewers(config.requiredReviewers);

  // Contradiction rule (FR-012, spec edge case "门禁条件互相矛盾 → 保存时拒绝"):
  // contest mode runs several independent proposals in parallel and the winner
  // is picked by tests/reviewers — the sibling proposals never gate on each
  // other's acceptance, so require_dependencies_accepted can never be satisfied
  // in contest runs. Reject the combination at save time instead of creating a
  // permanently blocked gate.
  if (config.requireDependenciesAccepted === true && config.reviewMode === "contest") {
    throw DomainError.invalidTask(
      "require_dependencies_accepted cannot be combined with contest review mode: " +
        "contest proposals run in parallel and do not depend on each other's acceptance.",
    );
  }
}

function validateGateChecks(checks: GateConfigInput["checks"]): void {
  if (checks == null) return;
  if (typeof checks !== "object" || Array.isArray(checks)) {
    throw DomainError.invalidTask("Gate checks must be an object keyed by tests/lint/typecheck/build.");
  }
  const entries = Object.entries(checks as Record<string, unknown>);
  if (entries.length > GATE_MAX_CHECK_COMMANDS) {
    throw DomainError.invalidTask(`Gate checks may configure at most ${GATE_MAX_CHECK_COMMANDS} commands.`);
  }
  for (const [key, value] of entries) {
    if (!(GATE_COMMAND_KEYS as readonly string[]).includes(key)) {
      throw DomainError.invalidTask(`Unknown gate check key: ${key}`);
    }
    // null means the check is not enabled (the shared DTO's convention); skip it.
    if (value === null) continue;
    if (value == null || typeof value !== "object") {
      throw DomainError.invalidTask(`Gate check ${key} must be a command object.`);
    }
    const command = value as GateCheckCommandInput;
    if (typeof command.command !== "string" || command.command.trim().length === 0) {
      throw DomainError.invalidTask(`Gate check ${key} requires a non-empty command.`);
    }
    if (
      typeof command.timeoutSeconds !== "number" ||
      !Number.isInteger(command.timeoutSeconds) ||
      command.timeoutSeconds < GATE_CHECK_TIMEOUT_SECONDS_MIN ||
      command.timeoutSeconds > GATE_CHECK_TIMEOUT_SECONDS_MAX
    ) {
      throw DomainError.invalidTask(
        `Gate check ${key} timeout must be an integer between ` +
          `${GATE_CHECK_TIMEOUT_SECONDS_MIN} and ${GATE_CHECK_TIMEOUT_SECONDS_MAX} seconds.`,
      );
    }
  }
}

function validateScopeAllowedPaths(paths: GateConfigInput["scopeAllowedPaths"]): void {
  if (paths == null) return;
  if (!Array.isArray(paths)) {
    throw DomainError.invalidTask("scope_allowed_paths must be an array of relative paths.");
  }
  if (paths.length > GATE_MAX_SCOPE_PATHS) {
    throw DomainError.invalidTask(`scope_allowed_paths may list at most ${GATE_MAX_SCOPE_PATHS} paths.`);
  }
  for (const path of paths) {
    if (typeof path !== "string" || path.trim().length === 0 || path.startsWith("/")) {
      throw DomainError.invalidTask(
        `scope_allowed_paths entries must be non-empty relative paths: ${String(path)}`,
      );
    }
  }
}

function validateRequiredReviewers(reviewers: GateConfigInput["requiredReviewers"]): void {
  if (reviewers == null) return;
  if (!Array.isArray(reviewers)) {
    throw DomainError.invalidTask("required_reviewers must be an array of agent kinds.");
  }
  for (const reviewer of reviewers) {
    if (!(CHILD_AGENT_KINDS as readonly string[]).includes(reviewer)) {
      throw DomainError.invalidTask(`Unknown required reviewer agent kind: ${String(reviewer)}`);
    }
  }
}
