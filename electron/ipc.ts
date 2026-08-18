// IPC surface wiring the renderer's AppState (port of OctoPunk/App/AppState.swift)
// to the main-process AppEnvironment, plus the live observers that replace
// SwiftUI's database-driven sidebar/detail updates (spec 001 FR-002a).

import { randomUUID } from "node:crypto";
import { BrowserWindow, dialog, ipcMain } from "electron";
import type { AppEnvironment } from "./appEnvironment";
import {
  CLAUDE_CHILD_MODEL_KEY,
  CLAUDE_EXECUTABLE_KEY,
  CODEX_CHILD_MODEL_KEY,
  CODEX_EXECUTABLE_KEY,
  CUSTOM_INSTRUCTIONS_KEY,
  DISABLED_AGENTS_KEY,
  LAUNCH_STAGGER_SECONDS_KEY,
  MAX_CONCURRENT_TASKS_KEY,
  PI_CHILD_MODEL_KEY,
  PI_EXECUTABLE_KEY,
  TASK_RETRY_LIMIT_KEY,
} from "./settingsStore";
import type { AsyncStream } from "./domain/repositoryPort";
import {
  clampLaunchStaggerSeconds,
  clampTaskRetryLimit,
  DEFAULT_MAX_CONCURRENT_TASKS,
  MAX_CONCURRENT_TASKS_LIMIT,
  type AvailabilityPayload,
  type ChildModelsPayload,
  type DelegateTaskItemPayload,
  type ExecutionPolicyPayload,
  type MaxConcurrentTasksPayload,
} from "../shared/ipc";

export interface RegisteredObservers {
  dispose: () => void;
}

/** Stable session identity for runs started from the Electron GUI itself. */
export const LOCAL_UI_SESSION_ID = "local-ui";

function clampMaxConcurrentTasks(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(MAX_CONCURRENT_TASKS_LIMIT, Math.max(1, Math.round(parsed)));
}

function storedMaxConcurrentTasks(environment: AppEnvironment): number {
  return (
    clampMaxConcurrentTasks(environment.settings.string(MAX_CONCURRENT_TASKS_KEY)) ??
    DEFAULT_MAX_CONCURRENT_TASKS
  );
}

export function registerIpc(environment: AppEnvironment): (window: BrowserWindow) => void {
  const handle = <T>(channel: string, handler: (payload: unknown) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return await handler(payload);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    });
  };

  handle("git:inspect", (payload) => {
    const request = payload as { path: string };
    return environment.git.inspect(request.path);
  });

  handle("team:start", async (payload) => {
    const request = payload as {
      repositoryPath: string;
      task: string;
      maxReviewRounds: number;
      maxConcurrentTasks?: number;
    };
    const inspection = await environment.git.inspect(request.repositoryPath);
    const dto = await environment.teamService.startTeam({
      requestID: randomUUID(),
      // The GUI owns its own single active-run slot, independent of MCP sessions.
      sessionID: LOCAL_UI_SESSION_ID,
      repositoryPath: request.repositoryPath,
      task: request.task,
      baselineCommit: inspection.head,
      targetBranch: inspection.branchName ?? "",
      // The renderer owns the value from Settings → General; the stored setting
      // covers callers that omit it (and stays the fallback for safety).
      maxConcurrentTasks:
        clampMaxConcurrentTasks(request.maxConcurrentTasks) ??
        storedMaxConcurrentTasks(environment),
      maxReviewRounds: request.maxReviewRounds,
    });
    return { run: dto.run, inspection };
  });

  handle("team:delegate-task", (payload) => {
    const request = payload as {
      runID: string;
      title: string;
      prompt: string;
      agentKind: "claude_code" | "codex";
      executionMode: "read_only" | "workspace_write";
    };
    return environment.teamService.delegateTask({
      requestID: randomUUID(),
      runID: request.runID,
      title: request.title,
      prompt: request.prompt,
      agentKind: request.agentKind,
      executionMode: request.executionMode,
      dependencies: [],
    });
  });

  handle("team:delegate-batch", (payload) => {
    const request = payload as {
      runID: string;
      contextSummary: string;
      tasks: DelegateTaskItemPayload[];
    };
    return environment.teamService.delegateTasks({
      requestID: randomUUID(),
      runID: request.runID,
      contextSummary: request.contextSummary,
      tasks: request.tasks,
    });
  });

  handle("queries:status", (payload) => {
    const request = payload as { runID: string };
    return environment.queryService.status(request.runID);
  });

  handle("queries:summaries", () => environment.repository.listRuns());

  handle("queries:run-summary", (payload) => {
    const request = payload as { runID: string };
    return environment.queryService.runSummary(request.runID);
  });

  handle("queries:event-page", (payload) => {
    const request = payload as { runID: string; before: number };
    return environment.queryService.eventPage(request.runID, request.before, 100);
  });

  handle("queries:execution-log", (payload) => {
    const request = payload as { runID: string; taskID: string };
    return environment.queryService.executionLogDetail(request.runID, request.taskID);
  });

  handle("team:join", (payload) => {
    const request = payload as { runID: string; batchID: string };
    return environment.teamService.joinTasks({
      runID: request.runID,
      batchID: request.batchID,
      taskIDs: [],
      timeoutSeconds: 45,
    });
  });

  handle("team:review", (payload) => {
    const request = payload as {
      action: "accept" | "rework" | "block";
      runID: string;
      taskID: string;
      summary: string;
    };
    const verdict =
      request.action === "accept" ? "PASS" : request.action === "rework" ? "REWORK" : "BLOCKED";
    const input = {
      requestID: randomUUID(),
      runID: request.runID,
      taskID: request.taskID,
      reviewer: "codex.ui",
      verdict: verdict as "PASS" | "REWORK" | "BLOCKED",
      summary: request.summary.length === 0 ? "Reviewed in OctoPunk UI" : request.summary,
      findings: [],
    };
    if (request.action === "accept") return environment.teamService.acceptTask(input);
    if (request.action === "rework") return environment.teamService.requestRework(input);
    return environment.teamService.blockTask(input);
  });

  handle("team:cancel-task", (payload) => {
    const request = payload as { runID: string; taskID: string };
    return environment.teamService.cancelTask({
      requestID: randomUUID(),
      runID: request.runID,
      taskID: request.taskID,
    });
  });

  handle("team:discard-task", (payload) => {
    const request = payload as { runID: string; taskID: string };
    return environment.teamService.discardTask({
      requestID: randomUUID(),
      runID: request.runID,
      taskID: request.taskID,
    });
  });

  handle("team:cancel-team", (payload) => {
    const request = payload as { runID: string };
    return environment.teamService.cancelTeam({
      requestID: randomUUID(),
      runID: request.runID,
    });
  });

  handle("team:delete-run", async (payload) => {
    const request = payload as { runID: string };
    await environment.teamService.discardTeam({
      requestID: randomUUID(),
      runID: request.runID,
    });
    await environment.repository.hideRun({
      requestID: randomUUID(),
      runID: request.runID,
    });
    return null;
  });

  handle("team:archive-run", (payload) => {
    const request = payload as { runID: string };
    return environment.teamService.archiveTeam({
      requestID: randomUUID(),
      runID: request.runID,
    });
  });

  handle("team:unarchive-run", (payload) => {
    const request = payload as { runID: string };
    return environment.teamService.unarchiveTeam({
      requestID: randomUUID(),
      runID: request.runID,
    });
  });

  handle("agent:check", (payload) => {
    const request = payload as { kind: "claude_code" | "codex"; override?: string | null };
    return environment.checkAgent(request.kind, request.override ?? null);
  });

  handle("settings:get-executables", () => ({
    claudeExecutable: environment.settings.string(CLAUDE_EXECUTABLE_KEY) ?? "",
    codexExecutable: environment.settings.string(CODEX_EXECUTABLE_KEY) ?? "",
    resolved: {
      claudeExecutable: environment.claudeExecutable,
      codexExecutable: environment.codexExecutable,
    },
  }));

  handle("settings:set-executable", (payload) => {
    const request = payload as { kind: "claude_code" | "codex"; path: string };
    environment.settings.set(
      request.kind === "claude_code" ? CLAUDE_EXECUTABLE_KEY : CODEX_EXECUTABLE_KEY,
      request.path,
    );
    return null;
  });

  handle("settings:get-custom-instructions", () => ({
    customInstructions: environment.settings.string(CUSTOM_INSTRUCTIONS_KEY) ?? "",
  }));

  handle("settings:set-custom-instructions", (payload) => {
    const request = payload as { text?: string };
    // An empty value clears the guidance (SettingsStore.string treats "" as unset).
    environment.settings.set(CUSTOM_INSTRUCTIONS_KEY, request.text ?? "");
    return null;
  });

  handle("settings:get-disabled-agents", () => {
    const stored = environment.settings.string(DISABLED_AGENTS_KEY);
    let disabled: string[] = [];
    try {
      const parsed = stored != null ? (JSON.parse(stored) as unknown) : [];
      if (Array.isArray(parsed)) {
        disabled = parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      disabled = [];
    }
    return { disabledAgents: disabled };
  });

  handle("settings:set-disabled-agents", (payload) => {
    const request = payload as { kinds?: string[] };
    const kinds = Array.isArray(request.kinds)
      ? request.kinds.filter((value): value is string => typeof value === "string")
      : [];
    // An empty array clears the key (SettingsStore.string treats "" as unset).
    environment.settings.set(DISABLED_AGENTS_KEY, JSON.stringify(kinds));
    return null;
  });

  handle("settings:get-max-concurrent-tasks", (): MaxConcurrentTasksPayload => ({
    maxConcurrentTasks: storedMaxConcurrentTasks(environment),
  }));

  handle("settings:set-max-concurrent-tasks", (payload): MaxConcurrentTasksPayload => {
    const request = payload as { value?: number };
    const value = clampMaxConcurrentTasks(request.value) ?? DEFAULT_MAX_CONCURRENT_TASKS;
    environment.settings.set(MAX_CONCURRENT_TASKS_KEY, String(value));
    return { maxConcurrentTasks: value };
  });

  handle("settings:get-execution-policy", (): ExecutionPolicyPayload => ({
    taskRetryLimit: clampTaskRetryLimit(environment.settings.string(TASK_RETRY_LIMIT_KEY)),
    launchStaggerSeconds: clampLaunchStaggerSeconds(
      environment.settings.string(LAUNCH_STAGGER_SECONDS_KEY),
    ),
  }));

  handle("settings:set-execution-policy", (payload): ExecutionPolicyPayload => {
    const request = payload as { taskRetryLimit?: unknown; launchStaggerSeconds?: unknown };
    const taskRetryLimit = clampTaskRetryLimit(request.taskRetryLimit);
    const launchStaggerSeconds = clampLaunchStaggerSeconds(request.launchStaggerSeconds);
    environment.settings.set(TASK_RETRY_LIMIT_KEY, String(taskRetryLimit));
    environment.settings.set(LAUNCH_STAGGER_SECONDS_KEY, String(launchStaggerSeconds));
    return { taskRetryLimit, launchStaggerSeconds };
  });

  handle("settings:get-child-models", (): ChildModelsPayload => ({
    claudeModel: environment.settings.string(CLAUDE_CHILD_MODEL_KEY) ?? "",
    codexModel: environment.settings.string(CODEX_CHILD_MODEL_KEY) ?? "",
    piModel: environment.settings.string(PI_CHILD_MODEL_KEY) ?? "",
  }));

  handle("settings:set-child-model", (payload): ChildModelsPayload => {
    const request = payload as { kind?: "claude_code" | "codex" | "pi"; model?: string };
    // Empty model clears the override (SettingsStore.string treats "" as unset).
    const model = (request.model ?? "").trim().slice(0, 100);
    if (request.kind === "claude_code" || request.kind === "codex" || request.kind === "pi") {
      environment.settings.set(
        request.kind === "claude_code"
          ? CLAUDE_CHILD_MODEL_KEY
          : request.kind === "pi"
            ? PI_CHILD_MODEL_KEY
            : CODEX_CHILD_MODEL_KEY,
        model,
      );
    }
    return {
      claudeModel: environment.settings.string(CLAUDE_CHILD_MODEL_KEY) ?? "",
      codexModel: environment.settings.string(CODEX_CHILD_MODEL_KEY) ?? "",
      piModel: environment.settings.string(PI_CHILD_MODEL_KEY) ?? "",
    };
  });

  handle("settings:get-skill-status", () => environment.skillInstaller.status());

  handle("settings:install-skill", (payload) => {
    const request = payload as { kind: "claude_code" | "codex" | "pi" };
    return environment.skillInstaller.install(request.kind);
  });

  handle("settings:connect-codex", async () => {
    const { app } = await import("electron");
    // Packaged: the app executable. Dev: `electron .` needs the app root.
    const appRoot = app.getAppPath();
    const command = app.isPackaged ? process.execPath : process.execPath;
    const args = app.isPackaged ? ["--mcp-stdio"] : [appRoot, "--mcp-stdio"];
    const backup = await environment.codexConfig.connectStdio(command, args);
    return { backupPath: backup };
  });

  handle("http:start", async () => {
    await environment.mcpServer.startHTTP();
    return { endpoint: "http://127.0.0.1:51931/mcp" };
  });

  handle("http:stop", async () => {
    await environment.mcpServer.stop();
    return null;
  });

  handle("settings:register-login-item", async (payload) => {
    const request = payload as { enabled: boolean };
    if (request.enabled) {
      await environment.loginItem.register();
    } else {
      await environment.loginItem.unregister();
    }
    return null;
  });

  handle("worktree:scan", () => {
    const { WorktreeMaintenanceService } = require("./platform/worktreeMaintenance") as typeof import("./platform/worktreeMaintenance");
    const service = new WorktreeMaintenanceService(environment.git, () => environment.repository.allRunWorkspaces());
    return { entries: service.scan() };
  });

  handle("worktree:cleanup", (payload) => {
    const request = payload as { paths: string[] };
    const { WorktreeMaintenanceService } = require("./platform/worktreeMaintenance") as typeof import("./platform/worktreeMaintenance");
    const service = new WorktreeMaintenanceService(environment.git, () => environment.repository.allRunWorkspaces());
    return service.cleanup(request.paths ?? []);
  });

  handle("app:pick-repository", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
  });

  handle("legacy:import", async () => {
    const { LegacySessionImporter } = await import("./data/legacySessionImporter");
    const importer = new LegacySessionImporter();
    const imported = await importer.importIfPresent(environment.repository);
    return imported == null ? null : { runID: imported.run.id };
  });

  return (window: BrowserWindow): void => {
    attachObservers(environment, window);
  };
}

function attachObservers(environment: AppEnvironment, window: BrowserWindow): RegisteredObservers {
  const stopExternalWatch = environment.repository.watchExternalChanges();
  const send = (channel: string, payload: unknown): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  };

  const summariesStream: AsyncStream<import("../shared/dtos").TeamRunSummaryDTO[]> =
    environment.queryService.observeSummaries();
  const summariesTask = (async () => {
    try {
      for await (const summaries of summariesStream) {
        send("runs:changed", summaries);
      }
    } catch {
      // Manual refresh remains the fallback path.
    }
  })();

  const detailObservers = new Map<string, () => void>();
  const onObserve = (_event: Electron.IpcMainEvent, runID: string): void => {
    if (detailObservers.has(runID)) return;
    const summaryStream = environment.queryService.observeRunSummary(runID);
    const tailStream = environment.queryService.observeEventTail(runID, 100);
    const logStreams = new Map<string, AsyncStream<import("./domain/models").TaskExecutionLog | null>>();
    const pumpSummary = (async () => {
      try {
        for await (const summary of summaryStream) {
          send("run:summary", { runID, summary });
        }
      } catch {
        // The persisted relay log stays authoritative.
      }
    })();
    const pumpTail = (async () => {
      try {
        for await (const tail of tailStream) {
          send("run:event-tail", { runID, tail });
        }
      } catch {
        // Live preview pauses only.
      }
    })();
    void pumpSummary;
    void pumpTail;
    const onObserveLog = (_logEvent: Electron.IpcMainEvent, taskID: string): void => {
      if (logStreams.has(taskID)) return;
      const stream = environment.repository.observeExecutionLog(runID, taskID);
      logStreams.set(taskID, stream);
      void (async () => {
        try {
          for await (const log of stream) {
            send("task-log", { taskID, log });
          }
        } catch {
          // The persisted log stays authoritative.
        }
      })();
    };
    const onUnobserveLog = (_logEvent: Electron.IpcMainEvent, taskID: string): void => {
      logStreams.get(taskID)?.cancel();
      logStreams.delete(taskID);
    };
    ipcMain.on("log:observe", onObserveLog);
    ipcMain.on("log:unobserve", onUnobserveLog);
    detailObservers.set(runID, () => {
      summaryStream.cancel();
      tailStream.cancel();
      for (const stream of logStreams.values()) stream.cancel();
      logStreams.clear();
      ipcMain.removeListener("log:observe", onObserveLog);
      ipcMain.removeListener("log:unobserve", onUnobserveLog);
      detailObservers.delete(runID);
    });
  };
  const onUnobserve = (_event: Electron.IpcMainEvent, runID: string): void => {
    detailObservers.get(runID)?.();
  };
  ipcMain.on("run:observe", onObserve);
  ipcMain.on("run:unobserve", onUnobserve);

  window.on("closed", () => {
    stopExternalWatch();
    summariesStream.cancel();
    for (const dispose of [...detailObservers.values()]) dispose();
    ipcMain.removeListener("run:observe", onObserve);
    ipcMain.removeListener("run:unobserve", onUnobserve);
    void summariesTask;
  });

  return {
    dispose: (): void => {
      stopExternalWatch();
      summariesStream.cancel();
      for (const dispose of [...detailObservers.values()]) dispose();
      ipcMain.removeListener("run:observe", onObserve);
      ipcMain.removeListener("run:unobserve", onUnobserve);
    },
  };
}

export type { AvailabilityPayload };
