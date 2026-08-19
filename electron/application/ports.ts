// Port of OctoPunk/OctoPunk/Application/Ports/AgentPorts.swift.

import type { ChildAgentKind, TaskExecutionMode, TaskWorkspaceKind } from "../domain/models";
import type { DiffPageDTO, DiffTreeEntryDTO } from "../../shared/dtos";

export type { ChildAgentKind, TaskExecutionMode, TaskWorkspaceKind };

export class CancellationError extends Error {
  constructor(message = "Cancelled") {
    super(message);
    this.name = "CancellationError";
  }
}

/** Tool profiles granted to the child per execution mode. */
export const ChildAgentToolProfile = {
  readOnly: ["Read", "Glob", "Grep"],
  implementation: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
} as const;

export function toolProfileForExecutionMode(mode: TaskExecutionMode): string[] {
  return mode === "read_only" ? [...ChildAgentToolProfile.readOnly] : [...ChildAgentToolProfile.implementation];
}

/**
 * Per-task restricted OctoPunk STDIO MCP server binding. The session is
 * bound by environment variables; the child can never override which run
 * or task it belongs to.
 */
export const OctoPunkContextServer = {
  runIDEnvironmentKey: "OCTOPUNK_SESSION_RUN_ID",
  taskIDEnvironmentKey: "OCTOPUNK_SESSION_TASK_ID",

  make(executablePath: string, runID: string, taskID: string) {
    return {
      executablePath,
      runID,
      taskID,
      environment: {
        [OctoPunkContextServer.runIDEnvironmentKey]: runID,
        [OctoPunkContextServer.taskIDEnvironmentKey]: taskID,
      } as Record<string, string>,
    };
  },
};

export type OctoPunkContextServerBinding = ReturnType<typeof OctoPunkContextServer.make>;

export interface ChildAgentEnvironment {
  repositoryURL: string;
  worktreeURL: string;
  agentKind: ChildAgentKind;
  executionMode: TaskExecutionMode;
  workspaceKind: TaskWorkspaceKind;
  allowNetwork: boolean;
  allowedTools: string[];
  contextServer: OctoPunkContextServerBinding | null;
  /** Settings → 子 Agent 模型 override; null keeps the agent's own default. */
  childModel: string | null;
}

export function makeChildAgentEnvironment(init: {
  repositoryURL: string;
  worktreeURL: string;
  agentKind?: ChildAgentKind;
  executionMode?: TaskExecutionMode;
  workspaceKind?: TaskWorkspaceKind;
  allowNetwork?: boolean;
  allowedTools?: string[] | null;
  contextServer?: OctoPunkContextServerBinding | null;
  childModel?: string | null;
}): ChildAgentEnvironment {
  const executionMode = init.executionMode ?? "workspace_write";
  return {
    repositoryURL: init.repositoryURL,
    worktreeURL: init.worktreeURL,
    agentKind: init.agentKind ?? "claude_code",
    executionMode,
    workspaceKind: init.workspaceKind ?? "isolated_write",
    allowNetwork: init.allowNetwork ?? false,
    allowedTools: init.allowedTools ?? toolProfileForExecutionMode(executionMode),
    contextServer: init.contextServer ?? null,
    childModel: init.childModel ?? null,
  };
}

export type ChildAgentEventKind =
  | "started"
  | "session"
  | "output"
  | "tool"
  | "completed"
  | "failed"
  | "cancelled";

export interface ChildAgentEvent {
  kind: ChildAgentEventKind;
  message?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  sessionID?: string | null;
  toolName?: string | null;
  /**
   * T016:detached 子进程的 OS pid(崩溃恢复的核对依据)。适配器在子进程
   * spawn 成功后尽力上报;获取失败时不设,消费端静默跳过。
   */
  pid?: number;
}

export type ChildAgentEventSink = (event: ChildAgentEvent) => void | Promise<void>;

export type ChildAgentFailureKind =
  | "rate_limited"
  | "timeout"
  | "authentication"
  | "protocol_error"
  | "cancelled"
  | "executable"
  | "unknown";

export class ChildAgentExecutionError extends Error {
  readonly failureKind: ChildAgentFailureKind;

  constructor(kind: ChildAgentFailureKind, message: string) {
    super(`[${kind}] ${message}`);
    this.name = "ChildAgentExecutionError";
    this.failureKind = kind;
  }
}

const REDACTION_PATTERNS: RegExp[] = [
  /bearer\s+[A-Za-z0-9._~+/-]+/gi,
  /(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
];

/** Keeps task diagnostics useful without persisting credentials. */
export const ChildAgentDiagnostics = {
  redact(value: string, limit?: number): string {
    let result = value;
    for (const pattern of REDACTION_PATTERNS) {
      result = result.replace(pattern, "[REDACTED]");
    }
    if (limit != null && result.length > limit) {
      return result.slice(result.length - limit);
    }
    return result;
  },

  failureKind(text: string): ChildAgentFailureKind {
    const normalized = text.toLowerCase();
    if (
      normalized.includes("529") ||
      normalized.includes("429") ||
      normalized.includes("rate limit") ||
      normalized.includes("too many requests") ||
      normalized.includes("overloaded") ||
      normalized.includes("访问量过大")
    ) {
      return "rate_limited";
    }
    if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("deadline exceeded")) {
      return "timeout";
    }
    if (
      normalized.includes("not logged") ||
      normalized.includes("no api key") ||
      normalized.includes("unauthorized") ||
      normalized.includes("authentication") ||
      normalized.includes("login required")
    ) {
      return "authentication";
    }
    if (normalized.includes("cancel") || normalized.includes("interrupted")) {
      return "cancelled";
    }
    if (normalized.includes("json-rpc") || normalized.includes("protocol") || normalized.includes("invalid response")) {
      return "protocol_error";
    }
    if (normalized.includes("executable") || normalized.includes("not found")) {
      return "executable";
    }
    return "unknown";
  },

  /**
   * Transient provider/transport failures are worth an automatic retry;
   * configuration, auth, and unknown failures are not (retrying cannot fix
   * them and burns the attempt budget).
   */
  isRetryable(kind: ChildAgentFailureKind): boolean {
    return kind === "rate_limited" || kind === "timeout" || kind === "protocol_error";
  },
};

export interface ChildAgentReport {
  sessionID: string;
  message: string;
  rawOutput: string;
  tests: string[];
  changedFiles: string[];
  diffSummary: string | null;
  blocker: string | null;
}

export interface ChildAgentAvailability {
  kind: ChildAgentKind;
  executable: string;
  isAvailable: boolean;
  detail: string;
}

export interface ChildAgentPort {
  start(
    prompt: string,
    environment: ChildAgentEnvironment,
    onEvent: ChildAgentEventSink,
    signal?: AbortSignal,
  ): Promise<ChildAgentReport>;
  resume(
    sessionID: string,
    prompt: string,
    environment: ChildAgentEnvironment,
    onEvent: ChildAgentEventSink,
    signal?: AbortSignal,
  ): Promise<ChildAgentReport>;
  cancel(sessionID: string, agentKind?: ChildAgentKind): Promise<void>;
}

export interface GitRepositoryState {
  repositoryURL: string;
  head: string;
  hasUncommittedChanges: boolean;
  branchName: string | null;
}

export interface ChildWorkspace {
  repositoryURL: string;
  branchName: string;
  worktreeURL: string;
  kind: TaskWorkspaceKind;
}

export type GitIntegrationResult =
  | { integrated: true; commit: string }
  | { integrated: false; conflict: string; details: string };

export type WorkspaceCleanupMode = "deleteBranch" | "discard";

/** Three-way diff viewpoint: baseline commit, task branch HEAD, integration worktree HEAD. */
export type GitDiffSide = "baseline" | "worktree" | "integration";

export class GitAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitAdapterError";
  }
  static worktreePathOccupied(path: string): GitAdapterError {
    return new GitAdapterError(`The requested worktree path is occupied by a non-Git directory: ${path}`);
  }
  static worktreeBranchMismatch(expected: string, actual: string): GitAdapterError {
    return new GitAdapterError(`Worktree branch mismatch. Expected ${expected}, found ${actual}.`);
  }
  static worktreeBaselineMismatch(expected: string, actual: string): GitAdapterError {
    return new GitAdapterError(`Worktree baseline mismatch. Expected ${expected}, found ${actual}.`);
  }
  static targetBranchRequired(): GitAdapterError {
    return new GitAdapterError("A target branch is required before applying the integration result.");
  }
  static targetBranchChanged(expected: string, actual: string): GitAdapterError {
    return new GitAdapterError(`The target branch moved since the run started. Expected ${expected}, found ${actual}.`);
  }
  static targetRepositoryDirty(): GitAdapterError {
    return new GitAdapterError(
      "The target repository has uncommitted changes; the integration result was not applied.",
    );
  }
  static emptyRepository(path: string): GitAdapterError {
    return new GitAdapterError(
      `The repository has no commits yet (${path}). Create an initial commit first — a TeamRun anchors its baseline on HEAD. 仓库还没有任何提交，请先完成一次初始提交再启动 TeamRun。`,
    );
  }
  static integrationWorktreeMissing(runID: string): GitAdapterError {
    return new GitAdapterError(
      `该运行的集成工作区尚未创建（octopunk/${runID}/integration）。请先执行任务集成或冲突预览，再查看 integration 侧 Diff。`,
    );
  }
  static invalidDiffCursor(cursor: string): GitAdapterError {
    return new GitAdapterError(`无法解析的 Diff 分页游标（${cursor}）。请从首页重新加载该文件的 Diff。`);
  }
}

export interface GitPort {
  inspect(repositoryURL: string): Promise<GitRepositoryState>;
  prepareWorkspace(input: {
    repositoryURL: string;
    runID: string;
    taskID: string;
    baselineCommit: string;
    branchName: string;
    worktreeURL: string;
  }): Promise<ChildWorkspace>;
  prepareReadOnlyWorkspace(input: {
    repositoryURL: string;
    runID: string;
    baselineCommit: string;
    worktreeURL: string;
  }): Promise<ChildWorkspace>;
  integrate(input: {
    repositoryURL: string;
    runID: string;
    taskID: string;
    baselineCommit: string;
    worktreeURL: string;
    taskBranch: string;
  }): Promise<GitIntegrationResult>;
  integrationHead(input: {
    repositoryURL: string;
    runID: string;
    baselineCommit: string;
  }): Promise<string>;
  applyIntegration(input: {
    repositoryURL: string;
    runID: string;
    targetBranch: string;
    baselineCommit: string;
  }): Promise<string>;
  /**
   * Change tree (numstat + name-status) for one side of the three-way diff.
   * The baseline side always compares the baseline commit against itself, so
   * an empty result is the legal answer. The integration side requires the
   * integration worktree to exist and throws a readable error otherwise.
   */
  diffTree(input: {
    repositoryURL: string;
    runID: string;
    taskID: string;
    baselineCommit: string;
    taskBranch: string;
    side: GitDiffSide;
  }): Promise<DiffTreeEntryDTO[]>;
  /**
   * One page (≤64KiB of redacted text) of the unified diff (-U3) for a single
   * file; `cursor` continues where the previous page stopped (`null` starts
   * over) and `nextCursor === null` marks the final page. Binary and oversize
   * files come back without content hunks.
   */
  diffPage(input: {
    repositoryURL: string;
    runID: string;
    taskID: string;
    baselineCommit: string;
    taskBranch: string;
    side: GitDiffSide;
    path: string;
    cursor: string | null;
  }): Promise<DiffPageDTO>;
  /**
   * Trial `merge --no-commit --no-ff` of every task branch inside the
   * integration worktree (creating it at the baseline if needed). Both
   * conflict and clean outcomes end with `merge --abort` so the worktree
   * stays untouched; conflicting paths are returned as the file list.
   */
  conflictPreview(input: {
    repositoryURL: string;
    runID: string;
    baselineCommit: string;
    taskBranches: string[];
  }): Promise<{ conflict: boolean; files: string[] }>;
  cleanupWorkspace(workspace: ChildWorkspace, mode: WorkspaceCleanupMode): Promise<void>;
}

export interface ProcessRequest {
  id: string;
  executable: string;
  arguments: string[];
  workingDirectory?: string | null;
  environment: Record<string, string>;
  sandboxProfile?: string | null;
  standardInput?: string | null;
}

export type ProcessOutputChannel = "stdout" | "stderr";

export interface ProcessOutputChunk {
  channel: ProcessOutputChannel;
  text: string;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessPort {
  run(request: ProcessRequest, signal?: AbortSignal): Promise<ProcessResult>;
  runStreaming(
    request: ProcessRequest,
    onOutput: (chunk: ProcessOutputChunk) => void,
    signal?: AbortSignal,
  ): Promise<ProcessResult>;
  /**
   * T016:processID 对应的存活子进程 OS pid(崩溃恢复核对用);进程未知或
   * 已退出时返回 null——调用方必须把 null 视为「无从核对」而非「已死亡」。
   */
  pidOf(processID: string): number | null;
  terminate(processID: string): Promise<void>;
  terminateAll(): Promise<void>;
}

export interface InteractiveProcessSession {
  send(text: string): Promise<void>;
  nextOutput(): Promise<ProcessOutputChunk | null>;
  waitForExit(): Promise<ProcessResult>;
  terminate(): Promise<void>;
}

export interface InteractiveProcessPort {
  startInteractive(request: ProcessRequest, signal?: AbortSignal): Promise<InteractiveProcessSession>;
}

export interface KeychainPort {
  loadToken(): Promise<string | null>;
  saveToken(token: string): Promise<void>;
}

export interface CodexConfigPort {
  connect(endpoint: string, tokenEnvironmentVariable: string): Promise<string | null>;
  connectStdio(command: string, arguments_: string[]): Promise<string | null>;
}

export interface LoginItemPort {
  register(): Promise<void>;
  unregister(): Promise<void>;
}

export type SkillInstallState = "not_installed" | "installed" | "update_available";

export interface SkillInstallStatus {
  kind: "claude_code" | "codex" | "pi";
  state: SkillInstallState;
  path: string;
}

export interface SkillInstallerPort {
  status(): Promise<SkillInstallStatus[]>;
  install(kind: "claude_code" | "codex" | "pi"): Promise<{ path: string; backupPath: string | null }>;
}
