// Port of OctoPunk/OctoPunk/Data/Persistence/Database/{OctoPunkDatabase,DatabaseMigrator}.swift.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

export const OctoPunkDatabaseMigrator = {
  currentVersion: 9,

  migrate(db: SqliteDatabase): void {
    const currentVersion = OctoPunkDatabaseMigrator.readVersion(db);
    if (currentVersion >= OctoPunkDatabaseMigrator.currentVersion) return;
    for (let version = currentVersion + 1; version <= OctoPunkDatabaseMigrator.currentVersion; version += 1) {
      const apply = OctoPunkDatabaseMigrator.stages[version];
      if (apply) {
        // Each stage is atomic: a crash mid-stage must not leave the schema
        // half-applied (which would make the next launch fail on re-running
        // the same CREATE statements).
        db.transaction(() => apply(db))();
      }
    }
  },

  readVersion(db: SqliteDatabase): number {
    try {
      const row = db
        .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      return row ? Number.parseInt(row.value, 10) || 0 : 0;
    } catch {
      return 0;
    }
  },

  stages: {
    1(db: SqliteDatabase): void {
      db.exec(`
        CREATE TABLE team_runs (
            id TEXT PRIMARY KEY NOT NULL,
            repository_path TEXT NOT NULL,
            task TEXT NOT NULL,
            baseline_commit TEXT NOT NULL,
            status TEXT NOT NULL,
            max_concurrent_tasks INTEGER NOT NULL,
            max_review_rounds INTEGER NOT NULL,
            current_review_round INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );

        CREATE TABLE child_tasks (
            id TEXT PRIMARY KEY NOT NULL,
            run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            prompt TEXT NOT NULL,
            baseline_commit TEXT NOT NULL,
            branch_name TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            session_id TEXT,
            status TEXT NOT NULL,
            latest_report TEXT,
            latest_error TEXT,
            review_round INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            UNIQUE(run_id, branch_name)
        );

        CREATE TABLE task_dependencies (
            id TEXT PRIMARY KEY NOT NULL,
            run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL REFERENCES child_tasks(id) ON DELETE CASCADE,
            depends_on_task_id TEXT NOT NULL REFERENCES child_tasks(id) ON DELETE CASCADE,
            UNIQUE(task_id, depends_on_task_id)
        );

        CREATE TABLE review_cycles (
            id TEXT PRIMARY KEY NOT NULL,
            run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
            task_id TEXT REFERENCES child_tasks(id) ON DELETE CASCADE,
            round INTEGER NOT NULL,
            reviewer TEXT NOT NULL,
            verdict TEXT NOT NULL,
            summary TEXT NOT NULL,
            created_at REAL NOT NULL
        );

        CREATE TABLE review_findings (
            id TEXT PRIMARY KEY NOT NULL,
            review_cycle_id TEXT NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
            task_id TEXT REFERENCES child_tasks(id) ON DELETE CASCADE,
            severity TEXT NOT NULL,
            file TEXT,
            line INTEGER,
            evidence TEXT NOT NULL,
            expected_fix TEXT
        );

        CREATE TABLE relay_events (
            id TEXT PRIMARY KEY NOT NULL,
            run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
            task_id TEXT REFERENCES child_tasks(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at REAL NOT NULL,
            UNIQUE(run_id, sequence)
        );

        CREATE TABLE idempotency_requests (
            request_id TEXT PRIMARY KEY NOT NULL,
            response_json TEXT NOT NULL,
            created_at REAL NOT NULL
        );

        CREATE TABLE app_metadata (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL,
            updated_at REAL NOT NULL
        );

        CREATE INDEX child_tasks_run_status_idx ON child_tasks(run_id, status);
        CREATE INDEX relay_events_run_sequence_idx ON relay_events(run_id, sequence);
        CREATE INDEX review_cycles_run_round_idx ON review_cycles(run_id, round);
        CREATE INDEX task_dependencies_run_idx ON task_dependencies(run_id);
      `);
      db.prepare("INSERT INTO app_metadata(key, value, updated_at) VALUES (?, ?, ?)").run(
        "schema_version",
        "1",
        Date.now() / 1000,
      );
    },

    2(db: SqliteDatabase): void {
      db.exec(`
        CREATE TABLE task_attempts (
            id TEXT PRIMARY KEY NOT NULL,
            run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL REFERENCES child_tasks(id) ON DELETE CASCADE,
            attempt_number INTEGER NOT NULL,
            prompt TEXT NOT NULL,
            session_id TEXT,
            status TEXT NOT NULL,
            started_at REAL NOT NULL,
            finished_at REAL,
            failure TEXT,
            UNIQUE(task_id, attempt_number)
        );

        ALTER TABLE child_tasks
            ADD COLUMN current_attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL;

        CREATE TABLE task_reports (
            id TEXT PRIMARY KEY NOT NULL,
            run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL REFERENCES child_tasks(id) ON DELETE CASCADE,
            attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL,
            summary TEXT NOT NULL,
            raw_output TEXT NOT NULL,
            tests_json TEXT NOT NULL,
            changed_files_json TEXT NOT NULL,
            diff_summary TEXT,
            blocker TEXT,
            created_at REAL NOT NULL
        );

        CREATE INDEX task_attempts_task_number_idx ON task_attempts(task_id, attempt_number);
        CREATE INDEX task_reports_task_created_idx ON task_reports(task_id, created_at);
        CREATE INDEX task_reports_attempt_idx ON task_reports(attempt_id);
      `);
      updateSchemaVersion(db, "2");
    },

    3(db: SqliteDatabase): void {
      db.exec("ALTER TABLE team_runs ADD COLUMN target_branch TEXT NOT NULL DEFAULT ''");
      updateSchemaVersion(db, "3");
    },

    4(db: SqliteDatabase): void {
      // V3 tasks were always Claude children with their own write branch.
      db.exec(`
        ALTER TABLE child_tasks ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'claude_code';
        ALTER TABLE child_tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'workspace_write';
        ALTER TABLE child_tasks ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'isolated_write';

        CREATE TABLE task_execution_logs (
            id TEXT PRIMARY KEY NOT NULL,
            run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL REFERENCES child_tasks(id) ON DELETE CASCADE,
            attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
            stdout_tail TEXT NOT NULL DEFAULT '',
            stderr_tail TEXT NOT NULL DEFAULT '',
            latest_activity TEXT,
            tool_summary_json TEXT NOT NULL DEFAULT '[]',
            updated_at REAL NOT NULL,
            UNIQUE(attempt_id)
        );

        CREATE INDEX task_execution_logs_task_updated_idx ON task_execution_logs(task_id, updated_at);
      `);
      updateSchemaVersion(db, "4");
    },

    5(db: SqliteDatabase): void {
      db.exec(`
        CREATE TABLE task_batches (
            id TEXT PRIMARY KEY NOT NULL,
            run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
            context_summary TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL
        );

        ALTER TABLE child_tasks ADD COLUMN batch_id TEXT REFERENCES task_batches(id) ON DELETE SET NULL;
        ALTER TABLE child_tasks ADD COLUMN client_key TEXT;
        ALTER TABLE child_tasks ADD COLUMN parent_task_id TEXT REFERENCES child_tasks(id) ON DELETE SET NULL;
        ALTER TABLE child_tasks ADD COLUMN context_snapshot TEXT NOT NULL DEFAULT '';
      `);
      // V4 tasks predate batches: one empty compatibility batch per run and
      // every old task becomes a root task.
      const runIDs = db.prepare("SELECT id FROM team_runs").all() as { id: string }[];
      for (const row of runIDs) {
        db.prepare(
          "INSERT INTO task_batches(id, run_id, context_summary, created_at) VALUES (?, ?, '', ?)",
        ).run(row.id, row.id, Date.now() / 1000);
        db.prepare(
          "UPDATE child_tasks SET batch_id = ?, client_key = id, parent_task_id = NULL, context_snapshot = '' WHERE run_id = ? AND batch_id IS NULL",
        ).run(row.id, row.id);
      }
      db.exec(`
        CREATE UNIQUE INDEX child_tasks_batch_client_key_idx ON child_tasks(batch_id, client_key) WHERE batch_id IS NOT NULL AND client_key IS NOT NULL;
        CREATE INDEX task_batches_run_idx ON task_batches(run_id, created_at);
        CREATE INDEX child_tasks_parent_idx ON child_tasks(run_id, parent_task_id);
      `);
      updateSchemaVersion(db, "5");
    },

    6(db: SqliteDatabase): void {
      // Soft delete: hidden runs leave the sidebar but the audit trail stays.
      db.exec("ALTER TABLE team_runs ADD COLUMN hidden_at REAL");
      updateSchemaVersion(db, "6");
    },

    7(db: SqliteDatabase): void {
      // Archive: reversible alternative to hiding — the run moves to the
      // sidebar's archived section and can be restored.
      db.exec("ALTER TABLE team_runs ADD COLUMN archived_at REAL");
      updateSchemaVersion(db, "7");
    },

    8(db: SqliteDatabase): void {
      // Owning MCP session (stdio process or HTTP session); NULL on legacy
      // rows, which never match a session and therefore block nobody.
      db.exec("ALTER TABLE team_runs ADD COLUMN session_id TEXT");
      updateSchemaVersion(db, "8");
    },

    9(db: SqliteDatabase): void {
      // Per-task model override; NULL keeps the per-kind setting (and then
      // the agent's own default), so legacy rows need no backfill.
      db.exec("ALTER TABLE child_tasks ADD COLUMN model TEXT");
      updateSchemaVersion(db, "9");
    },
  } as Record<number, (db: SqliteDatabase) => void>,
};

function updateSchemaVersion(db: SqliteDatabase, version: string): void {
  db.prepare("UPDATE app_metadata SET value = ?, updated_at = ? WHERE key = 'schema_version'").run(
    version,
    Date.now() / 1000,
  );
}

export class OctoPunkDatabase {
  readonly writer: SqliteDatabase;
  readonly databaseURL: string;

  private constructor(db: SqliteDatabase, databaseURL: string) {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    OctoPunkDatabaseMigrator.migrate(db);
    this.writer = db;
    this.databaseURL = databaseURL;
  }

  static open(databaseURL: string): OctoPunkDatabase {
    fs.mkdirSync(path.dirname(databaseURL), { recursive: true });
    return new OctoPunkDatabase(new Database(databaseURL), databaseURL);
  }

  static inMemory(): OctoPunkDatabase {
    return new OctoPunkDatabase(new Database(":memory:"), ":memory:");
  }

  static live(): OctoPunkDatabase {
    const support = path.join(os.homedir(), "Library", "Application Support");
    const directory = path.join(support, "OctoPunk");
    const databaseURL = path.join(directory, "octopunk.sqlite");
    const legacyDatabaseURL = path.join(support, "RelayDesk", "relaydesk.sqlite");

    if (!fs.existsSync(databaseURL) && fs.existsSync(legacyDatabaseURL)) {
      fs.mkdirSync(directory, { recursive: true });
      fs.copyFileSync(legacyDatabaseURL, databaseURL);
      for (const suffix of ["-wal", "-shm"]) {
        const legacySidecar = legacyDatabaseURL + suffix;
        if (fs.existsSync(legacySidecar)) {
          fs.copyFileSync(legacySidecar, databaseURL + suffix);
        }
      }
    }
    return OctoPunkDatabase.open(databaseURL);
  }
}
