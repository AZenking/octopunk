// RecoveryCleanupPort 平台实现(specs/001-v03-stability-multi-teamrun T019 /
// 崩溃恢复 US2):RecoveryService 经此端口执行破坏性清理,应用层自身不碰
// node:fs / 子进程。守护规则(宪法原则五:任何自动恢复动作不得绕过人工
// 确认点;本端口只服务已显式确认的 cleanupOrphans 调用):
//
// - removePath 只允许删除 OctoPunk 托管根(Application Support/OctoPunk 下
//   的 worktrees/ 与 integration/,与 gitAdapter 路径构建器同一事实源)之内
//   的路径;词法(../ 穿越与绝对路径)与真实路径(中间符号链接逃逸)双重
//   校验;目标本身是符号链接时只解除链接,绝不递归到链接指向的内容。
// - deleteBranch 只允许 octopunk/ 前缀分支,经注入的 ProcessPort 跑
//   `git branch -D`;git 失败转成可读中文错误(逐项落 skipped,由服务层
//   呈现),不抛裸进程错误。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProcessPort } from "../application/ports";
import type { RecoveryCleanupPort } from "../application/recoveryService";

/** OctoPunk 托管的 worktree 根(gitAdapter.taskWorktreeRoot 的父目录)。 */
function managedRoots(): string[] {
  const support = path.join(os.homedir(), "Library", "Application Support", "OctoPunk");
  return [path.join(support, "worktrees"), path.join(support, "integration")];
}

/** 真实根目录(根不存在时退回词法绝对路径,供对照)。 */
function realRoots(): string[] {
  return managedRoots().map((root) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return path.resolve(root);
    }
  });
}

/** child 是否位于 root 之内(root 自身不算「之内」——不允许删托管根本体)。 */
function isInside(child: string, root: string): boolean {
  if (child === root) return false;
  return child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * 沿现有祖先解析真实路径:从 target 向上找到第一个存在的祖先,realpath
 * 后拼回余下后缀。中间任何一环是符号链接都会被 realpath 展开,从而暴露
 * 「词法在托管根内、真实路径在根外」的逃逸。
 */
function resolveReal(target: string): string {
  const absolute = path.resolve(target);
  const suffix: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute; // 到根都不存在:词法判定为准
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export class RecoveryCleanup implements RecoveryCleanupPort {
  constructor(
    private readonly process: ProcessPort,
    private readonly gitExecutable = "/usr/bin/git",
  ) {}

  async removePath(target: string): Promise<void> {
    const roots = realRoots();
    const absolute = path.resolve(target);
    // ① 词法包含:拒绝 ../ 穿越与托管根之外的绝对路径。
    if (!roots.some((root) => isInside(absolute, root))) {
      throw new Error(
        `拒绝删除:路径不在 OctoPunk 托管目录(${managedRoots().join("、")})之内:${target}`,
      );
    }
    // ② 真实路径包含:拒绝中间符号链接把目标挪出托管根的逃逸。
    const real = resolveReal(absolute);
    if (!roots.some((root) => isInside(real, root))) {
      throw new Error(`拒绝删除:路径经符号链接逃逸出 OctoPunk 托管目录:${target}`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      return; // 不存在即视为已清理(幂等)。
    }
    if (stat.isSymbolicLink()) {
      // 只解除链接本身,绝不跟随(follow)链接删除其指向的内容。
      fs.unlinkSync(absolute);
      return;
    }
    fs.rmSync(absolute, { recursive: true, force: true });
  }

  async deleteBranch(repositoryURL: string, branch: string): Promise<void> {
    if (!branch.startsWith("octopunk/")) {
      throw new Error(`拒绝删除分支:只允许清理 octopunk/ 前缀的 OctoPunk 托管分支:${branch}`);
    }
    // 数组参数不经 shell,无注入面;前缀规则同时排除 "-…" 形态的选项注入。
    try {
      await this.process.run({
        id: randomUUID(),
        executable: this.gitExecutable,
        arguments: ["-C", repositoryURL, "branch", "-D", branch],
        environment: {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stderr = (error as { stderr?: unknown }).stderr;
      const tail = typeof stderr === "string" && stderr.trim().length > 0 ? `:${stderr.trim().split("\n")[0]}` : "";
      throw new Error(`删除分支 ${branch} 失败(${repositoryURL})${tail}。原始错误:${message}`);
    }
  }
}
