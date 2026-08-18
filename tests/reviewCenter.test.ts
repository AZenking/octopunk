// T014: ReviewCenterService 单元测试(specs/002-v04-review-center-gates US1)。
// 组合方式:真实 SqliteTeamRunRepository(内存 DB)+ 真实 GitAdapter(临时
// git 仓库,tests/gitDiff.test.ts 的建法)+ stub TeamReworkPort(直接委托
// repository.requestRework,透传 reviewer/verdict/summary/findings——无需装配
// 完整 AgentTeamApplicationService)。

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OctoPunkDatabase } from "../electron/data/database";
import { SqliteTeamRunRepository } from "../electron/data/repository";
import { DomainError } from "../electron/domain/models";
import { ReviewCenterService, sensitivePath } from "../electron/application/reviewCenterService";
import type { TeamReworkPort } from "../electron/application/reviewCenterService";
import { GitAdapter } from "../electron/platform/gitAdapter";
import { LocalProcessAdapter } from "../electron/platform/processAdapter";

const GIT = "/usr/bin/git";

function git(cwd: string, args: string[]): string {
  return execFileSync(
    GIT,
    ["-c", "user.email=octo@test.dev", "-c", "user.name=OctoPunk Test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function write(repositoryURL: string, relativePath: string, content: string): void {
  fs.writeFileSync(path.join(repositoryURL, relativePath), content);
}

/** 基线侧文件布局(行号即评论锚点坐标系)。 */
const FEATURE_BASE = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n";
const KEEP_BASE = "k1\nk2\nk3\nk4\nk5\nk6\nk7\nk8\nk9\nk10\n";
const REVERT_BASE = "original\n";
/** 第一轮任务提交:改 feature.ts 第 3 行、keep.ts 第 2 行,整体改写 revert.txt。 */
const FEATURE_ROUND1 = "l1\nl2\nl3-changed\nl4\nl5\nl6\nl7\nl8\n";
const KEEP_ROUND1 = "k1\nk2-changed\nk3\nk4\nk5\nk6\nk7\nk8\nk9\nk10\n";
const REVERT_ROUND1 = "modified\n";

interface World {
  root: string;
  repositoryURL: string;
  repository: SqliteTeamRunRepository;
  service: ReviewCenterService;
  baselineCommit: string;
  runID: string;
  taskID: string;
  branch: string;
  /** 在主仓库内执行 git(分支按名引用,无需真实任务工作区)。 */
  runGit: (args: string[]) => string;
}

const roots: string[] = [];

/** 临时仓库 + 内存 DB + startTeam + delegateTask + 第一轮任务提交。 */
async function buildWorld(prefix: string): Promise<World> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `octopunk-reviewcenter-${prefix}-`));
  roots.push(root);
  const repositoryURL = path.join(root, "repo");
  fs.mkdirSync(repositoryURL);
  git(repositoryURL, ["init", "-q", "-b", "main"]);
  write(repositoryURL, "feature.ts", FEATURE_BASE);
  write(repositoryURL, "keep.ts", KEEP_BASE);
  write(repositoryURL, "revert.txt", REVERT_BASE);
  git(repositoryURL, ["add", "-A"]);
  git(repositoryURL, ["commit", "-qm", "baseline"]);
  const baselineCommit = git(repositoryURL, ["rev-parse", "HEAD"]).trim();

  const db = OctoPunkDatabase.inMemory();
  const repository = new SqliteTeamRunRepository(db.writer);
  const start = await repository.startTeam({
    requestID: `${prefix}-start`,
    sessionID: `${prefix}-session`,
    repositoryPath: repositoryURL,
    task: "Review center flow",
    baselineCommit,
    targetBranch: "main",
    maxConcurrentTasks: 3,
    maxReviewRounds: 5,
  });
  const task = await repository.delegateTask({
    requestID: `${prefix}-delegate`,
    runID: start.run.id,
    title: "Change feature.ts",
    prompt: "Change feature.ts",
    agentKind: "codex",
    model: null,
    executionMode: "workspace_write",
    dependencies: [],
  });

  // 真实流程里分支由 prepareWorkspace 创建;这里直接按 delegateTask 生成的
  // 分支名在临时仓库创建并提交第一轮变更(worktree 侧 Diff 只依赖分支引用)。
  git(repositoryURL, ["checkout", "-qb", task.branchName, baselineCommit]);
  write(repositoryURL, "feature.ts", FEATURE_ROUND1);
  write(repositoryURL, "keep.ts", KEEP_ROUND1);
  write(repositoryURL, "revert.txt", REVERT_ROUND1);
  git(repositoryURL, ["add", "-A"]);
  git(repositoryURL, ["commit", "-qm", "round 1"]);
  git(repositoryURL, ["checkout", "-q", "main"]);

  // stub TeamReworkPort:直接委托仓储,透传全部字段。
  const teamService: TeamReworkPort = {
    requestRework: (input) => repository.requestRework(input),
  };
  const service = new ReviewCenterService({
    repository,
    git: new GitAdapter(new LocalProcessAdapter(), GIT, path.join(root, "support")),
    teamService,
  });
  return {
    root,
    repositoryURL,
    repository,
    service,
    baselineCommit,
    runID: start.run.id,
    taskID: task.id,
    branch: task.branchName,
    runGit: (args: string[]) => git(repositoryURL, args),
  };
}

/** 模拟子 Agent 报告(仓储直写),任务进入 awaiting_report。 */
function reportInput(world: World, requestID: string) {
  return {
    requestID,
    runID: world.runID,
    taskID: world.taskID,
    sessionID: "session-1",
    report: "Implemented with tests",
    rawOutput: "done",
    tests: ["vitest 2/2"],
    changedFiles: ["feature.ts", "keep.ts", "revert.txt"],
    diffSummary: "3 files changed",
    blocker: null,
  };
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("ReviewCenterService 评论闭环", () => {
  it("addComments → reworkBatch:任务转 rework_required、轮次 +1、评论保持 open、findings 入审查记录", async () => {
    const world = await buildWorld("loop");
    await world.repository.submitReport(reportInput(world, "loop-report"));

    const created = await world.service.addComments({
      requestID: "loop-comments",
      runID: world.runID,
      taskID: world.taskID,
      comments: [
        { file: "feature.ts", lineStart: 3, body: "rename l3-changed", severity: "info", author: "user" },
        { file: "revert.txt", lineStart: 1, body: "unexpected rewrite", severity: "risk", author: "user" },
      ],
    });
    expect(created).toHaveLength(2);
    expect(created.map((comment) => comment.status)).toEqual(["open", "open"]);
    expect(created[1].severity).toBe("risk");

    // 跨 run 待审查聚合也能看到该任务与未解决计数。
    const pending = await world.service.pendingReviewTasks();
    const entry = pending.find((item) => item.taskID === world.taskID);
    expect(entry).toMatchObject({
      runID: world.runID,
      status: "awaiting_report",
      unresolvedFindingCount: 2,
      hasRiskFinding: true,
    });

    const reworked = await world.service.reworkBatch({
      requestID: "loop-rework",
      runID: world.runID,
      taskID: world.taskID,
      commentIDs: created.map((comment) => comment.id),
      summary: "Fix both findings",
      reviewer: "user",
    });
    expect(reworked.status).toBe("rework_required");
    expect(reworked.reviewRound).toBe(1);

    const snapshot = await world.repository.snapshot(world.runID);
    const task = snapshot.tasks.find((candidate) => candidate.id === world.taskID);
    expect(task).toMatchObject({ status: "rework_required", reviewRound: 1 });

    // 评论在返工时保持 open,等待返工后 refreshCommentStatuses 复审。
    const comments = await world.repository.listReviewComments(world.runID, world.taskID);
    expect(comments.map((comment) => comment.status)).toEqual(["open", "open"]);

    // insertReview 落档:REWORK cycle(第 1 轮,reviewer=user)+ 两条 findings
    // (risk 评论映射 high,info 保持 info,证据=评论正文,锚点透传)。
    const cycle = snapshot.reviewCycles.find((candidate) => candidate.verdict === "REWORK");
    expect(cycle).toMatchObject({ round: 1, reviewer: "user", taskID: world.taskID });
    const byFile = new Map(snapshot.findings.map((finding) => [finding.file, finding]));
    expect(byFile.get("feature.ts")).toMatchObject({ severity: "info", line: 3, taskID: world.taskID });
    expect(byFile.get("revert.txt")).toMatchObject({ severity: "high", line: 1 });
    expect(byFile.get("revert.txt")?.evidence).toBe("unexpected rewrite");
  }, 20000);
});

describe("ReviewCenterService 锚点回填", () => {
  it("返工后:锚点行被改 → line_changed(快照保留);文件退出 Diff → resolved;未受影响行保持 open;重复调用幂等", async () => {
    const world = await buildWorld("refresh");
    await world.repository.submitReport(reportInput(world, "refresh-report"));
    const created = await world.service.addComments({
      requestID: "refresh-comments",
      runID: world.runID,
      taskID: world.taskID,
      comments: [
        // A:feature.ts 第 5 行,仅被第二轮返工提交改写 → line_changed。
        { file: "feature.ts", lineStart: 5, body: "also fix line 5", severity: "info", contextSnapshot: "l5" },
        // B:revert.txt,返工后恢复基线内容、文件退出 Diff → resolved。
        { file: "revert.txt", lineStart: 1, body: "restore original", severity: "info", contextSnapshot: "original" },
        // C:keep.ts 第 5 行,两轮都未触碰 → 保持 open。
        { file: "keep.ts", lineStart: 5, body: "style nits nearby", severity: "info", contextSnapshot: "k5" },
      ],
    });
    const [anchorMoved, anchorGone, anchorUntouched] = created;

    await world.service.reworkBatch({
      requestID: "refresh-rework",
      runID: world.runID,
      taskID: world.taskID,
      commentIDs: created.map((comment) => comment.id),
      summary: "",
      reviewer: "user",
    });

    // 第二轮任务提交:改写基线侧第 5 行;revert.txt 恢复为基线内容。
    world.runGit(["checkout", "-q", world.branch]);
    write(world.repositoryURL, "feature.ts", "l1\nl2\nl3-changed\nl4\nl5-fixed\nl6\nl7\nl8\n");
    world.runGit(["checkout", "-q", world.baselineCommit, "--", "revert.txt"]);
    world.runGit(["add", "-A"]);
    world.runGit(["commit", "-qm", "round 2 rework"]);
    world.runGit(["checkout", "-q", "main"]);

    const updated = await world.service.refreshCommentStatuses(world.runID, world.taskID);
    const updatedByID = new Map(updated.map((comment) => [comment.id, comment]));
    expect(updatedByID.get(anchorMoved.id)?.status).toBe("line_changed");
    expect(updatedByID.get(anchorGone.id)?.status).toBe("resolved");
    expect(updatedByID.has(anchorUntouched.id)).toBe(false);

    const comments = await world.repository.listReviewComments(world.runID, world.taskID);
    const byID = new Map(comments.map((comment) => [comment.id, comment]));
    expect(byID.get(anchorMoved.id)).toMatchObject({ status: "line_changed", contextSnapshot: "l5" });
    expect(byID.get(anchorGone.id)?.status).toBe("resolved");
    expect(byID.get(anchorUntouched.id)?.status).toBe("open");

    // 幂等:再次复审不迁移任何状态(line_changed/resolved 为终态,open 的 C 未受影响)。
    const second = await world.service.refreshCommentStatuses(world.runID, world.taskID);
    expect(second).toEqual([]);
    const reread = await world.repository.listReviewComments(world.runID, world.taskID);
    expect(reread.map((comment) => [comment.id, comment.status]).sort()).toEqual(
      [
        [anchorMoved.id, "line_changed"],
        [anchorGone.id, "resolved"],
        [anchorUntouched.id, "open"],
      ].sort(),
    );
  }, 20000);
});

describe("ReviewCenterService unresolvedFindings", () => {
  it("open 评论 risk 置顶;dismiss 后从未解决清单消失", async () => {
    const world = await buildWorld("findings");
    await world.repository.submitReport(reportInput(world, "findings-report"));
    const created = await world.service.addComments({
      requestID: "findings-comments",
      runID: world.runID,
      taskID: world.taskID,
      comments: [
        { file: "keep.ts", lineStart: 5, body: "info level note", severity: "info" },
        { file: "feature.ts", lineStart: 3, body: "risk level note", severity: "risk" },
      ],
    });
    const [info, risk] = created;

    const open = await world.service.unresolvedFindings(world.runID, world.taskID);
    expect(open.map((finding) => finding.id)).toEqual([risk.id, info.id]);
    expect(open.map((finding) => finding.severity)).toEqual(["risk", "info"]);

    // dismiss 需走仓储终态迁移(服务层无 dismiss 入口,评审操作由仓储承载)。
    await world.repository.setReviewCommentStatus({
      requestID: "findings-dismiss",
      runID: world.runID,
      commentID: risk.id,
      status: "dismissed",
    });
    const afterDismiss = await world.service.unresolvedFindings(world.runID, world.taskID);
    expect(afterDismiss.map((finding) => finding.id)).toEqual([info.id]);
  }, 20000);
});

describe("ReviewCenterService addComments 校验", () => {
  it("锚点文件不在 Diff 树 → 拒绝;行号 <1 → 拒绝;空批次 → 拒绝;正文含密钥 → 落库前 redact", async () => {
    const world = await buildWorld("validate");
    await world.repository.submitReport(reportInput(world, "validate-report"));

    await expect(
      world.service.addComments({
        requestID: "validate-missing",
        runID: world.runID,
        taskID: world.taskID,
        comments: [{ file: "not-in-diff.txt", lineStart: 1, body: "where is this file" }],
      }),
    ).rejects.toThrow(/不在该任务的 Diff/);

    await expect(
      world.service.addComments({
        requestID: "validate-line0",
        runID: world.runID,
        taskID: world.taskID,
        comments: [{ file: "feature.ts", lineStart: 0, body: "bad anchor" }],
      }),
    ).rejects.toThrow(DomainError);

    await expect(
      world.service.addComments({
        requestID: "validate-empty",
        runID: world.runID,
        taskID: world.taskID,
        comments: [],
      }),
    ).rejects.toThrow(DomainError);

    // 校验失败不落任何评论。
    expect(await world.repository.listReviewComments(world.runID, world.taskID)).toHaveLength(0);

    const [secret] = await world.service.addComments({
      requestID: "validate-secret",
      runID: world.runID,
      taskID: world.taskID,
      comments: [
        { file: "feature.ts", lineStart: 3, body: "leaked token sk-abcdef1234567890 please rotate" },
      ],
    });
    expect(secret.body).toContain("[REDACTED]");
    expect(secret.body).not.toContain("sk-abcdef1234567890");
    // 存储侧同样没有明文密钥。
    const stored = await world.repository.listReviewComments(world.runID, world.taskID);
    expect(stored.map((comment) => comment.body).join("\n")).not.toContain("sk-abcdef1234567890");
  }, 20000);
});

describe("ReviewCenterService 交付摘要", () => {
  it("generateDeliverySummary 生成含结论与遗留计数的 Markdown;getDeliverySummary 重算计数一致", async () => {
    const world = await buildWorld("summary");
    await world.repository.submitReport(reportInput(world, "summary-report"));
    const created = await world.service.addComments({
      requestID: "summary-comments",
      runID: world.runID,
      taskID: world.taskID,
      comments: [
        { file: "keep.ts", lineStart: 5, body: "minor style", severity: "info" },
        { file: "feature.ts", lineStart: 3, body: "risky change", severity: "risk" },
      ],
    });
    const [info, risk] = created;

    const summary = await world.service.generateDeliverySummary({
      runID: world.runID,
      taskID: world.taskID,
      verdict: "PASS",
      summaryLines: ["rotate sk-abcdef1234567890 after release"],
    });
    expect(summary.verdict).toBe("PASS");
    expect(summary.taskID).toBe(world.taskID);
    expect(summary.openFindingCount).toBe(2);
    expect(summary.waiverCount).toBe(0);
    expect(summary.evidence).toEqual(expect.arrayContaining([risk.id, info.id]));
    expect(summary.evidence.length).toBeGreaterThanOrEqual(3); // 报告 id + 两条评论 id

    expect(summary.summaryMd).toContain("- 结论:**PASS**");
    expect(summary.summaryMd).toContain("行级评论:2 条(未解决 2,其中 risk 1)");
    expect(summary.summaryMd).toContain("## 遗留未解决发现(Open Findings)");
    // risk 置顶列出。
    expect(summary.summaryMd.indexOf("[risk]")).toBeLessThan(summary.summaryMd.indexOf("[info]"));
    expect(summary.summaryMd).toContain("[risk] feature.ts:3");
    // 备注同样过 redact。
    expect(summary.summaryMd).not.toContain("sk-abcdef1234567890");

    // 读取侧:派生计数按当前状态重算,与生成时一致。
    const fetched = await world.service.getDeliverySummary(world.runID, world.taskID);
    expect(fetched?.id).toBe(summary.id);
    expect(fetched?.openFindingCount).toBe(summary.openFindingCount);
    expect(fetched?.summaryMd).toBe(summary.summaryMd);

    // dismiss 一条后重算:计数随之变化(派生值,不落库)。
    await world.repository.setReviewCommentStatus({
      requestID: "summary-dismiss",
      runID: world.runID,
      commentID: info.id,
      status: "dismissed",
    });
    const refetched = await world.service.getDeliverySummary(world.runID, world.taskID);
    expect(refetched?.openFindingCount).toBe(1);
  }, 20000);
});

describe("sensitivePath", () => {
  it("标记迁移目录、env/pem/key/secret/credential 类路径(大小写不敏感,规则从宽)", () => {
    for (const sensitive of [
      "db/migrations/001_init.sql",
      "migrations/0001_add_users.rb",
      "src/migration/legacy.sql",
      ".env",
      "config/prod.env",
      ".env.local",
      "certs/server.pem",
      "keys/id_rsa.pem",
      "secrets.yaml",
      "auth/credentials.json",
      "src/keyboard.ts", // 宽启发式:文件名含 key 即标记(误标只是多一层提示)
      "Migrations/Init.SQL",
    ]) {
      expect(sensitivePath(sensitive), sensitive).toBe(true);
    }
    for (const plain of ["src/config.ts", "README.md", "components/Button.tsx", "docs/architecture.md"]) {
      expect(sensitivePath(plain), plain).toBe(false);
    }
  });
});
