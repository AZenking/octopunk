// Port of OctoPunk/OctoPunk/Platform/Claude/CodexAppServerAdapter.swift
// (ChildAgentRegistry + CodexAppServerAdapter + CodexJSONRPCConnection).

import path from "node:path";
import {
  CancellationError,
  ChildAgentDiagnostics,
  ChildAgentExecutionError,
  OctoPunkContextServer,
  type ChildAgentEnvironment,
  type ChildAgentEvent,
  type ChildAgentEventSink,
  type ChildAgentKind,
  type ChildAgentPort,
  type ChildAgentReport,
  type InteractiveProcessPort,
  type InteractiveProcessSession,
  type ProcessPort,
  type ProcessRequest,
} from "../application/ports";

/** Explicit registry: task.agent_kind, not prompt wording, selects the adapter. */
export class ChildAgentRegistry implements ChildAgentPort {
  constructor(
    private readonly claude: ChildAgentPort,
    private readonly codex: ChildAgentPort,
    private readonly pi: ChildAgentPort,
  ) {}

  async start(
    prompt: string,
    environment: ChildAgentEnvironment,
    onEvent: ChildAgentEventSink,
    signal?: AbortSignal,
  ): Promise<ChildAgentReport> {
    return await this.adapter(environment.agentKind).start(prompt, environment, onEvent, signal);
  }

  async resume(
    sessionID: string,
    prompt: string,
    environment: ChildAgentEnvironment,
    onEvent: ChildAgentEventSink,
    signal?: AbortSignal,
  ): Promise<ChildAgentReport> {
    return await this.adapter(environment.agentKind).resume(sessionID, prompt, environment, onEvent, signal);
  }

  async cancel(sessionID: string): Promise<void> {
    // Callers that own a task use the overload below so cancellation cannot
    // cross adapter boundaries.
    await this.claude.cancel(sessionID);
  }

  async cancelKind(sessionID: string, agentKind: ChildAgentKind): Promise<void> {
    await this.adapter(agentKind).cancel(sessionID, agentKind);
  }

  private adapter(kind: ChildAgentKind): ChildAgentPort {
    if (kind === "claude_code") return this.claude;
    if (kind === "pi") return this.pi;
    return this.codex;
  }
}

/** Codex app-server JSON-RPC adapter: one app-server per turn, thread resumed on REWORK. */
export class CodexAppServerAdapter implements ChildAgentPort {
  private readonly executablePath: string;
  // T016:pidOf 挂在 ProcessPort 上,组合根(LocalProcessAdapter)两者都实现。
  private readonly process: InteractiveProcessPort & ProcessPort;
  private readonly sessions = new Map<string, InteractiveProcessSession>();

  constructor(executablePath: string, process_: InteractiveProcessPort & ProcessPort) {
    this.executablePath = executablePath;
    this.process = process_;
  }

  async start(
    prompt: string,
    environment: ChildAgentEnvironment,
    onEvent: ChildAgentEventSink,
    signal?: AbortSignal,
  ): Promise<ChildAgentReport> {
    return await this.run(prompt, null, environment, onEvent, signal);
  }

  async resume(
    sessionID: string,
    prompt: string,
    environment: ChildAgentEnvironment,
    onEvent: ChildAgentEventSink,
    signal?: AbortSignal,
  ): Promise<ChildAgentReport> {
    return await this.run(prompt, sessionID, environment, onEvent, signal);
  }

  async cancel(sessionID: string): Promise<void> {
    const session = this.sessions.get(sessionID);
    if (!session) return;
    this.sessions.delete(sessionID);
    await session.terminate();
  }

  private async run(
    prompt: string,
    resumeThreadID: string | null,
    environment: ChildAgentEnvironment,
    onEvent: ChildAgentEventSink,
    signal?: AbortSignal,
  ): Promise<ChildAgentReport> {
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const processID = crypto.randomUUID();
    await onEvent({ kind: "started", message: "Launching Codex app-server", sessionID: resumeThreadID });
    let processSession: InteractiveProcessSession;
    try {
      const executableDirectory = path.dirname(this.executablePath);
      const request: ProcessRequest = {
        id: processID,
        executable: this.executablePath,
        arguments: codexArguments(environment),
        workingDirectory: environment.worktreeURL,
        environment: {
          OCTOPUNK_CHILD_SANDBOX: "model-service",
          NO_PROXY: "*",
          no_proxy: "*",
          PATH: [executableDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
          ...(environment.contextServer?.environment ?? {}),
        },
      };
      processSession = await this.process.startInteractive(request, controller.signal);
      // T016 PID 上报:started 事件在 spawn 之前发出(见上),无法附带 pid,
      // 因此不挪动它的时序(避免 spawn 失败路径少发 started 的行为变化),而是
      // 在 startInteractive 成功(spawn 已同步完成)之后紧跟发一个携带 pid 的
      // 事件。kind 选 output:中性的执行日志事件,不重复触发 taskStarted。
      // 子进程闪退/判活失败时 pidOf 返回 null,静默跳过。
      const pid = this.process.pidOf(processID);
      if (pid != null) {
        await onEvent({
          kind: "output",
          message: `child process pid ${pid}`,
          sessionID: resumeThreadID,
          pid,
        });
      }
    } catch (error) {
      controller.abort();
      const message = ChildAgentDiagnostics.redact(errorMessage(error), 2048);
      await onEvent({ kind: "failed", message });
      throw new ChildAgentExecutionError(ChildAgentDiagnostics.failureKind(message), message);
    }

    const connection = new CodexJSONRPCConnection(processSession, environment, onEvent);
    const terminateOnAbort = (): void => {
      void processSession.terminate();
    };
    controller.signal.addEventListener("abort", terminateOnAbort, { once: true });
    try {
      await connection.initialize();
      let threadID: string;
      if (resumeThreadID) {
        threadID = await connection.resumeThread(resumeThreadID);
      } else {
        threadID = await connection.startThread();
      }
      this.sessions.set(threadID, processSession);
      await onEvent({ kind: "session", message: "Codex thread established", sessionID: threadID });
      const turn = await connection.startTurn(threadID, prompt);
      const message = turn.message.trim();
      const report: ChildAgentReport = {
        sessionID: threadID,
        message: message.length === 0 ? "Codex completed the task." : message,
        rawOutput: connection.transcript(),
        tests: [],
        changedFiles: [],
        diffSummary: null,
        blocker: null,
      };
      await onEvent({ kind: "completed", message: report.message, sessionID: threadID });
      this.sessions.delete(threadID);
      await connection.close();
      return report;
    } catch (error) {
      if (error instanceof CancellationError || controller.signal.aborted) {
        await onEvent({
          kind: "cancelled",
          message: "Codex execution cancelled",
          sessionID: resumeThreadID,
        });
        await connection.close();
        if (resumeThreadID) this.sessions.delete(resumeThreadID);
        throw new CancellationError();
      }
      // app-server can put a model/auth failure on either stream and then
      // close the JSON-RPC connection. Terminate the instance before awaiting
      // its exit so a protocol error cannot strand a child process.
      const transcript = connection.transcript();
      await connection.close();
      const exit = await processSession.waitForExit();
      const diagnosticInput = [
        errorMessage(error),
        exit.exitCode === 0 ? "" : `Codex app-server exited with ${exit.exitCode}.`,
        transcript,
        exit.stdout,
        exit.stderr,
      ]
        .filter((value) => value.length > 0)
        .join("\n");
      const failureKind = ChildAgentDiagnostics.failureKind(diagnosticInput);
      const message = ChildAgentDiagnostics.redact(diagnosticInput, 2048);
      await onEvent({ kind: "failed", message, sessionID: resumeThreadID });
      if (resumeThreadID) this.sessions.delete(resumeThreadID);
      throw new ChildAgentExecutionError(failureKind, message);
    } finally {
      controller.signal.removeEventListener("abort", terminateOnAbort);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }
}

interface CodexTurnResult {
  message: string;
}

type Json = Record<string, unknown>;

class CodexJSONRPCConnection {
  private receiveTask: Promise<void> | null = null;
  private stdoutBuffer = "";
  private nextRequestID = 1;
  private pending = new Map<number, { resolve: (data: string) => void; reject: (error: Error) => void }>();
  private completedTurns = new Map<string, { ok: boolean; value?: CodexTurnResult; error?: Error }>();
  private turnWaiters = new Map<string, { resolve: (r: CodexTurnResult) => void; reject: (e: Error) => void }>();
  private textFragments: string[] = [];
  private rawTranscript = "";

  constructor(
    private readonly session: InteractiveProcessSession,
    private readonly environment: ChildAgentEnvironment,
    private readonly onEvent: ChildAgentEventSink,
  ) {}

  async initialize(): Promise<void> {
    this.startReceivingIfNeeded();
    await this.request("initialize", {
      clientInfo: { name: "OctoPunk", version: "1" },
      capabilities: null,
    });
    await this.notify("initialized", {});
  }

  async startThread(): Promise<string> {
    const result = await this.request("thread/start", this.threadParameters());
    const threadID = nestedString(result, ["thread", "id"]) ?? stringValue(result.threadId);
    if (threadID == null) {
      throw new ChildAgentExecutionError("protocol_error", "Codex app-server did not return a thread id.");
    }
    return threadID;
  }

  async resumeThread(existingThreadID: string): Promise<string> {
    const params: Json = { ...this.threadParameters(), threadId: existingThreadID };
    const result = await this.request("thread/resume", params);
    return nestedString(result, ["thread", "id"]) ?? stringValue(result.threadId) ?? existingThreadID;
  }

  async startTurn(threadID: string, prompt: string): Promise<CodexTurnResult> {
    const result = await this.request("turn/start", {
      threadId: threadID,
      input: [[{ type: "text", text: prompt, text_elements: [] }]],
      cwd: this.environment.worktreeURL,
      approvalPolicy: "untrusted",
      sandboxPolicy: this.sandboxPolicy(),
    });
    const turnID = nestedString(result, ["turn", "id"]) ?? stringValue(result.turnId);
    if (turnID == null) {
      throw new ChildAgentExecutionError("protocol_error", "Codex app-server did not return a turn id.");
    }
    return await this.waitForTurn(turnID);
  }

  transcript(): string {
    return ChildAgentDiagnostics.redact(this.rawTranscript, 64 * 1024);
  }

  async close(): Promise<void> {
    for (const continuation of this.pending.values()) {
      continuation.reject(new CancellationError());
    }
    this.pending.clear();
    for (const continuation of this.turnWaiters.values()) {
      continuation.reject(new CancellationError());
    }
    this.turnWaiters.clear();
    await this.session.terminate();
  }

  private startReceivingIfNeeded(): void {
    if (this.receiveTask != null) return;
    this.receiveTask = (async () => {
      while (true) {
        const chunk = await this.session.nextOutput();
        if (chunk == null) break;
        await this.receive(chunk);
      }
      this.finishReceiving();
    })();
  }

  private async request(method: string, params: Json): Promise<Json> {
    const requestID = this.nextRequestID;
    this.nextRequestID += 1;
    const payload = jsonLine({ jsonrpc: "2.0", id: requestID, method, params });
    const resultText = await new Promise<string>((resolve, reject) => {
      this.pending.set(requestID, { resolve, reject });
      this.session.send(payload).catch((error) => {
        const continuation = this.pending.get(requestID);
        if (continuation) {
          this.pending.delete(requestID);
          continuation.reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    try {
      const parsed = JSON.parse(resultText);
      if (typeof parsed === "object" && parsed != null && !Array.isArray(parsed)) {
        return parsed as Json;
      }
      throw new Error("not an object");
    } catch {
      throw new ChildAgentExecutionError(
        "protocol_error",
        "Codex JSON-RPC response did not contain an object result.",
      );
    }
  }

  private async notify(method: string, params: Json): Promise<void> {
    await this.session.send(jsonLine({ jsonrpc: "2.0", method, params }));
  }

  private async waitForTurn(turnID: string): Promise<CodexTurnResult> {
    const completed = this.completedTurns.get(turnID);
    if (completed) {
      this.completedTurns.delete(turnID);
      if (completed.ok) return completed.value as CodexTurnResult;
      throw completed.error;
    }
    return await new Promise<CodexTurnResult>((resolve, reject) => {
      this.turnWaiters.set(turnID, { resolve, reject });
    });
  }

  private async receive(chunk: { channel: string; text: string }): Promise<void> {
    if (chunk.channel === "stderr") {
      this.rawTranscript = this.bounded(this.rawTranscript + chunk.text);
      await this.onEvent({ kind: "output", stderr: chunk.text });
      return;
    }
    this.stdoutBuffer += chunk.text;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      await this.receiveLine(line);
    }
  }

  private async receiveLine(line: string): Promise<void> {
    if (line.trim().length === 0) return;
    this.rawTranscript = this.bounded(this.rawTranscript + line + "\n");
    let object: Json | null = null;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "object" && parsed != null && !Array.isArray(parsed)) object = parsed as Json;
    } catch {
      object = null;
    }
    if (object == null) {
      await this.onEvent({
        kind: "output",
        stderr: "Codex app-server emitted non-JSON output: " + ChildAgentDiagnostics.redact(line, 256),
      });
      return;
    }
    const id = intValue(object.id);
    if (id != null) {
      const continuation = this.pending.get(id);
      if (continuation) {
        this.pending.delete(id);
        const error = object.error;
        if (isJson(error)) {
          continuation.reject(
            new ChildAgentExecutionError(
              "protocol_error",
              ChildAgentDiagnostics.redact(stringValue(error.message) ?? "Codex JSON-RPC error", 2048),
            ),
          );
        } else {
          const result = isJson(object.result) ? object.result : {};
          continuation.resolve(JSON.stringify(result));
        }
      }
      return;
    }
    const method = stringValue(object.method);
    if (method == null) return;
    const params = isJson(object.params) ? object.params : {};
    if (object.id != null) {
      await this.handleServerRequest(object.id, method, params);
    } else {
      await this.handleNotification(method, params);
    }
  }

  private async handleNotification(method: string, params: Json): Promise<void> {
    switch (method) {
      case "item/agentMessage/delta": {
        const delta = stringValue(params.delta);
        if (delta != null && delta.length > 0) {
          this.textFragments.push(delta);
          await this.onEvent({ kind: "output", stdout: delta });
        }
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = isJson(params.item) ? params.item : null;
        if (item) {
          const tool = toolNameIn(item);
          if (tool) {
            await this.onEvent({ kind: "tool", message: `Using ${tool}`, toolName: tool });
          }
          if (method === "item/completed") {
            const text = agentTextIn(item);
            if (text != null && text.length > 0) {
              this.textFragments.push(text);
            }
          }
        }
        break;
      }
      case "turn/completed": {
        const turn = isJson(params.turn) ? params.turn : params;
        const turnID = stringValue(turn.id) ?? stringValue(params.turnId);
        if (turnID == null) return;
        const status = stringValue(turn.status) ?? "completed";
        const message = agentTextIn(turn) ?? this.textFragments.join("");
        if (status === "completed") {
          this.completeTurn(turnID, { ok: true, value: { message } });
        } else if (status === "interrupted" || status === "cancelled") {
          this.completeTurn(turnID, { ok: false, error: new CancellationError() });
        } else {
          const error =
            stringValue(turn.error) ?? stringValue(params.error) ?? `Codex turn ${status}.`;
          this.completeTurn(turnID, {
            ok: false,
            error: new ChildAgentExecutionError(
              ChildAgentDiagnostics.failureKind(error),
              ChildAgentDiagnostics.redact(error, 2048),
            ),
          });
        }
        break;
      }
      default:
        break;
    }
  }

  private async handleServerRequest(id: unknown, method: string, params: Json): Promise<void> {
    if (
      method !== "item/commandExecution/requestApproval" &&
      method !== "item/fileChange/requestApproval"
    ) {
      await this.session
        .send(
          jsonLine({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "OctoPunk policy does not allow this request." },
          }),
        )
        .catch(() => {});
      return;
    }
    let accepted: boolean;
    if (method === "item/commandExecution/requestApproval") {
      accepted = this.environment.executionMode === "workspace_write" && commandAllowed(params, this.environment);
    } else {
      accepted = this.environment.executionMode === "workspace_write" && fileChangeAllowed(params, this.environment);
    }
    const decision = accepted ? "accept" : "decline";
    await this.onEvent({
      kind: "tool",
      message: accepted ? "Approved constrained local tool request" : "Denied tool request by policy",
      toolName: method,
    });
    await this.session
      .send(jsonLine({ jsonrpc: "2.0", id, result: { decision } }))
      .catch(() => {});
  }

  private completeTurn(turnID: string, result: { ok: boolean; value?: CodexTurnResult; error?: Error }): void {
    const waiter = this.turnWaiters.get(turnID);
    if (waiter) {
      this.turnWaiters.delete(turnID);
      if (result.ok) waiter.resolve(result.value as CodexTurnResult);
      else waiter.reject(result.error as Error);
    } else {
      this.completedTurns.set(turnID, result);
    }
  }

  private finishReceiving(): void {
    const error = new ChildAgentExecutionError(
      "protocol_error",
      "Codex app-server closed before completing the request.",
    );
    for (const continuation of this.pending.values()) {
      continuation.reject(error);
    }
    this.pending.clear();
    for (const continuation of this.turnWaiters.values()) {
      continuation.reject(error);
    }
    this.turnWaiters.clear();
  }

  private threadParameters(): Json {
    return {
      cwd: this.environment.worktreeURL,
      approvalPolicy: "untrusted",
      sandbox: this.environment.executionMode === "read_only" ? "read-only" : "workspace-write",
      developerInstructions:
        "Follow OctoPunk task policy. This is a leaf sub-agent: do not spawn or delegate other agents, do not use MCP tools, web, computer, commit, push, or network shell commands.",
      mcp_servers: {},
      // Settings → 子 Agent 模型 override; omitted keeps the Codex default.
      ...(this.environment.childModel != null ? { model: this.environment.childModel } : {}),
    };
  }

  private sandboxPolicy(): Json {
    if (this.environment.executionMode === "read_only") {
      return { type: "readOnly", networkAccess: false };
    }
    return {
      type: "workspaceWrite",
      writableRoots: [this.environment.worktreeURL],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  private bounded(value: string): string {
    return ChildAgentDiagnostics.redact(value, 64 * 1024);
  }
}

function jsonLine(object: unknown): string {
  return JSON.stringify(sortKeys(object)) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value != null) {
    const entries = Object.entries(value as Json).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const result: Json = {};
    for (const [key, item] of entries) {
      if (item !== undefined) result[key] = sortKeys(item);
    }
    return result;
  }
  return value;
}

/**
 * Default child arguments: app-server over stdio with multi-agent features
 * off and — unless a restricted context server is supplied — all MCP servers
 * cleared so a child cannot dial out.
 */
export function codexArguments(environment: ChildAgentEnvironment): string[] {
  const args = [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.multi_agent_v2=false",
  ];
  const server = environment.contextServer;
  if (server) {
    args.push(
      "-c",
      `mcp_servers={octopunk={command="${escapeTOML(server.executablePath)}",args=["--mcp-stdio"],env={${
        OctoPunkContextServer.runIDEnvironmentKey
      }="${server.runID}",${OctoPunkContextServer.taskIDEnvironmentKey}="${server.taskID}"}}}`,
    );
  } else {
    args.push("-c", "mcp_servers={}");
  }
  return args;
}

function escapeTOML(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * A deny list is too easy to bypass with `env`, shell separators, or a newly
 * introduced network executable. Keep approvals intentionally narrow: Bash
 * here is only for local inspection, builds, and tests.
 */
export function commandAllowed(params: Json, environment: ChildAgentEnvironment): boolean {
  const command = commandText(params).toLowerCase().trim();
  if (command.length === 0) return false;
  if (/[;|&><`\n\r]/.test(command) || command.includes("$(")) {
    return false;
  }
  const words = command.split(/\s+/);
  const executable = words[0];
  if (executable == null) return false;

  if (executable === "git") {
    if (words.length < 2) return false;
    return ["status", "diff", "log", "show", "rev-parse", "ls-files", "branch", "blame", "grep"].includes(words[1]);
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    if (words.length < 2) return false;
    return ["test", "run", "exec", "lint", "typecheck", "build"].includes(words[1]);
  }
  const localTools = new Set([
    "rg",
    "grep",
    "sed",
    "awk",
    "find",
    "ls",
    "pwd",
    "cat",
    "head",
    "tail",
    "wc",
    "sort",
    "uniq",
    "cut",
    "tr",
    "xargs",
    "stat",
    "du",
    "diff",
    "which",
    "test",
    "dirname",
    "basename",
    "jq",
    "plutil",
    "swift",
    "xcodebuild",
    "make",
    "cmake",
    "cargo",
    "go",
    "python",
    "python3",
    "pytest",
    "vitest",
    "jest",
    "tsc",
    "eslint",
    "prettier",
    "biome",
    "swiftlint",
    "gradle",
    "./gradlew",
    "mvn",
    "./mvnw",
    "java",
    "kotlinc",
    "ruby",
    "node",
  ]);
  return localTools.has(executable);
}

export function fileChangeAllowed(params: Json, environment: ChildAgentEnvironment): boolean {
  const root = path.resolve(environment.worktreeURL);
  const candidates = [
    stringValue(params.path),
    stringValue(params.filePath),
    nestedString(params, ["item", "path"]),
    stringValue(params.grantRoot),
  ].filter((value): value is string => value != null);
  if (candidates.length > 0) {
    return candidates.every((candidate) => {
      const resolved = path.resolve(candidate);
      return resolved === root || resolved.startsWith(root + path.sep);
    });
  }
  // No path on an ordinary workspace edit: the workspaceWrite sandbox passed
  // to turn/start already constrains it to writableRoots.
  return true;
}

function toolNameIn(item: Json): string | null {
  const type = stringValue(item.type) ?? "tool";
  if (type === "commandExecution") {
    return stringValue(item.command) ?? "commandExecution";
  }
  if (type === "fileChange") return "fileChange";
  return type === "agentMessage" ? null : type;
}

function agentTextIn(object: Json): string | null {
  return stringValue(object.text) ?? stringValue(object.message) ?? nestedString(object, ["item", "text"]);
}

function commandText(object: Json): string {
  const command = stringValue(object.command);
  if (command != null) return command;
  const nested = nestedString(object, ["item", "command"]);
  if (nested != null) return nested;
  if (Array.isArray(object.command) && object.command.every((v) => typeof v === "string")) {
    return (object.command as string[]).join(" ");
  }
  return "";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function intValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function nestedString(object: Json, pathSegments: string[]): string | null {
  let current: unknown = object;
  for (const key of pathSegments) {
    if (typeof current !== "object" || current == null || Array.isArray(current)) return null;
    current = (current as Json)[key];
  }
  return typeof current === "string" ? current : null;
}

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
