// Port of OctoPunk/OctoPunk/Platform/Git/GitAdapter.swift.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  GitAdapterError,
  type ChildWorkspace,
  type GitIntegrationResult,
  type GitPort,
  type GitRepositoryState,
  type ProcessPort,
  type ProcessRequest,
  type ProcessResult,
  type WorkspaceCleanupMode,
} from "../application/ports";

function applicationSupportDirectory(): string {
  return path.join(os.homedir(), "Library", "Application Support");
}

export class GitAdapter implements GitPort {
  private readonly process: ProcessPort;
  private readonly gitExecutable: string;
  /**
   * In-process serialization of check-then-merge on the shared target working
   * copy: with per-session TeamRuns, two runs on the same repository may
   * complete concurrently. Cross-process races still fail loudly through the
   * dirty-branch/HEAD pre-checks and git's own index.lock.
   */
  private integrationLocks = new Map<string, Promise<unknown>>();

  constructor(process_: ProcessPort, gitExecutable = "/usr/bin/git") {
    this.process = process_;
    this.gitExecutable = gitExecutable;
  }

  async inspect(repositoryURL: string): Promise<GitRepositoryState> {
    let head: string;
    try {
      head = (await this.runGit(["-C", repositoryURL, "rev-parse", "HEAD"])).stdout.trim();
    } catch (error) {
      // An unborn HEAD (fresh `git init`, zero commits) is the common case;
      // rev-list --count --all still answers "0" there, but fails elsewhere.
      const commitCount = await this.runGit(["-C", repositoryURL, "rev-list", "--count", "--all"])
        .then((result) => result.stdout.trim())
        .catch(() => null);
      if (commitCount === "0") {
        throw GitAdapterError.emptyRepository(repositoryURL);
      }
      throw error;
    }
    const status = (await this.runGit(["-C", repositoryURL, "status", "--porcelain"])).stdout;
    const branch = await this.currentBranch(repositoryURL).catch(() => "");
    return {
      repositoryURL,
      head,
      hasUncommittedChanges: status.trim().length > 0,
      branchName: branch.length > 0 ? branch : null,
    };
  }

  async prepareWorkspace(input: {
    repositoryURL: string;
    runID: string;
    taskID: string;
    baselineCommit: string;
    branchName: string;
    worktreeURL: string;
  }): Promise<ChildWorkspace> {
    fs.mkdirSync(path.dirname(input.worktreeURL), { recursive: true });
    const worktreeMarker = path.join(input.worktreeURL, ".git");
    const worktreeExists = fs.existsSync(input.worktreeURL);
    const isExistingWorktree = fs.existsSync(worktreeMarker);
    if (worktreeExists && !isExistingWorktree) {
      throw GitAdapterError.worktreePathOccupied(input.worktreeURL);
    }
    if (!isExistingWorktree) {
      try {
        await this.runGit([
          "-C",
          input.repositoryURL,
          "worktree",
          "add",
          "-b",
          input.branchName,
          input.worktreeURL,
          input.baselineCommit,
        ]);
      } catch (error) {
        const exists = await this.branchExists(input.repositoryURL, input.branchName);
        if (!exists) throw error;
        await this.runGit(["-C", input.repositoryURL, "worktree", "add", input.worktreeURL, input.branchName]);
      }
      await this.verifyWorktree(input.worktreeURL, input.branchName, input.baselineCommit);
    } else {
      await this.verifyWorktree(input.worktreeURL, input.branchName, null);
    }
    return {
      repositoryURL: input.repositoryURL,
      branchName: input.branchName,
      worktreeURL: input.worktreeURL,
      kind: "isolated_write",
    };
  }

  async prepareReadOnlyWorkspace(input: {
    repositoryURL: string;
    runID: string;
    baselineCommit: string;
    worktreeURL: string;
  }): Promise<ChildWorkspace> {
    fs.mkdirSync(path.dirname(input.worktreeURL), { recursive: true });
    const worktreeMarker = path.join(input.worktreeURL, ".git");
    const worktreeExists = fs.existsSync(input.worktreeURL);
    const isExistingWorktree = fs.existsSync(worktreeMarker);
    if (worktreeExists && !isExistingWorktree) {
      throw GitAdapterError.worktreePathOccupied(input.worktreeURL);
    }
    if (!isExistingWorktree) {
      await this.runGit([
        "-C",
        input.repositoryURL,
        "worktree",
        "add",
        "--detach",
        input.worktreeURL,
        input.baselineCommit,
      ]);
    }
    await this.verifyReadOnlyWorktree(input.worktreeURL, input.baselineCommit);
    return {
      repositoryURL: input.repositoryURL,
      branchName: "",
      worktreeURL: input.worktreeURL,
      kind: "shared_read_only",
    };
  }

  async integrate(input: {
    repositoryURL: string;
    runID: string;
    taskID: string;
    baselineCommit: string;
    worktreeURL: string;
    taskBranch: string;
  }): Promise<GitIntegrationResult> {
    try {
      const status = (await this.runGit(["-C", input.worktreeURL, "status", "--porcelain"])).stdout;
      if (status.trim().length > 0) {
        await this.runGit(["-C", input.worktreeURL, "add", "--all"]);
        await this.runGit([
          "-C",
          input.worktreeURL,
          "commit",
          "--no-verify",
          "-m",
          `OctoPunk: integrate task ${input.taskID}`,
        ]);
      }
    } catch (error) {
      return {
        integrated: false,
        conflict: `Could not create the OctoPunk integration commit: ${errorMessage(error)}`,
        details: `Could not create the OctoPunk integration commit: ${errorMessage(error)}`,
      };
    }

    const integrationURL = await this.ensureIntegrationWorktree(
      input.repositoryURL,
      input.runID,
      input.baselineCommit,
    );

    try {
      const taskCommit = (await this.runGit(["-C", integrationURL, "rev-parse", input.taskBranch])).stdout.trim();
      const integrationHead = (await this.runGit(["-C", integrationURL, "rev-parse", "HEAD"])).stdout.trim();
      const commonAncestor = (
        await this.runGit(["-C", integrationURL, "merge-base", input.taskBranch, "HEAD"])
      ).stdout.trim();
      if (commonAncestor === taskCommit) {
        return { integrated: true, commit: integrationHead };
      }
      await this.runGit(["-C", integrationURL, "merge", "--no-ff", "--no-edit", input.taskBranch]);
      const commit = (await this.runGit(["-C", integrationURL, "rev-parse", "HEAD"])).stdout.trim();
      return { integrated: true, commit };
    } catch (error) {
      await this.runGit(["-C", integrationURL, "merge", "--abort"]).catch(() => {});
      return { integrated: false, conflict: errorMessage(error), details: errorMessage(error) };
    }
  }

  async integrationHead(input: {
    repositoryURL: string;
    runID: string;
    baselineCommit: string;
  }): Promise<string> {
    const integrationURL = await this.ensureIntegrationWorktree(
      input.repositoryURL,
      input.runID,
      input.baselineCommit,
    );
    return (await this.runGit(["-C", integrationURL, "rev-parse", "HEAD"])).stdout.trim();
  }

  async applyIntegration(input: {
    repositoryURL: string;
    runID: string;
    targetBranch: string;
    baselineCommit: string;
  }): Promise<string> {
    const previous = this.integrationLocks.get(input.repositoryURL) ?? Promise.resolve();
    const next = previous.then(
      () => this.applyIntegrationLocked(input),
      () => this.applyIntegrationLocked(input),
    );
    this.integrationLocks.set(
      input.repositoryURL,
      next.catch(() => {}),
    );
    return await next;
  }

  private async applyIntegrationLocked(input: {
    repositoryURL: string;
    runID: string;
    targetBranch: string;
    baselineCommit: string;
  }): Promise<string> {
    if (input.targetBranch.length === 0) throw GitAdapterError.targetBranchRequired();
    const actualBranch = await this.currentBranch(input.repositoryURL);
    if (actualBranch !== input.targetBranch) {
      throw GitAdapterError.targetBranchChanged(input.targetBranch, actualBranch);
    }
    const status = (await this.runGit(["-C", input.repositoryURL, "status", "--porcelain"])).stdout;
    if (status.trim().length > 0) {
      throw GitAdapterError.targetRepositoryDirty();
    }

    const currentHead = (await this.runGit(["-C", input.repositoryURL, "rev-parse", "HEAD"])).stdout.trim();
    const branch = this.integrationBranch(input.runID);
    if (!(await this.branchExists(input.repositoryURL, branch))) {
      if (currentHead !== input.baselineCommit) {
        throw GitAdapterError.targetBranchChanged(input.baselineCommit, currentHead);
      }
      return currentHead;
    }
    const integrationHeadCommit = (
      await this.runGit(["-C", input.repositoryURL, "rev-parse", branch])
    ).stdout.trim();
    if (currentHead === integrationHeadCommit) return currentHead;
    if (currentHead !== input.baselineCommit) {
      throw GitAdapterError.targetBranchChanged(input.baselineCommit, currentHead);
    }
    await this.runGit(["-C", input.repositoryURL, "merge", "--no-ff", "--no-edit", branch]);
    return (await this.runGit(["-C", input.repositoryURL, "rev-parse", "HEAD"])).stdout.trim();
  }

  async cleanupWorkspace(workspace: ChildWorkspace, mode: WorkspaceCleanupMode): Promise<void> {
    if (fs.existsSync(workspace.worktreeURL)) {
      await this.runGit([
        "-C",
        workspace.repositoryURL,
        "worktree",
        "remove",
        "--force",
        workspace.worktreeURL,
      ]);
    }
    await this.runGit(["-C", workspace.repositoryURL, "worktree", "prune"]);
    if (workspace.kind !== "isolated_write") return;
    if (!(await this.branchExists(workspace.repositoryURL, workspace.branchName))) return;
    if (mode === "deleteBranch") {
      await this.runGit(["-C", workspace.repositoryURL, "branch", "-d", workspace.branchName]);
    } else {
      await this.runGit(["-C", workspace.repositoryURL, "branch", "-D", workspace.branchName]);
    }
  }

  private async runGit(args: string[]): Promise<ProcessResult> {
    return await this.process.run({
      id: randomUUID(),
      executable: this.gitExecutable,
      arguments: args,
      environment: {},
    });
  }

  private async currentBranch(repositoryURL: string): Promise<string> {
    return (await this.runGit(["-C", repositoryURL, "branch", "--show-current"])).stdout.trim();
  }

  private async branchExists(repositoryURL: string, branchName: string): Promise<boolean> {
    if (branchName.length === 0) return false;
    try {
      await this.runGit([
        "-C",
        repositoryURL,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branchName}`,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private async verifyWorktree(
    worktreeURL: string,
    branchName: string,
    expectedBaseline: string | null,
  ): Promise<void> {
    const actualBranch = (await this.runGit(["-C", worktreeURL, "branch", "--show-current"])).stdout.trim();
    if (actualBranch !== branchName) {
      throw GitAdapterError.worktreeBranchMismatch(branchName, actualBranch);
    }
    if (expectedBaseline == null) return;
    const actualHead = (await this.runGit(["-C", worktreeURL, "rev-parse", "HEAD"])).stdout.trim();
    if (actualHead !== expectedBaseline) {
      throw GitAdapterError.worktreeBaselineMismatch(expectedBaseline, actualHead);
    }
  }

  private async verifyReadOnlyWorktree(worktreeURL: string, expectedBaseline: string): Promise<void> {
    const actualBranch = (await this.runGit(["-C", worktreeURL, "branch", "--show-current"])).stdout.trim();
    if (actualBranch.length > 0) {
      throw GitAdapterError.worktreeBranchMismatch("detached HEAD", actualBranch);
    }
    const actualHead = (await this.runGit(["-C", worktreeURL, "rev-parse", "HEAD"])).stdout.trim();
    if (actualHead !== expectedBaseline) {
      throw GitAdapterError.worktreeBaselineMismatch(expectedBaseline, actualHead);
    }
  }

  private async ensureIntegrationWorktree(
    repositoryURL: string,
    runID: string,
    baselineCommit: string,
  ): Promise<string> {
    const integrationURL = path.join(
      applicationSupportDirectory(),
      "OctoPunk",
      "integration",
      runID,
    );
    fs.mkdirSync(path.dirname(integrationURL), { recursive: true });
    const marker = path.join(integrationURL, ".git");
    if (fs.existsSync(integrationURL) && !fs.existsSync(marker)) {
      throw GitAdapterError.worktreePathOccupied(integrationURL);
    }
    if (!fs.existsSync(marker)) {
      await this.runGit([
        "-C",
        repositoryURL,
        "worktree",
        "add",
        "-B",
        this.integrationBranch(runID),
        integrationURL,
        baselineCommit,
      ]);
    }
    return integrationURL;
  }

  private integrationBranch(runID: string): string {
    return `octopunk/${runID}/integration`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function taskWorktreeRoot(runID: string): string {
  return path.join(applicationSupportDirectory(), "OctoPunk", "worktrees", runID);
}

export function sharedReadOnlyWorktreeURL(runID: string, baselineCommit: string): string {
  const safeBaseline = Array.from(baselineCommit)
    .map((character) => (/[A-Za-z0-9_-]/.test(character) ? character : "-"))
    .join("");
  const suffix = safeBaseline.slice(0, 64);
  return path.join(taskWorktreeRoot(runID), "readonly", suffix);
}

export function integrationWorktreeURL(runID: string): string {
  return path.join(applicationSupportDirectory(), "OctoPunk", "integration", runID);
}
