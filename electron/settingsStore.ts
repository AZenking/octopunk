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
/** Host-wide custom instructions prepended to every child agent prompt (AGENTS.md-style global guidance). */
export const CUSTOM_INSTRUCTIONS_KEY = "OctoPunk.customInstructions";
/** Agent kinds hidden from delegation UI, stored as a JSON string array. */
export const DISABLED_AGENTS_KEY = "OctoPunk.disabledAgents";
/** Max concurrent child-agent tasks per TeamRun (Settings → General), as a decimal string. */
export const MAX_CONCURRENT_TASKS_KEY = "OctoPunk.maxConcurrentTasks";
