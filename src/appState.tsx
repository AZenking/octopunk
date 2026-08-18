// Port of OctoPunk/OctoPunk/App/AppState.swift as a React context store.
// All mutations go through the preload bridge into the Electron main
// process; live updates arrive through the runs:changed observer.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ChildTaskDTO,
  TeamRunSummaryDTO,
} from "../shared/dtos";
import type {
  AvailabilityPayload,
  ChildModelsPayload,
  DelegateTaskItemPayload,
  ExecutablesPayload,
  ExecutionPolicyPayload,
  GitInspectResult,
  MaxConcurrentTasksPayload,
  SkillInstallResultPayload,
  SkillInstallStatusPayload,
  StartTeamResult,
} from "../shared/ipc";
import {
  clampLaunchStaggerSeconds,
  clampTaskRetryLimit,
  DEFAULT_LAUNCH_STAGGER_SECONDS,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_TASK_RETRY_LIMIT,
  MAX_CONCURRENT_TASKS_LIMIT,
} from "../shared/ipc";

export type ChildAgentKindValue = "claude_code" | "codex" | "pi";
export type TaskExecutionModeValue = "read_only" | "workspace_write";

export interface AppStateValue {
  runs: TeamRunSummaryDTO[];
  selectedRunID: string | null;
  setSelectedRunID: (runID: string | null) => void;
  repositoryPath: string;
  setRepositoryPath: (value: string) => void;
  teamTask: string;
  setTeamTask: (value: string) => void;
  childTitle: string;
  setChildTitle: (value: string) => void;
  childPrompt: string;
  setChildPrompt: (value: string) => void;
  childContextSummary: string;
  setChildContextSummary: (value: string) => void;
  childBatchDraft: string;
  setChildBatchDraft: (value: string) => void;
  childParentTaskID: string | null;
  setChildParentTaskID: (value: string | null) => void;
  childDependencyIDs: Set<string>;
  toggleChildDependency: (taskID: string, enabled: boolean) => void;
  clearChildDependencyIDs: () => void;
  childTaskCandidates: ChildTaskDTO[];
  childAgentKind: ChildAgentKindValue;
  setChildAgentKind: (value: ChildAgentKindValue) => void;
  /** Agent kinds hidden from delegation UI (persisted in settings.json). */
  disabledAgents: Set<ChildAgentKindValue>;
  setAgentEnabled: (kind: ChildAgentKindValue, enabled: boolean) => void;
  childExecutionMode: TaskExecutionModeValue;
  setChildExecutionMode: (value: TaskExecutionModeValue) => void;
  /** Per-task model override applied to the next delegation ("" = per-kind setting). */
  childModelOverride: string;
  setChildModelOverride: (value: string) => void;
  maxReviewRounds: number;
  setMaxReviewRounds: (value: number) => void;
  /** Concurrent child-agent tasks per new TeamRun (persisted in settings.json). */
  maxConcurrentTasks: number;
  setMaxConcurrentTasks: (value: number) => void;
  /** Settings → 常规: auto-retry budget + launch pacing. */
  executionPolicy: ExecutionPolicyPayload;
  updateExecutionPolicy: (patch: Partial<ExecutionPolicyPayload>) => void;
  /** Settings → 外部 Agent: per-agent child model override ("" = default). */
  childModels: ChildModelsPayload;
  setChildModel: (kind: ChildAgentKindValue, model: string) => void;
  isHTTPRunning: boolean;
  migrationMessage: string | null;
  setMigrationMessage: (value: string | null) => void;
  errorMessage: string | null;
  setErrorMessage: (value: string | null) => void;
  codexBackupPath: string | null;
  claudeAvailability: AvailabilityPayload | null;
  codexAvailability: AvailabilityPayload | null;
  piAvailability: AvailabilityPayload | null;
  availability: (kind: ChildAgentKindValue) => AvailabilityPayload | null;
  startTeam: () => Promise<void>;
  delegateChildTask: () => Promise<void>;
  delegateChildBatch: () => Promise<void>;
  refresh: () => Promise<void>;
  cancelTeam: (runID: string) => Promise<void>;
  deleteRun: (runID: string) => Promise<void>;
  archiveRun: (runID: string) => Promise<void>;
  unarchiveRun: (runID: string) => Promise<void>;
  connectCodex: () => Promise<void>;
  connectPi: () => Promise<void>;
  startHTTPCompatibility: () => Promise<void>;
  stopHTTPCompatibility: () => Promise<void>;
  registerLoginItem: (enabled: boolean) => Promise<void>;
  /** Install state of the OctoPunk skill in each orchestrating agent. */
  skillStatus: SkillInstallStatusPayload[];
  installSkill: (kind: ChildAgentKindValue) => Promise<void>;
  testAgentExecutable: (kind: ChildAgentKindValue, path: string) => Promise<void>;
  pickRepository: () => Promise<void>;
  refreshSelectedRun: () => Promise<void>;
  statusMessage: string | null;
  setStatusMessage: (value: string | null) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function useAppState(): AppStateValue {
  const context = useContext(AppStateContext);
  if (context == null) {
    throw new Error("useAppState must be used within an AppStateProvider");
  }
  return context;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uuidPrefix(value: string, length = 8): string {
  return value.slice(0, length);
}

function isChildAgentKind(value: string): value is ChildAgentKindValue {
  return value === "claude_code" || value === "codex" || value === "pi";
}

const AGENT_KIND_ORDER: ChildAgentKindValue[] = ["claude_code", "codex", "pi"];

function agentKindDisplay(kind: ChildAgentKindValue): string {
  if (kind === "codex") return "Codex";
  if (kind === "pi") return "Pi";
  return "Claude Code";
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<TeamRunSummaryDTO[]>([]);
  const [selectedRunID, setSelectedRunIDState] = useState<string | null>(null);
  /** Set once the user makes an explicit selection (run row or New TeamRun);
   *  stops the observer from snapping an empty selection back to run #1. */
  const selectionTouched = useRef(false);
  const [repositoryPath, setRepositoryPath] = useState("");
  const [teamTask, setTeamTask] = useState("");
  const [childTitle, setChildTitle] = useState("");
  const [childPrompt, setChildPrompt] = useState("");
  const [childContextSummary, setChildContextSummary] = useState("");
  const [childBatchDraft, setChildBatchDraft] = useState("");
  const [childParentTaskID, setChildParentTaskID] = useState<string | null>(null);
  const [childDependencyIDs, setChildDependencyIDs] = useState<Set<string>>(new Set());
  const [childTaskCandidates, setChildTaskCandidates] = useState<ChildTaskDTO[]>([]);
  const [childAgentKind, setChildAgentKind] = useState<ChildAgentKindValue>("claude_code");
  const [disabledAgents, setDisabledAgents] = useState<Set<ChildAgentKindValue>>(new Set());
  const [childExecutionMode, setChildExecutionMode] = useState<TaskExecutionModeValue>("workspace_write");
  const [childModelOverride, setChildModelOverride] = useState("");
  const [maxReviewRounds, setMaxReviewRounds] = useState(5);
  const [maxConcurrentTasks, setMaxConcurrentTasksState] = useState(DEFAULT_MAX_CONCURRENT_TASKS);
  const [executionPolicy, setExecutionPolicyState] = useState<ExecutionPolicyPayload>({
    taskRetryLimit: DEFAULT_TASK_RETRY_LIMIT,
    launchStaggerSeconds: DEFAULT_LAUNCH_STAGGER_SECONDS,
  });
  const [childModels, setChildModelsState] = useState<ChildModelsPayload>({
    claudeModel: "",
    codexModel: "",
    piModel: "",
  });
  const [isHTTPRunning, setIsHTTPRunning] = useState(false);
  const [migrationMessage, setMigrationMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [codexBackupPath, setCodexBackupPath] = useState<string | null>(null);
  const [claudeAvailability, setClaudeAvailability] = useState<AvailabilityPayload | null>(null);
  const [codexAvailability, setCodexAvailability] = useState<AvailabilityPayload | null>(null);
  const [piAvailability, setPiAvailability] = useState<AvailabilityPayload | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [skillStatus, setSkillStatus] = useState<SkillInstallStatusPayload[]>([]);
  const bootstrapped = useRef(false);

  const refreshSelectedRun = useCallback(async () => {
    if (selectedRunID == null) {
      setChildTaskCandidates([]);
      return;
    }
    try {
      const status = await window.octopunk.invoke<{
        tasks: ChildTaskDTO[];
      }>("queries:status", { runID: selectedRunID });
      setChildTaskCandidates(
        [...status.tasks].sort((lhs, rhs) => {
          if (lhs.parentTaskID === rhs.parentTaskID) {
            return lhs.title < rhs.title ? -1 : lhs.title > rhs.title ? 1 : 0;
          }
          return (lhs.parentTaskID ?? "") < (rhs.parentTaskID ?? "") ? -1 : 1;
        }),
      );
    } catch {
      // Selected run disappeared; candidates refresh on next selection.
    }
  }, [selectedRunID]);

  const refresh = useCallback(async () => {
    // Reload the run list from SQLite: this is the only path that sees writes
    // from other processes (e.g. an MCP stdio instance sharing the database),
    // because the in-process observer cannot see cross-process commits.
    try {
      const summaries = await window.octopunk.invoke<TeamRunSummaryDTO[]>("queries:summaries");
      setRuns(summaries);
      setSelectedRunIDState((current) =>
        current != null && !summaries.some((summary) => summary.id === current) ? null : current,
      );
    } catch {
      // Availability refresh below still runs.
    }
    try {
      const [claude, codex, pi] = await Promise.all([
        window.octopunk.invoke<AvailabilityPayload>("agent:check", { kind: "claude_code" }),
        window.octopunk.invoke<AvailabilityPayload>("agent:check", { kind: "codex" }),
        window.octopunk.invoke<AvailabilityPayload>("agent:check", { kind: "pi" }),
      ]);
      setClaudeAvailability(claude);
      setCodexAvailability(codex);
      setPiAvailability(pi);
    } catch {
      // Manual refresh stays as the fallback path.
    }
  }, []);

  // Bootstrap: legacy import, agent availability, initial list (spec 001 FR-002a).
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void (async () => {
      try {
        const imported = await window.octopunk.invoke<{ runID: string } | null>("legacy:import");
        if (imported != null) {
          setMigrationMessage(
            `Imported the previous last-session.json as read-only history (${uuidPrefix(imported.runID)}).`,
          );
        }
      } catch (error) {
        setErrorMessage(`Legacy session import failed: ${errorMessageOf(error)}`);
        return;
      }
      try {
        const [claude, codex, pi] = await Promise.all([
          window.octopunk.invoke<AvailabilityPayload>("agent:check", { kind: "claude_code" }),
          window.octopunk.invoke<AvailabilityPayload>("agent:check", { kind: "codex" }),
          window.octopunk.invoke<AvailabilityPayload>("agent:check", { kind: "pi" }),
        ]);
        setClaudeAvailability(claude);
        setCodexAvailability(codex);
        setPiAvailability(pi);
      } catch {
        // Availability stays unknown; Settings can re-check.
      }
      try {
        const result = await window.octopunk.invoke<{ disabledAgents: string[] }>(
          "settings:get-disabled-agents",
        );
        setDisabledAgents(
          new Set(result.disabledAgents.filter(isChildAgentKind)),
        );
      } catch {
        // Disabled agents stay empty; Settings can rewrite the value.
      }
      try {
        const result = await window.octopunk.invoke<MaxConcurrentTasksPayload>(
          "settings:get-max-concurrent-tasks",
        );
        setMaxConcurrentTasksState(result.maxConcurrentTasks);
      } catch {
        // Concurrency stays at the default; Settings can rewrite the value.
      }
      try {
        setExecutionPolicyState(
          await window.octopunk.invoke<ExecutionPolicyPayload>("settings:get-execution-policy"),
        );
      } catch {
        // Policy stays at the defaults; Settings can rewrite the values.
      }
      try {
        setChildModelsState(
          await window.octopunk.invoke<ChildModelsPayload>("settings:get-child-models"),
        );
      } catch {
        // Model overrides stay empty; Settings can rewrite them.
      }
      try {
        setSkillStatus(
          await window.octopunk.invoke<SkillInstallStatusPayload[]>("settings:get-skill-status"),
        );
      } catch {
        // Skill status stays empty; install still reports errors.
      }
    })();
  }, []);

  const setSelectedRunID = useCallback((runID: string | null): void => {
    selectionTouched.current = true;
    setSelectedRunIDState(runID);
  }, []);

  const setAgentEnabled = useCallback(
    (kind: ChildAgentKindValue, enabled: boolean): void => {
      const next = new Set(disabledAgents);
      if (enabled) {
        next.delete(kind);
      } else {
        next.add(kind);
      }
      setDisabledAgents(next);
      void window.octopunk
        .invoke("settings:set-disabled-agents", { kinds: [...next] })
        .catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        });
    },
    [disabledAgents],
  );

  const setMaxConcurrentTasks = useCallback((value: number): void => {
    const clamped = Math.min(
      MAX_CONCURRENT_TASKS_LIMIT,
      Math.max(1, Math.round(Number.isFinite(value) ? value : DEFAULT_MAX_CONCURRENT_TASKS)),
    );
    setMaxConcurrentTasksState(clamped);
    void window.octopunk
      .invoke<MaxConcurrentTasksPayload>("settings:set-max-concurrent-tasks", { value: clamped })
      .then((result) => {
        // The main process re-clamps; align on what was actually persisted.
        setMaxConcurrentTasksState(result.maxConcurrentTasks);
      })
      .catch((error) => {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      });
  }, []);

  const updateExecutionPolicy = useCallback(
    (patch: Partial<ExecutionPolicyPayload>): void => {
      const next: ExecutionPolicyPayload = {
        taskRetryLimit: clampTaskRetryLimit(patch.taskRetryLimit ?? executionPolicy.taskRetryLimit),
        launchStaggerSeconds: clampLaunchStaggerSeconds(
          patch.launchStaggerSeconds ?? executionPolicy.launchStaggerSeconds,
        ),
      };
      setExecutionPolicyState(next);
      void window.octopunk
        .invoke<ExecutionPolicyPayload>("settings:set-execution-policy", next)
        .then((result) => {
          setExecutionPolicyState(result);
        })
        .catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        });
    },
    [executionPolicy],
  );

  const setChildModel = useCallback((kind: ChildAgentKindValue, model: string): void => {
    setChildModelsState((current) => ({
      ...current,
      [kind === "claude_code" ? "claudeModel" : kind === "pi" ? "piModel" : "codexModel"]: model,
    }));
    void window.octopunk
      .invoke<ChildModelsPayload>("settings:set-child-model", { kind, model })
      .then((result) => {
        setChildModelsState(result);
      })
      .catch((error) => {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      });
  }, []);

  // Keep the delegation selection on an enabled kind when agents get disabled.
  useEffect(() => {
    if (!disabledAgents.has(childAgentKind)) return;
    const fallback = AGENT_KIND_ORDER.find((kind) => !disabledAgents.has(kind));
    if (fallback != null) {
      setChildAgentKind(fallback);
    }
  }, [disabledAgents, childAgentKind]);

  // Keeps the sidebar run list live for in-process writes (spec 001
  // FR-002a/SC-006); cross-process writes are picked up by refresh().
  useEffect(() => {
    const unsubscribe = window.octopunk.subscribe("runs:changed", (payload) => {
      const summaries = payload as TeamRunSummaryDTO[];
      setRuns(summaries);
      if (!selectionTouched.current) {
        setSelectedRunIDState((current) =>
          current == null && summaries.length > 0 ? summaries[0].id : current,
        );
      }
    });
    // The main process emits the initial list at window creation, which can
    // land before this subscription exists — seed once from SQLite.
    void window.octopunk
      .invoke<TeamRunSummaryDTO[]>("queries:summaries")
      .then((summaries) => {
        setRuns((current) => (current.length === 0 ? summaries : current));
        if (!selectionTouched.current) {
          setSelectedRunIDState((selected) =>
            selected == null && summaries.length > 0 ? summaries[0].id : selected,
          );
        }
      })
      .catch(() => {});
    return unsubscribe;
  }, []);

  useEffect(() => {
    void refreshSelectedRun();
  }, [refreshSelectedRun]);

  const availability = useCallback(
    (kind: ChildAgentKindValue): AvailabilityPayload | null =>
      kind === "claude_code"
        ? claudeAvailability
        : kind === "pi"
          ? piAvailability
          : codexAvailability,
    [claudeAvailability, codexAvailability, piAvailability],
  );

  const startTeam = useCallback(async () => {
    const path = repositoryPath.trim();
    try {
      const result = await window.octopunk.invoke<StartTeamResult>("team:start", {
        repositoryPath: path,
        task: teamTask,
        maxReviewRounds,
        maxConcurrentTasks,
      });
      setSelectedRunID(result.run.id);
      if (!result.inspection.hasUncommittedChanges) {
        setMigrationMessage(null);
      } else {
        setMigrationMessage(
          `The repository has uncommitted changes; the run targets ${
            result.inspection.branchName ?? "detached HEAD"
          } at HEAD ${result.inspection.head.slice(0, 8)}.`,
        );
      }
    } catch (error) {
      setErrorMessage(errorMessageOf(error));
    }
  }, [repositoryPath, teamTask, maxReviewRounds, maxConcurrentTasks]);

  const delegateChildTask = useCallback(async () => {
    if (selectedRunID == null) return;
    if (disabledAgents.has(childAgentKind)) {
      const display = agentKindDisplay(childAgentKind);
      setErrorMessage(`${display} is disabled. Enable it in Settings before delegating.`);
      return;
    }
    if (availability(childAgentKind)?.isAvailable !== true) {
      const display = agentKindDisplay(childAgentKind);
      setErrorMessage(
        `${display} is unavailable. Check its executable in Settings before delegating.`,
      );
      return;
    }
    try {
      const task = await window.octopunk.invoke<ChildTaskDTO>("team:delegate-task", {
        runID: selectedRunID,
        title: childTitle,
        prompt: childPrompt,
        agentKind: childAgentKind,
        model: childModelOverride.trim() || null,
        executionMode: childExecutionMode,
      });
      setChildTitle("");
      setChildPrompt("");
      const display = agentKindDisplay(childAgentKind);
      setMigrationMessage(
        `Delegated ${task.title} to ${display} in ${childExecutionMode === "read_only" ? "read only" : "workspace write"} mode.`,
      );
      await refreshSelectedRun();
    } catch (error) {
      setErrorMessage(errorMessageOf(error));
    }
  }, [selectedRunID, childTitle, childPrompt, childAgentKind, childModelOverride, childExecutionMode, availability, refreshSelectedRun, disabledAgents]);

  const delegateChildBatch = useCallback(async () => {
    if (selectedRunID == null) return;
    if (disabledAgents.has(childAgentKind)) {
      const display = agentKindDisplay(childAgentKind);
      setErrorMessage(`${display} is disabled. Enable it in Settings before delegating.`);
      return;
    }
    if (availability(childAgentKind)?.isAvailable !== true) {
      const display = agentKindDisplay(childAgentKind);
      setErrorMessage(
        `${display} is unavailable. Check its executable in Settings before delegating.`,
      );
      return;
    }
    const lines = childBatchDraft
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      setErrorMessage("Add at least one batch task. Use one task per line: title | prompt");
      return;
    }
    if (childContextSummary.trim().length === 0) {
      setErrorMessage("A parent context summary is required for a batch.");
      return;
    }

    const parent = childParentTaskID != null ? { taskID: childParentTaskID, clientKey: null } : null;
    const dependencies = [...childDependencyIDs]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((taskID) => ({ taskID, clientKey: null }));
    const tasks: DelegateTaskItemPayload[] = lines.map((line, index) => {
      const parts = line.split("|").map((part) => part.trim());
      const structured = parts.length >= 3;
      const clientKey =
        structured && parts[0].length > 0 ? parts[0] : `gui-${index + 1}-${uuidPrefix(crypto.randomUUID())}`;
      const titleValue = structured ? parts[1] : (parts[0] ?? "");
      const title = titleValue.length === 0 ? `Task ${index + 1}` : titleValue;
      const promptValue = structured ? parts[2] : parts.length > 1 ? parts[1] : title;
      const prompt = promptValue.length === 0 ? title : promptValue;
      const taskParent = parts.length >= 4 ? taskReference(parts[3]) : parent;
      let taskDependencies: DelegateTaskItemPayload["dependencies"];
      if (parts.length >= 5) {
        taskDependencies = parts[4]
          .split(",")
          .map((value) => taskReference(value))
          .filter((value): value is NonNullable<typeof value> => value != null);
      } else {
        taskDependencies = dependencies;
      }
      return {
        clientKey,
        title,
        prompt,
        agentKind: childAgentKind,
        model: childModelOverride.trim() || null,
        executionMode: childExecutionMode,
        parentTask: taskParent,
        dependencies: taskDependencies,
      };
    });

    try {
      const result = await window.octopunk.invoke<{ batch: { id: string }; tasks: ChildTaskDTO[] }>(
        "team:delegate-batch",
        {
          runID: selectedRunID,
          contextSummary: childContextSummary,
          tasks,
        },
      );
      setChildContextSummary("");
      setChildBatchDraft("");
      setChildParentTaskID(null);
      setChildDependencyIDs(new Set());
      setMigrationMessage(
        `Delegated batch ${uuidPrefix(result.batch.id)} with ${result.tasks.length} tasks.`,
      );
      await refreshSelectedRun();
    } catch (error) {
      setErrorMessage(errorMessageOf(error));
    }
  }, [
    selectedRunID,
    childBatchDraft,
    childContextSummary,
    childParentTaskID,
    childDependencyIDs,
    childAgentKind,
    childExecutionMode,
    childModelOverride,
    availability,
    refreshSelectedRun,
    disabledAgents,
  ]);

  const cancelTeam = useCallback(async (runID: string) => {
    try {
      await window.octopunk.invoke("team:cancel-team", { runID });
      setSelectedRunID(runID);
      setMigrationMessage(`Force-cancelled TeamRun ${uuidPrefix(runID)}.`);
    } catch (error) {
      setErrorMessage(errorMessageOf(error));
    }
  }, []);

  /** Deletes a finished run: discards worktrees, then hides the audit record. */
  const deleteRun = useCallback(
    async (runID: string) => {
      try {
        await window.octopunk.invoke("team:delete-run", { runID });
        if (selectedRunID === runID) {
          setSelectedRunID(null);
        }
        setMigrationMessage(
          `Removed TeamRun ${uuidPrefix(runID)} from the list; its audit record stays in the database.`,
        );
      } catch (error) {
        setErrorMessage(errorMessageOf(error));
      }
    },
    [selectedRunID, setSelectedRunID],
  );

  /** Moves a finished run to the archived section; reversible. */
  const archiveRun = useCallback(async (runID: string) => {
    try {
      await window.octopunk.invoke("team:archive-run", { runID });
      setMigrationMessage(`Archived TeamRun ${uuidPrefix(runID)}; restore it from the archived section anytime.`);
    } catch (error) {
      setErrorMessage(errorMessageOf(error));
    }
  }, []);

  const unarchiveRun = useCallback(async (runID: string) => {
    try {
      await window.octopunk.invoke("team:unarchive-run", { runID });
      setMigrationMessage(`Restored TeamRun ${uuidPrefix(runID)} to the active list.`);
    } catch (error) {
      setErrorMessage(errorMessageOf(error));
    }
  }, []);

  const connectCodex = useCallback(async () => {
    try {
      const result = await window.octopunk.invoke<{ backupPath: string | null }>("settings:connect-codex");
      setCodexBackupPath(result.backupPath);
      setMigrationMessage(
        "Codex MCP configured through local STDIO. HTTP compatibility is optional and remains stopped.",
      );
    } catch (error) {
      setErrorMessage(errorMessageOf(error));
    }
  }, []);

  const connectPi = useCallback(async () => {
    try {
      const result = await window.octopunk.invoke<{ backupPath: string | null }>("settings:connect-pi");
      setStatusMessage(
        `已写入 ~/.pi/agent/mcp.json（octopunk · stdio · eager）${
          result.backupPath != null ? "；原文件已自动备份。" : ""
        }需先安装 pi-mcp-extension（pi install npm:pi-mcp-extension）。`,
      );
    } catch (error) {
      setErrorMessage(errorMessageOf(error));
    }
  }, []);

  const startHTTPCompatibility = useCallback(async () => {
    try {
      const result = await window.octopunk.invoke<{ endpoint: string }>("http:start");
      setIsHTTPRunning(true);
      setMigrationMessage(`Optional HTTP MCP compatibility is running at ${result.endpoint}.`);
    } catch (error) {
      setIsHTTPRunning(false);
      setErrorMessage(`HTTP MCP service failed to start: ${errorMessageOf(error)}`);
    }
  }, []);

  const stopHTTPCompatibility = useCallback(async () => {
    try {
      await window.octopunk.invoke("http:stop");
    } finally {
      setIsHTTPRunning(false);
      setMigrationMessage("HTTP MCP compatibility stopped. Codex STDIO remains the default transport.");
    }
  }, []);

  const registerLoginItem = useCallback(async (enabled: boolean) => {
    try {
      await window.octopunk.invoke("settings:register-login-item", { enabled });
    } catch (error) {
      setErrorMessage(errorMessageOf(error));
    }
  }, []);

  const installSkill = useCallback(async (kind: ChildAgentKindValue): Promise<void> => {
    try {
      const result = await window.octopunk.invoke<SkillInstallResultPayload>(
        "settings:install-skill",
        { kind },
      );
      const display = agentKindDisplay(kind);
      setSkillStatus(
        await window.octopunk.invoke<SkillInstallStatusPayload[]>("settings:get-skill-status"),
      );
      setStatusMessage(
        `OctoPunk skill 已安装到 ${display}（${result.path}）${
          result.backupPath != null ? "；原文件已自动备份。" : "。"
        }`,
      );
    } catch (error) {
      setErrorMessage(errorMessageOf(error));
    }
  }, []);

  const testAgentExecutable = useCallback(async (kind: ChildAgentKindValue, path: string) => {
    try {
      const result = await window.octopunk.invoke<AvailabilityPayload>("agent:check", {
        kind,
        override: path,
      });
      if (kind === "claude_code") {
        setClaudeAvailability(result);
      } else if (kind === "pi") {
        setPiAvailability(result);
      } else {
        setCodexAvailability(result);
      }
    } catch (error) {
      setErrorMessage(errorMessageOf(error));
    }
  }, []);

  const pickRepository = useCallback(async () => {
    try {
      const result = await window.octopunk.invoke<{ path: string | null }>("app:pick-repository");
      if (result.path != null) {
        setRepositoryPath(result.path);
      }
    } catch (error) {
      setErrorMessage(errorMessageOf(error));
    }
  }, []);

  const toggleChildDependency = useCallback((taskID: string, enabled: boolean) => {
    setChildDependencyIDs((current) => {
      const next = new Set(current);
      if (enabled) {
        next.add(taskID);
      } else {
        next.delete(taskID);
      }
      return next;
    });
  }, []);

  const clearChildDependencyIDs = useCallback(() => {
    setChildDependencyIDs(new Set());
  }, []);

  const value = useMemo<AppStateValue>(
    () => ({
      runs,
      selectedRunID,
      setSelectedRunID,
      repositoryPath,
      setRepositoryPath,
      teamTask,
      setTeamTask,
      childTitle,
      setChildTitle,
      childPrompt,
      setChildPrompt,
      childContextSummary,
      setChildContextSummary,
      childBatchDraft,
      setChildBatchDraft,
      childParentTaskID,
      setChildParentTaskID,
      childDependencyIDs,
      toggleChildDependency,
      clearChildDependencyIDs,
      childTaskCandidates,
      childAgentKind,
      setChildAgentKind,
      disabledAgents,
      setAgentEnabled,
      childExecutionMode,
      setChildExecutionMode,
      childModelOverride,
      setChildModelOverride,
      maxReviewRounds,
      setMaxReviewRounds,
      maxConcurrentTasks,
      setMaxConcurrentTasks,
      executionPolicy,
      updateExecutionPolicy,
      childModels,
      setChildModel,
      isHTTPRunning,
      migrationMessage,
      setMigrationMessage,
      errorMessage,
      setErrorMessage,
      codexBackupPath,
      claudeAvailability,
      codexAvailability,
      piAvailability,
      availability,
      startTeam,
      delegateChildTask,
      delegateChildBatch,
      refresh,
      cancelTeam,
      deleteRun,
      archiveRun,
      unarchiveRun,
      connectCodex,
      connectPi,
      startHTTPCompatibility,
      stopHTTPCompatibility,
      registerLoginItem,
      installSkill,
      skillStatus,
      testAgentExecutable,
      pickRepository,
      refreshSelectedRun,
      statusMessage,
      setStatusMessage,
    }),
    [
      runs,
      selectedRunID,
      repositoryPath,
      teamTask,
      childTitle,
      childPrompt,
      childContextSummary,
      childBatchDraft,
      childParentTaskID,
      childDependencyIDs,
      toggleChildDependency,
      clearChildDependencyIDs,
      childTaskCandidates,
      childAgentKind,
      disabledAgents,
      setAgentEnabled,
      childExecutionMode,
      childModelOverride,
      maxReviewRounds,
      maxConcurrentTasks,
      setMaxConcurrentTasks,
      executionPolicy,
      updateExecutionPolicy,
      childModels,
      setChildModel,
      isHTTPRunning,
      migrationMessage,
      errorMessage,
      codexBackupPath,
      claudeAvailability,
      codexAvailability,
      piAvailability,
      availability,
      startTeam,
      delegateChildTask,
      delegateChildBatch,
      refresh,
      cancelTeam,
      deleteRun,
      archiveRun,
      unarchiveRun,
      connectCodex,
      connectPi,
      startHTTPCompatibility,
      stopHTTPCompatibility,
      registerLoginItem,
      installSkill,
      skillStatus,
      testAgentExecutable,
      pickRepository,
      refreshSelectedRun,
      statusMessage,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

function taskReference(rawValue: string): { taskID: string | null; clientKey: string | null } | null {
  const value = rawValue.trim();
  if (value.length === 0 || value === "-" || value.toLowerCase() === "root") return null;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(value)) {
    return { taskID: value, clientKey: null };
  }
  return { taskID: null, clientKey: value };
}
