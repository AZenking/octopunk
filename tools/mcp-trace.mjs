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
//   node tools/mcp-trace.mjs --models glm-5.2,glm-5.3 # per-task model overrides (task N uses entry N)
//   node tools/mcp-trace.mjs --no-accept              # stop after the report, before review
//   node tools/mcp-trace.mjs --keep                   # never discard worktrees at the end
//   node tools/mcp-trace.mjs --verbose                # full JSON payloads
//   node tools/mcp-trace.mjs --list-only              # initialize + tools/list only
//   node tools/mcp-trace.mjs --gate "tests=pnpm test,lint=pnpm exec eslint ."
//     # quality-gate scenario (specs/002 quickstart 场景 2): set_gate_config before
//     # start_team, run_quality_gate per awaiting report before accept; a failing
//     # overall without --gate-waive proves accept_task interception (contract B).
//   #   --gate-fail-path tests/broken.test.ts  # plant a marker file and force the
//     # tests check to `test ! -f <marker>` so that item deterministically fails
//   #   --gate-waive                          # waive each failing item (reason
//     # "mcp-trace waiver"), re-evaluate to overall=waived, then accept

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
  prompts: [], // per-task prompts separated by "||"; missing entries fall back to --prompt
  tasks: 1,
  models: [], // per-task model overrides; task N uses entry N (unset = per-kind default)
  db: "temp", // temp | real
  pollMs: 3000,
  maxWaitSecs: 300,
  joinSecs: 60,
  accept: true,
  cleanup: "auto", // auto | always | never
  verbose: false,
  listOnly: false,
  keep: false,
  gateSpec: null, // "tests=pnpm test,lint=…" enables the quality-gate scenario (spec 002 场景 2)
  gateFailPath: null, // repo-relative marker path; forces the injected tests check to fail
  gateWaive: false, // waive failing items ("mcp-trace waiver"), re-evaluate, then accept
  runs: 0, // >0: multi-run scenario — N parallel MCP sessions (spec 001 场景 1)
  sameRepoSerial: false, // with --runs 2: same repo, second complete_team must be rejected (集成串行化)
  doctor: false, // run the doctor checkup scenario (spec 001 场景 3) and exit
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
    case "--prompts": flags.prompts = value().split("||").map((p) => p.trim()).filter(Boolean); break;
    case "--tasks": flags.tasks = Number.parseInt(value(), 10); break;
    case "--models": flags.models = value().split(",").map((model) => model.trim()).filter(Boolean); break;
    case "--db": flags.db = value(); break;
    case "--poll-ms": flags.pollMs = Number.parseInt(value(), 10); break;
    case "--max-wait-secs": flags.maxWaitSecs = Number.parseInt(value(), 10); break;
    case "--join-secs": flags.joinSecs = Number.parseInt(value(), 10); break;
    case "--cleanup": flags.cleanup = value(); break;
    case "--no-accept": flags.accept = false; break;
    case "--verbose": flags.verbose = true; break;
    case "--list-only": flags.listOnly = true; break;
    case "--keep": flags.keep = true; break;
    case "--gate": flags.gateSpec = value(); break;
    case "--gate-fail-path": flags.gateFailPath = value(); break;
    case "--runs": flags.runs = Number.parseInt(value(), 10); break;
    case "--same-repo-serial": flags.sameRepoSerial = true; break;
    case "--doctor": flags.doctor = true; break;
    case "--gate-waive": flags.gateWaive = true; break;
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
if (flags.gateSpec != null && flags.gateSpec.trim().length === 0) {
  console.error(`--gate must list at least one check, e.g. --gate "tests=pnpm test"`);
  process.exit(2);
}
if ((flags.gateFailPath != null || flags.gateWaive) && flags.gateSpec == null) {
  console.error(`--gate-fail-path / --gate-waive only make sense together with --gate`);
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
const shellQuote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

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

  async call(name, args, timeoutMs = 120000) {
    if (flags.verbose) line(`⇢ tools/call ${name} ${brief(args)}`);
    const response = await this.request("tools/call", { name, arguments: args }, timeoutMs);
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

/** One compact line per gate item: check_key / status / detail (+ fix suggestion). */
function printGateEvaluation(evaluation) {
  line(
    `task ${evaluation.taskID.slice(0, 8)} gate overall=${evaluation.overall} ` +
      `evaluation=${evaluation.id.slice(0, 8)} items=${evaluation.items.length}`,
  );
  for (const item of evaluation.items) {
    line(`  ${item.checkKey.padEnd(17)} ${item.status.padEnd(7)} ${brief(item.detail ?? "", 84)}`);
    if (item.status === "fail" && item.fixSuggestion != null) {
      line(`  ${" ".repeat(17)} fix: ${brief(item.fixSuggestion, 84)}`);
    }
  }
}

// ---------- v0.3 scenarios (T029): doctor / multi-run / same-repo serialization ----------

/** Poll get_team_status until the task reaches awaiting_report or a terminal state. */
async function awaitTaskReport(server, runID, taskID) {
  const deadline = Date.now() + flags.maxWaitSecs * 1000;
  for (;;) {
    const status = await server.call("get_team_status", { run_id: runID });
    const task = status.tasks.find((candidate) => candidate.id === taskID);
    if (
      task == null ||
      ["awaiting_report", "rework_required", "accepted", "blocked", "cancelled", "failed"].includes(task.status)
    ) {
      return { status, task };
    }
    if (Date.now() > deadline) return { status, task: task ?? null };
    await sleep(flags.pollMs);
  }
}

async function doctorScenario() {
  const tempRepo = makeTempRepo();
  const server = new McpServer(path.join(tempRepo.dir, "trace.sqlite"));
  try {
    step(1, "doctor scenario — run_doctor (throwaway repo + DB)");
    await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-trace", version: "1" },
    });
    server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const report = await server.call("run_doctor", {
      request_id: nextRequestID("doctor"),
      repository_path: tempRepo.repo,
      triggered_by: "user",
    });
    line(`overall=${report.overall} items=${report.items.length}`);
    for (const item of report.items) {
      line(`  ${item.checkKey.padEnd(16)} ${item.status.padEnd(8)} ${brief(item.detail ?? "", 80)}`);
    }
    const retryKey = report.items.find((item) => item.status !== "pass")?.checkKey ?? "db_health";
    step(2, `doctor rerun one item (${retryKey})`);
    const rerun = await server.call("run_doctor", {
      request_id: nextRequestID("doctor-rerun"),
      repository_path: tempRepo.repo,
      triggered_by: "user",
    }).catch(() => null);
    if (rerun != null) line(`re-check overall=${rerun.overall}`);
    console.log("\nDONE (--doctor)");
  } finally {
    server.child.kill("SIGTERM");
    fs.rmSync(tempRepo.dir, { recursive: true, force: true });
  }
  process.exit(0);
}

async function multiRunScenario() {
  const count = flags.runs;
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "octopunk-trace-multi-"));
  const databaseURL = path.join(sharedDir, "trace.sqlite");
  const sharedRepo = flags.sameRepoSerial ? makeTempRepo() : null;
  const temps = sharedRepo ? [sharedRepo] : [];
  const sessions = [];
  try {
    step(1, `multi-run scenario — ${count} parallel MCP sessions (${flags.sameRepoSerial ? "same repo" : "repo per session"})`);
    for (let index = 0; index < count; index += 1) {
      const repoInfo = sharedRepo ?? makeTempRepo();
      if (!sharedRepo) temps.push(repoInfo);
      const server = new McpServer(databaseURL);
      await server.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-trace", version: "1" },
      });
      server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const start = await server.call("start_team", {
        request_id: nextRequestID(`start-${index}`),
        repository_path: repoInfo.repo,
        task: `mcp-trace multi-run #${index + 1}`,
        baseline_commit: repoInfo.head,
        target_branch: currentBranch(repoInfo.repo),
      });
      const delegated = await server.call("delegate_tasks", {
        request_id: nextRequestID(`delegate-${index}`),
        context_summary: "multi-run isolation probe",
        tasks: [
          {
            client_key: `multi-${index}`,
            title: `Inspect #${index + 1}`,
            prompt: flags.prompt ?? "Report the repository name you can see and stop.",
            agent_kind: flags.agent,
            execution_mode: flags.mode,
          },
        ],
      });
      sessions.push({ server, repo: repoInfo.repo, runID: start.run.id, taskID: delegated.tasks[0].id, index });
      line(`session ${index + 1}: run ${start.run.id.slice(0, 8)} task ${delegated.tasks[0].id.slice(0, 8)} baseline=${start.run.baselineCommit.slice(0, 8)}`);
    }

    step(2, "cross-talk assertion — each session sees only its own run/task");
    let isolated = true;
    for (const session of sessions) {
      const status = await session.server.call("get_team_status", { run_id: session.runID });
      const foreignTasks = status.tasks.filter((task) => task.id !== session.taskID);
      const sameBase = status.run.baselineCommit != null;
      if (foreignTasks.length > 0 || status.run.id !== session.runID || !sameBase) isolated = false;
      line(`session ${session.index + 1}: tasks=${status.tasks.length} own=${foreignTasks.length === 0 ? "yes" : "NO"}`);
    }
    line(isolated ? "PASS: zero cross-talk between parallel runs" : "FAIL: cross-talk detected");
    if (!isolated) process.exitCode = 1;

    if (!flags.accept) {
      console.log("\nDONE (--runs, --no-accept)");
      return;
    }

    step(3, "await reports in parallel");
    await Promise.all(sessions.map((session) => awaitTaskReport(session.server, session.runID, session.taskID)));
    for (const session of sessions) {
      await session.server.call("accept_task", {
        request_id: nextRequestID(`accept-${session.index}`),
        run_id: session.runID,
        task_id: session.taskID,
        summary: `mcp-trace multi-run acceptance #${session.index + 1}`,
      });
    }

    if (flags.sameRepoSerial && sessions.length === 2) {
      step(4, "integration serialization — first complete applies, second must be rejected");
      const first = await sessions[0].server.call("complete_team", {
        request_id: nextRequestID("complete-0"),
        run_id: sessions[0].runID,
        final_verdict: "PASS",
        summary: "mcp-trace serial first",
      });
      line(`first  → run status=${first.run.status} (target branch advanced)`);
      let rejection = null;
      try {
        await sessions[1].server.call("complete_team", {
          request_id: nextRequestID("complete-1"),
          run_id: sessions[1].runID,
          final_verdict: "PASS",
          summary: "mcp-trace serial second",
        });
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
      }
      if (rejection != null && /baseline|target|moved|dirty/i.test(rejection)) {
        line(`second → REJECTED as expected: ${brief(rejection, 90)}`);
        line("PASS: same-repo integration is serialized (no double-write)");
      } else {
        line(`FAIL: second complete_team was not rejected (${rejection ?? "succeeded"})`);
        process.exitCode = 1;
      }
    } else {
      step(4, "complete each run");
      for (const session of sessions) {
        const completed = await session.server.call("complete_team", {
          request_id: nextRequestID(`complete-${session.index}`),
          run_id: session.runID,
          final_verdict: "PASS",
          summary: `mcp-trace multi-run #${session.index + 1}`,
        });
        line(`run ${session.runID.slice(0, 8)} → ${completed.run.status}`);
      }
    }
    console.log("\nDONE (--runs)");
  } finally {
    for (const session of sessions) session.server.child.kill("SIGTERM");
    if (!flags.keep) {
      for (const temp of temps) fs.rmSync(temp.dir, { recursive: true, force: true });
      fs.rmSync(sharedDir, { recursive: true, force: true });
    }
  }
  process.exit(process.exitCode ?? 0);
}

// ---------- main ----------

if (flags.doctor) await doctorScenario();
if (flags.runs > 0) {
  if (flags.sameRepoSerial && flags.runs !== 2) {
    console.error("--same-repo-serial requires --runs 2");
    process.exit(2);
  }
  await multiRunScenario();
}

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

// ---------- quality-gate scenario prep (specs/002-v04-review-center-gates, quickstart 场景 2) ----------

const GATE_COMMAND_KEYS = ["tests", "lint", "typecheck", "build"]; // policy.ts GATE_COMMAND_KEYS
const GATE_CHECK_TIMEOUT_SECONDS = 120; // per-check ceiling (policy caps 1–600)

/** Parse `--gate "tests=pnpm test,lint=…"` into GateCheckCommandInput entries. */
function parseGateChecks(spec) {
  const checks = {};
  for (const part of spec.split(",")) {
    const entry = part.trim();
    if (entry.length === 0) continue;
    const separator = entry.indexOf("=");
    const key = separator > 0 ? entry.slice(0, separator).trim() : "";
    const command = separator > 0 ? entry.slice(separator + 1).trim() : "";
    if (!GATE_COMMAND_KEYS.includes(key) || command.length === 0 || checks[key] != null) {
      console.error(`--gate entries must be ${GATE_COMMAND_KEYS.join("/")}=command, at most one each (got: "${entry}")`);
      process.exit(2);
    }
    checks[key] = { command, timeoutSeconds: GATE_CHECK_TIMEOUT_SECONDS };
  }
  if (Object.keys(checks).length === 0) {
    console.error(`--gate must configure at least one of ${GATE_COMMAND_KEYS.join("/")}`);
    process.exit(2);
  }
  return checks;
}

const gateChecks = flags.gateSpec != null ? parseGateChecks(flags.gateSpec) : null;
let gateFailNote = null;
if (gateChecks != null && flags.gateFailPath != null) {
  // --gate-fail-path deliberately breaks the `tests` check: write a marker file,
  // then force that check to `test ! -f <marker>` (exits 1 while the file exists).
  // The command pins the ABSOLUTE marker path because gate commands execute in
  // the task worktree (data-model), where an uncommitted repo file would be
  // invisible — this keeps the failure deterministic without committing to (or
  // otherwise rewriting) the user's git history. Cleanup: throwaway repos are
  // deleted wholesale in the finally block; a real repo is left untouched.
  const markerPath = path.isAbsolute(flags.gateFailPath) ? flags.gateFailPath : path.join(repo, flags.gateFailPath);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    "# mcp-trace --gate-fail-path marker\n# The injected tests check runs `test ! -f` on this file; delete it to let the gate pass.\n",
  );
  gateFailNote =
    `--gate-fail-path: marker planted at ${markerPath}; tests check ` +
    (gateChecks.tests != null ? `overridden ("${gateChecks.tests.command}" → "test ! -f") to fail` : `injected as "test ! -f"`);
  gateChecks.tests = { command: `test ! -f ${shellQuote(markerPath)}`, timeoutSeconds: GATE_CHECK_TIMEOUT_SECONDS };
}

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

  // Steps after tools/list number themselves so optional scenario steps
  // (--gate) can slot in without renumbering the whole script by hand.
  let stepNumber = 3;
  const nextStep = (title) => {
    stepNumber += 1;
    return step(stepNumber, title);
  };

  if (gateChecks != null) {
    nextStep("set_gate_config (project default gate)");
    // Saved BEFORE start_team: the run freezes the effective gate (project
    // default ⊕ overrides) into team_runs.gate_snapshot_json at start time,
    // so saving later would not affect this run.
    const saved = await server.call("set_gate_config", {
      request_id: nextRequestID("gate-config"),
      repository_path: repo,
      config: {
        checks: {
          tests: gateChecks.tests ?? null,
          lint: gateChecks.lint ?? null,
          typecheck: gateChecks.typecheck ?? null,
          build: gateChecks.build ?? null,
        },
        requireTargetBaselineSafe: true,
        requireTodoClean: false,
        reviewMode: "standard",
      },
    });
    const activeChecks = Object.entries(gateChecks)
      .map(([key, check]) => `${key}="${check.command}"`)
      .join(", ");
    line(`saved gate config for ${repo}`);
    line(`  checks: ${activeChecks.length > 0 ? activeChecks : "(none)"}`);
    line(`  requireTargetBaselineSafe=true requireTodoClean=false reviewMode=standard`);
    if (gateFailNote != null) line(gateFailNote);
    if (flags.verbose && saved != null) console.log(`  ${brief(saved)}`);
  }

  nextStep("start_team");
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

  nextStep(`delegate_tasks (${flags.tasks} × ${flags.agent}/${flags.mode}${flags.models.length > 0 ? `, models=[${flags.models.join(", ")}]` : ""})`);
  const items = Array.from({ length: flags.tasks }, (_, index) => ({
    client_key: `trace-${index + 1}`,
    title: `${flags.title ?? "Inspect"} #${index + 1}`,
    prompt: flags.prompts[index] ?? flags.prompt ?? "Reply with the single word OK and nothing else.",
    agent_kind: flags.agent,
    ...(flags.models[index] != null ? { model: flags.models[index] } : {}),
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
    line(`task ${task.id.slice(0, 8)} key=${task.clientKey} status=${task.status} workspace=${task.workspaceKind} model=${task.model ?? "-"}`);
  }

  nextStep(`monitor (poll every ${flags.pollMs}ms, live events below)`);
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

  nextStep(`join_tasks (bounded ${flags.joinSecs}s)`);
  const joined = await server.call("join_tasks", {
    run_id: runID,
    batch_id: batchID,
    timeout_seconds: flags.joinSecs,
  });
  line(`timedOut=${joined.timedOut} pending=${joined.pendingTaskIDs.length} latestSequence=${joined.latestEventSequence}`);
  for (const row of joined.markdownSummary.split("\n").filter(Boolean).slice(0, 2 + flags.tasks)) {
    console.log(`  | ${row}`);
  }

  // Latest evaluation per awaiting task; overall=fail (unwaived) drives the
  // accept interception demo below (contract B: accept_task must refuse).
  const gateOutcomes = new Map();
  if (gateChecks != null && reviewable) {
    nextStep("run_quality_gate (evaluate before accept)");
    const awaitingTaskIDs = taskIDs.filter((id) => lastStatus.get(id) === "awaiting_report");
    for (const taskID of awaitingTaskIDs) {
      // Generous timeout: each configured check may run up to its own timeoutSeconds.
      let evaluation = await server.call(
        "run_quality_gate",
        { request_id: nextRequestID("gate-eval"), run_id: runID, task_id: taskID },
        600000,
      );
      printGateEvaluation(evaluation);
      if (evaluation.overall === "fail" && flags.gateWaive) {
        for (const item of evaluation.items.filter((item) => item.status === "fail")) {
          // Contract invariant: waivers are per-item and must carry a reason.
          const waived = await server.call("waive_gate_item", {
            request_id: nextRequestID("gate-waive"),
            evaluation_id: evaluation.id,
            item_id: item.id,
            reason: "mcp-trace waiver",
          });
          line(`  waived ${item.checkKey} → ${waived?.status ?? "waived"} (reason "mcp-trace waiver")`);
        }
        // Re-evaluate (a fresh evaluation, not a mutation) to confirm overall=waived.
        evaluation = await server.call(
          "run_quality_gate",
          { request_id: nextRequestID("gate-reeval"), run_id: runID, task_id: taskID },
          600000,
        );
        printGateEvaluation(evaluation);
      }
      gateOutcomes.set(taskID, evaluation);
    }
  }

  if (flags.accept && reviewable) {
    nextStep("accept_task (PASS) per awaiting report");
    let gateBlocked = false;
    for (const [index, taskID] of taskIDs.entries()) {
      const gate = gateOutcomes.get(taskID);
      if (gate != null && gate.overall === "fail" && !flags.gateWaive) {
        // Interfaces.md B: accept_task must reject while unwaived failing items
        // exist — surface the rejection as evidence instead of failing the trace.
        try {
          const accepted = await server.call("accept_task", {
            request_id: nextRequestID("accept"),
            run_id: runID,
            task_id: taskID,
            summary: `mcp-trace acceptance #${index + 1}`,
          });
          line(`task ${taskID.slice(0, 8)} → ${accepted.status} (UNEXPECTED: failing gate did not intercept)`);
        } catch (error) {
          gateBlocked = true;
          line(`task ${taskID.slice(0, 8)} accept REJECTED by gate (expected): ${brief(error.message, 110)}`);
        }
        continue;
      }
      const accepted = await server.call("accept_task", {
        request_id: nextRequestID("accept"),
        run_id: runID,
        task_id: taskID,
        summary: `mcp-trace acceptance #${index + 1}`,
      });
      line(`task ${taskID.slice(0, 8)} → ${accepted.status}`);
    }

    if (gateBlocked) {
      nextStep("complete_team skipped (failing gate without --gate-waive blocks acceptance)");
    } else {
      nextStep("complete_team (final PASS)");
      const completed = await server.call("complete_team", {
        request_id: nextRequestID("complete"),
        run_id: runID,
        final_verdict: "PASS",
        summary: "mcp-trace final review",
      });
      line(`run → ${completed.run.status}`);
    }
  } else {
    nextStep(flags.accept ? "no awaiting_report task — skipping review" : "--no-accept — stopping before review");
  }

  nextStep("final state");
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
    nextStep("cleanup (cancel_team + discard_team)");
    await server.call("cancel_team", { request_id: nextRequestID("cancel"), run_id: runID });
    await server.call("discard_team", { request_id: nextRequestID("discard"), run_id: runID });
    line("worktrees discarded");
  } else if (cleanupMode === "always" && final.run.status === "completed") {
    nextStep("cleanup (completed run is retained by design)");
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
  // --gate-fail-path markers live inside the repo dir: throwaway repos are
  // removed wholesale here; a real repo (--repo …) is deliberately untouched.
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
