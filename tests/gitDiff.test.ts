// T008: GitPort diff capabilities (diffTree / diffPage / conflictPreview)
// exercised against a real throwaway git repository. Pure git CLI + tmpdir —
// no SQLite involved. The GitAdapter gets a fixture-local Application Support
// override so the integration worktree never touches the real home directory.

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitAdapter, integrationWorktreeURL } from "../electron/platform/gitAdapter";
import { LocalProcessAdapter } from "../electron/platform/processAdapter";
import { GitAdapterError } from "../electron/application/ports";

const GIT = "/usr/bin/git";
const PAGE_BUDGET = 64 * 1024;

function git(cwd: string, args: string[]): string {
  return execFileSync(
    GIT,
    ["-c", "user.email=octo@test.dev", "-c", "user.name=OctoPunk Test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function write(repositoryURL: string, relativePath: string, content: string | Buffer): void {
  fs.writeFileSync(path.join(repositoryURL, relativePath), content);
}

interface Fixture {
  root: string;
  repositoryURL: string;
  supportDirectory: string;
  adapter: GitAdapter;
  baselineCommit: string;
  runID: string;
  /** Never gets an integration worktree — used for the readable-error case. */
  missingRunID: string;
  taskID: string;
}

function buildFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octopunk-gitdiff-"));
  const repositoryURL = path.join(root, "repo");
  const supportDirectory = path.join(root, "support");
  fs.mkdirSync(repositoryURL);
  git(repositoryURL, ["init", "-q", "-b", "main"]);

  // Baseline: plain text files only.
  write(repositoryURL, "modify.txt", "line-1\nline-2\nline-3\n");
  write(repositoryURL, "delete.txt", "gone soon\n");
  write(repositoryURL, "untouched.txt", "stay\n");
  git(repositoryURL, ["add", "-A"]);
  git(repositoryURL, ["commit", "-qm", "baseline"]);
  const baselineCommit = git(repositoryURL, ["rev-parse", "HEAD"]).trim();

  // task-a: added / modified / deleted / renamed / binary / secret / paged /
  // oversize changes, all on one branch based on the baseline.
  git(repositoryURL, ["checkout", "-qb", "task-a"]);
  write(repositoryURL, "added.txt", "alpha\nbeta\n");
  write(repositoryURL, "modify.txt", "line-1\nline-2-changed\nline-3\nline-4\n");
  fs.rmSync(path.join(repositoryURL, "delete.txt"));
  git(repositoryURL, ["mv", "untouched.txt", "renamed-keep.txt"]);
  write(
    repositoryURL,
    "blob.bin",
    Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x00, 0x09]),
  );
  write(
    repositoryURL,
    "secret.txt",
    "api_key: supersecret123\nsk-abcdef1234567890\nplain line\n",
  );
  const pagedLines = Array.from({ length: 9000 }, (_, index) => `${String(index).padStart(5, "0")} paged content line`);
  write(repositoryURL, "paged.txt", `${pagedLines.join("\n")}\n`);
  const oversizeLines = Array.from({ length: 24000 }, (_, index) => `${String(index).padStart(6, "0")} ${"x".repeat(88)}`);
  write(repositoryURL, "oversize.txt", `${oversizeLines.join("\n")}\n`); // > 2MiB blob
  git(repositoryURL, ["add", "-A"]);
  git(repositoryURL, ["commit", "-qm", "task-a changes"]);

  // task-b: same line as task-a, different content — conflicts on integration.
  git(repositoryURL, ["checkout", "-qb", "task-b", baselineCommit]);
  write(repositoryURL, "modify.txt", "line-1\nline-2-from-task-b\nline-3\n");
  git(repositoryURL, ["add", "-A"]);
  git(repositoryURL, ["commit", "-qm", "task-b changes"]);

  const adapter = new GitAdapter(new LocalProcessAdapter(), GIT, supportDirectory);
  return {
    root,
    repositoryURL,
    supportDirectory,
    adapter,
    baselineCommit,
    runID: "11111111-1111-1111-1111-111111111111",
    missingRunID: "22222222-2222-2222-2222-222222222222",
    taskID: "task-a",
  };
}

const fixture = buildFixture();

afterAll(() => {
  // Integration/task worktrees and the repo all live under the temp root.
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

function diffInput(
  side: "baseline" | "worktree" | "integration",
  runID = fixture.runID,
): Parameters<GitAdapter["diffTree"]>[0] {
  return {
    repositoryURL: fixture.repositoryURL,
    runID,
    taskID: fixture.taskID,
    baselineCommit: fixture.baselineCommit,
    taskBranch: "task-a",
    side,
  };
}

function integrationURL(runID = fixture.runID): string {
  return integrationWorktreeURL(runID, fixture.supportDirectory);
}

describe("GitAdapter.diffTree", () => {
  it("lists task-branch changes with stats, binary and oversize flags (worktree side)", async () => {
    const entries = await fixture.adapter.diffTree(diffInput("worktree"));
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));

    expect(byPath.get("added.txt")).toMatchObject({
      changeType: "added",
      additions: 2,
      deletions: 0,
      isBinary: false,
      oversize: false,
    });
    const modified = byPath.get("modify.txt");
    expect(modified?.changeType).toBe("modified");
    expect(modified?.isBinary).toBe(false);
    expect(modified?.oversize).toBe(false);
    expect((modified?.additions ?? 0) + (modified?.deletions ?? 0)).toBeGreaterThan(0);
    expect(byPath.get("delete.txt")).toMatchObject({ changeType: "deleted", isBinary: false });
    expect(byPath.get("renamed-keep.txt")).toMatchObject({ changeType: "renamed", isBinary: false });
    expect(byPath.get("blob.bin")).toMatchObject({
      changeType: "added",
      additions: 0,
      deletions: 0,
      isBinary: true,
    });
    expect(byPath.get("oversize.txt")?.oversize).toBe(true);
    expect(byPath.get("paged.txt")?.oversize).toBe(false);
    expect(byPath.get("untouched.txt")).toBeUndefined(); // renamed away: keyed by new path
  });

  it("returns an empty tree for the baseline side (empty diff is a legal result)", async () => {
    await expect(fixture.adapter.diffTree(diffInput("baseline"))).resolves.toEqual([]);
  });

  it("throws a readable error for the integration side before the integration worktree exists", async () => {
    const treePromise = fixture.adapter.diffTree(diffInput("integration", fixture.missingRunID));
    await expect(treePromise).rejects.toBeInstanceOf(GitAdapterError);
    const pagePromise = fixture.adapter.diffPage({
      ...diffInput("integration", fixture.missingRunID),
      path: "modify.txt",
      cursor: null,
    });
    await expect(pagePromise).rejects.toThrow(/集成工作区尚未创建/);
  });
});

describe("GitAdapter.diffPage", () => {
  it("returns an empty page for the baseline side", async () => {
    const page = await fixture.adapter.diffPage({ ...diffInput("baseline"), path: "modify.txt", cursor: null });
    expect(page).toEqual({
      taskID: fixture.taskID,
      side: "baseline",
      path: "modify.txt",
      hunks: [],
      nextCursor: null,
      truncated: false,
    });
  });

  it("parses hunks and line origins for a plain modification", async () => {
    const page = await fixture.adapter.diffPage({ ...diffInput("worktree"), path: "modify.txt", cursor: null });
    expect(page.hunks.length).toBeGreaterThan(0);
    expect(page.nextCursor).toBeNull();
    expect(page.truncated).toBe(false);
    const firstHunk = page.hunks[0];
    expect(firstHunk.lines[0]).toMatchObject({ origin: "hunk", oldLine: null, newLine: null });
    expect(firstHunk.lines[0].text).toMatch(/^@@ -1,3 \+1,4 @@/);
    const origins = firstHunk.lines.slice(1).map((line) => line.origin);
    expect(origins).toContain("del");
    expect(origins).toContain("add");
    expect(origins).toContain("ctx");
    // ctx lines carry both side numbers; add/del only their own side.
    for (const line of firstHunk.lines.slice(1)) {
      if (line.origin === "ctx") {
        expect(line.oldLine).not.toBeNull();
        expect(line.newLine).not.toBeNull();
      } else if (line.origin === "add") {
        expect(line.oldLine).toBeNull();
        expect(line.newLine).not.toBeNull();
      } else if (line.origin === "del") {
        expect(line.oldLine).not.toBeNull();
        expect(line.newLine).toBeNull();
      }
    }
  });

  it("redacts credential-shaped text in hunk lines", async () => {
    const page = await fixture.adapter.diffPage({ ...diffInput("worktree"), path: "secret.txt", cursor: null });
    const text = page.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)).join("\n");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("plain line");
    expect(text).not.toContain("sk-abcdef1234567890");
    expect(text).not.toContain("supersecret123");
  });

  it("returns no content hunks for binary and oversize files", async () => {
    const binary = await fixture.adapter.diffPage({ ...diffInput("worktree"), path: "blob.bin", cursor: null });
    expect(binary.hunks).toEqual([]);
    expect(binary.nextCursor).toBeNull();
    expect(binary.truncated).toBe(false);

    const oversize = await fixture.adapter.diffPage({ ...diffInput("worktree"), path: "oversize.txt", cursor: null });
    expect(oversize.hunks).toEqual([]);
    expect(oversize.nextCursor).toBeNull();
    expect(oversize.truncated).toBe(false);
  });

  it("pages large diffs: truncation, cursors, and lossless reassembly", async () => {
    const pages = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await fixture.adapter.diffPage({ ...diffInput("worktree"), path: "paged.txt", cursor });
      pages.push(page);
      cursor = page.nextCursor;
      if (cursor == null) break;
    }

    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[0].truncated).toBe(true);
    expect(pages[0].nextCursor).not.toBeNull();
    const last = pages[pages.length - 1];
    expect(last.truncated).toBe(false);
    expect(last.nextCursor).toBeNull();

    for (const page of pages) {
      // Every page stays inside the 64KiB budget and carries content.
      const volume = page.hunks.reduce(
        (sum, hunk) => sum + hunk.lines.reduce((inner, line) => inner + line.text.length + 1, 0),
        0,
      );
      expect(volume).toBeLessThanOrEqual(PAGE_BUDGET);
      expect(page.hunks.length).toBeGreaterThan(0);
    }
    // Only the first page carries the hunk header line.
    expect(pages[0].hunks[0].lines[0].origin).toBe("hunk");
    for (const page of pages.slice(1)) {
      expect(page.hunks.every((hunk) => hunk.lines[0].origin !== "hunk")).toBe(true);
    }

    // Reassembled stream is complete, ordered, and gap-free.
    const addedLines = pages.flatMap((page) =>
      page.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.origin === "add")),
    );
    expect(addedLines.map((line) => line.newLine)).toEqual(
      Array.from({ length: 9000 }, (_, index) => index + 1),
    );
    expect(addedLines[0].text).toBe("00000 paged content line");
    expect(addedLines[addedLines.length - 1].text).toBe("08999 paged content line");
  });
});

describe("GitAdapter.conflictPreview", () => {
  it("reports no conflict, aborts, and leaves the integration worktree clean", async () => {
    const result = await fixture.adapter.conflictPreview({
      repositoryURL: fixture.repositoryURL,
      runID: fixture.runID,
      baselineCommit: fixture.baselineCommit,
      taskBranches: ["task-a"],
    });
    expect(result).toEqual({ conflict: false, files: [] });

    // The preview is side-effect free: clean status, HEAD still at baseline.
    expect(git(integrationURL(), ["status", "--porcelain"]).trim()).toBe("");
    expect(git(integrationURL(), ["rev-parse", "HEAD"]).trim()).toBe(fixture.baselineCommit);
  });

  it("serves integration-side diffs once the integration worktree exists", async () => {
    // conflictPreview created it at the baseline; nothing merged, so the diff
    // against the baseline is still empty.
    await expect(fixture.adapter.diffTree(diffInput("integration"))).resolves.toEqual([]);
  });

  it("detects conflicts with a file list and aborts to a clean worktree", async () => {
    // Integrate task-a for real, then preview task-b (same line, other change).
    // (prepareWorkspace is not used here: it verifies a freshly created branch
    // still sits on the baseline, while the fixture branch already has commits.)
    const worktreeURL = path.join(fixture.root, "task-a-worktree");
    git(fixture.repositoryURL, ["worktree", "add", worktreeURL, "task-a"]);
    const integration = await fixture.adapter.integrate({
      repositoryURL: fixture.repositoryURL,
      runID: fixture.runID,
      taskID: fixture.taskID,
      baselineCommit: fixture.baselineCommit,
      worktreeURL,
      taskBranch: "task-a",
    });
    expect(integration.integrated).toBe(true);

    // The integration side now mirrors the task branch changes.
    const entries = await fixture.adapter.diffTree(diffInput("integration"));
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("modify.txt")?.changeType).toBe("modified");
    expect(byPath.get("added.txt")?.changeType).toBe("added");

    const preview = await fixture.adapter.conflictPreview({
      repositoryURL: fixture.repositoryURL,
      runID: fixture.runID,
      baselineCommit: fixture.baselineCommit,
      taskBranches: ["task-b"],
    });
    expect(preview.conflict).toBe(true);
    expect(preview.files).toContain("modify.txt");

    // Worktree clean and HEAD untouched by the failed-trial preview.
    expect(git(integrationURL(), ["status", "--porcelain"]).trim()).toBe("");
    expect(git(integrationURL(), ["rev-parse", "HEAD"]).trim()).toBe(
      (integration as { commit: string }).commit,
    );
  });
});
