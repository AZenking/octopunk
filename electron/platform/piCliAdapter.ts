// pi coding agent (https://pi.dev) CLI adapter, shaped after ClaudeCLIAdapter.
// pi speaks its own JSONL event stream (`--mode json`, see
// https://pi.dev/docs/latest/json): a `session` header, message lifecycle
// events, and tool_execution events. pi has no built-in MCP client; when the
// pi-mcp-extension package is installed (pi install npm:pi-mcp-extension) the
// per-task context server is staged as a project-level .pi/mcp.json in the
// worktree and the extension is loaded explicitly via -e. Without it the
// child degrades to its prompt snapshot — the same fallback path Claude takes
// when MCP staging fails.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CancellationError,
  ChildAgentDiagnostics,
  ChildAgentExecutionError,
  OctoPunkContextServer,
  type ChildAgentEnvironment,
  type ChildAgentEvent,
  type ChildAgentEventSink,
  type ChildAgentPort,
  type ChildAgentReport,
  type ProcessOutputChunk,
  type ProcessPort,
  type ProcessRequest,
} from "../application/ports";
import { LocalProcessError } from "./processAdapter";
import { sandboxProfile } from "./claudeCliAdapter";

export class PiCLIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiCLIError";
  }
  static missingSession(): PiCLIError {
    return new PiCLIError("pi did not return a session id.");
  }
  static invalidResponse(): PiCLIError {
    return new PiCLIError("pi returned no assistant message.");
  }
}

/** pi names its tools lowercase; profiles arrive in Claude's casing. */
const PI_TOOL_FOR_PROFILE_TOOL: Record<string, string> = {
  Read: "read",
  Glob: "find",
  Grep: "grep",
  Ls: "ls",
  Edit: "edit",
  Write: "write",
  Bash: "bash",
};

/** Full built-in set when the profile maps to nothing (defensive). */
const PI_ALL_TOOLS = ["read", "ls", "find", "grep", "edit", "write", "bash"];

function piToolNames(allowedTools: string[]): string[] {
  const names = allowedTools
    .map((tool) => PI_TOOL_FOR_PROFILE_TOOL[tool])
    .filter((name): name is string => name != null);
  return names.length > 0 ? [...new Set(names)] : PI_ALL_TOOLS;
}

/**
 * Entry file of the MCP bridge extension, if installed. `pi install
 * npm:pi-mcp-extension` places the package under ~/.pi/agent/npm; the
 * extension ships TypeScript sources, so the entry is src/index.ts.
 */
function piMcpExtensionEntry(home = os.homedir()): string | null {
  const candidates = [
    path.join(home, ".pi", "agent", "npm", "node_modules", "pi-mcp-extension", "src", "index.ts"),
    path.join(home, ".pi", "agent", "extensions", "pi-mcp-extension", "index.ts"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next layout.
    }
  }
  return null;
}

/**
 * Stages the per-task context server as the worktree's project-level MCP
 * config (the pi-mcp-extension reads <cwd>/.pi/mcp.json; eager lifecycle
 * starts the server at session start — lazy needs an interactive /mcp:start).
 * The server subprocess inherits the child's OCTOPUNK_SESSION_* binding from
 * the process environment. Returns the cleanup for the staged file.
 */
function stageMCPConfig(
  worktreeURL: string,
  server: ReturnType<typeof OctoPunkContextServer.make>,
): () => void {
  const directory = path.join(worktreeURL, ".pi");
  const configPath = path.join(directory, "mcp.json");
  let previous: string | null = null;
  try {
    previous = fs.readFileSync(configPath, "utf8");
  } catch {
    previous = null;
  }
  const config = {
    mcpServers: {
      octopunk: {
        command: server.executablePath,
        args: ["--mcp-stdio"],
        transport: "stdio",
        lifecycle: "eager",
      },
    },
  };
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch {
    return () => {};
  }
  return () => {
    try {
      if (previous != null) {
        fs.writeFileSync(configPath, previous);
      } else {
        fs.rmSync(configPath, { force: true });
        fs.rmdirSync(directory, { recursive: false });
      }
    } catch {
      // Best-effort cleanup; the worktree maintenance pass removes leftovers.
    }
  };
}

export class PiCLIAdapter implements ChildAgentPort {
  private readonly executablePath: string;
  private readonly process: ProcessPort;
  private readonly processRegistry = new Map<string, string>();

  constructor(executablePath: string, process_: ProcessPort) {
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
    const processID = this.processRegistry.get(sessionID);
    if (processID) {
      await this.process.terminate(processID);
    }
  }

  private async run(
    prompt: string,
    sessionID: string | null,
    environment: ChildAgentEnvironment,
    onEvent: ChildAgentEventSink,
    signal?: AbortSignal,
  ): Promise<ChildAgentReport> {
    const processID = randomUUID();
    if (sessionID) {
      this.processRegistry.set(sessionID, processID);
    }
    await onEvent({ kind: "started", message: "Launching pi", sessionID });
    const liveDecoder = new PiLiveStreamDecoder(onEvent, processID, this.processRegistry);
    // The context server rides through the pi-mcp-extension when installed;
    // otherwise the child keeps working from its prompt snapshot.
    const mcpEntry =
      environment.contextServer != null ? piMcpExtensionEntry() : null;
    let restoreMCPConfig: (() => void) | null = null;
    if (mcpEntry != null && environment.contextServer != null) {
      restoreMCPConfig = stageMCPConfig(environment.worktreeURL, environment.contextServer);
    }
    try {
      // fnm/npm-global CLIs are `#!/usr/bin/env node` scripts; the runtime
      // node lives beside them, so prepend the executable's own directory.
      const executableDirectory = path.dirname(this.executablePath);
      const mergedEnvironment: Record<string, string> = {
        OCTOPUNK_CHILD_SANDBOX: environment.allowNetwork ? "model-service" : "offline",
        NO_PROXY: "*",
        no_proxy: "*",
        PATH: [executableDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
        // Binds the context server subprocess (spawned by the MCP extension,
        // inheriting this environment) to this run and task.
        ...(environment.contextServer?.environment ?? {}),
      };
      const request: ProcessRequest = {
        id: processID,
        executable: this.executablePath,
        arguments: this.arguments(prompt, sessionID, environment, mcpEntry),
        workingDirectory: environment.worktreeURL,
        environment: mergedEnvironment,
        // pi's model connection needs the host network; tool-level hazards
        // stay denied by the explicit tool policy in arguments().
        sandboxProfile: environment.allowNetwork
          ? null
          : sandboxProfile(environment.worktreeURL, false, [
              path.join(os.homedir(), ".pi"),
            ]),
      };
      const result = await this.process.runStreaming(
        request,
        (chunk) => liveDecoder.consume(chunk),
        signal,
      );
      const report = this.parse(result.stdout, result.stderr);
      this.processRegistry.set(report.sessionID, processID);
      await onEvent({ kind: "completed", message: report.message, sessionID: report.sessionID });
      this.processRegistry.delete(report.sessionID);
      if (sessionID && sessionID !== report.sessionID) {
        this.processRegistry.delete(sessionID);
      }
      return report;
    } catch (error) {
      if (error instanceof CancellationError) {
        await onEvent({ kind: "cancelled", message: "pi execution cancelled", sessionID });
        if (sessionID) this.processRegistry.delete(sessionID);
        throw error;
      }
      const diagnostic = diagnosticFor(error);
      await onEvent({
        kind: "failed",
        message: diagnostic.message,
        stderr: diagnostic.stderr ?? undefined,
        sessionID,
      });
      if (sessionID) this.processRegistry.delete(sessionID);
      throw new ChildAgentExecutionError(
        ChildAgentDiagnostics.failureKind(diagnostic.message),
        diagnostic.message,
      );
    } finally {
      restoreMCPConfig?.();
    }
  }

  private arguments(
    prompt: string,
    sessionID: string | null,
    environment: ChildAgentEnvironment,
    mcpEntry: string | null,
  ): string[] {
    const args = [
      "--print",
      "--mode",
      "json",
      // Deterministic child runs: no extension/skill discovery — the installed
      // OctoPunk orchestration skill must never reach a spawned child. The
      // MCP bridge, when used, is loaded explicitly via -e below.
      "--no-extensions",
      "--no-skills",
    ];
    if (mcpEntry != null) {
      args.push("-e", mcpEntry);
      // pi's --tools allowlist matches exact names, which cannot cover the
      // server's dynamic mcp_* tools; switch to a denylist so the context
      // server stays reachable while read-only tasks keep their contract.
      if (environment.executionMode === "read_only") {
        args.push("--exclude-tools", "bash,edit,write");
      }
    } else {
      args.push("--tools", piToolNames(environment.allowedTools).join(","));
    }
    if (sessionID) {
      args.push("--session", sessionID);
    }
    if (environment.childModel != null && environment.childModel.length > 0) {
      args.push("--model", environment.childModel);
    }
    args.push(prompt);
    return args;
  }

  private parse(stdout: string, stderr: string): ChildAgentReport {
    const parsed = PiStreamParser.parse(stdout);
    if (parsed.sessionID == null || parsed.sessionID.length === 0) {
      throw PiCLIError.missingSession();
    }
    // pi reports provider/auth failures as plain text after the session
    // header with a non-zero exit; surface that instead of an empty answer.
    const message = parsed.text ?? diagnosticText(stdout, stderr);
    if (message.length === 0) throw PiCLIError.invalidResponse();
    return {
      sessionID: parsed.sessionID,
      message,
      rawOutput: ChildAgentDiagnostics.redact(stdout, 64 * 1024),
      tests: [],
      changedFiles: [],
      diffSummary: null,
      blocker: null,
    };
  }
}

function diagnosticText(stdout: string | null | undefined, stderr: string | null | undefined): string {
  const combined = [stderr ?? "", stdout ?? ""]
    .map((value) => (value ?? "").replace(/^\s*\{.*$/gm, "")) // drop event lines, keep prose
    .filter((value) => value.trim().length > 0)
    .join("\n")
    .trim();
  return ChildAgentDiagnostics.redact(combined, 2048);
}

function diagnosticFor(error: unknown): { message: string; stderr: string | null } {
  if (error instanceof LocalProcessError) {
    return {
      message: diagnosticText(error.stdout, error.stderr),
      stderr: ChildAgentDiagnostics.redact(error.stderr ?? "", 2048),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message: ChildAgentDiagnostics.redact(message, 2048), stderr: null };
}

class PiLiveStreamDecoder {
  private stdoutBuffer = "";
  private lastEmittedSessionID: string | null = null;

  constructor(
    private readonly onEvent: ChildAgentEventSink,
    private readonly processID: string,
    private readonly registry: Map<string, string>,
  ) {}

  consume(chunk: ProcessOutputChunk): void {
    if (chunk.channel !== "stdout") {
      void this.emit({ kind: "output", stderr: chunk.text });
      return;
    }
    this.stdoutBuffer += chunk.text;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      for (const event of PiStreamParser.events(line, this.lastEmittedSessionID)) {
        void this.emit(event);
      }
      // Track the session id seen so far so later events carry it.
      const sessionID = sessionIDOf(line);
      if (sessionID != null) this.lastEmittedSessionID = sessionID;
    }
  }

  private async emit(event: ChildAgentEvent): Promise<void> {
    if (event.kind === "session") {
      const sessionID = event.sessionID;
      if (sessionID == null || sessionID.length === 0) return;
      if (sessionID === this.lastEmittedSessionID && this.registry.has(sessionID)) return;
      this.lastEmittedSessionID = sessionID;
    }
    if (event.sessionID) {
      this.registry.set(event.sessionID, this.processID);
    }
    await this.onEvent(event);
  }
}

interface PiParsedStream {
  sessionID: string | null;
  /** Final assistant message text, joined across content blocks. */
  text: string | null;
  /** Fallback: concatenated text deltas when no message_end was seen. */
  deltas: string[];
}

type Json = Record<string, unknown>;

const PiStreamParser = {
  parse(output: string): PiParsedStream {
    const parsed: PiParsedStream = { sessionID: null, text: null, deltas: [] };
    for (const line of output.split(/\r?\n/)) {
      const object = jsonObject(line);
      if (!object) continue;
      const sessionID = sessionIDOf(object);
      if (sessionID != null) parsed.sessionID = sessionID;
      if (stringValue(object.type) === "message_end") {
        const text = assistantText(object.message);
        if (text != null && text.length > 0) parsed.text = text;
      }
      if (stringValue(object.type) === "message_update") {
        const delta = textDelta(object.assistantMessageEvent);
        if (delta != null && delta.length > 0) parsed.deltas.push(delta);
      }
    }
    if (parsed.text == null && parsed.deltas.length > 0) {
      parsed.text = parsed.deltas.join("");
    }
    return parsed;
  },

  events(line: string, knownSessionID: string | null): ChildAgentEvent[] {
    const object = jsonObject(line);
    if (!object) return [];
    const events: ChildAgentEvent[] = [];
    const sessionID = sessionIDOf(object);
    if (sessionID != null && sessionID !== knownSessionID) {
      events.push({
        kind: "session",
        message: "pi session established",
        sessionID,
      });
    }
    const delta = stringValue(object.type) === "message_update"
      ? textDelta(object.assistantMessageEvent)
      : null;
    if (delta != null && delta.length > 0) {
      events.push({
        kind: "output",
        stdout: delta,
        sessionID: sessionID ?? knownSessionID ?? undefined,
      });
    }
    if (stringValue(object.type) === "tool_execution_start") {
      const toolName = stringValue(object.toolName);
      if (toolName != null) {
        events.push({
          kind: "tool",
          message: `Using ${toolName}`,
          sessionID: sessionID ?? knownSessionID ?? undefined,
          toolName,
        });
      }
    }
    return events;
  },
};

function sessionIDOf(line: string | Json): string | null {
  const object = typeof line === "string" ? jsonObject(line) : line;
  if (object == null) return null;
  const type = stringValue(object.type);
  if (type !== "session") return null;
  return stringValue(object.id);
}

function textDelta(event: unknown): string | null {
  if (typeof event !== "object" || event == null) return null;
  const record = event as Json;
  if (stringValue(record.type) !== "text_delta") return null;
  return stringValue(record.delta);
}

/** message_end carries the authoritative AssistantMessage; join its text blocks. */
function assistantText(message: unknown): string | null {
  if (typeof message !== "object" || message == null) return null;
  const record = message as Json;
  if (record.role != null && stringValue(record.role) !== "assistant") return null;
  const content = record.content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block == null) continue;
    const json = block as Json;
    const type = stringValue(json.type);
    const text = stringValue(json.text);
    if (text != null && (type == null || type === "text")) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function jsonObject(line: string): Json | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed);
    return typeof value === "object" && value != null && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
