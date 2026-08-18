#!/usr/bin/env node
// mcp-trace — step-by-step MCP observability tool for OctoPunk.
//
// Spawns the real Electron app in --mcp-stdio mode and drives one full
// TeamRun while printing EVERY execution step with elapsed-time stamps:
// each JSON-RPC request/response, each live task_event notification, each
// task state transition, and each new audit (relay) event as it lands.
//
// Usage:
//   node tools/mcp-trace.mjs                          # temp repo + temp DB, 1 read-only claude task, full lifecycle
//   node tools/mcp-trace.mjs --repo /path/to/repo     # drive a real repository
//   node tools/mcp-trace.mjs --db real                # use the live DB (run shows up in the GUI sidebar)
//   node tools/mcp-trace.mjs --tasks 4                # 4 tasks: 3 run concurrently, 1 queues
//   node tools/mcp-trace.mjs --agent codex --mode workspace_write
//   node tools/mcp-trace.mjs --no-accept              # stop after the report, before review
//   node tools/mcp-trace.mjs --keep                   # never discard worktrees at the end
//   node tools/mcp-trace.mjs --verbose                # full JSON payloads
//   node tools/mcp-trace.mjs --list-only              # initialize + tools/list only

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- flags ----------

const flags = {
  repo: null,
  agent: "claude_code",
  mode: "read_only",
  title: null,
  prompt: null,
  tasks: 1,
  db: "temp", // temp | real
  pollMs: 3000,
  maxWaitSecs: 300,
  joinSecs: 60,
  accept: true,
  cleanup: "auto", // auto | always | never
  verbose: false,
  listOnly: false,
  keep: false,
};

for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  const value = () => process.argv[++index];
  switch (arg) {
    case "--repo": flags.repo = value(); break;
    case "--agent": flags.agent = value(); break;
    case "--mode": flags.mode = value(); break;
    case "--title": flags.title = value(); break;
    case "--prompt": flags.prompt = value(); break;
    case "--tasks": flags.tasks = Number.parseInt(value(), 10); break;
    case "--db": flags.db = value(); break;
    case "--poll-ms": flags.pollMs = Number.parseInt(value(), 10); break;
    case "--max-wait-secs": flags.maxWaitSecs = Number.parseInt(value(), 10); break;
    case "--join-secs": flags.joinSecs = Number.parseInt(value(), 10); break;
    case "--cleanup": flags.cleanup = value(); break;
    case "--no-accept": flags.accept = false; break;
    case "--verbose": flags.verbose = true; break;
    case "--list-only": flags.listOnly = true; break;
    case "--keep": flags.keep = true; break;
    default:
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
  }
}
if (!["claude_code", "codex"].includes(flags.agent)) {
  console.error(`--agent must be claude_code or codex`);
  process.exit(2);
}
if (!["read_only", "workspace_write"].includes(flags.mode)) {
  console.error(`--mode must be read_only or workspace_write`);
  process.exit(2);
}

// ---------- pretty logging ----------

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const step = (n, title) => console.log(`\n━━ STEP ${n}: ${title} ${"━".repeat(Math.max(2, 52 - title.length))}`);
const line = (text) => console.log(`${stamp()} ${text}`);
const brief = (value, limit = 110) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? text.slice(0, limit) + "…" : text;
};

// ---------- throwaway repo ----------

function runSync(cwd, command) {
  return execFileSync("sh", ["-c", command], { cwd, encoding: "utf8" });
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octopunk-trace-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  runSync(repo, "git init -q && git config user.email trace@local && git config user.name trace");
  fs.writeFileSync(path.join(repo, "README.md"), "# trace repo\n");
  const head = runSync(repo, "git add -A && git commit -qm init && git rev-parse HEAD").trim();
  return { dir, repo, head };
}

// ---------- MCP client ----------

class McpServer {
  constructor(databaseURL) {
    this.child = spawn("./node_modules/.bin/electron", [".", "--mcp-stdio"], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        ...(databaseURL != null ? { OCTOPUNK_DATABASE_URL: databaseURL } : {}),
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.nextID = 1;
    this.pending = new Map();
    this.notificationCount = 0;
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const text of lines) {
        if (text.trim().length === 0) continue;
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          continue;
        }
        if (message.id != null && this.pending.has(message.id)) {
          const { resolve } = this.pending.get(message.id);
          this.pending.delete(message.id);
          resolve(message);
        } else if (message.method != null) {
          this.notificationCount += 1;
          const params = message.params ?? {};
          line(
            `⇠ event #${this.notificationCount} ${message.method} seq=${params.sequence ?? "-"} ` +
              `kind=${params.kind ?? "-"}${params.status ? ` status=${params.status}` : ""}`,
          );
          if (flags.verbose) {
            console.log(`         ${brief(params)}`);
          }
        }
      }
    });
  }

  get pid() {
    return this.child.pid;
  }

  send(object) {
    this.child.stdin.write(JSON.stringify(object) + "\n");
  }

  request(method, params, timeoutMs = 120000) {
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout (${timeoutMs}ms) waiting for ${method}`));
        }
      }, timeoutMs).unref();
    });
  }

  async call(name, args) {
    if (flags.verbose) line(`⇢ tools/call ${name} ${brief(args)}`);
    const response = await this.request("tools/call", { name, arguments: args });
    if (response.error) throw new Error(`${name}: ${response.error.message}`);
    const text = response.result?.content?.[0]?.text ?? "";
    if (response.result?.isError) throw new Error(`${name} failed: ${text}`);
    return text.length > 0 ? JSON.parse(text) : null;
  }

  kill() {
    this.child.kill("SIGTERM");
    setTimeout(() => this.child.kill("SIGKILL"), 5000).unref();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requestCounter = { value: 0 };
const processSalt = Date.now().toString(36);
const nextRequestID = (label) => `trace-${processSalt}-${label}-${++requestCounter.value}`;

function payloadPreview(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed.message ?? brief(raw, 90);
  } catch {
    return brief(raw, 90);
  }
}

// ---------- main ----------

let temp = null;
let databaseURL = null;
let repo = null;
let head = null;

if (flags.repo != null) {
  repo = flags.repo;
  head = runSync(repo, "git rev-parse HEAD").trim();
  databaseURL =
    flags.db === "real"
      ? null
      : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "octopunk-trace-db-")), "trace.sqlite");
} else {
  temp = makeTempRepo();
  repo = temp.repo;
  head = temp.head;
  databaseURL = path.join(temp.dir, "trace.sqlite");
}
if (flags.db === "real") databaseURL = null;

const server = new McpServer(databaseURL);

try {
  step(1, `launch (${repo === temp?.repo ? "throwaway repo + throwaway DB" : repo})`);
  console.log(`  app       : ${APP_ROOT}`);
  console.log(`  server pid: ${server.pid}`);
  console.log(`  repo      : ${repo} @ ${head.slice(0, 10)}`);
  console.log(`  database  : ${databaseURL ?? "~/Library/Application Support/OctoPunk/octopunk.sqlite (LIVE)"}`);

  step(2, "initialize");
  const init = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-trace", version: "1" },
  });
  console.log(`  server: ${init.result.serverInfo.name}@${init.result.serverInfo.version}`);
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  step(3, "tools/list");
  const tools = await server.request("tools/list", {});
  console.log(`  ${tools.result.tools.length} tools: ${tools.result.tools.map((t) => t.name).join(", ")}`);
  if (flags.listOnly) {
    console.log("\nDONE (--list-only)");
    process.exit(0);
  }

  step(4, "start_team");
  const start = await server.call("start_team", {
    request_id: nextRequestID("start"),
    repository_path: repo,
    task: flags.title ?? "mcp-trace inspection run",
    baseline_commit: head,
    target_branch: currentBranch(repo),
    max_review_rounds: 3,
  });
  const runID = start.run.id;
  line(`run ${runID.slice(0, 8)} status=${start.run.status} baseline=${start.run.baselineCommit.slice(0, 10)} target=${start.run.targetBranch || "detached"}`);

  step(5, `delegate_tasks (${flags.tasks} × ${flags.agent}/${flags.mode})`);
  const items = Array.from({ length: flags.tasks }, (_, index) => ({
    client_key: `trace-${index + 1}`,
    title: `${flags.title ?? "Inspect"} #${index + 1}`,
    prompt: flags.prompt ?? "Reply with the single word OK and nothing else.",
    agent_kind: flags.agent,
    execution_mode: flags.mode,
    parent_task: null,
    dependencies: [],
  }));
  const delegation = await server.call("delegate_tasks", {
    request_id: nextRequestID("delegate"),
    run_id: runID,
    context_summary: "mcp-trace parent context: observe every execution step.",
    tasks: items,
  });
  const batchID = delegation.batch.id;
  const taskIDs = delegation.tasks.map((task) => task.id);
  for (const task of delegation.tasks) {
    line(`task ${task.id.slice(0, 8)} key=${task.clientKey} status=${task.status} workspace=${task.workspaceKind}`);
  }

  step(6, `monitor (poll every ${flags.pollMs}ms, live events below)`);
  const cursor = new Map();
  const lastStatus = new Map();
  const deadline = Date.now() + flags.maxWaitSecs * 1000;
  let reviewable = false;
  while (Date.now() < deadline) {
    const status = await server.call("get_team_status", { run_id: runID });
    for (const task of status.tasks) {
      if (lastStatus.get(task.id) !== task.status) {
        lastStatus.set(task.id, task.status);
        line(`task ${task.id.slice(0, 8)} → ${task.status}${task.latestError ? ` (${brief(task.latestError, 60)})` : ""}`);
      }
    }
    for (const task of status.tasks) {
      const after = cursor.get(task.id) ?? 0;
      const log = await server.call("get_task_execution_log", {
        run_id: runID,
        task_id: task.id,
        after_sequence: after,
      });
      for (const event of log.events) {
        cursor.set(task.id, Math.max(cursor.get(task.id) ?? 0, event.sequence));
        line(`  audit #${event.sequence} ${event.kind}: ${payloadPreview(event.payload)}`);
      }
      if (log.log?.latestActivity && flags.verbose) {
        line(`  activity ${task.id.slice(0, 8)}: ${brief(log.log.latestActivity, 90)}`);
      }
    }
    const allSettled = status.tasks.every(
      (task) =>
        task.status === "awaiting_report" ||
        ["accepted", "blocked", "cancelled", "failed"].includes(task.status),
    );
    if (allSettled) {
      reviewable = status.tasks.some((task) => task.status === "awaiting_report");
      break;
    }
    await sleep(flags.pollMs);
  }

  step(7, `join_tasks (bounded ${flags.joinSecs}s)`);
  const joined = await server.call("join_tasks", {
    run_id: runID,
    batch_id: batchID,
    timeout_seconds: flags.joinSecs,
  });
  line(`timedOut=${joined.timedOut} pending=${joined.pendingTaskIDs.length} latestSequence=${joined.latestEventSequence}`);
  for (const row of joined.markdownSummary.split("\n").filter(Boolean).slice(0, 2 + flags.tasks)) {
    console.log(`  | ${row}`);
  }

  if (flags.accept && reviewable) {
    step(8, "accept_task (PASS) per awaiting report");
    for (const [index, taskID] of taskIDs.entries()) {
      const accepted = await server.call("accept_task", {
        request_id: nextRequestID("accept"),
        run_id: runID,
        task_id: taskID,
        summary: `mcp-trace acceptance #${index + 1}`,
      });
      line(`task ${taskID.slice(0, 8)} → ${accepted.status}`);
    }

    step(9, "complete_team (final PASS)");
    const completed = await server.call("complete_team", {
      request_id: nextRequestID("complete"),
      run_id: runID,
      final_verdict: "PASS",
      summary: "mcp-trace final review",
    });
    line(`run → ${completed.run.status}`);
  } else {
    step(8, flags.accept ? "no awaiting_report task — skipping review" : "--no-accept — stopping before review");
  }

  step(10, "final state");
  const final = await server.call("get_team_status", { run_id: runID });
  line(`run ${final.run.id.slice(0, 8)} status=${final.run.status}`);
  for (const task of final.tasks) {
    line(
      `task ${task.id.slice(0, 8)} status=${task.status} attempts=${final.attempts.filter((a) => a.taskID === task.id).length}` +
        `${task.latestReport ? ` report="${brief(task.latestReport, 50)}"` : ""}`,
    );
  }

  const cleanupMode = flags.keep ? "never" : flags.cleanup === "auto" ? (databaseURL != null ? "always" : "never") : flags.cleanup;
  if (cleanupMode === "always" && final.run.status !== "completed") {
    step(11, "cleanup (cancel_team + discard_team)");
    await server.call("cancel_team", { request_id: nextRequestID("cancel"), run_id: runID });
    await server.call("discard_team", { request_id: nextRequestID("discard"), run_id: runID });
    line("worktrees discarded");
  } else if (cleanupMode === "always" && final.run.status === "completed") {
    step(11, "cleanup (completed run is retained by design)");
  }

  console.log(`\n${"━".repeat(64)}`);
  console.log(
    `SUMMARY  notifications=${server.notificationCount}  audit-events=${final.events.length}  final-run=${final.run.status}`,
  );
  console.log("TRACE PASSED");
} catch (error) {
  console.error(`\n${stamp()} TRACE FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  server.kill();
  if (temp != null) {
    setTimeout(() => fs.rmSync(temp.dir, { recursive: true, force: true }), 1000).unref();
  }
}

function currentBranch(repoPath) {
  try {
    return runSync(repoPath, "git branch --show-current").trim();
  } catch {
    return "";
  }
}
