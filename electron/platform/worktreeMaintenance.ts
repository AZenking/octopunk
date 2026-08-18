// Worktree maintenance: scan and clean the OctoPunk-managed worktree roots.
// Conservative by design — only terminal-run or unknown (orphan/skeleton)
// entries are cleanable; active runs' resumable worktrees are never touched.

import fs from "node:fs";
import path from "node:path";
import { GitAdapter } from "./gitAdapter";
import { integrationWorktreeURL } from "./gitAdapter";

const integrationRoot = (): string => path.dirname(integrationWorktreeURL("00000000-0000-0000-0000-000000000000"));

export type WorktreeEntryKind = "task-worktree" | "shared-readonly" | "integration" | "orphan" | "skeleton";

export interface WorktreeEntry {
  path: string;
  runID: string | null;
  kind: WorktreeEntryKind;
  runStatus: string | null;
  branchName: string | null;
  sizeBytes: number;
  cleanable: boolean;
  reason: string;
}

export interface KnownWorkspace {
  worktreePath: string;
  branchName: string;
  workspaceKind: string;
  runStatus: string;
}

const TERMINAL = new Set(["completed", "blocked", "cancelled", "failed"]);

export function octoPunkWorktreesRoot(): string {
  return path.join(process.env.HOME ?? "", "Library", "Application Support", "OctoPunk", "worktrees");
}

function dirSize(target: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) total += dirSize(child);
      else {
        try {
          total += fs.statSync(child).size;
        } catch {
          // Gone mid-walk.
        }
      }
    }
  } catch {
    // Unreadable.
  }
  return total;
}

export class WorktreeMaintenanceService {
  constructor(
    private readonly git: GitAdapter,
    private readonly loadKnown: () => KnownWorkspace[],
  ) {}

  scan(): WorktreeEntry[] {
    const known = new Map(this.loadKnown().map((item) => [item.worktreePath, item]));
    const entries: WorktreeEntry[] = [];
    const roots: { root: string; kind: WorktreeEntryKind }[] = [
      { root: octoPunkWorktreesRoot(), kind: "task-worktree" },
      { root: integrationRoot(), kind: "integration" },
    ];
    for (const { root, kind: rootKind } of roots) {
      let runIDs: string[] = [];
      try {
        runIDs = fs.readdirSync(root).filter((name) => /^[0-9a-fA-F-]{36}$/.test(name));
      } catch {
        continue;
      }
      for (const runID of runIDs) {
        const runDir = path.join(root, runID);
        const children = this.collectLeafDirs(runDir);
        if (children.length === 0) {
          entries.push(this.entry(runDir, runID, "skeleton", null, null, 0, true, "empty run directory"));
          continue;
        }
        for (const child of children) {
          if (known.has(child)) {
            const item = known.get(child) as KnownWorkspace;
            const kind: WorktreeEntryKind =
              rootKind === "integration" ? "integration" : item.workspaceKind === "shared_read_only" ? "shared-readonly" : "task-worktree";
            const terminal = TERMINAL.has(item.runStatus);
            entries.push(
              this.entry(child, runID, kind, item.runStatus, item.branchName, dirSize(child), terminal, `run ${item.runStatus}`),
            );
          } else {
            entries.push(this.entry(child, runID, "orphan", null, null, dirSize(child), true, "no task owns this path"));
          }
        }
      }
    }
    return entries;
  }

  /** Only cleanable paths from the given candidates (re-derived, never trusted). */
  async cleanup(candidatePaths: string[]): Promise<{ removed: string[]; failed: { path: string; error: string }[] }> {
    const allowed = new Set(this.scan().filter((entry) => entry.cleanable).map((entry) => entry.path));
    const targets = candidatePaths.filter((candidate) => allowed.has(candidate));
    const knownBranch = new Map(
      this.scan()
        .filter((entry) => entry.branchName != null)
        .map((entry) => [entry.path, entry.branchName as string]),
    );
    const removed: string[] = [];
    const failed: { path: string; error: string }[] = [];
    const repos = new Set<string>();
    for (const target of targets) {
      try {
        const repo = this.owningRepository(target);
        if (repo != null) {
          repos.add(repo);
          const branch = knownBranch.get(target);
          if (branch != null && branch.length > 0) {
            await this.git.cleanupWorkspace(
              { repositoryURL: repo, branchName: branch, worktreeURL: target, kind: "isolated_write" },
              "discard",
            );
          } else {
            await this.git.cleanupWorkspace(
              { repositoryURL: repo, branchName: "", worktreeURL: target, kind: "shared_read_only" },
              "discard",
            );
          }
        } else {
          fs.rmSync(target, { recursive: true, force: true });
        }
        removed.push(target);
      } catch (error) {
        failed.push({ path: target, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const repo of repos) {
      try {
        await this.git.cleanupWorkspace(
          { repositoryURL: repo, branchName: "", worktreeURL: path.join(repo, ".__nonexistent__"), kind: "shared_read_only" },
          "discard",
        );
      } catch {
        // prune happens inside cleanupWorkspace before the existence check? No — best effort.
      }
    }
    this.removeEmptyRunDirs();
    return { removed, failed };
  }

  private entry(
    target: string,
    runID: string | null,
    kind: WorktreeEntryKind,
    runStatus: string | null,
    branchName: string | null,
    sizeBytes: number,
    cleanable: boolean | string,
    reason: string,
  ): WorktreeEntry {
    return {
      path: target,
      runID,
      kind,
      runStatus,
      branchName,
      sizeBytes,
      cleanable: typeof cleanable === "boolean" ? cleanable : TERMINAL.has(String(runStatus)),
      reason,
    };
  }

  private collectLeafDirs(root: string): string[] {
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
    walk(root);
    return leaves;
  }

  /** A git worktree's `.git` file points back at the owning repository. */
  private owningRepository(target: string): string | null {
    try {
      const gitFile = path.join(target, ".git");
      if (!fs.existsSync(gitFile)) return null;
      const content = fs.readFileSync(gitFile, "utf8").trim();
      const match = content.match(/gitdir:\s*(.*)\/\.git\/worktrees\/[^/]+$/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  private removeEmptyRunDirs(): void {
    for (const root of [octoPunkWorktreesRoot(), integrationRoot()]) {
      try {
        for (const name of fs.readdirSync(root)) {
          const runDir = path.join(root, name);
          try {
            if (fs.statSync(runDir).isDirectory() && fs.readdirSync(runDir).length === 0) {
              fs.rmdirSync(runDir);
            }
          } catch {
            // Best effort.
          }
        }
      } catch {
        // Root missing.
      }
    }
  }
}

