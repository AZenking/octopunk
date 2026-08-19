// Preload bridge: the renderer's only entry into the Electron main process.

import { contextBridge, ipcRenderer } from "electron";

const INVOKE_ALLOWLIST = new Set([
  "agent:check",
  "app:pick-repository",
  "doctor:bundle",
  "doctor:latest",
  "doctor:rerun-item",
  "doctor:run",
  "gate:evaluate",
  "gate:get-config",
  "gate:set-config",
  "gate:waive-item",
  "git:inspect",
  "http:start",
  "http:stop",
  "legacy:import",
  "pr:check",
  "pr:create",
  "pr:settings",
  "pr:status",
  "queries:event-page",
  "queries:execution-log",
  "queries:run-summary",
  "queries:status",
  "queries:summaries",
  "recovery:cleanup-orphans",
  "recovery:mark-failed",
  "recovery:rerun",
  "recovery:status",
  "review:add-comments",
  "review:arbitration",
  "review:collect-arbitration",
  "review:generate-summary",
  "review:get-diff",
  "review:get-summary",
  "review:pending-list",
  "review:rework-batch",
  "review:review-tasks",
  "review:run-review",
  "review:unresolved-findings",
  "run:pause",
  "run:resume",
  "run:set-priority",
  "scheduler:resource-status",
  "scheduler:settings",
  "settings:connect-codex",
  "settings:connect-pi",
  "settings:get-child-models",
  "settings:get-custom-instructions",
  "settings:get-disabled-agents",
  "settings:get-executables",
  "settings:get-execution-policy",
  "settings:get-max-concurrent-tasks",
  "settings:get-skill-status",
  "settings:install-skill",
  "settings:register-login-item",
  "settings:set-child-model",
  "settings:set-custom-instructions",
  "settings:set-disabled-agents",
  "settings:set-executable",
  "settings:set-execution-policy",
  "settings:set-max-concurrent-tasks",
  "team:archive-run",
  "team:cancel-task",
  "team:cancel-team",
  "team:delegate-batch",
  "team:delegate-task",
  "team:delete-run",
  "team:discard-task",
  "team:join",
  "team:review",
  "team:start",
  "team:unarchive-run",
  "workbench:summary",
  "worktree:cleanup",
  "worktree:scan",
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
