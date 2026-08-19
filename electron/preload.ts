// Preload bridge: the renderer's only entry into the Electron main process.

import { contextBridge, ipcRenderer } from "electron";

const INVOKE_ALLOWLIST = new Set([
  "gate:evaluate",
  "gate:get-config",
  "gate:set-config",
  "gate:waive-item",
  "git:inspect",
  "team:start",
  "team:delegate-task",
  "team:delegate-batch",
  "queries:status",
  "queries:summaries",
  "queries:run-summary",
  "queries:event-page",
  "queries:execution-log",
  "review:add-comments",
  "review:generate-summary",
  "review:get-diff",
  "review:get-summary",
  "review:pending-list",
  "review:rework-batch",
  "review:unresolved-findings",
  "team:join",
  "team:review",
  "team:cancel-task",
  "team:discard-task",
  "team:cancel-team",
  "team:delete-run",
  "team:archive-run",
  "team:unarchive-run",
  "agent:check",
  "settings:get-executables",
  "settings:set-executable",
  "settings:get-custom-instructions",
  "settings:set-custom-instructions",
  "settings:get-disabled-agents",
  "settings:set-disabled-agents",
  "settings:get-max-concurrent-tasks",
  "settings:set-max-concurrent-tasks",
  "settings:get-execution-policy",
  "settings:set-execution-policy",
  "settings:get-child-models",
  "settings:set-child-model",
  "settings:get-skill-status",
  "settings:install-skill",
  "settings:connect-codex",
  "settings:register-login-item",
  "http:start",
  "http:stop",
  "app:pick-repository",
  "worktree:scan",
  "worktree:cleanup",
  "legacy:import",
]);

const EVENT_ALLOWLIST = new Set(["runs:changed", "run:summary", "run:event-tail", "task-log", "ui:show-settings"]);

const api = {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
    if (!INVOKE_ALLOWLIST.has(channel)) {
      return Promise.reject(new Error(`Channel is not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  observeRun(runID: string): void {
    ipcRenderer.send("run:observe", runID);
  },
  unobserveRun(runID: string): void {
    ipcRenderer.send("run:unobserve", runID);
  },
  observeTaskLog(_runID: string, taskID: string): void {
    ipcRenderer.send("log:observe", taskID);
  },
  unobserveTaskLog(taskID: string): void {
    ipcRenderer.send("log:unobserve", taskID);
  },
  subscribe(channel: string, listener: (payload: unknown) => void): () => void {
    if (!EVENT_ALLOWLIST.has(channel)) {
      throw new Error(`Channel is not allowed: ${channel}`);
    }
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped as never);
    return () => {
      ipcRenderer.removeListener(channel, wrapped as never);
    };
  },
};

export type OctoPunkBridge = typeof api;

contextBridge.exposeInMainWorld("octopunk", api);
