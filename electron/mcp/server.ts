// Port of OctoPunk/OctoPunk/Platform/MCP/OctoPunkMCPServer.swift using the
// official TypeScript MCP SDK (low-level Server + StdioServerTransport, and
// a custom stateful HTTP bridge transport in httpApplication.ts).

import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentTeamServicePortLike } from "./serviceTypes";
import type { ContextFetchService } from "../application/contextFetchService";
import { DEFAULT_MAX_CONCURRENT_TASKS } from "../../shared/ipc";
import type { GitDiffSide, GitPort, KeychainPort } from "../application/ports";
import type { ReviewCenterService, ReviewCommentInput } from "../application/reviewCenterService";
import { TaskEventHub } from "../domain/events";
import type { TaskEventUpdate } from "../domain/events";
import { OctoPunkContextServer } from "../application/ports";
import { stableStringify } from "../domain/events";
import type { ReviewFinding } from "../domain/models";
import { randomReviewFindingID } from "./ids";
import { OctoPunkHTTPApplication } from "./httpApplication";

export const MCP_ENDPOINT = "http://127.0.0.1:51931/mcp";
export const MCP_TOKEN_ENVIRONMENT_VARIABLE = "OCTOPUNK_MCP_TOKEN";

/** A sub-agent's restricted STDIO session, bound to exactly one task. */
export interface RestrictedSession {
  runID: string;
  taskID: string;
}

export const RestrictedSession = {
  detect(environment: Record<string, string | undefined> = process.env): RestrictedSession | null {
    const runRaw = environment[OctoPunkContextServer.runIDEnvironmentKey];
    const taskRaw = environment[OctoPunkContextServer.taskIDEnvironmentKey];
    if (runRaw == null || taskRaw == null) return null;
    if (!isUUID(runRaw) || !isUUID(taskRaw)) return null;
    return { runID: runRaw, taskID: taskRaw };
  },
};

export class OctoPunkMCPServer {
  private readonly service: AgentTeamServicePortLike;
  private readonly git: GitPort;
  private readonly keychain: KeychainPort;
  private readonly eventHub: TaskEventHub | null;
  private readonly readOnlyContext: ContextFetchService | null;
  private readonly defaultMaxConcurrentTasks: (() => number) | null;
  private readonly endpointURL: URL;
  private token: string | null = null;
  private httpApplication: OctoPunkHTTPApplication | null = null;

  constructor(input: {
    service: AgentTeamServicePortLike;
    git: GitPort;
    keychain: KeychainPort;
    endpoint?: string;
    eventHub?: TaskEventHub | null;
    readOnlyContext?: ContextFetchService | null;
    /** Stored OctoPunk.maxConcurrentTasks, used when a caller omits the argument. */
    defaultMaxConcurrentTasks?: () => number;
    /** Review Center service; when present the review tools become available. */
    reviewCenter?: ReviewCenterService | null;
  }) {
    // Prototype-chain delegation keeps reads live against the underlying
    // service instance while exposing the optional reviewCenter field.
    this.service = Object.create(input.service) as AgentTeamServicePortLike;
    this.service.reviewCenter = input.reviewCenter ?? undefined;
    this.git = input.git;
    this.keychain = input.keychain;
    this.eventHub = input.eventHub ?? null;
    this.readOnlyContext = input.readOnlyContext ?? null;
    this.endpointURL = new URL(input.endpoint ?? MCP_ENDPOINT);
    this.defaultMaxConcurrentTasks = input.defaultMaxConcurrentTasks ?? null;
  }

  accessToken(): string | null {
    return this.token;
  }

  async runStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    const session = RestrictedSession.detect();
    if (session != null) {
      // A sub-agent session: only the read-only context tools exist and no
      // task-event notifications are pushed to it.
      if (this.readOnlyContext == null) {
        throw new Error("Restricted session requested without a context service.");
      }
      const server = makeContextServer(session, this.readOnlyContext);
      await server.connect(transport);
      await waitForClose(server, transport);
      return;
    }
    // One stdio process == one MCP session == at most one active TeamRun.
    const sessionID = randomUUID();
    const failSession = (): void => {
      try {
        // Synchronous SQLite writes run before the first await, so this is
        // safe from exit hooks; failures are best-effort by design.
        void this.service.failActiveRunsForSession({ sessionID, reason: "session closed" });
      } catch {
        // The UI cancel button is the fallback path.
      }
    };
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        void this.service
          .failActiveRunsForSession({ sessionID, reason: "session closed" })
          .catch(() => {})
          .finally(() => process.exit(0));
      });
    }
    process.once("exit", failSession);
    const server = makeFullServer(this.service, this.git, sessionID, this.defaultMaxConcurrentTasks);
    let subscription: string | null = null;
    if (this.eventHub != null) {
      subscription = this.eventHub.subscribe((update) => {
        void server
          .notification(taskEventNotification(update))
          .catch(() => {});
      });
    }
    await server.connect(transport);
    await waitForClose(server, transport);
    // The client closed the stdio pipe: this session's runs stop with it.
    failSession();
    if (subscription != null) {
      this.eventHub?.unsubscribe(subscription);
    }
  }

  async startHTTP(): Promise<void> {
    if (this.httpApplication != null) return;
    const token = await this.ensureHTTPToken();
    const application = new OctoPunkHTTPApplication({
      host: this.endpointURL.hostname || "127.0.0.1",
      port: Number.parseInt(this.endpointURL.port, 10) || 51931,
      endpoint: this.endpointURL.pathname.length === 0 ? "/mcp" : this.endpointURL.pathname,
      token,
      serverFactory: (sessionID) =>
        Promise.resolve(makeFullServer(this.service, this.git, sessionID, this.defaultMaxConcurrentTasks)),
      onSessionClose: (sessionID) =>
        this.service.failActiveRunsForSession({ sessionID, reason: "session closed" }),
    });
    await application.start();
    this.httpApplication = application;
  }

  async stop(): Promise<void> {
    await this.httpApplication?.stop();
    this.httpApplication = null;
  }

  private async ensureHTTPToken(): Promise<string> {
    if (this.token != null && this.token.length > 0) {
      return this.token;
    }
    const existing = await this.keychain.loadToken();
    if (existing != null && existing.length > 0) {
      this.token = existing;
      return existing;
    }
    const generated = randomToken();
    await this.keychain.saveToken(generated);
    this.token = generated;
    return generated;
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

function waitForClose(server: Server, transport: StdioServerTransport): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => resolve();
    transport.onclose = finish;
    server.onclose = finish;
    // The SDK's stdio transport only listens for stdin 'data'/'error' — it
    // never observes EOF, so a client closing its pipe (how Codex exits)
    // would leave this process and its session dangling. Resolve on EOF.
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
  });
}

function makeFullServer(
  service: AgentTeamServicePortLike,
  git: GitPort,
  sessionID: string,
  defaultMaxConcurrentTasks: (() => number) | null,
): Server {
  const server = new Server({ name: "octopunk", version: "1.0.0" }, { capabilities: { tools: { listChanged: false } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: fullToolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await dispatchTool(
        service,
        git,
        request.params.name,
        request.params.arguments ?? {},
        sessionID,
        defaultMaxConcurrentTasks,
      );
      return { content: [{ type: "text", text: result }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });
  return server;
}

function makeContextServer(session: RestrictedSession, readOnlyContext: ContextFetchService): Server {
  const server = new Server(
    { name: "octopunk-context", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: contextToolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await dispatchContextTool(session, readOnlyContext, request.params.name, request.params.arguments ?? {});
      return { content: [{ type: "text", text: result }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });
  return server;
}

function taskEventNotification(update: TaskEventUpdate): {
  method: string;
  params: Record<string, unknown>;
} {
  return {
    method: "notifications/octopunk/task_event",
    params: {
      run_id: update.runID,
      batch_id: update.batchID,
      task_id: update.taskID,
      parent_task_id: update.parentTaskID,
      sequence: update.sequence,
      kind: update.kind,
      status: update.status,
      activity_preview: update.activityPreview,
      created_at: update.createdAt,
    } as Record<string, unknown>,
  };
}

// MARK: - Tool schemas (identical names, descriptions, and JSON schemas).

function stringSchema(): Record<string, unknown> {
  return { type: "string" };
}
function integerSchema(): Record<string, unknown> {
  return { type: "integer" };
}
function arraySchema(): Record<string, unknown> {
  return { type: "array", items: { type: "string" } };
}
function taskReferenceSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { task_id: stringSchema(), client_key: stringSchema() },
  };
}
function findingsSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        severity: stringSchema(),
        file: stringSchema(),
        line: integerSchema(),
        evidence: stringSchema(),
        expected_fix: stringSchema(),
      },
      required: ["evidence"],
    },
  };
}
function delegateTasksSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        client_key: stringSchema(),
        title: stringSchema(),
        prompt: stringSchema(),
        agent_kind: stringSchema(),
        model: stringSchema(),
        execution_mode: stringSchema(),
        parent_task: taskReferenceSchema(),
        dependencies: { type: "array", items: taskReferenceSchema() },
      },
      required: ["client_key", "title", "prompt", "agent_kind", "execution_mode"],
    },
  };
}
function reviewCommentsSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        file: stringSchema(),
        line_start: integerSchema(),
        line_end: integerSchema(),
        body: stringSchema(),
        severity: stringSchema(),
      },
      required: ["file", "line_start", "body"],
    },
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
    },
    annotations: { readOnlyHint: name.startsWith("get_") || name === "wait_for_report" },
  };
}

export function fullToolList(): Tool[] {
  const runIDNote = "Omit run_id to target this session's active TeamRun.";
  return [
    tool(
      "start_team",
      "Create this session's active TeamRun — one per MCP session. Capture baseline_commit from git before calling.",
      {
        request_id: stringSchema(),
        repository_path: stringSchema(),
        task: stringSchema(),
        baseline_commit: stringSchema(),
        target_branch: stringSchema(),
        max_concurrent_tasks: integerSchema(),
        max_review_rounds: integerSchema(),
      },
      ["request_id", "repository_path", "task"],
    ),
    tool(
      "delegate_task",
      `Delegate one task with an explicit agent kind and execution mode. ${runIDNote}`,
      {
        request_id: stringSchema(),
        run_id: stringSchema(),
        title: stringSchema(),
        prompt: stringSchema(),
        agent_kind: stringSchema(),
        model: stringSchema(),
        execution_mode: stringSchema(),
        dependencies: arraySchema(),
      },
      ["request_id", "title", "prompt", "agent_kind", "execution_mode"],
    ),
    tool(
      "delegate_tasks",
      `Atomically delegate a task batch with a parent context snapshot and optional task tree/DAG references. ${runIDNote}`,
      {
        request_id: stringSchema(),
        run_id: stringSchema(),
        context_summary: stringSchema(),
        tasks: delegateTasksSchema(),
      },
      ["request_id", "context_summary", "tasks"],
    ),
    tool(
      "wait_for_report",
      `Wait up to 45 seconds for an external-agent report. ${runIDNote}`,
      { run_id: stringSchema(), task_id: stringSchema() },
      ["task_id"],
    ),
    tool(
      "join_tasks",
      `Wait for a task batch or explicit task set and return a deterministic aggregate report. ${runIDNote}`,
      {
        run_id: stringSchema(),
        batch_id: stringSchema(),
        task_ids: arraySchema(),
        timeout_seconds: integerSchema(),
      },
      [],
    ),
    tool(
      "get_task_execution_log",
      `Read bounded redacted execution logs and task events after an optional sequence. ${runIDNote}`,
      { run_id: stringSchema(), task_id: stringSchema(), after_sequence: integerSchema() },
      ["task_id"],
    ),
    tool(
      "get_task_review_context",
      `Read the task report, audit context, unresolved review findings, and delivery summary (when present) for review. ${runIDNote}`,
      { run_id: stringSchema(), task_id: stringSchema() },
      ["task_id"],
    ),
    tool(
      "request_rework",
      `Send review findings to the task's same native agent session for rework. ${runIDNote}`,
      {
        request_id: stringSchema(),
        run_id: stringSchema(),
        task_id: stringSchema(),
        summary: stringSchema(),
        findings: findingsSchema(),
      },
      ["request_id", "task_id", "summary"],
    ),
    tool(
      "get_task_diff",
      `Read a task's changed-file tree and, when path names one changed file, its hunk-paged diff text (<=64KiB redacted per page, page.next_cursor continues). ${runIDNote}`,
      {
        run_id: stringSchema(),
        task_id: stringSchema(),
        side: stringSchema(),
        path: stringSchema(),
        cursor: stringSchema(),
      },
      ["task_id", "side"],
    ),
    tool(
      "add_review_comments",
      `Attach batched line-anchored review comments (baseline-side anchors; each file must appear in the task's worktree-side diff). ${runIDNote}`,
      {
        request_id: stringSchema(),
        run_id: stringSchema(),
        task_id: stringSchema(),
        comments: reviewCommentsSchema(),
      },
      ["request_id", "task_id", "comments"],
    ),
    tool(
      "request_rework_batch",
      `Aggregate selected open review comments into one rework round through the task's existing review flow. ${runIDNote}`,
      {
        request_id: stringSchema(),
        run_id: stringSchema(),
        task_id: stringSchema(),
        comment_ids: arraySchema(),
        summary: stringSchema(),
      },
      ["request_id", "task_id", "comment_ids", "summary"],
    ),
    tool(
      "accept_task",
      `Accept a task after Codex PASS and integrate its branch. ${runIDNote}`,
      {
        request_id: stringSchema(),
        run_id: stringSchema(),
        task_id: stringSchema(),
        summary: stringSchema(),
      },
      ["request_id", "task_id", "summary"],
    ),
    tool(
      "block_task",
      `Block a task with an explicit reason. ${runIDNote}`,
      {
        request_id: stringSchema(),
        run_id: stringSchema(),
        task_id: stringSchema(),
        summary: stringSchema(),
      },
      ["request_id", "task_id", "summary"],
    ),
    tool(
      "resume_task",
      `Resume a blocked or cancelled task using its existing native Agent session when available. ${runIDNote}`,
      { request_id: stringSchema(), run_id: stringSchema(), task_id: stringSchema() },
      ["request_id", "task_id"],
    ),
    tool(
      "get_team_status",
      `Read the complete TeamRun status. ${runIDNote}`,
      { run_id: stringSchema() },
      [],
    ),
    tool(
      "get_team_review_context",
      `Read all reports and audit events for final Codex review. ${runIDNote}`,
      { run_id: stringSchema() },
      [],
    ),
    tool(
      "complete_team",
      `Apply the integration result to the captured target branch, then complete the TeamRun after final Codex PASS. ${runIDNote}`,
      {
        request_id: stringSchema(),
        run_id: stringSchema(),
        final_verdict: stringSchema(),
        summary: stringSchema(),
      },
      ["request_id", "final_verdict", "summary"],
    ),
    tool(
      "cancel_task",
      `Stop one task but retain its worktree so it can be resumed. ${runIDNote}`,
      { request_id: stringSchema(), run_id: stringSchema(), task_id: stringSchema() },
      ["request_id", "task_id"],
    ),
    tool(
      "cancel_team",
      `Stop the active TeamRun and retain its worktrees so it can be resumed. ${runIDNote}`,
      { request_id: stringSchema(), run_id: stringSchema() },
      ["request_id"],
    ),
    tool(
      "discard_task",
      `Cancel a task and permanently discard its worktree and temporary branch. ${runIDNote}`,
      { request_id: stringSchema(), run_id: stringSchema(), task_id: stringSchema() },
      ["request_id", "task_id"],
    ),
    tool(
      "discard_team",
      `Cancel a TeamRun and permanently discard all task and integration worktrees and branches. Completed runs keep their status; only leftover workspaces are swept. ${runIDNote}`,
      { request_id: stringSchema(), run_id: stringSchema() },
      ["request_id"],
    ),
    tool(
      "archive_team",
      `Archive a finished TeamRun: it moves to the archived section of the list and stays fully recoverable via unarchive_team. ${runIDNote}`,
      { request_id: stringSchema(), run_id: stringSchema() },
      ["request_id"],
    ),
    tool(
      "unarchive_team",
      `Restore an archived TeamRun back to the active list. ${runIDNote}`,
      { request_id: stringSchema(), run_id: stringSchema() },
      ["request_id"],
    ),
  ];
}

export function contextToolList(): Tool[] {
  return [
    {
      name: "get_team_context",
      description:
        "Fetch this run's latest redacted status summary (bounded to 16 KiB) with per-task digests and dependency report availability.",
      inputSchema: {
        type: "object",
        properties: { request_id: stringSchema() },
        required: ["request_id"],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_task_report",
      description: "Fetch one dependency task's full redacted report (bounded to 64 KiB) by task_id.",
      inputSchema: {
        type: "object",
        properties: { request_id: stringSchema(), task_id: stringSchema() },
        required: ["request_id", "task_id"],
      },
      annotations: { readOnlyHint: true },
    },
  ];
}

// MARK: - Dispatchers

type Arguments = Record<string, unknown>;

function requireString(arguments_: Arguments, key: string): string {
  const value = arguments_[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidParamsError(`Missing string argument: ${key}`);
  }
  return value;
}

function optionalString(arguments_: Arguments, key: string): string | undefined {
  const value = arguments_[key];
  return typeof value === "string" ? value : undefined;
}

/** Optional per-task model override: trim, empty → null (per-kind setting applies). */
function optionalModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function optionalInteger(arguments_: Arguments, key: string): number | undefined {
  const value = arguments_[key];
  return typeof value === "number" ? value : undefined;
}

function requireUUID(arguments_: Arguments, key: string): string {
  const value = arguments_[key];
  if (typeof value !== "string" || !isUUID(value)) {
    throw new InvalidParamsError(`Invalid UUID argument: ${key}`);
  }
  return value;
}

function optionalUUID(arguments_: Arguments, key: string): string | null {
  const value = arguments_[key];
  if (value == null) return null;
  if (typeof value !== "string" || !isUUID(value)) {
    throw new InvalidParamsError(`Invalid UUID argument: ${key}`);
  }
  return value;
}

function uuidArray(arguments_: Arguments, key: string): string[] {
  const value = arguments_[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item !== "string" || !isUUID(item)) {
      throw new InvalidParamsError("Invalid dependency UUID");
    }
    return item;
  });
}

class InvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidParamsError";
  }
}

/**
 * Explicit run_id wins (cross-session access stays possible); when omitted,
 * the call targets the owning session's active TeamRun.
 */
async function resolveRunID(
  service: AgentTeamServicePortLike,
  arguments_: Arguments,
  sessionID: string,
): Promise<string> {
  const explicit = arguments_.run_id;
  if (explicit != null) {
    if (typeof explicit !== "string" || !isUUID(explicit)) {
      throw new InvalidParamsError("Invalid UUID argument: run_id");
    }
    return explicit;
  }
  const runID = await service.activeRunIDForSession(sessionID);
  if (runID == null) {
    throw new InvalidParamsError(
      "run_id omitted, but this session has no active TeamRun; call start_team first or pass run_id explicitly.",
    );
  }
  return runID;
}

async function dispatchTool(
  service: AgentTeamServicePortLike,
  git: GitPort,
  name: string,
  arguments_: Arguments,
  sessionID: string,
  defaultMaxConcurrentTasks: (() => number) | null = null,
): Promise<string> {
  switch (name) {
    case "start_team": {
      const requestID = requireString(arguments_, "request_id");
      const repositoryPath = requireString(arguments_, "repository_path");
      const inspection = await git.inspect(repositoryPath);
      const baseline = optionalString(arguments_, "baseline_commit") ?? inspection.head;
      const targetBranch = optionalString(arguments_, "target_branch") ?? inspection.branchName ?? "";
      const result = await service.startTeam({
        requestID,
        sessionID,
        repositoryPath,
        task: requireString(arguments_, "task"),
        baselineCommit: baseline,
        targetBranch,
        maxConcurrentTasks:
          optionalInteger(arguments_, "max_concurrent_tasks") ??
          defaultMaxConcurrentTasks?.() ??
          DEFAULT_MAX_CONCURRENT_TASKS,
        maxReviewRounds: optionalInteger(arguments_, "max_review_rounds") ?? 5,
      });
      return stableStringify(result);
    }
    case "delegate_task": {
      const agentKind = requireString(arguments_, "agent_kind");
      const executionMode = requireString(arguments_, "execution_mode");
      if (agentKind !== "claude_code" && agentKind !== "codex") {
        throw new InvalidParamsError("Unsupported agent_kind. Use claude_code or codex.");
      }
      if (executionMode !== "read_only" && executionMode !== "workspace_write") {
        throw new InvalidParamsError("Unsupported execution_mode. Use read_only or workspace_write.");
      }
      const result = await service.delegateTask({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
        title: requireString(arguments_, "title"),
        prompt: requireString(arguments_, "prompt"),
        agentKind,
        model: optionalModel(arguments_.model),
        executionMode,
        dependencies: uuidArray(arguments_, "dependencies"),
      });
      return stableStringify(result);
    }
    case "delegate_tasks": {
      const tasks = taskItems(arguments_.tasks);
      const result = await service.delegateTasks({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
        contextSummary: requireString(arguments_, "context_summary"),
        tasks,
      });
      return stableStringify(result);
    }
    case "wait_for_report": {
      const result = await service.waitForReport(
        await resolveRunID(service, arguments_, sessionID),
        requireUUID(arguments_, "task_id"),
        45,
      );
      return stableStringify(result);
    }
    case "join_tasks": {
      const batchID = optionalUUID(arguments_, "batch_id");
      const taskIDs = uuidArray(arguments_, "task_ids");
      if ((batchID != null) === (taskIDs.length > 0)) {
        throw new InvalidParamsError("Provide exactly one of batch_id or task_ids.");
      }
      const timeout = Math.min(45, Math.max(0, optionalInteger(arguments_, "timeout_seconds") ?? 45));
      const result = await service.joinTasks({
        runID: await resolveRunID(service, arguments_, sessionID),
        batchID,
        taskIDs,
        timeoutSeconds: timeout,
      });
      return stableStringify(result);
    }
    case "get_task_review_context": {
      const runID = await resolveRunID(service, arguments_, sessionID);
      const taskID = requireUUID(arguments_, "task_id");
      const context = await service.getTaskReviewContext(runID, taskID);
      // Spec 002 section B: append unresolved findings (open comment digests)
      // and the delivery summary when the Review Center service is wired.
      if (service.reviewCenter == null) {
        return stableStringify(context);
      }
      const unresolvedFindings = await service.reviewCenter.unresolvedFindings(runID, taskID);
      const deliverySummary = await service.reviewCenter.getDeliverySummary(runID, taskID);
      return stableStringify({ ...context, unresolvedFindings, deliverySummary });
    }
    case "get_task_execution_log": {
      const result = await service.getTaskExecutionLog(
        await resolveRunID(service, arguments_, sessionID),
        requireUUID(arguments_, "task_id"),
        optionalInteger(arguments_, "after_sequence") ?? null,
      );
      return stableStringify(result);
    }
    case "request_rework":
    case "accept_task":
    case "block_task": {
      const verdict = name === "request_rework" ? "REWORK" : name === "accept_task" ? "PASS" : "BLOCKED";
      const input = {
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
        taskID: requireUUID(arguments_, "task_id"),
        reviewer: "codex",
        verdict: verdict as "PASS" | "REWORK" | "BLOCKED",
        summary: requireString(arguments_, "summary"),
        findings: findings(arguments_.findings),
      };
      if (name === "request_rework") {
        return stableStringify(await service.requestRework(input));
      }
      if (name === "accept_task") {
        return stableStringify(await service.acceptTask(input));
      }
      return stableStringify(await service.blockTask(input));
    }
    case "get_task_diff": {
      const review = requireReviewCenter(service);
      const side = diffSide(arguments_);
      const runID = await resolveRunID(service, arguments_, sessionID);
      const taskID = requireUUID(arguments_, "task_id");
      const path = optionalString(arguments_, "path");
      const page =
        path == null
          ? null
          : await review.getDiffPage(runID, taskID, side, path, optionalString(arguments_, "cursor") ?? null);
      const tree = await review.getDiffTree(runID, taskID, side);
      return stableStringify({ tree, page });
    }
    case "add_review_comments": {
      const review = requireReviewCenter(service);
      const result = await review.addComments({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
        taskID: requireUUID(arguments_, "task_id"),
        comments: commentInputs(arguments_.comments),
      });
      return stableStringify(result);
    }
    case "request_rework_batch": {
      const review = requireReviewCenter(service);
      const commentIDs = uuidArray(arguments_, "comment_ids");
      if (commentIDs.length === 0) {
        throw new InvalidParamsError("comment_ids must contain at least one comment id.");
      }
      const result = await review.reworkBatch({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
        taskID: requireUUID(arguments_, "task_id"),
        commentIDs,
        summary: requireString(arguments_, "summary"),
      });
      return stableStringify(result);
    }
    case "resume_task": {
      const result = await service.resumeTask({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
        taskID: requireUUID(arguments_, "task_id"),
      });
      return stableStringify(result);
    }
    case "get_team_status": {
      return stableStringify(await service.getTeamStatus(await resolveRunID(service, arguments_, sessionID)));
    }
    case "get_team_review_context": {
      return stableStringify(await service.getTeamReviewContext(await resolveRunID(service, arguments_, sessionID)));
    }
    case "complete_team": {
      const rawVerdict = requireString(arguments_, "final_verdict");
      const verdict: "PASS" | "REWORK" | "BLOCKED" =
        rawVerdict === "PASS" ? "PASS" : rawVerdict === "REWORK" ? "REWORK" : "BLOCKED";
      const result = await service.completeTeam({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
        finalVerdict: verdict,
        summary: requireString(arguments_, "summary"),
      });
      return stableStringify(result);
    }
    case "cancel_task": {
      const result = await service.cancelTask({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
        taskID: requireUUID(arguments_, "task_id"),
      });
      return stableStringify(result);
    }
    case "cancel_team": {
      const result = await service.cancelTeam({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
      });
      return stableStringify(result);
    }
    case "discard_task": {
      const result = await service.discardTask({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
        taskID: requireUUID(arguments_, "task_id"),
      });
      return stableStringify(result);
    }
    case "discard_team": {
      const result = await service.discardTeam({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
      });
      return stableStringify(result);
    }
    case "archive_team": {
      const runID = await resolveRunID(service, arguments_, sessionID);
      await service.archiveTeam({ requestID: requireString(arguments_, "request_id"), runID });
      return stableStringify({ runID, archived: true });
    }
    case "unarchive_team": {
      const runID = await resolveRunID(service, arguments_, sessionID);
      await service.unarchiveTeam({ requestID: requireString(arguments_, "request_id"), runID });
      return stableStringify({ runID, archived: false });
    }
    default:
      throw new Error(`Method not found: ${name}`);
  }
}

async function dispatchContextTool(
  session: RestrictedSession,
  service: ContextFetchService,
  name: string,
  arguments_: Arguments,
): Promise<string> {
  const requestID = requireString(arguments_, "request_id");
  switch (name) {
    case "get_team_context": {
      const digest = await service.fetchTeamContext(session.runID, session.taskID, requestID);
      return stableStringify(digest);
    }
    case "get_task_report": {
      const payload = await service.fetchTaskReport(
        session.runID,
        session.taskID,
        requireUUID(arguments_, "task_id"),
        requestID,
      );
      return stableStringify(payload);
    }
    default:
      throw new Error(`Method not found: ${name}`);
  }
}

function taskItems(value: unknown): import("../domain/repositoryPort").DelegateTaskItemInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidParamsError("tasks must contain at least one task object");
  }
  return value.map((item) => {
    if (typeof item !== "object" || item == null || Array.isArray(item)) {
      throw new InvalidParamsError("Each task must be an object");
    }
    const object = item as Arguments;
    const clientKey = requiredObjectString(object, "client_key");
    const title = requiredObjectString(object, "title");
    const prompt = requiredObjectString(object, "prompt");
    const rawAgent = object.agent_kind;
    if (rawAgent !== "claude_code" && rawAgent !== "codex") {
      throw new InvalidParamsError("Unsupported or missing task agent_kind");
    }
    const rawMode = object.execution_mode;
    if (rawMode !== "read_only" && rawMode !== "workspace_write") {
      throw new InvalidParamsError("Unsupported or missing task execution_mode");
    }
    const parentTask = reference(object.parent_task);
    const dependencies = Array.isArray(object.dependencies)
      ? object.dependencies.map((dependency) => reference(dependency)).filter((d): d is NonNullable<typeof d> => d != null)
      : [];
    return {
      clientKey,
      title,
      prompt,
      agentKind: rawAgent,
      model: optionalModel(object.model),
      executionMode: rawMode,
      parentTask,
      dependencies,
    };
  });
}

function reference(value: unknown): import("../domain/repositoryPort").TaskReference | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidParamsError("Task reference must be an object");
  }
  const object = value as Arguments;
  let taskID: string | null = null;
  if (typeof object.task_id === "string") {
    if (!isUUID(object.task_id)) {
      throw new InvalidParamsError("Invalid task_id reference");
    }
    taskID = object.task_id;
  }
  const clientKey = typeof object.client_key === "string" ? object.client_key : null;
  const result = { taskID, clientKey };
  if ((result.taskID == null) === (result.clientKey == null)) {
    throw new InvalidParamsError("A task reference requires exactly one of task_id or client_key");
  }
  return result;
}

function requiredObjectString(object: Arguments, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidParamsError(`Missing string field: ${key}`);
  }
  return value;
}

function findings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const mapped: (ReviewFinding | null)[] = value.map((item): ReviewFinding | null => {
    if (typeof item !== "object" || item == null || Array.isArray(item)) return null;
    const object = item as Arguments;
    const evidence = object.evidence;
    if (typeof evidence !== "string") return null;
    const severity = typeof object.severity === "string" ? object.severity : "medium";
    const finding: ReviewFinding = {
      id: randomReviewFindingID(),
      taskID: null,
      severity: (["blocker", "high", "medium", "low", "info"].includes(severity)
        ? severity
        : "medium") as ReviewFinding["severity"],
      file: typeof object.file === "string" ? object.file : null,
      line: typeof object.line === "number" ? object.line : null,
      evidence,
      expectedFix: typeof object.expected_fix === "string" ? object.expected_fix : null,
    };
    return finding;
  });
  return mapped.filter((finding): finding is ReviewFinding => finding != null);
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Review Center tools share the team service port; until appEnvironment wires the instance they answer with a readable error. */
function requireReviewCenter(service: AgentTeamServicePortLike): ReviewCenterService {
  if (service.reviewCenter == null) {
    throw new Error("Review Center tools are unavailable: the reviewCenter service is not wired in this build.");
  }
  return service.reviewCenter;
}

function diffSide(arguments_: Arguments): GitDiffSide {
  const side = requireString(arguments_, "side");
  if (side !== "baseline" && side !== "worktree" && side !== "integration") {
    throw new InvalidParamsError("Unsupported side. Use baseline, worktree, or integration.");
  }
  return side;
}

/** snake_case tool comments → ReviewCommentInput; semantic anchor validation stays in the service. */
function commentInputs(value: unknown): ReviewCommentInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidParamsError("comments must contain at least one comment object");
  }
  return value.map((item) => {
    if (typeof item !== "object" || item == null || Array.isArray(item)) {
      throw new InvalidParamsError("Each comment must be an object");
    }
    const object = item as Arguments;
    const lineStart = object.line_start;
    if (typeof lineStart !== "number" || !Number.isInteger(lineStart)) {
      throw new InvalidParamsError("Comment line_start must be an integer");
    }
    const rawLineEnd = object.line_end;
    if (rawLineEnd != null && (typeof rawLineEnd !== "number" || !Number.isInteger(rawLineEnd))) {
      throw new InvalidParamsError("Comment line_end must be an integer when present");
    }
    const rawSeverity = object.severity;
    const severity = typeof rawSeverity === "string" ? rawSeverity : undefined;
    if (severity != null && severity !== "info" && severity !== "risk") {
      throw new InvalidParamsError("Unsupported comment severity. Use info or risk.");
    }
    return {
      file: requiredObjectString(object, "file"),
      lineStart,
      lineEnd: rawLineEnd ?? undefined,
      body: requiredObjectString(object, "body"),
      severity,
    };
  });
}

export { randomUUID };
