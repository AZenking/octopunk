// Platform diagnostics probes (v0.3 T017): process liveness via `ps`, orphan
// worktree/branch scanning, and system/disk sampling. Pure read-only helpers
// shared by recovery (US2), doctor (US3), and resource monitoring (US4).
//
// Constitution principle four: only processes carrying the octopunk marker in
// their command line are ever considered ours. Every probe is best effort —
// failures never throw; they return discriminable results (Chinese detail).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ChildAgentDiagnostics, type ProcessPort } from "../application/ports";

const PS_EXECUTABLE = "/bin/ps";
const GIT_EXECUTABLE = "/usr/bin/git";
/** Command snippets stay short and credential-free wherever they are shown. */
const COMMAND_SNIPPET_LIMIT = 300;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function redactCommand(command: string): string {
  return ChildAgentDiagnostics.redact(command).slice(0, COMMAND_SNIPPET_LIMIT);
}

/** The ownership marker: "octopunk" anywhere in the command line (any case). */
function hasOctopunkMarker(command: string): boolean {
  return command.toLowerCase().includes("octopunk");
}

/** Parses `ps -o pid=,command=` rows into {pid, command} entries. */
function parsePsLines(stdout: string): { pid: number; command: string }[] {
  const entries: { pid: number; command: string }[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\S.*)$/);
    if (match == null) continue;
    const pid = Number.parseInt(match[1], 10);
    const command = match[2].trim();
    if (command.length === 0) continue;
    entries.push({ pid, command });
  }
  return entries;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// 1. Process liveness probe
// ---------------------------------------------------------------------------

export interface ProcessProbeResult {
  alive: boolean;
  /** True only when the command line carries the octopunk marker. */
  octopunkOwned: boolean;
  command: string | null;
  /** 非 null 表示探测本身失败(进程状态未知)的中文说明。 */
  detail: string | null;
}

/**
 * `ps -o pid=,command= -p <pid>`: alive = ps produced a row; octopunkOwned =
 * the command line carries the marker. A non-zero ps exit means the PID is
 * gone; a failure to run ps at all is surfaced through `detail`.
 */
export async function probeProcess(pid: number, processPort: ProcessPort): Promise<ProcessProbeResult> {
  const dead = (detail: string | null = null): ProcessProbeResult => ({
    alive: false,
    octopunkOwned: false,
    command: null,
    detail,
  });
  if (!Number.isInteger(pid) || pid <= 0) {
    return dead("无效 PID,无法探测");
  }
  let stdout: string;
  try {
    const result = await processPort.run({
      id: randomUUID(),
      executable: PS_EXECUTABLE,
      arguments: ["-o", "pid=,command=", "-p", String(pid)],
      environment: {},
    });
    stdout = result.stdout;
  } catch (error) {
    // `ps -p` exits non-zero when the PID matches nothing — a normal dead pid,
    // not an unknown state. Anything else means the probe could not run.
    const exitCode = (error as { exitCode?: unknown }).exitCode;
    if (typeof exitCode === "number") return dead();
    const message = error instanceof Error ? error.message : String(error);
    return dead(`无法运行 ps,进程 ${pid} 状态未知:${redactCommand(message)}`);
  }
  const entry = parsePsLines(stdout)[0];
  if (entry == null) return dead();
  return {
    alive: true,
    octopunkOwned: hasOctopunkMarker(entry.command),
    command: redactCommand(entry.command),
    detail: null,
  };
}

// ---------------------------------------------------------------------------
// 2. OctoPunk-marked process listing
// ---------------------------------------------------------------------------

export interface OctopunkProcessEntry {
  pid: number;
  command: string;
}

/** `ps -axo pid=,command=` filtered to marker-carrying rows, minus our own PID. */
export async function listOctopunkProcesses(processPort: ProcessPort): Promise<OctopunkProcessEntry[]> {
  let stdout: string;
  try {
    const result = await processPort.run({
      id: randomUUID(),
      executable: PS_EXECUTABLE,
      arguments: ["-axo", "pid=,command="],
      environment: {},
    });
    stdout = result.stdout;
  } catch {
    // Best effort: no listing beats a fabricated one.
    return [];
  }
  const ownPID = process.pid;
  return parsePsLines(stdout)
    .filter((entry) => entry.pid !== ownPID && hasOctopunkMarker(entry.command))
    .map((entry) => ({ pid: entry.pid, command: redactCommand(entry.command) }));
}

// ---------------------------------------------------------------------------
// 3. Orphan worktree scan
// ---------------------------------------------------------------------------

export interface OrphanWorktreeItem {
  path: string;
  kind: "orphan_worktree";
  /** 中文说明:目录大小(尽力而为,失败标未知)+ .git 标记存在性。 */
  detail: string;
  suggestion: string;
}

export interface ScanOrphanWorktreesOptions {
  /** 托管根(gitAdapter 的 worktrees/ 与 integration/ 根),由调用方传入。 */
  managedRoots: string[];
  /** 数据库登记的活/终态任务 worktree 路径,由调用方查库后传入。 */
  registeredPaths: string[];
}

/**
 * Enumerates the leaf worktree directories under each managed root (same walk
 * semantics as WorktreeMaintenanceService: descend until a `.git` entry or a
 * leaf) and reports the ones absent from registeredPaths as orphans.
 */
export async function scanOrphanWorktrees(
  options: ScanOrphanWorktreesOptions,
): Promise<OrphanWorktreeItem[]> {
  const registered = new Set(options.registeredPaths);
  const items: OrphanWorktreeItem[] = [];
  for (const root of options.managedRoots) {
    for (const candidate of collectLeafWorktreeDirs(root)) {
      if (registered.has(candidate)) continue;
      items.push(orphanWorktreeItem(candidate));
    }
  }
  items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return items;
}

/** Port of WorktreeMaintenanceService.collectLeafDirs (best effort, sync). */
function collectLeafWorktreeDirs(root: string): string[] {
  const leaves: string[] = [];
  const walk = (directory: string): void => {
    // A directory with a .git entry is a worktree root — stop there.
    if (fs.existsSync(path.join(directory, ".git"))) {
      if (directory !== root) leaves.push(directory);
      return;
    }
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs = children.filter((child) => child.isDirectory() && child.name !== ".git");
    if (subdirs.length === 0) {
      if (directory !== root) leaves.push(directory);
      return;
    }
    for (const child of subdirs) walk(path.join(directory, child.name));
  };
  try {
    walk(root);
  } catch {
    // Best effort: unreadable root yields nothing.
  }
  return leaves;
}

function orphanWorktreeItem(target: string): OrphanWorktreeItem {
  const hasGitMarker = fs.existsSync(path.join(target, ".git"));
  const sizeBytes = directorySize(target);
  const sizeText = sizeBytes == null ? "大小未知(目录统计失败)" : `大小约 ${formatBytes(sizeBytes)}`;
  return {
    path: target,
    kind: "orphan_worktree",
    detail: `${sizeText};${hasGitMarker ? "含 .git 工作树标记" : "无 .git 标记"}`,
    suggestion: "未登记于任何任务的托管目录,请在恢复视图显式确认后清理",
  };
}

/** Recursive stat sum; null when the walk fails (caller renders 大小未知). */
function directorySize(target: string): number | null {
  let total = 0;
  let readFailed = false;
  const walk = (directory: string): void => {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      readFailed = true;
      return;
    }
    for (const child of children) {
      const childPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        walk(childPath);
      } else {
        try {
          total += fs.statSync(childPath).size;
        } catch {
          // Gone mid-walk: keep the partial sum.
        }
      }
    }
  };
  try {
    walk(target);
  } catch {
    return null;
  }
  return readFailed ? null : total;
}

// ---------------------------------------------------------------------------
// 4. Orphan branch scan
// ---------------------------------------------------------------------------

export interface OrphanBranchItem {
  branch: string;
  kind: "orphan_branch";
  detail: string;
  suggestion: string;
}

export interface ScanOrphanBranchesOptions {
  repositoryURL: string;
  /** 该仓库现存 run 的分支前缀(octopunk/<runID>/),由调用方查库后传入。 */
  keepPrefixes: string[];
  processPort: ProcessPort;
  gitExecutable?: string;
}

/**
 * `git branch --list 'octopunk/*'` against the keep prefixes; branches under
 * no living run's prefix are reported as orphan_branch.
 */
export async function scanOrphanBranches(options: ScanOrphanBranchesOptions): Promise<OrphanBranchItem[]> {
  let stdout: string;
  try {
    const result = await options.processPort.run({
      id: randomUUID(),
      executable: options.gitExecutable ?? GIT_EXECUTABLE,
      arguments: ["-C", options.repositoryURL, "branch", "--list", "octopunk/*"],
      environment: {},
    });
    stdout = result.stdout;
  } catch {
    // Best effort: git unavailable → no verdict rather than a fabricated one.
    return [];
  }
  const keep = options.keepPrefixes.filter((prefix) => prefix.length > 0);
  const items: OrphanBranchItem[] = [];
  for (const branch of parseBranchListing(stdout)) {
    if (keep.some((prefix) => branch.startsWith(prefix))) continue;
    items.push({
      branch,
      kind: "orphan_branch",
      detail: "octopunk/* 分支不属于任何现存 run(登记前缀中无匹配)",
      suggestion: "确认无未合并工作后删除该分支",
    });
  }
  items.sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0));
  return items;
}

/** Strips the `* ` current-branch marker; keeps only octopunk/ names. */
function parseBranchListing(stdout: string): string[] {
  const branches: string[] = [];
  for (const line of stdout.split("\n")) {
    const name = line.trim().replace(/^\*\s*/, "");
    if (name.startsWith("octopunk/")) branches.push(name);
  }
  return branches;
}

// ---------------------------------------------------------------------------
// 5/6. System and disk sampling
// ---------------------------------------------------------------------------

export interface SystemSample {
  loadavg: [number, number, number];
  freeMemBytes: number;
  totalMemBytes: number;
  cpuCores: number;
}

/** In-process os-module snapshot; never throws for practical inputs. */
export function sampleSystem(): SystemSample {
  const [one, five, fifteen] = os.loadavg();
  return {
    loadavg: [one, five, fifteen],
    freeMemBytes: os.freemem(),
    totalMemBytes: os.totalmem(),
    cpuCores: os.cpus().length,
  };
}

export interface DiskSample {
  freeBytes: number;
  totalBytes: number;
}

/** statfs on the filesystem holding `target`; null = unknown (best effort). */
export async function sampleDisk(target: string): Promise<DiskSample | null> {
  try {
    const stats = await fs.promises.statfs(target);
    const freeBytes = stats.bavail * stats.bsize;
    const totalBytes = stats.blocks * stats.bsize;
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes)) return null;
    return { freeBytes, totalBytes };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 7. Port facade
// ---------------------------------------------------------------------------

/** Method-signature set of the probes so services can inject or stub them. */
export interface DiagnosticsProbePort {
  probeProcess(pid: number, processPort: ProcessPort): Promise<ProcessProbeResult>;
  listOctopunkProcesses(processPort: ProcessPort): Promise<OctopunkProcessEntry[]>;
  scanOrphanWorktrees(options: ScanOrphanWorktreesOptions): Promise<OrphanWorktreeItem[]>;
  scanOrphanBranches(options: ScanOrphanBranchesOptions): Promise<OrphanBranchItem[]>;
  sampleSystem(): SystemSample;
  sampleDisk(target: string): Promise<DiskSample | null>;
}

/** Stateless concrete facade over the standalone probe functions. */
export class DiagnosticsProbes implements DiagnosticsProbePort {
  constructor(private readonly gitExecutable: string = GIT_EXECUTABLE) {}

  probeProcess(pid: number, processPort: ProcessPort): Promise<ProcessProbeResult> {
    return probeProcess(pid, processPort);
  }

  listOctopunkProcesses(processPort: ProcessPort): Promise<OctopunkProcessEntry[]> {
    return listOctopunkProcesses(processPort);
  }

  scanOrphanWorktrees(options: ScanOrphanWorktreesOptions): Promise<OrphanWorktreeItem[]> {
    return scanOrphanWorktrees(options);
  }

  scanOrphanBranches(options: ScanOrphanBranchesOptions): Promise<OrphanBranchItem[]> {
    return scanOrphanBranches({ gitExecutable: this.gitExecutable, ...options });
  }

  sampleSystem(): SystemSample {
    return sampleSystem();
  }

  sampleDisk(target: string): Promise<DiskSample | null> {
    return sampleDisk(target);
  }
}
