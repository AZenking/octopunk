// Port of OctoPunk/OctoPunk/Domain/Policies/TeamRunPolicy.swift.

import { DomainError, runStatusIsTerminal } from "./models";
import type { ChildTask, ReviewVerdict, TaskDependency, TeamRun, TeamRunStatus } from "./models";
import { MAX_CONCURRENT_TASKS_LIMIT } from "../../shared/ipc";

export const TeamRunPolicy = {
  defaultMaxConcurrentTasks: 3,
  defaultMaxReviewRounds: 5,

  validateStart(input: {
    repositoryPath: string;
    task: string;
    maxConcurrentTasks: number;
    maxReviewRounds: number;
  }): void {
    if (input.repositoryPath.trim().length === 0) {
      throw DomainError.invalidTask("A repository path is required.");
    }
    if (input.task.trim().length === 0) {
      throw DomainError.invalidTask("A team task is required.");
    }
    if (
      input.maxConcurrentTasks < 1 ||
      input.maxConcurrentTasks > MAX_CONCURRENT_TASKS_LIMIT
    ) {
      throw DomainError.invalidTask(
        `Concurrency must be between 1 and ${MAX_CONCURRENT_TASKS_LIMIT}.`,
      );
    }
    if (input.maxReviewRounds <= 0) {
      throw DomainError.invalidTask("Review rounds must be positive.");
    }
  },

  validateCanDelegate(run: TeamRun, tasks: ChildTask[], dependencies: TaskDependency[]): void {
    if (runStatusIsTerminal(run.status)) {
      throw DomainError.invalidTransition("TeamRun", run.status, "running");
    }
    const taskIDs = new Set(tasks.map((task) => task.id));
    for (const dependency of dependencies) {
      if (!taskIDs.has(dependency.dependsOnTaskID)) {
        throw DomainError.missingDependency(dependency.dependsOnTaskID);
      }
    }
    TeamRunPolicy.validateAcyclic(tasks, dependencies);
  },

  validateAcyclic(tasks: ChildTask[], dependencies: TaskDependency[]): void {
    const taskIDs = new Set(tasks.map((task) => task.id));
    const graph = new Map<string, string[]>();
    for (const dependency of dependencies) {
      if (!taskIDs.has(dependency.taskID) || !taskIDs.has(dependency.dependsOnTaskID)) {
        continue;
      }
      const list = graph.get(dependency.taskID) ?? [];
      list.push(dependency.dependsOnTaskID);
      graph.set(dependency.taskID, list);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw DomainError.dependencyCycle();
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of graph.get(id) ?? []) {
        visit(dependency);
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const task of tasks) {
      visit(task.id);
    }
  },

  nextRunStatus(verdict: ReviewVerdict): TeamRunStatus {
    switch (verdict) {
      case "PASS":
        return "awaiting_final_review";
      case "REWORK":
        return "reviewing";
      case "BLOCKED":
        return "blocked";
    }
  },

  validateReviewRound(run: TeamRun): void {
    if (!(run.currentReviewRound < run.maxReviewRounds)) {
      throw DomainError.reviewLimitReached();
    }
  },
};
