// Ported from OctoPunkTests/DatabaseTests.swift (core lifecycle) and the
// ApplicationTests flow: startTeam → delegateTasks → markTaskRunning →
// submitReport → acceptTask → completeTeam, plus idempotency replay and
// segmented observation.

import { describe, expect, it } from "vitest";
import { OctoPunkDatabase, OctoPunkDatabaseMigrator } from "../electron/data/database";
import { SqliteTeamRunRepository } from "../electron/data/repository";
import { DomainError } from "../electron/domain/models";
import { stableStringify } from "../electron/domain/events";

function makeRepository(): { repository: SqliteTeamRunRepository; db: OctoPunkDatabase } {
  const db = OctoPunkDatabase.inMemory();
  return { repository: new SqliteTeamRunRepository(db.writer), db };
}

const startInput = (requestID: string, sessionID = "session-a") => ({
  requestID,
  sessionID,
  repositoryPath: "/tmp/repo",
  task: "Fix the build",
  baselineCommit: "0123456789abcdef",
  targetBranch: "main",
  maxConcurrentTasks: 3,
  maxReviewRounds: 5,
});

describe("migrations", () => {
  it("applies all stages up to the current version", () => {
    const db = OctoPunkDatabase.inMemory();
    expect(OctoPunkDatabaseMigrator.readVersion(db.writer)).toBe(9);
    const teamRunsColumns = (
      db.writer.prepare("PRAGMA table_info(team_runs)").all() as { name: string }[]
    ).map((row) => row.name);
    expect(teamRunsColumns).toContain("hidden_at");
    expect(teamRunsColumns).toContain("archived_at");
    expect(teamRunsColumns).toContain("session_id");
    const childTasksColumns = (
      db.writer.prepare("PRAGMA table_info(child_tasks)").all() as { name: string }[]
    ).map((row) => row.name);
    expect(childTasksColumns).toContain("model");
    const tables = (
      db.writer
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);
    for (const expected of [
      "team_runs",
      "child_tasks",
      "task_batches",
      "task_attempts",
      "task_reports",
      "task_execution_logs",
      "task_dependencies",
      "review_cycles",
      "review_findings",
      "relay_events",
      "idempotency_requests",
      "app_metadata",
    ]) {
      expect(tables).toContain(expected);
    }
  });
});

describe("per-task model override", () => {
  it("persists per-task models and normalizes blank values to null", async () => {
    const { repository } = makeRepository();
    const start = await repository.startTeam(startInput("m1"));
    const batch = await repository.delegateTasks({
      requestID: "m2",
      runID: start.run.id,
      contextSummary: "",
      tasks: [
        {
          clientKey: "a",
          title: "A",
          prompt: "A",
          agentKind: "claude_code",
          model: "glm-5.2",
          executionMode: "workspace_write",
          parentTask: null,
          dependencies: [],
        },
        {
          clientKey: "b",
          title: "B",
          prompt: "B",
          agentKind: "claude_code",
          model: "   ",
          executionMode: "workspace_write",
          parentTask: null,
          dependencies: [],
        },
      ],
    });
    expect(batch.tasks[0].model).toBe("glm-5.2");
    expect(batch.tasks[1].model).toBeNull();

    const single = await repository.delegateTask({
      requestID: "m3",
      runID: start.run.id,
      title: "C",
      prompt: "C",
      agentKind: "claude_code",
      model: "glm-5-air",
      executionMode: "read_only",
      dependencies: [],
    });
    expect(single.model).toBe("glm-5-air");

    const snapshot = await repository.snapshot(start.run.id);
    const models = new Map(snapshot.tasks.map((task) => [task.clientKey, task.model]));
    expect(models.get("a")).toBe("glm-5.2");
    expect(models.get("b")).toBeNull();
    // Single delegation uses the request id as its client key.
    expect(models.get("m3")).toBe("glm-5-air");
  });

  it("truncates over-long model ids to 100 characters", async () => {
    const { repository } = makeRepository();
    const start = await repository.startTeam(startInput("m4"));
    const single = await repository.delegateTask({
      requestID: "m5",
      runID: start.run.id,
      title: "D",
      prompt: "D",
      agentKind: "codex",
      model: "x".repeat(140),
      executionMode: "read_only",
      dependencies: [],
    });
    expect(single.model).toHaveLength(100);
  });
});

describe("repository lifecycle", () => {
  it("starts a team, delegates a batch, reports, accepts, and completes", async () => {
    const { repository } = makeRepository();
    const start = await repository.startTeam(startInput("r1"));
    expect(start.run.status).toBe("running");
    expect(start.events.map((event) => event.kind)).toContain("team.started");

    const batch = await repository.delegateTasks({
      requestID: "r2",
      runID: start.run.id,
      contextSummary: "Parent context",
      tasks: [
        {
          clientKey: "scan",
          title: "Scan the code",
          prompt: "Scan everything",
          agentKind: "claude_code",
          model: null,
          executionMode: "read_only",
          parentTask: null,
          dependencies: [],
        },
        {
          clientKey: "fix",
          title: "Fix the bug",
          prompt: "Fix it",
          agentKind: "codex",
          model: null,
          executionMode: "workspace_write",
          parentTask: null,
          dependencies: [{ taskID: null, clientKey: "scan" }],
        },
      ],
    });
    expect(batch.tasks).toHaveLength(2);
    const scan = batch.tasks.find((task) => task.clientKey === "scan") as typeof batch.tasks[number];
    const fix = batch.tasks.find((task) => task.clientKey === "fix") as typeof batch.tasks[number];
    expect(scan.workspaceKind).toBe("shared_read_only");
    expect(fix.workspaceKind).toBe("isolated_write");
    expect(fix.branchName).toContain("octopunk/");

    const running = await repository.markTaskRunning({
      requestID: "r3",
      runID: start.run.id,
      taskID: scan.id,
      sessionID: null,
    });
    expect(running.status).toBe("running");
    expect(running.currentAttemptID).not.toBeNull();

    const reported = await repository.submitReport({
      requestID: "r4",
      runID: start.run.id,
      taskID: scan.id,
      sessionID: "session-1",
      report: "Found nothing",
      rawOutput: "Found nothing",
      tests: [],
      changedFiles: [],
      diffSummary: null,
      blocker: null,
    });
    expect(reported.status).toBe("awaiting_report");
    expect(reported.latestReport).toBe("Found nothing");

    const accepted = await repository.acceptTask({
      requestID: "r5",
      runID: start.run.id,
      taskID: scan.id,
      reviewer: "codex",
      verdict: "PASS",
      summary: "Looks good",
      findings: [],
    });
    expect(accepted.status).toBe("accepted");

    await expect(
      repository.completeTeam({
        requestID: "r6",
        runID: start.run.id,
        finalVerdict: "PASS",
        summary: "Final",
      }),
    ).rejects.toThrow(DomainError);

    await repository.markTaskRunning({
      requestID: "r7",
      runID: start.run.id,
      taskID: fix.id,
      sessionID: null,
    });
    await repository.submitReport({
      requestID: "r8",
      runID: start.run.id,
      taskID: fix.id,
      sessionID: "session-2",
      report: "Fixed",
      rawOutput: "Fixed",
      tests: ["vitest"],
      changedFiles: ["a.ts"],
      diffSummary: "1 file",
      blocker: null,
    });
    await repository.acceptTask({
      requestID: "r9",
      runID: start.run.id,
      taskID: fix.id,
      reviewer: "codex",
      verdict: "PASS",
      summary: "Accepted",
      findings: [],
    });

    const completed = await repository.completeTeam({
      requestID: "r10",
      runID: start.run.id,
      finalVerdict: "PASS",
      summary: "Final PASS",
    });
    expect(completed.run.status).toBe("completed");
    expect(completed.run.status).toBe("completed");
    const cycle = completed.reviewCycles.find((entry) => entry.reviewer === "codex.final");
    expect(cycle?.verdict).toBe("PASS");
    const persistedReport = completed.reports.find((report) => report.taskID === fix.id);
    expect(persistedReport?.tests).toEqual(["vitest"]);
  });

  it("replays idempotent commands with value-equal snapshots", async () => {
    const { repository } = makeRepository();
    const first = await repository.startTeam(startInput("idem-1"));
    const replay = await repository.startTeam(startInput("idem-1"));
    expect(replay.run.id).toBe(first.run.id);
    // Value equality (like Swift's Codable Equatable), insensitive to key order.
    expect(stableStringify(replay)).toBe(stableStringify(first));
  });

  it("scopes the single active run per session", async () => {
    const { repository } = makeRepository();
    const first = await repository.startTeam(startInput("a", "session-a"));
    const other = await repository.startTeam(startInput("b", "session-b"));
    expect(first.run.status).toBe("running");
    expect(other.run.status).toBe("running");

    await expect(repository.startTeam(startInput("c", "session-a"))).rejects.toThrow(
      "This session already has an active TeamRun.",
    );

    expect((await repository.activeRun("session-a"))?.run.id).toBe(first.run.id);
    expect((await repository.activeRun("session-b"))?.run.id).toBe(other.run.id);

    // Freeing the slot in one session does not affect the other.
    await repository.cancelTeam({ requestID: "d", runID: first.run.id });
    const restarted = await repository.startTeam(startInput("e", "session-a"));
    expect(restarted.run.status).toBe("running");
    expect((await repository.activeRun("session-b"))?.run.id).toBe(other.run.id);
  });

  it("fails a session's active runs on session close", async () => {
    const { repository } = makeRepository();
    const start = await repository.startTeam(startInput("f1", "session-x"));
    const batch = await repository.delegateTasks({
      requestID: "f2",
      runID: start.run.id,
      contextSummary: "",
      tasks: [
        {
          clientKey: "work",
          title: "Work",
          prompt: "Work",
          agentKind: "codex",
          model: null,
          executionMode: "workspace_write",
          parentTask: null,
          dependencies: [],
        },
      ],
    });
    await repository.markTaskRunning({
      requestID: "f3",
      runID: start.run.id,
      taskID: batch.tasks[0].id,
      sessionID: "native-1",
    });

    const failed = await repository.failActiveRunsForSession({
      sessionID: "session-x",
      reason: "session closed",
    });
    expect(failed).toEqual([start.run.id]);

    const snapshot = await repository.snapshot(start.run.id);
    expect(snapshot.run.status).toBe("failed");
    expect(snapshot.tasks[0].status).toBe("failed");
    expect(snapshot.tasks[0].latestError).toBe("session closed");
    expect(snapshot.attempts.map((attempt) => attempt.status)).toContain("failed");
    expect(snapshot.events.map((event) => event.kind)).toContain("team.failed");

    // Best-effort teardown is idempotent and scoped to the dead session.
    expect(
      await repository.failActiveRunsForSession({ sessionID: "session-x", reason: "again" }),
    ).toEqual([]);
    const survivor = await repository.startTeam(startInput("f4", "session-y"));
    expect(survivor.run.status).toBe("running");
  });

  it("legacy rows with a NULL session never block a new session", async () => {
    const { repository, db } = makeRepository();
    const now = Date.now() / 1000;
    db.writer
      .prepare(
        `INSERT INTO team_runs(
            id, repository_path, task, baseline_commit, status,
            max_concurrent_tasks, max_review_rounds, current_review_round,
            revision, created_at, updated_at
        ) VALUES ('legacy-run', '/tmp/legacy', 'Legacy', 'deadbeef', 'running', 3, 5, 0, 0, ?, ?)`,
      )
      .run(now, now);
    const started = await repository.startTeam(startInput("legacy-1", "session-new"));
    expect(started.run.status).toBe("running");
  });

  it("rejects duplicate batch client keys and dependency cycles", async () => {
    const { repository } = makeRepository();
    const start = await repository.startTeam(startInput("c"));
    await expect(
      repository.delegateTasks({
        requestID: "d",
        runID: start.run.id,
        contextSummary: "",
        tasks: [
          {
            clientKey: "same",
            title: "A",
            prompt: "A",
            agentKind: "claude_code",
            model: null,
            executionMode: "read_only",
            parentTask: null,
            dependencies: [],
          },
          {
            clientKey: "same",
            title: "B",
            prompt: "B",
            agentKind: "claude_code",
            model: null,
            executionMode: "read_only",
            parentTask: null,
            dependencies: [],
          },
        ],
      }),
    ).rejects.toThrow(/Duplicate batch client key/i);

    await expect(
      repository.delegateTasks({
        requestID: "e",
        runID: start.run.id,
        contextSummary: "",
        tasks: [
          {
            clientKey: "x",
            title: "X",
            prompt: "X",
            agentKind: "claude_code",
            model: null,
            executionMode: "read_only",
            parentTask: null,
            dependencies: [{ taskID: null, clientKey: "y" }],
          },
          {
            clientKey: "y",
            title: "Y",
            prompt: "Y",
            agentKind: "claude_code",
            model: null,
            executionMode: "read_only",
            parentTask: null,
            dependencies: [{ taskID: null, clientKey: "x" }],
          },
        ],
      }),
    ).rejects.toThrow(/cycle/i);
  });

  it("hides finished runs including completed and emits run.hidden", async () => {
    const { repository } = makeRepository();
    const start = await repository.startTeam(startInput("h"));
    await expect(repository.hideRun({ requestID: "h2", runID: start.run.id })).rejects.toThrow(
      /Only finished TeamRuns/i,
    );
    const completed = await repository.completeTeam({
      requestID: "h3",
      runID: start.run.id,
      finalVerdict: "PASS",
      summary: "Final PASS",
    });
    expect(completed.run.status).toBe("completed");
    await repository.hideRun({ requestID: "h4", runID: start.run.id });
    const summaries = await repository.listRuns();
    expect(summaries).toHaveLength(0);
    const snapshot = await repository.snapshot(start.run.id);
    expect(snapshot.events.some((event) => event.kind === "run.hidden")).toBe(true);
  });

  it("archives finished runs and restores them with audit events", async () => {
    const { repository } = makeRepository();
    const start = await repository.startTeam(startInput("arc"));
    await expect(repository.archiveRun({ requestID: "arc2", runID: start.run.id })).rejects.toThrow(
      /Only finished TeamRuns can be archived/i,
    );
    await repository.cancelTeam({ requestID: "arc3", runID: start.run.id });
    await repository.archiveRun({ requestID: "arc4", runID: start.run.id });
    let summaries = await repository.listRuns();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.archivedAt).not.toBeNull();
    await repository.unarchiveRun({ requestID: "arc5", runID: start.run.id });
    summaries = await repository.listRuns();
    expect(summaries[0]?.archivedAt).toBeNull();
    const snapshot = await repository.snapshot(start.run.id);
    expect(snapshot.events.some((event) => event.kind === "run.archived")).toBe(true);
    expect(snapshot.events.some((event) => event.kind === "run.unarchived")).toBe(true);
  });

  it("redacts and audits read-only context fetches with idempotent replay", async () => {
    const { repository } = makeRepository();
    const start = await repository.startTeam(startInput("ctx"));
    const batch = await repository.delegateTasks({
      requestID: "ctx2",
      runID: start.run.id,
      contextSummary: "",
      tasks: [
        {
          clientKey: "only",
          title: "Only",
          prompt: "Only",
          agentKind: "claude_code",
          model: null,
          executionMode: "read_only",
          parentTask: null,
          dependencies: [],
        },
      ],
    });
    const taskID = batch.tasks[0].id;
    await expect(
      repository.fetchTeamContext({ requestID: "ctx3", runID: start.run.id, requesterTaskID: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(DomainError);
    const digest = await repository.fetchTeamContext({
      requestID: "ctx4",
      runID: start.run.id,
      requesterTaskID: taskID,
    });
    expect(digest.summary).toContain("TeamRun");
    const replay = await repository.fetchTeamContext({
      requestID: "ctx4",
      runID: start.run.id,
      requesterTaskID: taskID,
    });
    expect(stableStringify(replay)).toBe(stableStringify(digest));
    const snapshot = await repository.snapshot(start.run.id);
    const fetched = snapshot.events.filter((event) => event.kind === "context.fetched");
    expect(fetched).toHaveLength(1);
  });

  it("observes segmented run summaries and event tails", async () => {
    const { repository } = makeRepository();
    const start = await repository.startTeam(startInput("obs"));
    const seenSummaries: number[] = [];
    const seenTailCounts: number[] = [];
    const summaryStream = repository.observeRunSummary(start.run.id);
    const tailStream = repository.observeEventTail(start.run.id, 100);
    const pumpSummary = (async () => {
      for await (const value of summaryStream) {
        seenSummaries.push(value.tasks.length);
      }
    })();
    const pumpTail = (async () => {
      for await (const tail of tailStream) {
        seenTailCounts.push(tail.length);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await repository.delegateTasks({
      requestID: "obs2",
      runID: start.run.id,
      contextSummary: "",
      tasks: [
        {
          clientKey: "one",
          title: "One",
          prompt: "One",
          agentKind: "claude_code",
          model: null,
          executionMode: "read_only",
          parentTask: null,
          dependencies: [],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    summaryStream.cancel();
    tailStream.cancel();
    await Promise.allSettled([pumpSummary, pumpTail]);
    expect(seenSummaries).toContain(1);
    expect(Math.max(...seenTailCounts)).toBeGreaterThanOrEqual(1);
  });
});
