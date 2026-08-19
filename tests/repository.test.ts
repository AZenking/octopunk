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
    expect(OctoPunkDatabaseMigrator.readVersion(db.writer)).toBe(11);
    const teamRunsColumns = (
      db.writer.prepare("PRAGMA table_info(team_runs)").all() as { name: string }[]
    ).map((row) => row.name);
    expect(teamRunsColumns).toContain("hidden_at");
    expect(teamRunsColumns).toContain("archived_at");
    expect(teamRunsColumns).toContain("session_id");
    expect(teamRunsColumns).toContain("gate_snapshot_json");
    // v11: scheduling controls (priority for quota ordering, paused_at).
    expect(teamRunsColumns).toContain("priority");
    expect(teamRunsColumns).toContain("paused_at");
    const childTasksColumns = (
      db.writer.prepare("PRAGMA table_info(child_tasks)").all() as { name: string }[]
    ).map((row) => row.name);
    expect(childTasksColumns).toContain("model");
    const taskAttemptsColumns = (
      db.writer.prepare("PRAGMA table_info(task_attempts)").all() as { name: string }[]
    ).map((row) => row.name);
    // v11: crash-recovery process reconciliation key.
    expect(taskAttemptsColumns).toContain("pid");
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
      // v10: review center & quality gates.
      "review_comments",
      "project_gate_configs",
      "gate_evaluations",
      "gate_evaluation_items",
      "arbitrations",
      "delivery_summaries",
      "pr_links",
      // v11: doctor health-check reports.
      "doctor_reports",
      "doctor_check_items",
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

// ---- v0.4 review center & quality gates (specs/002-v04-review-center-gates) ----

async function makeRunWithTask(
  repository: SqliteTeamRunRepository,
  requestPrefix: string,
): Promise<{ runID: string; taskID: string }> {
  const start = await repository.startTeam(startInput(`${requestPrefix}-start`));
  const batch = await repository.delegateTasks({
    requestID: `${requestPrefix}-delegate`,
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
  return { runID: start.run.id, taskID: batch.tasks[0].id };
}

describe("review center comments", () => {
  it("batch-inserts comments atomically with idempotent replay", async () => {
    const { repository } = makeRepository();
    const { runID, taskID } = await makeRunWithTask(repository, "rc");
    const comments = [
      {
        filePath: "src/a.ts",
        lineStart: 10,
        contextSnapshot: "const a = 1;",
        body: "Rename this",
        severity: "info" as const,
        author: "user" as const,
      },
      {
        filePath: "src/b.ts",
        lineStart: 20,
        lineEnd: 24,
        contextSnapshot: "export function b() {}",
        body: "Missing null check",
        severity: "risk" as const,
        author: "codex" as const,
      },
    ];
    const created = await repository.addReviewComments({
      requestID: "rc-c1",
      runID,
      taskID,
      comments,
    });
    expect(created).toHaveLength(2);
    expect(created[0].status).toBe("open");
    expect(created[0].lineEnd).toBe(10);
    expect(created[1].lineEnd).toBe(24);

    // Replaying the same requestID returns the cached batch, not duplicates.
    const replay = await repository.addReviewComments({ requestID: "rc-c1", runID, taskID, comments });
    expect(stableStringify(replay)).toBe(stableStringify(created));

    const listed = await repository.listReviewComments(runID, taskID);
    expect(listed.map((comment) => comment.id).sort()).toEqual(created.map((comment) => comment.id).sort());

    // Open list surfaces risk severity first (spec: risk findings stay on top).
    const open = await repository.listOpenReviewComments(runID);
    expect(open.map((comment) => comment.severity)).toEqual(["risk", "info"]);

    const snapshot = await repository.snapshot(runID);
    expect(snapshot.events.some((event) => event.kind === "review.comment_added")).toBe(true);
  });

  it("moves open comments to terminal states and rejects illegal transitions", async () => {
    const { repository } = makeRepository();
    const { runID, taskID } = await makeRunWithTask(repository, "rs");
    const created = await repository.addReviewComments({
      requestID: "rs-c1",
      runID,
      taskID,
      comments: [
        {
          filePath: "src/a.ts",
          lineStart: 1,
          contextSnapshot: "line",
          body: "One",
          severity: "info",
          author: "user",
        },
        {
          filePath: "src/b.ts",
          lineStart: 2,
          contextSnapshot: "line",
          body: "Two",
          severity: "risk",
          author: "codex",
        },
      ],
    });
    const [first, second] = created;

    const resolved = await repository.setReviewCommentStatus({
      requestID: "rs-s1",
      runID,
      commentID: first.id,
      status: "resolved",
    });
    expect(resolved.status).toBe("resolved");
    // Idempotent replay returns the cached terminal state.
    const replay = await repository.setReviewCommentStatus({
      requestID: "rs-s1",
      runID,
      commentID: first.id,
      status: "resolved",
    });
    expect(stableStringify(replay)).toBe(stableStringify(resolved));

    const moved = await repository.setReviewCommentStatus({
      requestID: "rs-s2",
      runID,
      commentID: second.id,
      status: "line_changed",
    });
    expect(moved.status).toBe("line_changed");

    // Terminal states are irreversible.
    await expect(
      repository.setReviewCommentStatus({ requestID: "rs-s3", runID, commentID: first.id, status: "dismissed" }),
    ).rejects.toMatchObject({ kind: "invalidTransition" });
    await expect(
      repository.setReviewCommentStatus({ requestID: "rs-s4", runID, commentID: second.id, status: "resolved" }),
    ).rejects.toThrow(DomainError);

    expect(await repository.listOpenReviewComments(runID)).toHaveLength(0);
    const snapshot = await repository.snapshot(runID);
    const transitions = snapshot.events.filter((event) => event.kind === "review.comment_status_changed");
    expect(transitions).toHaveLength(2);
  });
});

describe("quality gates", () => {
  it("upserts the per-project gate config", async () => {
    const { repository } = makeRepository();
    expect(await repository.getGateConfig("/tmp/repo")).toBeNull();
    await repository.saveGateConfig({
      repositoryPath: "/tmp/repo",
      configJson: '{"reviewMode":"standard"}',
      updatedAt: 100,
    });
    const initial = await repository.getGateConfig("/tmp/repo");
    expect(initial?.configJson).toBe('{"reviewMode":"standard"}');
    expect(initial?.updatedAt).toBe(100);

    await repository.saveGateConfig({
      repositoryPath: "/tmp/repo",
      configJson: '{"reviewMode":"arbitration"}',
      updatedAt: 200,
    });
    const updated = await repository.getGateConfig("/tmp/repo");
    expect(updated?.configJson).toBe('{"reviewMode":"arbitration"}');
    expect(updated?.updatedAt).toBe(200);

    // Other projects keep independent configs.
    await repository.saveGateConfig({
      repositoryPath: "/tmp/other",
      configJson: '{"reviewMode":"contest"}',
      updatedAt: 300,
    });
    expect((await repository.getGateConfig("/tmp/other"))?.configJson).toContain("contest");
    expect((await repository.getGateConfig("/tmp/repo"))?.updatedAt).toBe(200);
  });

  it("records gate evaluations with idempotent replay and waives items with a trail", async () => {
    const { repository, db } = makeRepository();
    const { runID, taskID } = await makeRunWithTask(repository, "ge");
    const items = [
      { checkKey: "tests" as const, status: "pass" as const, detail: "vitest 12/12" },
      {
        checkKey: "lint" as const,
        status: "fail" as const,
        detail: "1 error",
        fixSuggestion: "pnpm lint --fix",
      },
    ];
    const evaluation = await repository.recordGateEvaluation({
      requestID: "ge-1",
      runID,
      taskID,
      overall: "fail",
      items,
    });
    expect(evaluation.overall).toBe("fail");
    expect(evaluation.items).toHaveLength(2);
    expect(evaluation.items[1].fixSuggestion).toBe("pnpm lint --fix");
    expect(evaluation.items[1].waivedBy).toBeNull();

    // Same requestID → cached evaluation, no second row.
    const replay = await repository.recordGateEvaluation({
      requestID: "ge-1",
      runID,
      taskID,
      overall: "fail",
      items,
    });
    expect(stableStringify(replay)).toBe(stableStringify(evaluation));
    const counted = db.writer
      .prepare("SELECT COUNT(*) AS n FROM gate_evaluations WHERE run_id = ?")
      .get(runID) as { n: number };
    expect(counted.n).toBe(1);

    const latest = await repository.getLatestGateEvaluation(runID, taskID);
    expect(latest?.id).toBe(evaluation.id);
    expect(latest?.items.map((item) => item.checkKey)).toEqual(["tests", "lint"]);

    // Waive the failing item: status flips and the trail records who/why/when.
    const failing = latest?.items.find((item) => item.status === "fail");
    expect(failing).toBeDefined();
    const waived = await repository.waiveGateItem({
      requestID: "ge-w1",
      evaluationID: evaluation.id,
      itemID: (failing as { id: string }).id,
      waivedBy: "user",
      waivedReason: "Legacy lint baseline",
    });
    expect(waived.status).toBe("waived");
    expect(waived.waivedBy).toBe("user");
    expect(waived.waivedReason).toBe("Legacy lint baseline");
    expect(waived.waivedAt).not.toBeNull();
    const reread = (await repository.listGateEvaluationItems(evaluation.id)).find(
      (item) => item.id === waived.id,
    );
    expect(reread?.status).toBe("waived");
    expect(reread?.waivedReason).toBe("Legacy lint baseline");

    const snapshot = await repository.snapshot(runID);
    expect(snapshot.events.some((event) => event.kind === "gate.evaluated")).toBe(true);
    expect(snapshot.events.some((event) => event.kind === "gate.item_waived")).toBe(true);

    // A later evaluation supersedes the first as the latest one.
    const second = await repository.recordGateEvaluation({
      requestID: "ge-2",
      runID,
      taskID,
      overall: "pass",
      items: [{ checkKey: "tests", status: "pass", detail: "vitest 13/13" }],
    });
    expect((await repository.getLatestGateEvaluation(runID, taskID))?.id).toBe(second.id);
  });
});

describe("arbitration, summaries and PR links", () => {
  it("records and reloads arbitration outcomes", async () => {
    const { repository } = makeRepository();
    const { runID, taskID } = await makeRunWithTask(repository, "ar");
    expect(await repository.getArbitration(runID, taskID)).toBeNull();
    const recorded = await repository.recordArbitration({
      runID,
      taskID,
      consensus: "Ship after follow-up",
      disagreements: [{ reviewer: "codex", verdict: "REWORK", evidence: "missing test for b()" }],
      toVerify: [{ claim: "vitest is green", howToVerify: "pnpm test" }],
      autoPassed: false,
    });
    expect(recorded.autoPassed).toBe(false);
    const loaded = await repository.getArbitration(runID, taskID);
    expect(loaded?.id).toBe(recorded.id);
    expect(loaded?.consensus).toBe("Ship after follow-up");
    expect(loaded?.disagreements).toEqual(recorded.disagreements);
    expect(loaded?.toVerify[0]?.claim).toBe("vitest is green");
    const snapshot = await repository.snapshot(runID);
    expect(snapshot.events.some((event) => event.kind === "arbitration.recorded")).toBe(true);
  });

  it("records task-level and run-level delivery summaries", async () => {
    const { repository } = makeRepository();
    const { runID, taskID } = await makeRunWithTask(repository, "ds");
    expect(await repository.getDeliverySummary(runID, null)).toBeNull();
    const taskSummary = await repository.recordDeliverySummary({
      runID,
      taskID,
      verdict: "PASS",
      summaryMd: "# Task summary",
      evidence: ["report-1", "gate-1"],
    });
    expect(taskSummary.taskID).toBe(taskID);
    const runSummary = await repository.recordDeliverySummary({
      runID,
      taskID: null,
      verdict: "PASS",
      summaryMd: "# Run summary",
      evidence: [],
    });
    expect(runSummary.taskID).toBeNull();

    expect((await repository.getDeliverySummary(runID, taskID))?.evidence).toEqual(["report-1", "gate-1"]);
    expect((await repository.getDeliverySummary(runID, null))?.summaryMD).toBe("# Run summary");
    const snapshot = await repository.snapshot(runID);
    expect(snapshot.events.filter((event) => event.kind === "summary.generated")).toHaveLength(2);
  });

  it("upserts the PR link and freezes the run gate snapshot", async () => {
    const { repository, db } = makeRepository();
    const { runID, taskID } = await makeRunWithTask(repository, "pr");
    expect(await repository.getPrLink(runID, taskID)).toBeNull();

    await repository.savePrLink({
      runID,
      taskID,
      prURL: "https://github.com/org/repo/pull/1",
      prNumber: 1,
      lastSyncedAt: 100,
    });
    const updated = await repository.savePrLink({
      runID,
      taskID,
      prURL: "https://github.com/org/repo/pull/2",
      prNumber: 2,
      lastSyncedAt: 200,
    });
    expect(updated.prNumber).toBe(2);
    expect(updated.prURL).toContain("/pull/2");
    const counted = db.writer
      .prepare("SELECT COUNT(*) AS n FROM pr_links WHERE run_id = ? AND task_id = ?")
      .get(runID, taskID) as { n: number };
    expect(counted.n).toBe(1);
    const loaded = await repository.getPrLink(runID, taskID);
    expect(loaded?.lastSyncedAt).toBe(200);

    await repository.saveRunGateSnapshot(runID, '{"reviewMode":"standard","maxRiskFindings":0}');
    const row = db.writer
      .prepare("SELECT gate_snapshot_json AS json FROM team_runs WHERE id = ?")
      .get(runID) as { json: string | null };
    expect(row.json).toBe('{"reviewMode":"standard","maxRiskFindings":0}');
  });
});

// ---- v0.3 stability & multi-run (specs/001-v03-stability-multi-teamrun) ----

describe("run scheduling controls", () => {
  it("rejects out-of-range priorities and records legal changes with audit and notification", async () => {
    const { repository } = makeRepository();
    const start = await repository.startTeam(startInput("pr1"));
    expect(start.run.priority).toBe(0);

    for (const priority of [6, -6, 1.5, Number.NaN]) {
      await expect(
        repository.setRunPriority({ requestID: `pr-bad-${priority}`, runID: start.run.id, priority }),
      ).rejects.toMatchObject({ kind: "invalidTask" });
    }

    const seenPriorities: number[] = [];
    const stream = repository.observeRunSummary(start.run.id);
    const pump = (async () => {
      for await (const value of stream) {
        seenPriorities.push(value.run.priority);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await repository.setRunPriority({
      requestID: "pr-ok-1",
      runID: start.run.id,
      priority: 3,
    });
    expect(updated.priority).toBe(3);
    expect(updated.pausedAt).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10));
    stream.cancel();
    await Promise.allSettled([pump]);
    // The run observer emits both the initial and the re-prioritized value.
    expect(seenPriorities).toContain(0);
    expect(seenPriorities).toContain(3);

    // Idempotent replay returns the cached run (same requestID).
    const replay = await repository.setRunPriority({
      requestID: "pr-ok-1",
      runID: start.run.id,
      priority: 3,
    });
    expect(stableStringify(replay)).toBe(stableStringify(updated));

    // A same-value set is a no-op: current run returned, no duplicate event.
    const noop = await repository.setRunPriority({
      requestID: "pr-ok-2",
      runID: start.run.id,
      priority: 3,
    });
    expect(noop.priority).toBe(3);

    const snapshot = await repository.snapshot(start.run.id);
    const priorityEvents = snapshot.events.filter((event) => event.kind === "run.priorityChanged");
    expect(priorityEvents).toHaveLength(1);
    expect(priorityEvents[0].payload).toContain('"from":"0"');
    expect(priorityEvents[0].payload).toContain('"to":"3"');

    // Summaries and snapshots both surface the new priority.
    const summaries = await repository.listRuns();
    expect(summaries[0].priority).toBe(3);
    expect((await repository.snapshot(start.run.id)).run.priority).toBe(3);
  });

  it("pauses idempotently and resumes with audit events", async () => {
    const { repository } = makeRepository();
    const start = await repository.startTeam(startInput("pz1"));
    expect(start.run.pausedAt).toBeNull();

    const paused = await repository.pauseRun({ requestID: "pz2", runID: start.run.id });
    expect(paused.pausedAt).not.toBeNull();

    // Pausing an already-paused run (new request id) is idempotent: the
    // current state returns and no second audit event is appended.
    const pausedAgain = await repository.pauseRun({ requestID: "pz3", runID: start.run.id });
    expect(pausedAgain.pausedAt).toBe(paused.pausedAt);

    // Replaying the original pause request returns its cached response.
    const replay = await repository.pauseRun({ requestID: "pz2", runID: start.run.id });
    expect(stableStringify(replay)).toBe(stableStringify(paused));

    let snapshot = await repository.snapshot(start.run.id);
    expect(snapshot.events.filter((event) => event.kind === "run.paused")).toHaveLength(1);
    expect(snapshot.run.pausedAt).toBe(paused.pausedAt);

    const resumed = await repository.resumeRun({ requestID: "pz4", runID: start.run.id });
    expect(resumed.pausedAt).toBeNull();

    // Resuming a running run is likewise idempotent.
    const resumedAgain = await repository.resumeRun({ requestID: "pz5", runID: start.run.id });
    expect(resumedAgain.pausedAt).toBeNull();

    snapshot = await repository.snapshot(start.run.id);
    expect(snapshot.events.filter((event) => event.kind === "run.resumed")).toHaveLength(1);
    expect(snapshot.run.pausedAt).toBeNull();

    // Unknown runs are rejected, not silently ignored.
    await expect(
      repository.pauseRun({ requestID: "pz6", runID: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toMatchObject({ kind: "runNotFound" });
  });
});

describe("doctor reports", () => {
  const item = (checkKey: "cli_path" | "login" | "gui_path" | "db_health", status: "pass" | "fail" | "unknown") => ({
    checkKey,
    status,
    detail: `${checkKey} ${status}`,
    impact: "impact",
    suggestion: "suggestion",
    durationMs: 12,
  });

  it("records idempotent reports and derives overall (fail / unknown-only / all pass)", async () => {
    const { repository, db } = makeRepository();
    expect(await repository.getLatestDoctorReport("/tmp/repo")).toBeNull();

    // Any fail → fail, even alongside passes.
    const failing = await repository.recordDoctorReport({
      requestID: "doc-1",
      triggeredBy: "user",
      repositoryPath: "/tmp/repo",
      items: [item("cli_path", "pass"), item("login", "fail")],
    });
    expect(failing.overall).toBe("fail");
    expect(failing.items).toHaveLength(2);
    expect(failing.items[0].reportID).toBe(failing.id);

    // No fail but at least one unknown → degraded.
    const degraded = await repository.recordDoctorReport({
      requestID: "doc-2",
      triggeredBy: "prestart",
      repositoryPath: "/tmp/repo",
      items: [item("gui_path", "unknown")],
    });
    expect(degraded.overall).toBe("degraded");

    // All pass → pass; a NULL repository path covers the global checks.
    const passing = await repository.recordDoctorReport({
      requestID: "doc-3",
      triggeredBy: "codex",
      repositoryPath: null,
      items: [item("db_health", "pass")],
    });
    expect(passing.overall).toBe("pass");
    expect(passing.repositoryPath).toBeNull();

    // Same requestID → cached report, no duplicate rows.
    const replay = await repository.recordDoctorReport({
      requestID: "doc-1",
      triggeredBy: "user",
      repositoryPath: "/tmp/repo",
      items: [item("cli_path", "pass"), item("login", "fail")],
    });
    expect(stableStringify(replay)).toBe(stableStringify(failing));
    const counted = db.writer
      .prepare("SELECT COUNT(*) AS n FROM doctor_reports")
      .get() as { n: number };
    expect(counted.n).toBe(3);

    // Latest per repository scope: the degraded report is newest for /tmp/repo.
    const latest = await repository.getLatestDoctorReport("/tmp/repo");
    expect(latest?.id).toBe(degraded.id);
    expect(latest?.items.map((entry) => entry.status)).toEqual(["unknown"]);
    // The global (NULL) scope never leaks repository-scoped rows and vice versa.
    expect((await repository.getLatestDoctorReport(null))?.id).toBe(passing.id);
    expect(await repository.getLatestDoctorReport("/tmp/other")).toBeNull();
  });

  it("reruns a single check item and recalculates overall", async () => {
    const { repository } = makeRepository();
    const report = await repository.recordDoctorReport({
      requestID: "rr-1",
      triggeredBy: "user",
      repositoryPath: "/tmp/repo",
      items: [item("login", "fail"), item("cli_path", "pass")],
    });
    expect(report.overall).toBe("fail");

    const updated = await repository.rerunDoctorCheckItem({
      requestID: "rr-2",
      reportID: report.id,
      checkKey: "login",
      status: "pass",
      detail: "login ok now",
      impact: "none",
      suggestion: "none",
      durationMs: 5,
    });
    expect(updated.overall).toBe("pass");
    const login = updated.items.find((entry) => entry.checkKey === "login");
    expect(login?.status).toBe("pass");
    expect(login?.detail).toBe("login ok now");
    expect(login?.durationMs).toBe(5);
    // The untouched item keeps its original verdict.
    expect(updated.items.find((entry) => entry.checkKey === "cli_path")?.status).toBe("pass");

    // The recalculated overall is persisted on the report row.
    expect((await repository.getLatestDoctorReport("/tmp/repo"))?.overall).toBe("pass");

    // Idempotent replay returns the cached report.
    const replay = await repository.rerunDoctorCheckItem({
      requestID: "rr-2",
      reportID: report.id,
      checkKey: "login",
      status: "pass",
      detail: "login ok now",
      impact: "none",
      suggestion: "none",
      durationMs: 5,
    });
    expect(stableStringify(replay)).toBe(stableStringify(updated));

    // Unknown report or unknown check key → invalidTask.
    const missing = { status: "pass" as const, detail: "d", impact: "i", suggestion: "s", durationMs: 1 };
    await expect(
      repository.rerunDoctorCheckItem({
        requestID: "rr-3",
        reportID: "00000000-0000-0000-0000-000000000000",
        checkKey: "login",
        ...missing,
      }),
    ).rejects.toMatchObject({ kind: "invalidTask" });
    await expect(
      repository.rerunDoctorCheckItem({ requestID: "rr-4", reportID: report.id, checkKey: "sandbox", ...missing }),
    ).rejects.toMatchObject({ kind: "invalidTask" });
  });
});

describe("attempt pid", () => {
  it("writes and clears pids with task ownership checks", async () => {
    const { repository, db } = makeRepository();
    const { runID, taskID } = await makeRunWithTask(repository, "pid");
    const running = await repository.markTaskRunning({
      requestID: "pid-r1",
      runID,
      taskID,
      sessionID: null,
    });
    const attemptID = running.currentAttemptID as string;
    const pidOf = (id: string): number | null =>
      (db.writer.prepare("SELECT pid FROM task_attempts WHERE id = ?").get(id) as { pid: number | null })
        .pid;

    expect(pidOf(attemptID)).toBeNull();
    await repository.updateAttemptPid({ runID, taskID, attemptID, pid: 4242 });
    expect(pidOf(attemptID)).toBe(4242);

    // Clean exit clears the pid back to NULL.
    await repository.updateAttemptPid({ runID, taskID, attemptID, pid: null });
    expect(pidOf(attemptID)).toBeNull();

    // Ownership: an attempt of another task never matches, and its pid stays untouched.
    const other = await repository.delegateTask({
      requestID: "pid-r2",
      runID,
      title: "Other",
      prompt: "Other",
      agentKind: "codex",
      model: null,
      executionMode: "read_only",
      dependencies: [],
    });
    const otherRunning = await repository.markTaskRunning({
      requestID: "pid-r3",
      runID,
      taskID: other.id,
      sessionID: null,
    });
    const otherAttemptID = otherRunning.currentAttemptID as string;
    await repository.updateAttemptPid({ runID, taskID: other.id, attemptID: otherAttemptID, pid: 777 });
    await expect(
      repository.updateAttemptPid({ runID, taskID, attemptID: otherAttemptID, pid: 1 }),
    ).rejects.toMatchObject({ kind: "invalidTask" });
    expect(pidOf(otherAttemptID)).toBe(777);
    // A fully unknown attempt id is rejected the same way.
    await expect(
      repository.updateAttemptPid({
        runID,
        taskID,
        attemptID: "00000000-0000-0000-0000-000000000000",
        pid: 1,
      }),
    ).rejects.toMatchObject({ kind: "invalidTask" });
  });
});
