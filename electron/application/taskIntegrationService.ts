// Port of OctoPunk/OctoPunk/Application/Services/TaskIntegrationService.swift.

import type { GitPort, WorkspaceCleanupMode } from "./ports";
import type { ChildTask, TeamRun } from "../domain/models";
import { integrationWorktreeURL } from "../platform/gitAdapter";

export class TaskIntegrationService {
  private readonly git: GitPort;

  constructor(git: GitPort) {
    this.git = git;
  }

  async integrate(run: TeamRun, task: ChildTask): Promise<import("./ports").GitIntegrationResult> {
    return await this.git.integrate({
      repositoryURL: run.repositoryPath,
      runID: run.id,
      taskID: task.id,
      baselineCommit: run.baselineCommit,
      worktreeURL: task.worktreePath,
      taskBranch: task.branchName,
    });
  }

  async dependentBaseCommit(run: TeamRun): Promise<string> {
    return await this.git.integrationHead({
      repositoryURL: run.repositoryPath,
      runID: run.id,
      baselineCommit: run.baselineCommit,
    });
  }

  async applyToTarget(run: TeamRun): Promise<string> {
    return await this.git.applyIntegration({
      repositoryURL: run.repositoryPath,
      runID: run.id,
      targetBranch: run.targetBranch,
      baselineCommit: run.baselineCommit,
    });
  }

  async cleanup(
    run: TeamRun,
    taskOrTasks: ChildTask | ChildTask[],
    mode: WorkspaceCleanupMode,
  ): Promise<void> {
    const tasks = Array.isArray(taskOrTasks) ? taskOrTasks : [taskOrTasks];
    const repositoryURL = run.repositoryPath;
    const cleanedWorktrees = new Set<string>();
    for (const task of tasks) {
      if (cleanedWorktrees.has(task.worktreePath)) continue;
      cleanedWorktrees.add(task.worktreePath);
      await this.git.cleanupWorkspace(
        {
          repositoryURL,
          branchName: task.branchName,
          worktreeURL: task.worktreePath,
          kind: task.workspaceKind,
        },
        mode,
      );
    }

    // A run containing only investigations never creates an integration
    // branch/worktree, so there is nothing additional to prune here.
    if (!tasks.some((task) => task.executionMode === "workspace_write")) return;

    await this.git.cleanupWorkspace(
      {
        repositoryURL,
        branchName: `octopunk/${run.id}/integration`,
        worktreeURL: integrationWorktreeURL(run.id),
        kind: "isolated_write",
      },
      mode,
    );
  }
}
