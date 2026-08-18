// Port of OctoPunk/OctoPunk/Platform/Claude/ClaudeCLIAdapter.swift.

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

export class ClaudeCLIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCLIError";
  }
  static invalidResponse(): ClaudeCLIError {
    return new ClaudeCLIError("Claude returned an unrecognized stream-json response.");
  }
  static missingSession(): ClaudeCLIError {
    return new ClaudeCLIError("Claude did not return a session id.");
  }
}

/**
 * The small subset of Claude's environment contract needed by compatible
 * providers such as GLM. Global Claude settings remain disabled in the child
 * process; only these provider variables are selectively forwarded.
 */
const CLAUDE_PROVIDER_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
]);

export const ClaudeProviderEnvironment = {
  load(processEnvironment: Record<string, string | undefined> = process.env): Record<string, string> {
    const settingsURL = path.join(os.homedir(), ".claude", "settings.json");
    const result = ClaudeProviderEnvironment.loadSettings(settingsURL);
    for (const key of CLAUDE_PROVIDER_KEYS) {
      const value = processEnvironment[key];
      if (value != null && value.length > 0) {
        result[key] = value;
      }
    }
    return result;
  },

  loadSettings(url: string): Record<string, string> {
    try {
      const root = JSON.parse(fs.readFileSync(url, "utf8")) as { env?: Record<string, unknown> };
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(root.env ?? {})) {
        if (CLAUDE_PROVIDER_KEYS.has(key) && typeof value === "string" && value.length > 0) {
          result[key] = value;
        }
      }
      return result;
    } catch {
      return {};
    }
  },
};

export class ClaudeCLIAdapter implements ChildAgentPort {
  private readonly executablePath: string;
  private readonly process: ProcessPort;
  private readonly providerEnvironment: Record<string, string>;
  private readonly processRegistry = new Map<string, string>();

  constructor(
    executablePath: string,
    process_: ProcessPort,
    providerEnvironment?: Record<string, string> | null,
  ) {
    this.executablePath = executablePath;
    this.process = process_;
    this.providerEnvironment = providerEnvironment ?? ClaudeProviderEnvironment.load();
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
    await onEvent({ kind: "started", message: "Launching Claude Code", sessionID });
    const liveDecoder = new ClaudeLiveStreamDecoder(onEvent, processID, this.processRegistry);
    // The restricted context server is best-effort: a sub-agent keeps working
    // from its spawn-time snapshot if the config cannot be staged.
    let mcpConfigPath: string | null = null;
    if (environment.contextServer) {
      try {
        mcpConfigPath = writeMCPConfig(environment.contextServer);
      } catch {
        mcpConfigPath = null;
      }
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
        ...(environment.contextServer?.environment ?? {}),
        ...this.providerEnvironment,
      };
      const request: ProcessRequest = {
        id: processID,
        executable: this.executablePath,
        arguments: this.arguments(prompt, sessionID, environment, mcpConfigPath),
        workingDirectory: environment.worktreeURL,
        environment: mergedEnvironment,
        // Claude's own model connection needs the host network; the task's
        // web access is constrained by the CLI tool policy.
        sandboxProfile: environment.allowNetwork
          ? null
          : sandboxProfile(environment.worktreeURL, false),
      };
      const result = await this.process.runStreaming(
        request,
        (chunk) => liveDecoder.consume(chunk),
        signal,
      );
      const report = this.parse(result.stdout);
      this.processRegistry.set(report.sessionID, processID);
      await onEvent({ kind: "completed", message: report.message, sessionID: report.sessionID });
      this.processRegistry.delete(report.sessionID);
      if (sessionID && sessionID !== report.sessionID) {
        this.processRegistry.delete(sessionID);
      }
      return report;
    } catch (error) {
      if (error instanceof CancellationError) {
        await onEvent({ kind: "cancelled", message: "Claude execution cancelled", sessionID });
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
      if (mcpConfigPath) {
        try {
          fs.rmSync(mcpConfigPath, { force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }

  private arguments(
    prompt: string,
    sessionID: string | null,
    environment: ChildAgentEnvironment,
    mcpConfigPath: string | null,
  ): string[] {
    const tools = environment.allowedTools.join(",");
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--input-format",
      "text",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "acceptEdits",
      "--setting-sources",
      "",
      "--tools",
      tools,
      "--allowedTools",
      tools,
      "--disallowedTools",
      DISALLOWED_TOOLS,
    ];
    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }
    if (sessionID) {
      args.push("--resume", sessionID);
    }
    return args;
  }

  private parse(output: string): ChildAgentReport {
    const parsed = ClaudeStreamParser.parse(output);
    if (parsed.sessionID == null || parsed.sessionID.length === 0) {
      throw ClaudeCLIError.missingSession();
    }
    const message =
      parsed.result ?? parsed.text[parsed.text.length - 1] ?? output.trim();
    if (message.length === 0) throw ClaudeCLIError.invalidResponse();
    return {
      sessionID: parsed.sessionID,
      message,
      rawOutput: ChildAgentDiagnostics.redact(output, 64 * 1024),
      tests: parsed.tests,
      changedFiles: parsed.changedFiles,
      diffSummary: parsed.diffSummary,
      blocker: parsed.blocker,
    };
  }
}

/** Claude only accepts MCP servers through a JSON config file; task-scoped, deleted after the run. */
function writeMCPConfig(server: ReturnType<typeof OctoPunkContextServer.make>): string {
  const config = {
    mcpServers: {
      octopunk: {
        command: server.executablePath,
        args: ["--mcp-stdio"],
        env: server.environment,
      },
    },
  };
  const url = path.join(os.tmpdir(), `octopunk-mcp-${server.taskID}.json`);
  fs.writeFileSync(url, JSON.stringify(config));
  return url;
}

const DISALLOWED_TOOLS = [
  "WebSearch",
  "WebFetch",
  "Computer",
  "Bash(git commit)",
  "Bash(git commit *)",
  "Bash(git push)",
  "Bash(git push *)",
  "Bash(git clone)",
  "Bash(git clone *)",
  "Bash(git fetch)",
  "Bash(git fetch *)",
  "Bash(git pull)",
  "Bash(git pull *)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(nc *)",
  "Bash(ssh *)",
  "Bash(scp *)",
  "Bash(sftp *)",
  "Bash(rsync *)",
  "Bash(npm publish *)",
  "Bash(pnpm publish *)",
  "Bash(yarn publish *)",
  "Bash(npm install *)",
  "Bash(pnpm install *)",
  "Bash(yarn install *)",
  "Bash(pip install *)",
  "Bash(pip3 install *)",
  "Bash(brew install *)",
  "Bash(open *)",
  "Bash(osascript *)",
].join(",");

function diagnosticFor(error: unknown): { message: string; stderr: string | null } {
  if (error instanceof LocalProcessError && error.exitCode != null) {
    const combined = [error.stderr ?? "", error.stdout ?? ""].filter((v) => v.length > 0).join("\n");
    return {
      message: ChildAgentDiagnostics.redact(combined, 2048),
      stderr: ChildAgentDiagnostics.redact(error.stderr ?? "", 2048),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message: ChildAgentDiagnostics.redact(message, 2048), stderr: null };
}

class ClaudeLiveStreamDecoder {
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
      for (const event of ClaudeStreamParser.events(line)) {
        void this.emit(event);
      }
    }
  }

  private async emit(event: ChildAgentEvent): Promise<void> {
    if (event.kind === "session") {
      const sessionID = event.sessionID;
      if (sessionID == null || sessionID.length === 0) return;
      if (sessionID === this.lastEmittedSessionID) return;
      this.lastEmittedSessionID = sessionID;
    }
    if (event.sessionID) {
      this.registry.set(event.sessionID, this.processID);
    }
    await this.onEvent(event);
  }
}

interface ClaudeParsedStream {
  sessionID: string | null;
  result: string | null;
  text: string[];
  tests: string[];
  changedFiles: string[];
  diffSummary: string | null;
  blocker: string | null;
}

type Json = Record<string, unknown>;

const ClaudeStreamParser = {
  parse(output: string): ClaudeParsedStream {
    const result: ClaudeParsedStream = {
      sessionID: null,
      result: null,
      text: [],
      tests: [],
      changedFiles: [],
      diffSummary: null,
      blocker: null,
    };
    for (const line of output.split(/\r?\n/)) {
      const object = jsonObject(line);
      if (object) merge(object, result);
    }
    return result;
  },

  events(line: string): ChildAgentEvent[] {
    const object = jsonObject(line);
    if (!object) return [];
    const sessionID = stringValue(object.session_id) ?? stringValue(object.sessionId);
    const type = stringValue(object.type);
    const events: ChildAgentEvent[] = [];
    if (sessionID) {
      events.push({ kind: "session", message: "Claude session established", sessionID });
    }
    const text = textValue(object);
    if (text != null && text.length > 0) {
      events.push({ kind: "output", stdout: text, sessionID: sessionID ?? undefined });
    }
    for (const tool of toolNames(object)) {
      events.push({ kind: "tool", message: `Using ${tool}`, sessionID: sessionID ?? undefined, toolName: tool });
    }
    if (type === "result" && object.is_error === true) {
      const message =
        stringValue(object.result) ?? stringValue(object.message) ?? "Claude reported an error";
      events.push({
        kind: "failed",
        message: ChildAgentDiagnostics.redact(message),
        sessionID: sessionID ?? undefined,
      });
    }
    return events;
  },
};

function merge(object: Json, parsed: ClaudeParsedStream): void {
  parsed.sessionID = stringValue(object.session_id) ?? stringValue(object.sessionId) ?? parsed.sessionID;
  const type = stringValue(object.type);
  if (type === "result") {
    const message = stringValue(object.result) ?? stringValue(object.message);
    if (message != null && message.length > 0) {
      parsed.result = message;
    }
    parsed.tests = stringArray(object.tests) ?? stringArray(object.test_results) ?? parsed.tests;
    parsed.changedFiles = stringArray(object.changed_files) ?? stringArray(object.changedFiles) ?? parsed.changedFiles;
    parsed.diffSummary = stringValue(object.diff_summary) ?? stringValue(object.diffSummary) ?? parsed.diffSummary;
    parsed.blocker = stringValue(object.blocker) ?? parsed.blocker;
  }
  const text = textValue(object);
  if (text != null && text.length > 0) parsed.text.push(text);
}

function jsonObject(line: string): Json | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const value = JSON.parse(trimmed);
    return typeof value === "object" && value != null && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

function textValue(object: Json): string | null {
  const result = stringValue(object.result);
  if (result != null && stringValue(object.type) !== "result") return result;
  const message = object.message;
  if (isJson(message)) {
    const content = message.content;
    if (Array.isArray(content)) {
      const values = content.map((block) => (isJson(block) ? stringValue(block.text) : null)).filter((v): v is string => v != null);
      if (values.length > 0) return values.join("");
    }
  }
  const event = object.event;
  if (isJson(event) && isJson(event.delta)) {
    const text = stringValue(event.delta.text);
    if (text != null) return text;
  }
  if (typeof object.content === "string") return object.content;
  return null;
}

function toolNames(object: Json): string[] {
  const names: string[] = [];
  const message = object.message;
  if (isJson(message) && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isJson(block) && stringValue(block.type) === "tool_use") {
        const name = stringValue(block.name);
        if (name != null) names.push(name);
      }
    }
  }
  if (typeof object.tool_name === "string") names.push(object.tool_name);
  return names;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

export function sandboxProfile(worktreeURL: string, allowNetwork: boolean): string {
  const escaped = (value: string): string =>
    value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const worktreePath = escaped(path.resolve(worktreeURL));
  const claudeStatePath = escaped(path.join(os.homedir(), ".claude"));
  const networkRule = allowNetwork ? "(allow network-outbound)" : "(deny network*)";
  return `(version 1)
${networkRule}
(allow process*)
(allow file-read*)
(allow file-write*
    (subpath "${worktreePath}")
    (subpath "${claudeStatePath}")
    (subpath "/tmp"))
`;
}
