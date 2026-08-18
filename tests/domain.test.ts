// Ported from OctoPunkTests/DomainTests.swift.

import { describe, expect, it } from "vitest";
import { DomainError, TeamRunPolicy } from "../electron/domain/policy";
import { makeChildTask, makeTeamRun } from "../electron/domain/models";
import { MAX_CONCURRENT_TASKS_LIMIT } from "../shared/ipc";
import { ChildAgentDiagnostics } from "../electron/application/ports";
import { renderTeamContextSummary } from "../electron/domain/models";
import { stableStringify } from "../electron/domain/events";

function task(id: string, overrides: Partial<ReturnType<typeof makeChildTask>> = {}) {
  return makeChildTask({
    id,
    runID: "11111111-1111-1111-1111-111111111111",
    title: "Task " + id,
    prompt: "prompt",
    baselineCommit: "abc",
    branchName: "branch-" + id,
    worktreePath: "/tmp/" + id,
    ...overrides,
  });
}

describe("TeamRunPolicy.validateStart", () => {
  it("rejects empty repository paths and tasks", () => {
    expect(() =>
      TeamRunPolicy.validateStart({
        repositoryPath: "  ",
        task: "task",
        maxConcurrentTasks: 3,
        maxReviewRounds: 5,
      }),
    ).toThrow(DomainError);
    expect(() =>
      TeamRunPolicy.validateStart({
        repositoryPath: "/repo",
        task: "",
        maxConcurrentTasks: 3,
        maxReviewRounds: 5,
      }),
    ).toThrow(/team task is required/i);
  });

  it("rejects concurrency outside 1...10 and non-positive review rounds", () => {
    expect(() =>
      TeamRunPolicy.validateStart({
        repositoryPath: "/repo",
        task: "task",
        maxConcurrentTasks: 11,
        maxReviewRounds: 5,
      }),
    ).toThrow(/between 1 and 10/i);
    expect(() =>
      TeamRunPolicy.validateStart({
        repositoryPath: "/repo",
        task: "task",
        maxConcurrentTasks: 0,
        maxReviewRounds: 5,
      }),
    ).toThrow(/between 1 and 10/i);
    expect(() =>
      TeamRunPolicy.validateStart({
        repositoryPath: "/repo",
        task: "task",
        maxConcurrentTasks: 4,
        maxReviewRounds: 0,
      }),
    ).toThrow(/positive/i);
  });

  it("accepts concurrency up to the limit and clamps makeTeamRun", () => {
    expect(() =>
      TeamRunPolicy.validateStart({
        repositoryPath: "/repo",
        task: "task",
        maxConcurrentTasks: MAX_CONCURRENT_TASKS_LIMIT,
        maxReviewRounds: 5,
      }),
    ).not.toThrow();
    expect(
      makeTeamRun({
        repositoryPath: "/repo",
        task: "task",
        baselineCommit: "abc",
        maxConcurrentTasks: 99,
      }).maxConcurrentTasks,
    ).toBe(MAX_CONCURRENT_TASKS_LIMIT);
  });
});

describe("TeamRunPolicy.validateAcyclic", () => {
  const dependency = (taskID: string, dependsOn: string) => ({
    id: taskID + "-" + dependsOn,
    runID: "11111111-1111-1111-1111-111111111111",
    taskID,
    dependsOnTaskID: dependsOn,
  });

  it("accepts a DAG and rejects a cycle", () => {
    const tasks = [task("a"), task("b"), task("c")];
    expect(() =>
      TeamRunPolicy.validateAcyclic(tasks, [dependency("c", "a"), dependency("c", "b")]),
    ).not.toThrow();
    expect(() =>
      TeamRunPolicy.validateAcyclic(tasks, [dependency("a", "b"), dependency("b", "a")]),
    ).toThrow(/cycle/i);
  });
});

describe("TeamRunPolicy.nextRunStatus", () => {
  it("maps verdicts like the Swift policy", () => {
    expect(TeamRunPolicy.nextRunStatus("PASS")).toBe("awaiting_final_review");
    expect(TeamRunPolicy.nextRunStatus("REWORK")).toBe("reviewing");
    expect(TeamRunPolicy.nextRunStatus("BLOCKED")).toBe("blocked");
  });
});

describe("TeamRunPolicy.validateReviewRound", () => {
  it("enforces the review limit", () => {
    const run = makeTeamRun({
      repositoryPath: "/repo",
      task: "task",
      baselineCommit: "abc",
      maxReviewRounds: 2,
      currentReviewRound: 2,
    });
    expect(() => TeamRunPolicy.validateReviewRound(run)).toThrow(DomainError);
    run.currentReviewRound = 1;
    expect(() => TeamRunPolicy.validateReviewRound(run)).not.toThrow();
  });
});

describe("ChildAgentDiagnostics", () => {
  it("redacts bearer tokens, keys, and sk- secrets", () => {
    const redacted = ChildAgentDiagnostics.redact(
      "bearer abc123XYZ_-./more api_key=supersecret password: hunter2 sk-1234567890abcdef stays",
    );
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("sk-1234567890abcdef");
  });

  it("caps to the trailing limit", () => {
    expect(ChildAgentDiagnostics.redact("0123456789", 4)).toBe("6789");
  });

  it("classifies failure kinds", () => {
    expect(ChildAgentDiagnostics.failureKind("HTTP 529 overloaded")).toBe("rate_limited");
    expect(ChildAgentDiagnostics.failureKind("Request timed out")).toBe("timeout");
    expect(ChildAgentDiagnostics.failureKind("Not logged in")).toBe("authentication");
    expect(ChildAgentDiagnostics.failureKind("Operation was cancelled")).toBe("cancelled");
    expect(ChildAgentDiagnostics.failureKind("invalid JSON-RPC response")).toBe("protocol_error");
    expect(ChildAgentDiagnostics.failureKind("Executable not found")).toBe("executable");
    expect(ChildAgentDiagnostics.failureKind("something else")).toBe("unknown");
  });
});

describe("renderTeamContextSummary", () => {
  it("renders deterministic task lines with report availability", () => {
    const run = makeTeamRun({
      id: "aaaaaaaa-1111-1111-1111-111111111111",
      repositoryPath: "/repo",
      task: "Fix the build",
      baselineCommit: "0123456789abcdef",
      targetBranch: "main",
    });
    const parent = task("b", { latestReport: "report-body" });
    const child = task("c", { parentTaskID: "bbbbbbbb-2222-2222-2222-222222222222", id: "cccccccc-3333-3333-3333-333333333333" });
    const text = renderTeamContextSummary(
      { run, batches: [], tasks: [parent, child], dependencies: [] },
      1700000000,
    );
    expect(text).toContain("TeamRun aaaaaaaa — task: Fix the build");
    expect(text).toContain("branch: main, baseline: 0123456789");
    expect(text).toContain("report=yes(11B)");
    expect(text).toContain("report=no");
  });
});

describe("stableStringify", () => {
  it("sorts keys so idempotency replays stay byte-equal", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
