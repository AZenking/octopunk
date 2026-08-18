// Port of OctoPunk/OctoPunk/Platform/Git/GitAdapter.swift.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  ChildAgentDiagnostics,
  GitAdapterError,
  type ChildWorkspace,
  type GitDiffSide,
  type GitIntegrationResult,
  type GitPort,
  type GitRepositoryState,
  type ProcessPort,
  type ProcessRequest,
  type ProcessResult,
  type WorkspaceCleanupMode,
} from "../application/ports";
import type { DiffLineDTO, DiffPageDTO, DiffTreeEntryDTO } from "../../shared/dtos";

function applicationSupportDirectory(): string {
  return path.join(os.homedir(), "Library", "Application Support");
}

/** One diff page carries at most 64KiB of (already-redacted) line text. */
const DIFF_PAGE_BUDGET = 64 * 1024;
/** Blobs beyond 2MiB are flagged oversize and never paged for content. */
const OVERSIZED_FILE_BYTES = 2 * 1024 * 1024;

export class GitAdapter implements GitPort {
  private readonly process: ProcessPort;
  private readonly gitExecutable: string;
  /** Overrides the Application Support root (tests keep worktrees hermetic). */
  private readonly supportDirectory: string | null;
  /**
   * In-process serialization of check-then-merge on the shared target working
   * copy: with per-session TeamRuns, two runs on the same repository may
   * complete concurrently. Cross-process races still fail loudly through the
   * dirty-branch/HEAD pre-checks and git's own index.lock.
   */
  private integrationLocks = new Map<string, Promise<unknown>>();

  constructor(process_: ProcessPort, gitExecutable = "/usr/bin/git", supportDirectory: string | null = null) {
    this.process = process_;
    this.gitExecutable = gitExecutable;
    this.supportDirectory = supportDirectory;
  }

  async inspect(repositoryURL: string): Promise<GitRepositoryState> {
    let head: string;
    try {
      head = (await this.runGit(["-C", repositoryURL, "rev-parse", "HEAD"])).stdout.trim();
    } catch (error) {
      // An unborn HEAD (fresh `git init`, zero commits) is the common case;
      // rev-list --count --all still answers "0" there, but fails elsewhere.
      const commitCount = await this.runGit(["-C", repositoryURL, "rev-list", "--count", "--all"])
        .then((result) => result.stdout.trim())
        .catch(() => null);
      if (commitCount === "0") {
        throw GitAdapterError.emptyRepository(repositoryURL);
      }
      throw error;
    }
    const status = (await this.runGit(["-C", repositoryURL, "status", "--porcelain"])).stdout;
    const branch = await this.currentBranch(repositoryURL).catch(() => "");
    return {
      repositoryURL,
      head,
      hasUncommittedChanges: status.trim().length > 0,
      branchName: branch.length > 0 ? branch : null,
    };
  }

  async prepareWorkspace(input: {
    repositoryURL: string;
    runID: string;
    taskID: string;
    baselineCommit: string;
    branchName: string;
    worktreeURL: string;
  }): Promise<ChildWorkspace> {
    fs.mkdirSync(path.dirname(input.worktreeURL), { recursive: true });
    const worktreeMarker = path.join(input.worktreeURL, ".git");
    const worktreeExists = fs.existsSync(input.worktreeURL);
    const isExistingWorktree = fs.existsSync(worktreeMarker);
    if (worktreeExists && !isExistingWorktree) {
      throw GitAdapterError.worktreePathOccupied(input.worktreeURL);
    }
    if (!isExistingWorktree) {
      try {
        await this.runGit([
          "-C",
          input.repositoryURL,
          "worktree",
          "add",
          "-b",
          input.branchName,
          input.worktreeURL,
          input.baselineCommit,
        ]);
      } catch (error) {
        const exists = await this.branchExists(input.repositoryURL, input.branchName);
        if (!exists) throw error;
        await this.runGit(["-C", input.repositoryURL, "worktree", "add", input.worktreeURL, input.branchName]);
      }
      await this.verifyWorktree(input.worktreeURL, input.branchName, input.baselineCommit);
    } else {
      await this.verifyWorktree(input.worktreeURL, input.branchName, null);
    }
    return {
      repositoryURL: input.repositoryURL,
      branchName: input.branchName,
      worktreeURL: input.worktreeURL,
      kind: "isolated_write",
    };
  }

  async prepareReadOnlyWorkspace(input: {
    repositoryURL: string;
    runID: string;
    baselineCommit: string;
    worktreeURL: string;
  }): Promise<ChildWorkspace> {
    fs.mkdirSync(path.dirname(input.worktreeURL), { recursive: true });
    const worktreeMarker = path.join(input.worktreeURL, ".git");
    const worktreeExists = fs.existsSync(input.worktreeURL);
    const isExistingWorktree = fs.existsSync(worktreeMarker);
    if (worktreeExists && !isExistingWorktree) {
      throw GitAdapterError.worktreePathOccupied(input.worktreeURL);
    }
    if (!isExistingWorktree) {
      await this.runGit([
        "-C",
        input.repositoryURL,
        "worktree",
        "add",
        "--detach",
        input.worktreeURL,
        input.baselineCommit,
      ]);
    }
    await this.verifyReadOnlyWorktree(input.worktreeURL, input.baselineCommit);
    return {
      repositoryURL: input.repositoryURL,
      branchName: "",
      worktreeURL: input.worktreeURL,
      kind: "shared_read_only",
    };
  }

  async integrate(input: {
    repositoryURL: string;
    runID: string;
    taskID: string;
    baselineCommit: string;
    worktreeURL: string;
    taskBranch: string;
  }): Promise<GitIntegrationResult> {
    try {
      const status = (await this.runGit(["-C", input.worktreeURL, "status", "--porcelain"])).stdout;
      if (status.trim().length > 0) {
        await this.runGit(["-C", input.worktreeURL, "add", "--all"]);
        await this.runGit([
          "-C",
          input.worktreeURL,
          "commit",
          "--no-verify",
          "-m",
          `OctoPunk: integrate task ${input.taskID}`,
        ]);
      }
    } catch (error) {
      return {
        integrated: false,
        conflict: `Could not create the OctoPunk integration commit: ${errorMessage(error)}`,
        details: `Could not create the OctoPunk integration commit: ${errorMessage(error)}`,
      };
    }

    const integrationURL = await this.ensureIntegrationWorktree(
      input.repositoryURL,
      input.runID,
      input.baselineCommit,
    );

    try {
      const taskCommit = (await this.runGit(["-C", integrationURL, "rev-parse", input.taskBranch])).stdout.trim();
      const integrationHead = (await this.runGit(["-C", integrationURL, "rev-parse", "HEAD"])).stdout.trim();
      const commonAncestor = (
        await this.runGit(["-C", integrationURL, "merge-base", input.taskBranch, "HEAD"])
      ).stdout.trim();
      if (commonAncestor === taskCommit) {
        return { integrated: true, commit: integrationHead };
      }
      await this.runGit(["-C", integrationURL, "merge", "--no-ff", "--no-edit", input.taskBranch]);
      const commit = (await this.runGit(["-C", integrationURL, "rev-parse", "HEAD"])).stdout.trim();
      return { integrated: true, commit };
    } catch (error) {
      await this.runGit(["-C", integrationURL, "merge", "--abort"]).catch(() => {});
      return { integrated: false, conflict: errorMessage(error), details: errorMessage(error) };
    }
  }

  async integrationHead(input: {
    repositoryURL: string;
    runID: string;
    baselineCommit: string;
  }): Promise<string> {
    const integrationURL = await this.ensureIntegrationWorktree(
      input.repositoryURL,
      input.runID,
      input.baselineCommit,
    );
    return (await this.runGit(["-C", integrationURL, "rev-parse", "HEAD"])).stdout.trim();
  }

  async applyIntegration(input: {
    repositoryURL: string;
    runID: string;
    targetBranch: string;
    baselineCommit: string;
  }): Promise<string> {
    const previous = this.integrationLocks.get(input.repositoryURL) ?? Promise.resolve();
    const next = previous.then(
      () => this.applyIntegrationLocked(input),
      () => this.applyIntegrationLocked(input),
    );
    this.integrationLocks.set(
      input.repositoryURL,
      next.catch(() => {}),
    );
    return await next;
  }

  private async applyIntegrationLocked(input: {
    repositoryURL: string;
    runID: string;
    targetBranch: string;
    baselineCommit: string;
  }): Promise<string> {
    if (input.targetBranch.length === 0) throw GitAdapterError.targetBranchRequired();
    const actualBranch = await this.currentBranch(input.repositoryURL);
    if (actualBranch !== input.targetBranch) {
      throw GitAdapterError.targetBranchChanged(input.targetBranch, actualBranch);
    }
    const status = (await this.runGit(["-C", input.repositoryURL, "status", "--porcelain"])).stdout;
    if (status.trim().length > 0) {
      throw GitAdapterError.targetRepositoryDirty();
    }

    const currentHead = (await this.runGit(["-C", input.repositoryURL, "rev-parse", "HEAD"])).stdout.trim();
    const branch = this.integrationBranch(input.runID);
    if (!(await this.branchExists(input.repositoryURL, branch))) {
      if (currentHead !== input.baselineCommit) {
        throw GitAdapterError.targetBranchChanged(input.baselineCommit, currentHead);
      }
      return currentHead;
    }
    const integrationHeadCommit = (
      await this.runGit(["-C", input.repositoryURL, "rev-parse", branch])
    ).stdout.trim();
    if (currentHead === integrationHeadCommit) return currentHead;
    if (currentHead !== input.baselineCommit) {
      throw GitAdapterError.targetBranchChanged(input.baselineCommit, currentHead);
    }
    await this.runGit(["-C", input.repositoryURL, "merge", "--no-ff", "--no-edit", branch]);
    return (await this.runGit(["-C", input.repositoryURL, "rev-parse", "HEAD"])).stdout.trim();
  }

  async diffTree(input: {
    repositoryURL: string;
    runID: string;
    taskID: string;
    baselineCommit: string;
    taskBranch: string;
    side: GitDiffSide;
  }): Promise<DiffTreeEntryDTO[]> {
    const endpoints = await this.diffEndpoints(input);
    if (endpoints.head == null) return [];
    const { repositoryURL, base, head } = endpoints;
    const numstat = (
      await this.runGit([
        "-C",
        repositoryURL,
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-color",
        "--numstat",
        base,
        head,
      ])
    ).stdout;
    if (numstat.trim().length === 0) return [];
    const nameStatus = (
      await this.runGit([
        "-C",
        repositoryURL,
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-color",
        "--name-status",
        base,
        head,
      ])
    ).stdout;
    const blobSizes = await this.collectBlobSizes(repositoryURL, base, head);

    // numstat: "<additions>\t<deletions>\t<path>"; binaries report "-",
    // renames report "old => new" (possibly collapsed to "pre{old => new}post").
    const statsByFinalPath = new Map<string, { additions: string; deletions: string }>();
    for (const line of numstat.split("\n")) {
      const fields = line.split("\t");
      if (fields.length < 3) continue;
      const rename = expandRenameField(fields[2]);
      statsByFinalPath.set(rename ? rename.newPath : fields[2], {
        additions: fields[0],
        deletions: fields[1],
      });
    }

    // name-status: "<status>\t<path>" (renames: "R100\t<old>\t<new>").
    const entries: DiffTreeEntryDTO[] = [];
    for (const line of nameStatus.split("\n")) {
      const fields = line.split("\t");
      if (fields.length < 2) continue;
      const changeType = changeTypeFor(fields[0]);
      const finalPath = fields[fields.length - 1];
      const stats = statsByFinalPath.get(finalPath);
      const isBinary = stats != null && (stats.additions === "-" || stats.deletions === "-");
      entries.push({
        path: finalPath,
        changeType,
        additions: parseCount(stats?.additions),
        deletions: parseCount(stats?.deletions),
        isBinary,
        oversize: !isBinary && (blobSizes.get(finalPath) ?? 0) > OVERSIZED_FILE_BYTES,
      });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return entries;
  }

  async diffPage(input: {
    repositoryURL: string;
    runID: string;
    taskID: string;
    baselineCommit: string;
    taskBranch: string;
    side: GitDiffSide;
    path: string;
    cursor: string | null;
  }): Promise<DiffPageDTO> {
    const page: DiffPageDTO = {
      taskID: input.taskID,
      side: input.side,
      path: input.path,
      hunks: [],
      nextCursor: null,
      truncated: false,
    };
    const endpoints = await this.diffEndpoints(input);
    if (endpoints.head == null) return page;
    const { repositoryURL, base, head } = endpoints;
    if (await this.isOversizedPath(repositoryURL, base, head, input.path)) return page;

    const raw = (
      await this.runGit([
        "-C",
        repositoryURL,
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-color",
        "--unified=3",
        base,
        head,
        "--",
        input.path,
      ])
    ).stdout;
    if (raw.trim().length === 0 || isBinaryDiff(raw)) return page;

    const hunks = parseUnifiedDiff(raw);
    const cursor = input.cursor;
    let start: { hunkIndex: number; lineIndex: number } = { hunkIndex: 0, lineIndex: 0 };
    if (cursor != null) {
      const parsed = parseDiffCursor(cursor);
      if (parsed == null) throw GitAdapterError.invalidDiffCursor(cursor);
      start = parsed;
    }

    let budget = DIFF_PAGE_BUDGET;
    let emittedInPage = false;
    let lineIndex = start.lineIndex;
    for (let hunkIndex = start.hunkIndex; hunkIndex < hunks.length; hunkIndex++) {
      const source = hunks[hunkIndex];
      const lines: DiffLineDTO[] = [];
      while (lineIndex < source.lines.length) {
        const candidate = source.lines[lineIndex];
        const cost = candidate.text.length + 1;
        // Always take at least one line so a page never returns empty-with-cursor
        // (a single oversized line would otherwise stall pagination forever).
        if (emittedInPage && cost > budget) break;
        lines.push(candidate);
        budget -= cost;
        emittedInPage = true;
        lineIndex += 1;
      }
      if (lines.length > 0) {
        page.hunks.push({
          oldStart: source.oldStart,
          oldLines: source.oldLines,
          newStart: source.newStart,
          newLines: source.newLines,
          lines,
        });
      }
      if (lineIndex < source.lines.length) {
        page.nextCursor = `${hunkIndex}:${lineIndex}`;
        page.truncated = true;
        return page;
      }
      lineIndex = 0;
    }
    return page;
  }

  async conflictPreview(input: {
    repositoryURL: string;
    runID: string;
    baselineCommit: string;
    taskBranches: string[];
  }): Promise<{ conflict: boolean; files: string[] }> {
    const integrationURL = await this.ensureIntegrationWorktree(
      input.repositoryURL,
      input.runID,
      input.baselineCommit,
    );
    const files = new Set<string>();
    for (const taskBranch of input.taskBranches) {
      // Each branch is trialed independently against the integration HEAD:
      // git refuses to stack --no-commit merges (MERGE_HEAD blocks the next).
      let mergeError: unknown = null;
      try {
        await this.runGit(["-C", integrationURL, "merge", "--no-commit", "--no-ff", taskBranch]);
      } catch (error) {
        mergeError = error;
      }
      if (mergeError != null) {
        const unmerged = (
          await this.runGit([
            "-C",
            integrationURL,
            "diff",
            "--no-color",
            "--name-only",
            "--diff-filter=U",
          ])
        ).stdout
          .split("\n")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        if (unmerged.length === 0) {
          // Not a content conflict (missing branch, dirty state, ...) — restore
          // and surface git's own diagnostic.
          await this.abortMerge(integrationURL);
          throw mergeError;
        }
        for (const file of unmerged) files.add(file);
      }
      // --no-commit leaves MERGE_HEAD/staged state even after a clean merge,
      // so abort unconditionally to keep the worktree pristine.
      await this.abortMerge(integrationURL);
    }
    return { conflict: files.size > 0, files: [...files].sort() };
  }

  async cleanupWorkspace(workspace: ChildWorkspace, mode: WorkspaceCleanupMode): Promise<void> {
    if (fs.existsSync(workspace.worktreeURL)) {
      await this.runGit([
        "-C",
        workspace.repositoryURL,
        "worktree",
        "remove",
        "--force",
        workspace.worktreeURL,
      ]);
    }
    await this.runGit(["-C", workspace.repositoryURL, "worktree", "prune"]);
    if (workspace.kind !== "isolated_write") return;
    if (!(await this.branchExists(workspace.repositoryURL, workspace.branchName))) return;
    if (mode === "deleteBranch") {
      await this.runGit(["-C", workspace.repositoryURL, "branch", "-d", workspace.branchName]);
    } else {
      await this.runGit(["-C", workspace.repositoryURL, "branch", "-D", workspace.branchName]);
    }
  }

  private async runGit(args: string[]): Promise<ProcessResult> {
    return await this.process.run({
      id: randomUUID(),
      executable: this.gitExecutable,
      arguments: args,
      environment: {},
    });
  }

  private async currentBranch(repositoryURL: string): Promise<string> {
    return (await this.runGit(["-C", repositoryURL, "branch", "--show-current"])).stdout.trim();
  }

  private async branchExists(repositoryURL: string, branchName: string): Promise<boolean> {
    if (branchName.length === 0) return false;
    try {
      await this.runGit([
        "-C",
        repositoryURL,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branchName}`,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolves the two diff endpoints for a side. `head == null` short-circuits
   * to an empty diff: the baseline side compares the baseline commit with
   * itself, which legitimately produces no output. The integration side
   * requires an existing integration worktree — unlike conflictPreview it
   * never creates one, because viewing a diff must not run git mutations.
   */
  private async diffEndpoints(input: {
    repositoryURL: string;
    runID: string;
    baselineCommit: string;
    taskBranch: string;
    side: GitDiffSide;
  }): Promise<{ repositoryURL: string; base: string; head: string | null }> {
    if (input.side === "baseline") {
      return { repositoryURL: input.repositoryURL, base: input.baselineCommit, head: null };
    }
    if (input.side === "worktree") {
      const head = (await this.runGit(["-C", input.repositoryURL, "rev-parse", input.taskBranch]))
        .stdout.trim();
      return { repositoryURL: input.repositoryURL, base: input.baselineCommit, head };
    }
    const integrationURL = this.integrationURL(input.runID);
    if (!fs.existsSync(path.join(integrationURL, ".git"))) {
      throw GitAdapterError.integrationWorktreeMissing(input.runID);
    }
    const head = (await this.runGit(["-C", integrationURL, "rev-parse", "HEAD"])).stdout.trim();
    return { repositoryURL: input.repositoryURL, base: input.baselineCommit, head };
  }

  /** Largest blob size per path across both sides (ls-tree -l is one spawn). */
  private async collectBlobSizes(
    repositoryURL: string,
    ...commits: string[]
  ): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    for (const commit of commits) {
      const listing = await this.runGit(["-C", repositoryURL, "ls-tree", "-r", "-l", commit]).catch(
        () => null,
      );
      if (listing == null) continue;
      for (const line of listing.stdout.split("\n")) {
        // "<mode> <type> <object> <size>\t<path>" (size is space-padded).
        const match = line.match(/^\S+\s+\S+\s+\S+\s+(\d+)\t(.+)$/);
        if (match == null) continue;
        const size = Number.parseInt(match[1], 10);
        const filePath = match[2];
        if (size > (sizes.get(filePath) ?? 0)) sizes.set(filePath, size);
      }
    }
    return sizes;
  }

  private async isOversizedPath(
    repositoryURL: string,
    base: string,
    head: string,
    filePath: string,
  ): Promise<boolean> {
    // Prefer the head blob; a deleted file only exists at the baseline.
    for (const commit of [head, base]) {
      const size = await this.runGit(["-C", repositoryURL, "cat-file", "-s", `${commit}:${filePath}`])
        .then((result) => Number.parseInt(result.stdout.trim(), 10))
        .catch(() => NaN);
      if (!Number.isNaN(size)) return size > OVERSIZED_FILE_BYTES;
    }
    return false;
  }

  private async abortMerge(integrationURL: string): Promise<void> {
    await this.runGit(["-C", integrationURL, "merge", "--abort"]).catch(async () => {
      // merge --abort needs MERGE_HEAD; fall back for any leftover state.
      await this.runGit(["-C", integrationURL, "reset", "--hard", "HEAD"]).catch(() => {});
    });
  }

  private async verifyWorktree(
    worktreeURL: string,
    branchName: string,
    expectedBaseline: string | null,
  ): Promise<void> {
    const actualBranch = (await this.runGit(["-C", worktreeURL, "branch", "--show-current"])).stdout.trim();
    if (actualBranch !== branchName) {
      throw GitAdapterError.worktreeBranchMismatch(branchName, actualBranch);
    }
    if (expectedBaseline == null) return;
    const actualHead = (await this.runGit(["-C", worktreeURL, "rev-parse", "HEAD"])).stdout.trim();
    if (actualHead !== expectedBaseline) {
      throw GitAdapterError.worktreeBaselineMismatch(expectedBaseline, actualHead);
    }
  }

  private async verifyReadOnlyWorktree(worktreeURL: string, expectedBaseline: string): Promise<void> {
    const actualBranch = (await this.runGit(["-C", worktreeURL, "branch", "--show-current"])).stdout.trim();
    if (actualBranch.length > 0) {
      throw GitAdapterError.worktreeBranchMismatch("detached HEAD", actualBranch);
    }
    const actualHead = (await this.runGit(["-C", worktreeURL, "rev-parse", "HEAD"])).stdout.trim();
    if (actualHead !== expectedBaseline) {
      throw GitAdapterError.worktreeBaselineMismatch(expectedBaseline, actualHead);
    }
  }

  private integrationURL(runID: string): string {
    return integrationWorktreeURL(runID, this.supportDirectory ?? undefined);
  }

  private async ensureIntegrationWorktree(
    repositoryURL: string,
    runID: string,
    baselineCommit: string,
  ): Promise<string> {
    const integrationURL = this.integrationURL(runID);
    fs.mkdirSync(path.dirname(integrationURL), { recursive: true });
    const marker = path.join(integrationURL, ".git");
    if (fs.existsSync(integrationURL) && !fs.existsSync(marker)) {
      throw GitAdapterError.worktreePathOccupied(integrationURL);
    }
    if (!fs.existsSync(marker)) {
      await this.runGit([
        "-C",
        repositoryURL,
        "worktree",
        "add",
        "-B",
        this.integrationBranch(runID),
        integrationURL,
        baselineCommit,
      ]);
    }
    return integrationURL;
  }

  private integrationBranch(runID: string): string {
    return `octopunk/${runID}/integration`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function taskWorktreeRoot(runID: string): string {
  return path.join(applicationSupportDirectory(), "OctoPunk", "worktrees", runID);
}

export function sharedReadOnlyWorktreeURL(runID: string, baselineCommit: string): string {
  const safeBaseline = Array.from(baselineCommit)
    .map((character) => (/[A-Za-z0-9_-]/.test(character) ? character : "-"))
    .join("");
  const suffix = safeBaseline.slice(0, 64);
  return path.join(taskWorktreeRoot(runID), "readonly", suffix);
}

export function integrationWorktreeURL(runID: string, supportDirectory?: string): string {
  return path.join(supportDirectory ?? applicationSupportDirectory(), "OctoPunk", "integration", runID);
}

/** parsed unified-diff hunk (line texts already redacted). */
interface ParsedDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLineDTO[];
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseUnifiedDiff(raw: string): ParsedDiffHunk[] {
  const hunks: ParsedDiffHunk[] = [];
  let current: ParsedDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of raw.split("\n")) {
    const header = line.match(HUNK_HEADER_PATTERN);
    if (header != null) {
      const oldStart = Number.parseInt(header[1], 10);
      const newStart = Number.parseInt(header[3], 10);
      current = {
        oldStart,
        oldLines: header[2] != null ? Number.parseInt(header[2], 10) : 1,
        newStart,
        newLines: header[4] != null ? Number.parseInt(header[4], 10) : 1,
        lines: [],
      };
      hunks.push(current);
      oldLine = oldStart;
      newLine = newStart;
      current.lines.push({
        origin: "hunk",
        oldLine: null,
        newLine: null,
        text: ChildAgentDiagnostics.redact(line),
      });
      continue;
    }
    // Anything before the first hunk header (diff --git / index / --- / +++)
    // is metadata; "\ No newline at end of file" carries no display content.
    if (current == null || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      current.lines.push({
        origin: "add",
        oldLine: null,
        newLine,
        text: ChildAgentDiagnostics.redact(line.slice(1)),
      });
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.lines.push({
        origin: "del",
        oldLine,
        newLine: null,
        text: ChildAgentDiagnostics.redact(line.slice(1)),
      });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      current.lines.push({
        origin: "ctx",
        oldLine,
        newLine,
        text: ChildAgentDiagnostics.redact(line.slice(1)),
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks;
}

function isBinaryDiff(raw: string): boolean {
  return /^Binary files .* differ$/m.test(raw) || /^GIT binary patch$/m.test(raw);
}

/** Cursor format "<hunkIndex>:<lineIndex>" — both index into the parsed hunk list. */
function parseDiffCursor(cursor: string): { hunkIndex: number; lineIndex: number } | null {
  const match = cursor.match(/^(\d+):(\d+)$/);
  if (match == null) return null;
  return { hunkIndex: Number.parseInt(match[1], 10), lineIndex: Number.parseInt(match[2], 10) };
}

function parseCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function changeTypeFor(status: string): DiffTreeEntryDTO["changeType"] {
  const letter = status[0];
  if (letter === "A" || letter === "C") return "added";
  if (letter === "D") return "deleted";
  if (letter === "R") return "renamed";
  return "modified";
}

/**
 * Expands numstat rename path fields — "old => new" or the collapsed
 * "prefix/{old => new}suffix" form — to the post-rename path used as the
 * canonical key (name-status reports the same path tab-separated).
 */
function expandRenameField(field: string): { oldPath: string; newPath: string } | null {
  if (!field.includes(" => ")) return null;
  const collapsed = field.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (collapsed != null) {
    return {
      oldPath: `${collapsed[1]}${collapsed[2]}${collapsed[4]}`,
      newPath: `${collapsed[1]}${collapsed[3]}${collapsed[4]}`,
    };
  }
  const separator = field.indexOf(" => ");
  return {
    oldPath: field.slice(0, separator),
    newPath: field.slice(separator + " => ".length),
  };
}
