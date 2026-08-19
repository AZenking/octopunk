// UserDefaults-equivalent persistent settings for the Electron shell
// (mirrors the SwiftUI @AppStorage keys used by AppEnvironment/SettingsView).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function octoPunkSupportDirectory(): string {
  return path.join(os.homedir(), "Library", "Application Support", "OctoPunk");
}

export class SettingsStore {
  private readonly file: string;
  private cache: Record<string, string> | null = null;

  constructor(file?: string) {
    this.file = file ?? path.join(octoPunkSupportDirectory(), "settings.json");
  }

  string(key: string): string | undefined {
    this.load();
    const value = this.cache?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  has(key: string): boolean {
    this.load();
    return this.cache?.[key] != null;
  }

  set(key: string, value: string): void {
    this.load();
    this.cache = this.cache ?? {};
    this.cache[key] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2), "utf8");
  }

  /** Copies a legacy RelayDesk value forward once, like AppEnvironment does. */
  migrateKey(legacyKey: string, newKey: string): void {
    if (this.has(newKey)) return;
    const legacy = this.string(legacyKey);
    if (legacy != null) {
      this.set(newKey, legacy);
    }
  }

  private load(): void {
    if (this.cache != null) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      this.cache = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          this.cache[key] = value;
        }
      }
    } catch {
      this.cache = {};
    }
  }
}

export const CLAUDE_EXECUTABLE_KEY = "OctoPunk.claudeExecutable";
export const LEGACY_CLAUDE_EXECUTABLE_KEY = "RelayDesk.claudeExecutable";
export const CODEX_EXECUTABLE_KEY = "OctoPunk.codexExecutable";
export const PI_EXECUTABLE_KEY = "OctoPunk.piExecutable";
/** Host-wide custom instructions prepended to every child agent prompt (AGENTS.md-style global guidance). */
export const CUSTOM_INSTRUCTIONS_KEY = "OctoPunk.customInstructions";
/** Agent kinds hidden from delegation UI, stored as a JSON string array. */
export const DISABLED_AGENTS_KEY = "OctoPunk.disabledAgents";
/** Max concurrent child-agent tasks per TeamRun (Settings → General), as a decimal string. */
export const MAX_CONCURRENT_TASKS_KEY = "OctoPunk.maxConcurrentTasks";
/** Automatic retry budget for transient child-agent failures (0 disables), as a decimal string. */
export const TASK_RETRY_LIMIT_KEY = "OctoPunk.taskRetryLimit";
/** Minimum seconds between consecutive child launches (0 disables pacing), as a decimal string. */
export const LAUNCH_STAGGER_SECONDS_KEY = "OctoPunk.launchStaggerSeconds";
/** Per-agent child model overrides (empty = the agent's own default). */
export const CLAUDE_CHILD_MODEL_KEY = "OctoPunk.claudeChildModel";
export const CODEX_CHILD_MODEL_KEY = "OctoPunk.codexChildModel";
export const PI_CHILD_MODEL_KEY = "OctoPunk.piChildModel";
/**
 * GitHub PR 回灌开关(specs/002-v04 US4 / FR-016),布尔字符串("true" = 开启),
 * 默认关闭。凭证由本机 gh CLI 自管,OctoPunk 不保存任何 GitHub 凭证。
 */
export const GITHUB_FEEDBACK_ENABLED_KEY = "OctoPunk.githubFeedbackEnabled";
/**
 * 全局并发子进程上限(specs/001-v03 T004),十进制字符串,默认 6,钳制 1–20。
 * 实际生效值 = min(全局, 项目, 单类型, run.maxConcurrentTasks)四级联检。
 */
export const GLOBAL_MAX_CHILDREN_KEY = "OctoPunk.globalMaxChildren";
/** 单仓库并发子进程上限(specs/001-v03 T004),十进制字符串,默认 3,钳制 1–10。 */
export const PER_PROJECT_MAX_CHILDREN_KEY = "OctoPunk.perProjectMaxChildren";
/** 单 Agent 类型并发子进程上限(specs/001-v03 T004),十进制字符串,默认 3,钳制 1–10。 */
export const PER_KIND_MAX_CHILDREN_KEY = "OctoPunk.perKindMaxChildren";
/** 资源高压时暂缓发放新任务配额(specs/001-v03 T004),布尔字符串,默认开启。 */
export const RESOURCE_PAUSE_ENABLED_KEY = "OctoPunk.resourcePauseEnabled";
/** 高压判定最小剩余磁盘字节数(specs/001-v03 T004),十进制字符串,默认 1GiB(1073741824),下限 100MiB。 */
export const MIN_FREE_DISK_BYTES_KEY = "OctoPunk.minFreeDiskBytes";
/** 为交互式操作预留 1 个并发槽位(specs/001-v03 T004),布尔字符串,默认开启。 */
export const INTERACTIVE_SLOT_RESERVED_KEY = "OctoPunk.interactiveSlotReserved";
