// Tests for ChildExecutionService prompt assembly, focusing on host-wide
// custom instructions (AGENTS.md-style global guidance) injection and the
// per-task model override precedence.

import { describe, expect, it } from "vitest";
import { ChildExecutionService } from "../electron/application/childExecutionService";
import type { ChildAgentEnvironment, ChildAgentReport, GitPort } from "../electron/application/ports";
import { makeChildTask, makeTeamRun, type ChildTask, type TeamRun } from "../electron/domain/models";

function makeFixture(
  globalInstructions?: () => string | null,
  childModel?: (agentKind: ChildTask["agentKind"]) => string | null,
): {
  prompts: string[];
  environments: ChildAgentEnvironment[];
  service: ChildExecutionService;
} {
  const prompts: string[] = [];
  const environments: ChildAgentEnvironment[] = [];
  const report: ChildAgentReport = {
    sessionID: "session-1",
    message: "done",
    rawOutput: "",
    tests: [],
    changedFiles: [],
    diffSummary: null,
    blocker: null,
  };
  const childAgent = {
    start: async (prompt: string, environment: ChildAgentEnvironment): Promise<ChildAgentReport> => {
      prompts.push(prompt);
      environments.push(environment);
      return report;
    },
    resume: async (_sessionID: string, prompt: string): Promise<ChildAgentReport> => {
      prompts.push(prompt);
      return report;
    },
    cancel: async (): Promise<void> => {},
  };
  const git = {
    inspect: async () => ({
      repositoryURL: "https://example.test/repo.git",
      head: "abc123",
      hasUncommittedChanges: false,
      branchName: "main",
    }),
    prepareWorkspace: async (input: {
      repositoryURL: string;
      branchName: string;
      worktreeURL: string;
    }) => ({
      repositoryURL: input.repositoryURL,
      branchName: input.branchName,
      worktreeURL: input.worktreeURL,
      kind: "isolated_write" as const,
    }),
    prepareReadOnlyWorkspace: async (input: { repositoryURL: string; worktreeURL: string }) => ({
      repositoryURL: input.repositoryURL,
      branchName: "",
      worktreeURL: input.worktreeURL,
      kind: "shared_read_only" as const,
    }),
  } as unknown as GitPort;
  const service = new ChildExecutionService({
    childAgent,
    git,
    repository: null,
    globalInstructions,
    childModel,
  });
  return { prompts, environments, service };
}

function makeRunAndTask(overrides?: Partial<ChildTask>): { run: TeamRun; task: ChildTask } {
  const run = makeTeamRun({
    repositoryPath: "https://example.test/repo.git",
    task: "root task",
    baselineCommit: "abc123",
  });
  const task = makeChildTask({
    runID: run.id,
    title: "child task",
    prompt: "Do the thing.",
    baselineCommit: "abc123",
    branchName: "octopunk/task-1",
    worktreePath: "/tmp/worktrees/task-1",
  });
  return { run, task: { ...task, ...overrides } };
}

describe("ChildExecutionService global instructions", () => {
  it("injects host-wide guidance into a start prompt before the task", async () => {
    const { prompts, service } = makeFixture(() => "Always answer in Chinese.");
    const { run, task } = makeRunAndTask();
    await service.execute(run, task);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Host-wide operator instructions (apply to every OctoPunk task on this machine):");
    expect(prompts[0]).toContain("Always answer in Chinese.");
    expect(prompts[0].indexOf("Always answer in Chinese.")).toBeLessThan(prompts[0].indexOf("Task: Do the thing."));
  });

  it("injects the same guidance on rework resume", async () => {
    const { prompts, service } = makeFixture(() => "Run tests after edits.");
    const { run, task } = makeRunAndTask({ sessionID: "thread-9" });
    await service.execute(run, task);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Run tests after edits.");
  });

  it("keeps the prompt unchanged when no guidance is configured", async () => {
    const withGuidance = makeFixture(() => "  ");
    const { prompts, service } = withGuidance;
    const { run, task } = makeRunAndTask();
    await service.execute(run, task);
    expect(prompts[0]).not.toContain("Host-wide operator instructions");
    // The original framing is intact and the task follows immediately.
    expect(prompts[0]).toContain("OctoPunk owns Git integration; never commit or push.\n\nTask: Do the thing.");
  });

  it("reads the provider fresh per execution so Settings edits apply to the next task", async () => {
    let guidance: string | null = "first";
    const { prompts, service } = makeFixture(() => guidance);
    const { run, task } = makeRunAndTask();
    await service.execute(run, task);
    guidance = "second";
    await service.execute(run, task);
    expect(prompts[0]).toContain("first");
    expect(prompts[1]).toContain("second");
  });

  it("truncates guidance beyond the 32 KiB ceiling", async () => {
    const { prompts, service } = makeFixture(() => "x".repeat(32 * 1024 + 100));
    const { run, task } = makeRunAndTask();
    await service.execute(run, task);
    expect(prompts[0]).toContain("[host-wide instructions truncated]");
    expect(prompts[0].length).toBeLessThan(32 * 1024 + 1000);
  });
});

describe("ChildExecutionService model override precedence", () => {
  it("prefers the task-level model over the per-kind setting", async () => {
    const { environments, service } = makeFixture(undefined, () => "glm-5.2");
    const { run, task } = makeRunAndTask({ model: "glm-5-air" });
    await service.execute(run, task);
    expect(environments[0].childModel).toBe("glm-5-air");
  });

  it("falls back to the per-kind setting when the task has no model", async () => {
    const { environments, service } = makeFixture(undefined, () => "glm-5.2");
    const { run, task } = makeRunAndTask();
    await service.execute(run, task);
    expect(environments[0].childModel).toBe("glm-5.2");
  });

  it("stays null when neither layer overrides", async () => {
    const { environments, service } = makeFixture();
    const { run, task } = makeRunAndTask();
    await service.execute(run, task);
    expect(environments[0].childModel).toBeNull();
  });
});
