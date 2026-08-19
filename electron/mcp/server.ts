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
import type { QualityGateService } from "../application/qualityGateService";
import type { ReviewModeService } from "../application/reviewModeService";
import type { RecoveryService } from "../application/recoveryService";
import type { DoctorService } from "../application/doctorService";
import type { GateConfigInput } from "../domain/policy";
import { CHILD_AGENT_KINDS, type ChildAgentKind } from "../domain/models";
import { TaskEventHub } from "../domain/events";
import type { TaskEventUpdate } from "../domain/events";
import { OctoPunkContextServer } from "../application/ports";
import { stableStringify } from "../domain/events";
import { GATE_REVIEW_MODES, type GateReviewMode, type ReviewFinding } from "../domain/models";
import { DOCTOR_TRIGGERED_BY, RUN_PRIORITY_MIN, RUN_PRIORITY_MAX } from "../domain/models";
import type { DoctorTriggeredBy } from "../domain/models";
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
    /** Quality Gate service; when present the gate tools become available. */
    qualityGate?: QualityGateService | null;
    /** Review Mode service; when present the review/arbitration tools become available. */
    reviewModes?: ReviewModeService | null;
    /**
     * Workbench six-section aggregate service; when present the get_workbench
     * tool becomes available (same instance the IPC channel uses).
     */
    workbench?: AgentTeamServicePortLike["workbench"];
    /** Recovery service; when present the recovery tools become available. */
    recovery?: RecoveryService | null;
    /**
     * Doctor service; when present the doctor tools become available and
     * start_team consults its prestart blockers.
     */
    doctor?: DoctorService | null;
  }) {
    // Prototype-chain delegation keeps reads live against the underlying
    // service instance while exposing the optional reviewCenter field.
    this.service = Object.create(input.service) as AgentTeamServicePortLike;
    this.service.reviewCenter = input.reviewCenter ?? undefined;
    // Same delegation pattern for the gate service (see reviewCenter above).
    this.service.qualityGate = input.qualityGate ?? undefined;
    // Same delegation pattern for the review mode service (see above).
    this.service.reviewModes = input.reviewModes ?? undefined;
    // Same delegation pattern for the workbench aggregate service (see above).
    this.service.workbench = input.workbench ?? undefined;
    // Same delegation pattern for the recovery / doctor services (see above).
    this.service.recovery = input.recovery ?? undefined;
    this.service.doctor = input.doctor ?? undefined;
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
function booleanSchema(): Record<string, unknown> {
  return { type: "boolean" };
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
        interactive: booleanSchema(),
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
/** One command check (tests/lint/typecheck/build); null = check disabled. */
function gateCommandConfigSchema(): Record<string, unknown> {
  return {
    type: ["object", "null"],
    properties: { command: stringSchema(), timeoutSeconds: integerSchema() },
    required: ["command"],
  };
}
/**
 * Gate config payload (contracts A 节 set_gate_config):camelCase keys, the
 * domain GateConfigInput shape verbatim; partial fields = no override and
 * contradictory combinations are rejected by the domain policy on save.
 */
function gateConfigSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      checks: {
        type: "object",
        properties: {
          tests: gateCommandConfigSchema(),
          lint: gateCommandConfigSchema(),
          typecheck: gateCommandConfigSchema(),
          build: gateCommandConfigSchema(),
        },
      },
      maxRiskFindings: integerSchema(),
      scopeAllowedPaths: arraySchema(),
      requireDependenciesAccepted: { type: "boolean" },
      requireTargetBaselineSafe: { type: "boolean" },
      requiredReviewers: arraySchema(),
      manualConfirmHighRisk: { type: "boolean" },
      requireTodoClean: { type: "boolean" },
      reviewMode: stringSchema(),
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
        interactive: booleanSchema(),
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
      "set_gate_config",
      "Save the project's default quality gate config (frozen into each run's snapshot at start_team). Contradictory combinations are rejected.",
      {
        request_id: stringSchema(),
        repository_path: stringSchema(),
        config: gateConfigSchema(),
      },
      ["request_id", "repository_path", "config"],
    ),
    tool(
      "run_quality_gate",
      `Run the quality gate evaluation for one task and persist the per-check details (a re-run creates a fresh evaluation). ${runIDNote}`,
      {
        request_id: stringSchema(),
        run_id: stringSchema(),
        task_id: stringSchema(),
      },
      ["request_id", "task_id"],
    ),
    tool(
      "waive_gate_item",
      "Waive one failed gate item (identified by evaluation_id + item_id) with a mandatory reason; once every fail item is waived the evaluation's overall becomes waived.",
      {
        request_id: stringSchema(),
        evaluation_id: stringSchema(),
        item_id: stringSchema(),
        reason: stringSchema(),
      },
      ["request_id", "evaluation_id", "item_id", "reason"],
    ),
    tool(
      "run_review",
      `Dispatch read-only reviewers for one task per the review mode (standard | cross_model | dual_readonly | contest | role_based | arbitration; default = the run's effective gate config), wait until every reviewer reports or the collect timeout, then return the recorded arbitration (consensus/disagreements/to_verify/auto_passed). standard dispatches no reviewers and returns a notice instead. ${runIDNote}`,
      {
        request_id: stringSchema(),
        run_id: stringSchema(),
        task_id: stringSchema(),
        mode: stringSchema(),
        contest_models: arraySchema(),
        collect_timeout_seconds: integerSchema(),
      },
      ["request_id", "task_id"],
    ),
    tool(
      "get_arbitration",
      `Read the latest recorded arbitration (consensus / disagreements / to_verify / auto_passed) for one task, or null when none exists. ${runIDNote}`,
      { run_id: stringSchema(), task_id: stringSchema() },
      ["task_id"],
    ),
    tool(
      "create_pr",
      `Create a GitHub PR for one reviewed task through the local gh CLI (head = the task branch, base = the run's target branch; requires the GitHub feedback switch in Settings, default off — gh missing / not authenticated returns a readable error and never affects local review). ${runIDNote}`,
      {
        request_id: stringSchema(),
        run_id: stringSchema(),
        task_id: stringSchema(),
        title: stringSchema(),
        body: stringSchema(),
      },
      ["request_id", "task_id"],
    ),
    tool(
      "get_pr_status",
      `Read the task's linked PR state, status-check rollup and latest redacted comments (null when no PR is linked; a gh failure returns a readable error). ${runIDNote}`,
      { run_id: stringSchema(), task_id: stringSchema() },
      ["task_id"],
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
      "pause_team",
      `Pause a TeamRun: new quota grants stop while in-flight tasks continue; queued tasks stay queued with reason run_paused. Returns the updated run (priority/pausedAt included). ${runIDNote}`,
      { request_id: stringSchema(), run_id: stringSchema() },
      ["request_id"],
    ),
    tool(
      "resume_team",
      `Resume a paused TeamRun: queued tasks continue by priority. Returns the updated run (priority/pausedAt included). ${runIDNote}`,
      { request_id: stringSchema(), run_id: stringSchema() },
      ["request_id"],
    ),
    tool(
      "set_run_priority",
      `Set a TeamRun's scheduling priority (integer ${RUN_PRIORITY_MIN}..${RUN_PRIORITY_MAX}, higher = earlier quota grants). Returns the updated run (priority/pausedAt included). ${runIDNote}`,
      {
        request_id: stringSchema(),
        run_id: stringSchema(),
        priority: { type: "integer", minimum: RUN_PRIORITY_MIN, maximum: RUN_PRIORITY_MAX },
      },
      ["request_id", "priority"],
    ),
    tool(
      "get_workbench",
      "Read the six-section workbench aggregate across active TeamRuns (running, queued, awaiting_input, failed, awaiting_review, integratable); queued entries carry their queue reason.",
      {},
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
    tool(
      "get_recovery_status",
      "Read the crash-recovery view: process reconciliation of running tasks (dead / reused / alive-but-detached / unknown), orphan worktrees and orphan branches under the OctoPunk managed roots. Read-only — no task is ever auto-failed; every recovery action stays behind explicit human confirmation.",
      { run_id: stringSchema() },
      [],
    ),
    tool(
      "rerun_task",
      `Rerun a failed/blocked/cancelled task node: flips it back to queued through the normal dependency gate; include_downstream additionally resumes blocked descendants (queued descendants need no reset). Returns the reset tasks. ${runIDNote}`,
      {
        request_id: stringSchema(),
        run_id: stringSchema(),
        task_id: stringSchema(),
        include_downstream: { type: "boolean", description: "Default false." },
      },
      ["request_id", "task_id"],
    ),
    tool(
      "run_doctor",
      "Run the nine-check environment doctor (agent CLIs, GUI PATH, login state, MCP stdio self-launch, git repo state, worktree disk, sandbox, provider quota, database health). Each item has its own timeout and degrades to unknown instead of failing the whole report.",
      {
        request_id: stringSchema(),
        repository_path: stringSchema(),
        triggered_by: { type: "string", enum: [...DOCTOR_TRIGGERED_BY], description: "Default user." },
      },
      ["request_id"],
    ),
    tool(
      "get_doctor_report",
      "Read the most recent doctor report for one repository (omit repository_path for the global report), or null when none exists yet.",
      { repository_path: stringSchema() },
      [],
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

/** agent_kind 校验(领域常量为单一事实源,新增 Provider 自动放行)。 */
function isChildAgentKind(value: string): value is ChildAgentKind {
  return (CHILD_AGENT_KINDS as readonly string[]).includes(value);
}

function requireString(arguments_: Arguments, key: string): string {  const value = arguments_[key];
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
      // 体检预启动拦截(specs/001-v03 FR-014 / T023):「注定失败」级阻塞项
      // (仓库不可用 / 全部 CLI 不可用)在排队前拒绝并列出中文原因;探测
      // 超时按「无法确认」放行,交给完整体检呈现。doctor 未接线时不拦截。
      if (service.doctor != null) {
        const blockers = await service.doctor.prestartBlockers(repositoryPath);
        if (blockers.length > 0) {
          throw new Error(
            `start_team 已被体检查出注定失败的原因而拒绝:${blockers.join(";")}。请先运行 run_doctor 查看完整诊断。`,
          );
        }
      }
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
      if (!isChildAgentKind(agentKind)) {
        throw new InvalidParamsError(
          `Unsupported agent_kind. Use one of: ${CHILD_AGENT_KINDS.join(", ")}.`,
        );
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
        // 交互槽标记(specs/001-v03 T026):缺省 false,共享配额。
        interactive: arguments_.interactive === true,
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
      const runID = await resolveRunID(service, arguments_, sessionID);
      const input = {
        requestID: requireString(arguments_, "request_id"),
        runID,
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
        const accepted = await service.acceptTask(input);
        // 契约 B 节:accept 成功后自动生成交付摘要;失败只吞掉,不影响 accept 的
        // 返回(摘要在 get_task_review_context 中按需读取)。注意 accept 的门禁
        // 拦截已在 service 层(T017)完成,此处错误透传为 isError,无需重复判定。
        if (service.reviewCenter != null) {
          await service.reviewCenter
            .generateDeliverySummary({ runID, taskID: input.taskID, verdict: "PASS" })
            .catch(() => null);
        }
        return stableStringify(accepted);
      }
      return stableStringify(await service.blockTask(input));
    }
    case "set_gate_config": {
      const gate = requireQualityGate(service);
      const config = gateConfigInput(arguments_.config);
      await gate.saveProjectDefault(
        requireString(arguments_, "request_id"),
        requireString(arguments_, "repository_path"),
        config,
      );
      return stableStringify(config);
    }
    case "run_quality_gate": {
      const gate = requireQualityGate(service);
      const evaluation = await gate.evaluate({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
        taskID: requireUUID(arguments_, "task_id"),
      });
      return stableStringify(evaluation);
    }
    case "waive_gate_item": {
      const gate = requireQualityGate(service);
      const evaluation = await gate.waive({
        requestID: requireString(arguments_, "request_id"),
        evaluationID: requireUUID(arguments_, "evaluation_id"),
        itemID: requireUUID(arguments_, "item_id"),
        // 豁免主体:dispatch 里的 sessionID 只用于定位 active run,不是稳定身份;
        // MCP 侧的主 Agent 即 Codex,与 review 决策的 reviewer="codex" 保持一致。
        waivedBy: "codex",
        waivedReason: requireString(arguments_, "reason"),
      });
      return stableStringify(evaluation);
    }
    case "run_review": {
      const reviewModes = requireReviewModes(service);
      const runID = await resolveRunID(service, arguments_, sessionID);
      const taskID = requireUUID(arguments_, "task_id");
      // 契约不变量 2:变更类调用携带 request_id;幂等由 dispatchReview 内部
      // 确定性派生的 requestID(review:<mode>:<taskID>:<i> + 响应缓存)承担。
      requireString(arguments_, "request_id");
      const dispatch = await reviewModes.dispatchReview({
        runID,
        taskID,
        mode: optionalReviewMode(arguments_, "mode"),
        contestModels: stringArray(arguments_, "contest_models"),
      });
      if (dispatch.reviewTaskIDs.length === 0) {
        return stableStringify({
          mode: dispatch.mode,
          reviewTaskIDs: [],
          arbitration: null,
          note: "standard 模式不派发审查任务:走既有常规审查流(门禁检查 + 行级评论 + accept/rework)。",
        });
      }
      // 轮询至全部审查任务到达可收集状态(报告就绪/待返工/终态)或超时;
      // 到齐后再 collectArbitration(其内部等待立即返回)。超时则不落库,
      // 返回可读提示——重放 run_review 派发幂等,可安全重试。
      const timeoutSeconds = clampCollectTimeoutSeconds(
        optionalInteger(arguments_, "collect_timeout_seconds"),
      );
      const deadline = Date.now() + timeoutSeconds * 1000;
      let allArrived = false;
      for (;;) {
        allArrived = await reviewTasksArrived(reviewModes, runID, taskID, dispatch.reviewTaskIDs);
        if (allArrived || Date.now() + RUN_REVIEW_POLL_INTERVAL_MS > deadline) break;
        await sleep(RUN_REVIEW_POLL_INTERVAL_MS);
      }
      if (!allArrived) {
        return stableStringify({
          mode: dispatch.mode,
          reviewTaskIDs: dispatch.reviewTaskIDs,
          arbitration: null,
          note: `审查任务未在 ${timeoutSeconds}s 内全部到达;重放 run_review(派发幂等)等待剩余审查,或待其完成后用 get_arbitration 读取仲裁结论。`,
        });
      }
      const arbitration = await reviewModes.collectArbitration({
        runID,
        taskID,
        reviewTaskIDs: dispatch.reviewTaskIDs,
      });
      return stableStringify({ mode: dispatch.mode, reviewTaskIDs: dispatch.reviewTaskIDs, arbitration });
    }
    case "get_arbitration": {
      const reviewModes = requireReviewModes(service);
      const runID = await resolveRunID(service, arguments_, sessionID);
      const taskID = requireUUID(arguments_, "task_id");
      return stableStringify(await reviewModes.getArbitration(runID, taskID));
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
    case "create_pr": {
      // GitHub PR 回灌(specs/002-v04 US4 / 契约 A 节):gh 未启用/未安装/未登录
      // 的 GhCliError 携带中文可读消息,直接透传为 isError,不影响其他工具。
      // request_id 为契约要求的幂等语义:gh 的"already exists"分支 + savePrLink
      // UPSERT 使重放收敛到同一 PR。
      const review = requireReviewCenter(service);
      requireString(arguments_, "request_id");
      const result = await review.createPrForTask({
        runID: await resolveRunID(service, arguments_, sessionID),
        taskID: requireUUID(arguments_, "task_id"),
        title: optionalString(arguments_, "title"),
        body: optionalString(arguments_, "body"),
      });
      return stableStringify({ pr_url: result.url, pr_number: result.number });
    }
    case "get_pr_status": {
      const review = requireReviewCenter(service);
      const refreshed = await review.refreshPrStatus({
        runID: await resolveRunID(service, arguments_, sessionID),
        taskID: requireUUID(arguments_, "task_id"),
      });
      if (refreshed == null) return stableStringify(null);
      return stableStringify({ link: refreshed.link, status: refreshed.status });
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
      const runID = await resolveRunID(service, arguments_, sessionID);
      const status = await service.getTeamStatus(runID);
      // v0.3 扩展(interfaces.md A 节):queueReasons 只保留仍在排队的任务原因
      // (getQueueReasons 仅含被闸门拒绝的在册条目,此处按任务状态再过滤一次);
      // 未接线时降级为空列表,不影响既有 get_team_status 输出。
      const queuedTaskIDs = new Set(
        status.tasks.filter((task) => task.status === "queued").map((task) => task.id),
      );
      const queueReasons =
        service.getQueueReasons == null
          ? []
          : service.getQueueReasons(runID).filter((entry) => queuedTaskIDs.has(entry.taskID));
      // priority/pausedAt 透传自 run 序列化(TeamRunDTO 未含字段时 stableStringify
      // 省略该键;DTO 补齐字段后此处零改动即生效)。
      const { priority, pausedAt } = status.run as { priority?: number; pausedAt?: number | null };
      return stableStringify({ ...status, priority, pausedAt, queueReasons });
    }
    case "pause_team": {
      if (service.pauseRun == null) {
        throw new Error("pause_team is unavailable: the team service does not expose run control in this build.");
      }
      const run = await service.pauseRun({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
      });
      return stableStringify(run);
    }
    case "resume_team": {
      if (service.resumeRun == null) {
        throw new Error("resume_team is unavailable: the team service does not expose run control in this build.");
      }
      const run = await service.resumeRun({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
      });
      return stableStringify(run);
    }
    case "set_run_priority": {
      if (service.setRunPriority == null) {
        throw new Error("set_run_priority is unavailable: the team service does not expose run control in this build.");
      }
      const rawPriority = arguments_.priority;
      if (
        typeof rawPriority !== "number" ||
        !Number.isInteger(rawPriority) ||
        rawPriority < RUN_PRIORITY_MIN ||
        rawPriority > RUN_PRIORITY_MAX
      ) {
        throw new InvalidParamsError(
          `priority must be an integer between ${RUN_PRIORITY_MIN} and ${RUN_PRIORITY_MAX} (got ${
            typeof rawPriority === "number" ? rawPriority : JSON.stringify(rawPriority) ?? "missing"
          }).`,
        );
      }
      const run = await service.setRunPriority({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
        priority: rawPriority,
      });
      return stableStringify(run);
    }
    case "get_workbench": {
      const workbench = requireWorkbench(service);
      return stableStringify(await workbench.summary());
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
    case "get_recovery_status": {
      const recovery = requireRecovery(service);
      const runID = optionalUUID(arguments_, "run_id");
      return stableStringify(await recovery.scan(runID == null ? undefined : { runID }));
    }
    case "rerun_task": {
      const recovery = requireRecovery(service);
      const rawDownstream = arguments_.include_downstream;
      if (rawDownstream != null && typeof rawDownstream !== "boolean") {
        throw new InvalidParamsError("include_downstream must be a boolean (default false).");
      }
      const tasks = await recovery.rerunTask({
        requestID: requireString(arguments_, "request_id"),
        runID: await resolveRunID(service, arguments_, sessionID),
        taskID: requireUUID(arguments_, "task_id"),
        includeDownstream: rawDownstream === true,
      });
      return stableStringify(tasks);
    }
    case "run_doctor": {
      const doctor = requireDoctor(service);
      const rawTrigger = optionalString(arguments_, "triggered_by") ?? "user";
      if (!(DOCTOR_TRIGGERED_BY as readonly string[]).includes(rawTrigger)) {
        throw new InvalidParamsError(
          `Unsupported triggered_by. Use one of: ${DOCTOR_TRIGGERED_BY.join(", ")}.`,
        );
      }
      const report = await doctor.runCheckup({
        requestID: requireString(arguments_, "request_id"),
        repositoryPath: optionalString(arguments_, "repository_path") ?? null,
        triggeredBy: rawTrigger as DoctorTriggeredBy,
      });
      return stableStringify(report);
    }
    case "get_doctor_report": {
      const doctor = requireDoctor(service);
      return stableStringify(await doctor.latestReport(optionalString(arguments_, "repository_path") ?? null));
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
    if (typeof rawAgent !== "string" || !isChildAgentKind(rawAgent)) {
      throw new InvalidParamsError(
        `Unsupported or missing task agent_kind. Use one of: ${CHILD_AGENT_KINDS.join(", ")}.`,
      );
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
      // 交互槽标记(specs/001-v03 T026):缺省 false,共享配额。
      interactive: object.interactive === true,
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

/** Gate tools share the team service port; until appEnvironment wires the instance they answer with a readable error. */
function requireQualityGate(service: AgentTeamServicePortLike): QualityGateService {
  if (service.qualityGate == null) {
    throw new Error("Quality gate tools are unavailable: the qualityGate service is not wired in this build.");
  }
  return service.qualityGate;
}

/** Review Mode tools share the team service port; until appEnvironment wires the instance they answer with a readable error. */
function requireReviewModes(service: AgentTeamServicePortLike): ReviewModeService {
  if (service.reviewModes == null) {
    throw new Error("Review mode tools are unavailable: the reviewModes service is not wired in this build.");
  }
  return service.reviewModes;
}

/**
 * Workbench aggregate shares the team service port (structural `{ summary }`
 * port); until appEnvironment wires the instance the tool answers with a
 * readable error instead of failing to build.
 */
function requireWorkbench(service: AgentTeamServicePortLike): NonNullable<AgentTeamServicePortLike["workbench"]> {
  if (service.workbench == null) {
    throw new Error("Workbench tool is unavailable: the workbench service is not wired in this build.");
  }
  return service.workbench;
}

/** Recovery tools share the team service port; until appEnvironment wires the instance they answer with a readable error. */
function requireRecovery(service: AgentTeamServicePortLike): RecoveryService {
  if (service.recovery == null) {
    throw new Error("Recovery tools are unavailable: the recovery service is not wired in this build.");
  }
  return service.recovery;
}

/** Doctor tools share the team service port; until appEnvironment wires the instance they answer with a readable error. */
function requireDoctor(service: AgentTeamServicePortLike): DoctorService {
  if (service.doctor == null) {
    throw new Error("Doctor tools are unavailable: the doctor service is not wired in this build.");
  }
  return service.doctor;
}

/** run_review 的轮询节奏(与 ReviewModeService.collectArbitration 内部节奏一致)。 */
const RUN_REVIEW_POLL_INTERVAL_MS = 5_000;

/** run_review 的收集等待窗口:60–600s,缺省 300s。 */
function clampCollectTimeoutSeconds(value: number | undefined): number {
  return Math.min(600, Math.max(60, Math.round(value ?? 300)));
}

/** 可选 mode 参数:六值枚举(GATE_REVIEW_MODES),非法值给可读错误。 */
function optionalReviewMode(arguments_: Arguments, key: string): GateReviewMode | undefined {
  const value = arguments_[key];
  if (value == null) return undefined;
  if (typeof value !== "string" || !(GATE_REVIEW_MODES as readonly string[]).includes(value)) {
    throw new InvalidParamsError(`Unsupported ${key}. Use one of: ${GATE_REVIEW_MODES.join(", ")}.`);
  }
  return value as GateReviewMode;
}

function stringArray(arguments_: Arguments, key: string): string[] {
  const value = arguments_[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** 与 ReviewModeService 的可收集判定同构:报告就绪、待返工或任一终态。 */
function reviewTaskArrived(status: string): boolean {
  return (
    status === "awaiting_report" ||
    status === "rework_required" ||
    status === "accepted" ||
    status === "blocked" ||
    status === "cancelled" ||
    status === "failed"
  );
}

/** 指定审查任务是否全部到达可收集状态(按 latestReviewTasks 快照判定)。 */
async function reviewTasksArrived(
  reviewModes: ReviewModeService,
  runID: string,
  taskID: string,
  reviewTaskIDs: string[],
): Promise<boolean> {
  const reviewTasks = await reviewModes.latestReviewTasks(runID, taskID);
  const statuses = new Map(reviewTasks.map((task) => [task.id, task.status] as const));
  return reviewTaskIDs.every((id) => {
    const status = statuses.get(id);
    return status != null && reviewTaskArrived(status);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** MCP `config` 参数 → 领域 GateConfigInput:结构透传,字段校验(含矛盾组合)留给保存时的领域 policy。 */
function gateConfigInput(value: unknown): GateConfigInput {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new InvalidParamsError("config must be a gate config object");
  }
  return value as GateConfigInput;
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
