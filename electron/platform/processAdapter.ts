// Port of OctoPunk/OctoPunk/Platform/Process/LocalProcessAdapter.swift.
// Uses node:child_process with a dedicated process group so termination
// reaches the whole child tree, and /usr/bin/sandbox-exec for the offline
// sandbox profile exactly like the Swift adapter.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ChildAgentDiagnostics,
  CancellationError,
  type InteractiveProcessPort,
  type InteractiveProcessSession,
  type ProcessOutputChunk,
  type ProcessPort,
  type ProcessRequest,
  type ProcessResult,
} from "../application/ports";

export class LocalProcessError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
    readonly stdout?: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "LocalProcessError";
  }

  static executableNotFound(path_: string): LocalProcessError {
    return new LocalProcessError(`Executable not found: ${path_}`);
  }

  static failedToLaunch(message: string): LocalProcessError {
    return new LocalProcessError(`Could not launch process: ${message}`);
  }

  static nonZeroExit(code: number, stdout: string, stderr: string): LocalProcessError {
    const diagnostic = ChildAgentDiagnostics.redact(
      [stderr, stdout].filter((value) => value.length > 0).join("\n"),
      1024,
    ).trim();
    return new LocalProcessError(
      diagnostic.length === 0 ? `Process exited with ${code}.` : `Process exited with ${code}: ${diagnostic}`,
      code,
      stdout,
      stderr,
    );
  }
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Small allow-list instead of inheriting the full Finder/Terminal environment. */
export const OctoPunkProcessEnvironment = {
  minimum(): Record<string, string> {
    const source = process.env as Record<string, string | undefined>;
    const allowed = [
      "HOME",
      "PATH",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "USER",
      "LOGNAME",
      "SHELL",
    ];
    const result: Record<string, string> = {};
    for (const key of allowed) {
      const value = source[key];
      if (value != null) result[key] = value;
    }
    if (!result.PATH || result.PATH.length === 0) {
      result.PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    }
    return result;
  },
};

interface ManagedProcess {
  child: ChildProcess;
  hasProcessGroup: boolean;
}

export function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return existsSync(file);
  } catch {
    return false;
  }
}

/** Push-back output queue shared by streaming and interactive consumers. */
class OutputQueue {
  private values: ProcessOutputChunk[] = [];
  private waiter: ((value: ProcessOutputChunk | null) => void) | null = null;
  private finished = false;

  push(value: ProcessOutputChunk): void {
    if (this.finished) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(value);
    } else {
      this.values.push(value);
    }
  }

  async next(): Promise<ProcessOutputChunk | null> {
    if (this.values.length > 0) return this.values.shift() as ProcessOutputChunk;
    if (this.finished) return null;
    return await new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  finish(): void {
    this.finished = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(null);
    }
  }
}

class LocalInteractiveProcessSession implements InteractiveProcessSession {
  private inputClosed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly stdin: NodeJS.WritableStream | null,
    private readonly outputQueue: OutputQueue,
    private readonly completion: { wait: () => Promise<ProcessResult> },
    private readonly hasProcessGroup: boolean,
  ) {}

  async send(text: string): Promise<void> {
    if (this.inputClosed || this.stdin == null) {
      throw LocalProcessError.failedToLaunch("Process standard input is closed.");
    }
    await new Promise<void>((resolve, reject) => {
      this.stdin!.write(text, "utf8", (error) => (error ? reject(error) : resolve()));
    });
  }

  async nextOutput(): Promise<ProcessOutputChunk | null> {
    return await this.outputQueue.next();
  }

  async waitForExit(): Promise<ProcessResult> {
    return await this.completion.wait();
  }

  async terminate(): Promise<void> {
    if (this.child.exitCode == null && !this.child.killed) {
      if (this.hasProcessGroup && this.child.pid) {
        try {
          process.kill(-this.child.pid, "SIGTERM");
        } catch {
          this.child.kill("SIGTERM");
        }
      } else {
        this.child.kill("SIGTERM");
      }
      const pid = this.child.pid;
      const group = this.hasProcessGroup;
      setTimeout(() => {
        if (this.child.exitCode != null && this.child.exitCode !== null) return;
        try {
          if (group && pid) process.kill(-pid, "SIGKILL");
          else if (pid) process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }, 5000).unref();
    }
  }

  closeInput(): void {
    if (this.inputClosed) return;
    this.inputClosed = true;
    this.stdin?.end();
  }
}

export class LocalProcessAdapter implements ProcessPort, InteractiveProcessPort {
  private processes = new Map<string, ManagedProcess>();

  async run(request: ProcessRequest, signal?: AbortSignal): Promise<ProcessResult> {
    return await this.runStreaming(request, () => {}, signal);
  }

  async runStreaming(
    request: ProcessRequest,
    onOutput: (chunk: ProcessOutputChunk) => void,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    const { session, managed } = this.start(request, onOutput, false);
    const abortListener = (): void => {
      void this.terminateProcess(managed, request.id);
    };
    signal?.addEventListener("abort", abortListener, { once: true });
    try {
      const result = await session.waitForExit();
      if (signal?.aborted) throw new CancellationError();
      if (result.exitCode !== 0) {
        throw LocalProcessError.nonZeroExit(result.exitCode, result.stdout, result.stderr);
      }
      return result;
    } finally {
      signal?.removeEventListener("abort", abortListener);
      this.processes.delete(request.id);
    }
  }

  async startInteractive(request: ProcessRequest, signal?: AbortSignal): Promise<InteractiveProcessSession> {
    const { session, managed } = this.start(request, () => {}, true);
    signal?.addEventListener(
      "abort",
      () => {
        void this.terminateProcess(managed, request.id);
      },
      { once: true },
    );
    return session;
  }

  async terminate(processID: string): Promise<void> {
    const managed = this.processes.get(processID);
    if (!managed) return;
    this.signalProcess(managed, "SIGTERM");
    this.scheduleForcedTermination(processID);
  }

  pidOf(processID: string): number | null {
    // T016:复用既有 processID→child 注册表,只读不改。判活是必须的:
    // ChildProcess.pid 在退出后仍保留旧值,而交互式会话的注册表条目由
    // 适配器生命周期持有(流式运行则由 runStreaming 的 finally 移除),
    // 残留条目不能把已死进程的 pid 报给崩溃恢复探活。信号杀死时
    // exitCode 为 null 而 signalCode 置位;kill() 已发出但 exit 事件尚未
    // 派发的微小窗口按「垂死」处理,返回 null。
    const managed = this.processes.get(processID);
    const child = managed?.child;
    if (
      child == null ||
      child.exitCode != null ||
      child.signalCode != null ||
      child.killed
    ) {
      return null;
    }
    return child.pid ?? null;
  }

  async terminateAll(): Promise<void> {
    for (const processID of [...this.processes.keys()]) {
      await this.terminate(processID);
    }
  }

  private start(
    request: ProcessRequest,
    onOutput: (chunk: ProcessOutputChunk) => void,
    keepInputOpen: boolean,
  ): { session: LocalInteractiveProcessSession; managed: ManagedProcess } {
    if (!isExecutable(request.executable)) {
      throw LocalProcessError.executableNotFound(request.executable);
    }
    const useSandbox = request.sandboxProfile != null && isExecutable(SANDBOX_EXEC);
    const executable = useSandbox ? SANDBOX_EXEC : request.executable;
    const args = useSandbox ? ["-p", request.sandboxProfile as string, request.executable, ...request.arguments] : request.arguments;

    const child = spawn(executable, args, {
      cwd: request.workingDirectory ?? undefined,
      env: { ...OctoPunkProcessEnvironment.minimum(), ...request.environment },
      // Non-interactive commands without supplied input must see an immediate
      // EOF; keeping stdin as a pipe would make Claude Code wait for input.
      stdio: [
        keepInputOpen || request.standardInput != null ? "pipe" : "ignore",
        "pipe",
        "pipe",
      ],
      detached: true,
    });
    child.on("error", () => {
      // surfaced through the exit collector below
    });

    let stdoutData = "";
    let stderrData = "";
    const outputQueue = new OutputQueue();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => {
      stdoutData += text;
      const chunk: ProcessOutputChunk = { channel: "stdout", text };
      onOutput(chunk);
      outputQueue.push(chunk);
    });
    child.stderr?.on("data", (text: string) => {
      stderrData += text;
      const chunk: ProcessOutputChunk = { channel: "stderr", text };
      onOutput(chunk);
      outputQueue.push(chunk);
    });

    const exitPromise = new Promise<ProcessResult>((resolve) => {
      child.on("close", (code) => {
        outputQueue.finish();
        resolve({
          exitCode: code ?? -1,
          stdout: stdoutData,
          stderr: stderrData,
        });
      });
    });
    const completion = { wait: (): Promise<ProcessResult> => exitPromise };

    // Best effort only: a dedicated process group exists because we always
    // spawn detached; negative-PID signaling then reaches descendants.
    const hasProcessGroup = child.pid != null && child.pid > 0;
    const session = new LocalInteractiveProcessSession(
      child,
      child.stdin ?? null,
      outputQueue,
      completion,
      hasProcessGroup,
    );
    const managed: ManagedProcess = { child, hasProcessGroup };
    this.processes.set(request.id, managed);

    if (request.standardInput != null && request.standardInput.length > 0) {
      void session.send(request.standardInput).catch(() => {});
    }
    if (!keepInputOpen) {
      session.closeInput();
    }
    return { session, managed };
  }

  private signalProcess(managed: ManagedProcess, signal: NodeJS.Signals): void {
    if (managed.child.exitCode != null) return;
    if (managed.hasProcessGroup && managed.child.pid) {
      try {
        process.kill(-managed.child.pid, signal);
        return;
      } catch {
        // fall through to direct kill
      }
    }
    try {
      managed.child.kill(signal);
    } catch {
      // Already gone.
    }
  }

  private scheduleForcedTermination(processID: string): void {
    setTimeout(() => {
      const managed = this.processes.get(processID);
      if (!managed || managed.child.exitCode != null) return;
      this.signalProcess(managed, "SIGKILL");
    }, 5000).unref();
  }

  private async terminateProcess(managed: ManagedProcess, processID: string): Promise<void> {
    this.signalProcess(managed, "SIGTERM");
    this.scheduleForcedTermination(processID);
  }
}

export function temporaryDirectory(): string {
  return os.tmpdir();
}

export function temporaryFile(name: string): string {
  return path.join(os.tmpdir(), name);
}

export function newProcessID(): string {
  return randomUUID();
}
