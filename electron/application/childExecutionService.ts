// Port of OctoPunk/OctoPunk/Application/Services/ChildExecutionService.swift.

import { OctoPunkContextServer, ChildAgentDiagnostics, type ChildAgentEvent, type ChildAgentReport, type ChildWorkspace, type GitPort } from "./ports";
import { makeChildAgentEnvironment, toolProfileForExecutionMode } from "./ports";
import type { ChildAgentKind } from "../domain/models";
import type { ChildTask, ReviewFeedback, TeamRun } from "../domain/models";
import type { TeamRunRepository } from "../domain/repositoryPort";
import { isExecutable } from "../platform/processAdapter";

interface SharedPreparation {
  promise: Promise<ChildWorkspace>;
}

export class ChildExecutionService {
  private readonly childAgent: { cancel(sessionID: string, agentKind?: ChildAgentKind): Promise<void> } & (
    | {
        start: (
          prompt: string,
          environment: ReturnType<typeof makeChildAgentEnvironment>,
          onEvent: (event: ChildAgentEvent) => void | Promise<void>,
          signal?: AbortSignal,
        ) => Promise<ChildAgentReport>;
        resume: (
          sessionID: string,
          prompt: string,
          environment: ReturnType<typeof makeChildAgentEnvironment>,
          onEvent: (event: ChildAgentEvent) => void | Promise<void>,
          signal?: AbortSignal,
        ) => Promise<ChildAgentReport>;
      }
  );
  private readonly git: GitPort;
  private readonly repository: TeamRunRepository | null;
  private readonly allowNetwork: boolean;
  /** Read fresh at every execution so Settings edits apply to the next task. */
  private readonly globalInstructions?: () => string | null;
  /** Settings → 子 Agent 模型 override per agent kind, read at execution time. */
  private readonly childModel?: (agentKind: ChildAgentKind) => string | null;
  /** Path to this OctoPunk executable, spawned per task as a restricted context MCP server. */
  private readonly selfExecutablePath: string | null;
  /** Coalesces the first detached worktree creation for read-only children. */
  private sharedReadOnlyPreparations = new Map<string, SharedPreparation>();

  constructor(input: {
    childAgent: ChildExecutionService["childAgent"];
    git: GitPort;
    repository?: TeamRunRepository | null;
    allowNetwork?: boolean;
    selfExecutablePath?: string | null;
    globalInstructions?: () => string | null;
    childModel?: (agentKind: ChildAgentKind) => string | null;
  }) {
    this.childAgent = input.childAgent;
    this.git = input.git;
    this.repository = input.repository ?? null;
    this.allowNetwork = input.allowNetwork ?? false;
    this.globalInstructions = input.globalInstructions;
    this.childModel = input.childModel;
    const candidate = input.selfExecutablePath ?? process.execPath;
    this.selfExecutablePath = isExecutable(candidate) ? candidate : null;
  }

  async execute(
    run: TeamRun,
    task: ChildTask,
    repositoryURL: string,
    reviewFeedback: ReviewFeedback | null = null,
    signal?: AbortSignal,
  ): Promise<ChildAgentReport> {
    const worktreeURL = task.worktreePath;
    let workspace: ChildWorkspace;
    if (task.executionMode === "read_only") {
      workspace = await this.prepareSharedReadOnlyWorkspace({
        repositoryURL,
        runID: run.id,
        baselineCommit: task.baselineCommit,
        worktreeURL,
      });
    } else {
      workspace = await this.git.prepareWorkspace({
        repositoryURL,
        runID: run.id,
        taskID: task.id,
        baselineCommit: task.baselineCommit,
        branchName: task.branchName,
        worktreeURL,
      });
    }

    const environment = makeChildAgentEnvironment({
      repositoryURL,
      worktreeURL: workspace.worktreeURL,
      agentKind: task.agentKind,
      executionMode: task.executionMode,
      workspaceKind: workspace.kind,
      allowNetwork: this.allowNetwork,
      allowedTools: toolProfileForExecutionMode(task.executionMode),
      contextServer: this.selfExecutablePath
        ? OctoPunkContextServer.make(this.selfExecutablePath, run.id, task.id)
        : null,
      childModel: task.model ?? this.childModel?.(task.agentKind) ?? null,
    });
    const taskExecutionInstructions =
      task.executionMode === "read_only"
        ? `Inspect the requested scope and report findings with supporting file locations.
Do not create, edit, or delete files. Bash, Web, Computer, commit, and push are unavailable.`
        : `Complete the task in this isolated worktree and run the most relevant local verification.
Use only local development tools required by this task. Web, Computer, git commit, and git push are unavailable.
Report what changed, what was verified, changed files, a concise diff summary, and any blocker.`;
    let reviewSection = "";
    if (reviewFeedback != null) {
      const findings = reviewFeedback.findings
        .map((finding, index) => {
          const location =
            finding.file != null
              ? finding.file + (finding.line != null ? `:${finding.line}` : "")
              : "unspecified location";
          const expectedFix = finding.expectedFix != null ? ` Expected fix: ${finding.expectedFix}` : "";
          return `${index + 1}. [${finding.severity}] ${location}: ${finding.evidence}${expectedFix}`;
        })
        .join("\n");
      reviewSection = `

OctoPunk review feedback for this rework round:
Summary: ${reviewFeedback.summary}
Findings:
${findings.length === 0 ? "- No file-level finding was supplied; re-check the summary and tests." : findings}
Resolve every finding, run the relevant tests again, and explicitly report how each finding was addressed.`;
    }
    const inheritedContext = task.contextSnapshot.trim();
    let dependencySection = "";
    if (this.repository != null) {
      const snapshot = await this.repository.snapshot(run.id).catch(() => null);
      if (snapshot != null) {
        const dependencyIDs = snapshot.dependencies
          .filter((dependency) => dependency.taskID === task.id)
          .map((dependency) => dependency.dependsOnTaskID);
        const dependencyReports = dependencyIDs
          .map((dependencyID) => {
            const dependency = snapshot.tasks.find((candidate) => candidate.id === dependencyID);
            if (dependency == null || dependency.latestReport == null) return null;
            return `- ${dependency.title}: ${ChildAgentDiagnostics.redact(dependency.latestReport, 4096)}`;
          })
          .filter((report): report is string => report != null);
        let parentReport: string | null = null;
        if (task.parentTaskID != null) {
          const parent = snapshot.tasks.find((candidate) => candidate.id === task.parentTaskID);
          if (parent != null && parent.latestReport != null) {
            parentReport = `- ${parent.title}: ${ChildAgentDiagnostics.redact(parent.latestReport, 4096)}`;
          }
        }
        const inheritedReports = (parentReport != null ? [parentReport] : []).concat(dependencyReports);
        if (inheritedReports.length > 0) {
          dependencySection = `

Completed parent/dependency reports:
${inheritedReports.join("\n")}`;
        }
      }
    }
    const contextSection =
      inheritedContext.length === 0
        ? ""
        : `

Parent Agent context snapshot:
${inheritedContext}`;
    // AGENTS.md-style global guidance: host-wide operator instructions come
    // before task-specific content so later sections stay more specific.
    const guidance = this.globalInstructions != null ? (this.globalInstructions() ?? "").trim() : "";
    const guidanceSection =
      guidance.length === 0
        ? ""
        : `

Host-wide operator instructions (apply to every OctoPunk task on this machine):
${capGlobalInstructions(guidance)}`;
    const prompt = `You are an external ${displayName(task.agentKind)} sub-agent managed by OctoPunk.
Work only inside the supplied worktree. The repository baseline is ${task.baselineCommit}.
${taskExecutionInstructions}
OctoPunk owns Git integration; never commit or push.${guidanceSection}

Task: ${task.prompt}
${contextSection}${dependencySection}
${reviewSection}
`;
    const repositoryRef = this.repository;
    const runID = run.id;
    const taskID = task.id;
    const eventSink = (event: ChildAgentEvent): void => {
      if (repositoryRef == null) return;
      // T016 PID 持久化:本 sink 是子任务事件管道在 recordTaskExecutionEvent
      // 之前的唯一消费点,在此拦截适配器上报的 pid 字段并尽力写入
      // task_attempts.pid(崩溃恢复的核对依据)。task.currentAttemptID 为空
      // (尚未 markTaskRunning)或写库失败时静默跳过——pid 是尽力而为的
      // 核对辅助,不得影响事件管道本身。
      if (event.pid != null) {
        const pid = event.pid;
        void repositoryRef
          .snapshot(runID)
          .then((snapshot) => {
            const current = snapshot.tasks.find((candidate) => candidate.id === taskID);
            const attemptID = current?.currentAttemptID;
            if (attemptID == null) return;
            return repositoryRef.updateAttemptPid({ runID, taskID, attemptID, pid });
          })
          .catch(() => {});
      }
      void repositoryRef
        .recordTaskExecutionEvent({ runID, taskID, event })
        .catch(() => {});
    };
    if (task.sessionID != null) {
      return await this.childAgent.resume(task.sessionID, prompt, environment, eventSink, signal);
    }
    return await this.childAgent.start(prompt, environment, eventSink, signal);
  }

  async cancel(sessionID: string, agentKind?: ChildAgentKind): Promise<void> {
    await this.childAgent.cancel(sessionID, agentKind);
  }

  private async prepareSharedReadOnlyWorkspace(input: {
    repositoryURL: string;
    runID: string;
    baselineCommit: string;
    worktreeURL: string;
  }): Promise<ChildWorkspace> {
    const key = input.worktreeURL;
    const existing = this.sharedReadOnlyPreparations.get(key);
    if (existing) {
      return await existing.promise;
    }
    const git = this.git;
    const preparation: SharedPreparation = {
      promise: git.prepareReadOnlyWorkspace(input),
    };
    this.sharedReadOnlyPreparations.set(key, preparation);
    try {
      const workspace = await preparation.promise;
      this.sharedReadOnlyPreparations.delete(key);
      return workspace;
    } catch (error) {
      this.sharedReadOnlyPreparations.delete(key);
      throw error;
    }
  }
}

function displayName(kind: ChildAgentKind): string {
  return kind === "claude_code" ? "Claude Code" : "Codex";
}

/** Mirrors Codex's project_doc_max_bytes ceiling so guidance cannot starve the task prompt. */
const GLOBAL_INSTRUCTIONS_MAX_CHARS = 32 * 1024;

function capGlobalInstructions(guidance: string): string {
  return guidance.length <= GLOBAL_INSTRUCTIONS_MAX_CHARS
    ? guidance
    : guidance.slice(0, GLOBAL_INSTRUCTIONS_MAX_CHARS) + "\n…[host-wide instructions truncated]";
}
