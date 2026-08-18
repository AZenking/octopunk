// Installs the bundled OctoPunk skill into the orchestrating agents' skill
// directories (Claude Code: ~/.claude/skills, Codex: ~/.codex/skills — both
// discover <dir>/octopunk/SKILL.md automatically). Follows the
// FileCodexConfigAdapter shape: injectable home directory, backup before
// overwrite, idempotent writes, version-marker comparison for status.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillInstallStatus, SkillInstallerPort } from "../application/ports";
import {
  OCTOPUNK_SKILL_VERSION,
  parseSkillVersion,
  renderSkillMarkdown,
  type SkillTargetKind,
} from "./skillTemplate";

/** Resolves the command that launches this app as an MCP STDIO server. */
export type SelfCommandProvider = () => { command: string; args: string[] };

const SKILL_DIRECTORIES: Record<SkillTargetKind, (home: string) => string> = {
  claude_code: (home) => path.join(home, ".claude", "skills", "octopunk"),
  codex: (home) => path.join(home, ".codex", "skills", "octopunk"),
};

export class FileSkillInstaller implements SkillInstallerPort {
  private readonly homeDirectory: string;
  private readonly selfCommand: SelfCommandProvider;

  constructor(options?: { homeDirectory?: string; selfCommand?: SelfCommandProvider }) {
    this.homeDirectory = options?.homeDirectory ?? os.homedir();
    this.selfCommand = options?.selfCommand ?? (() => ({ command: process.execPath, args: [] }));
  }

  async status(): Promise<SkillInstallStatus[]> {
    return (Object.keys(SKILL_DIRECTORIES) as SkillTargetKind[]).map((kind) => {
      const target = this.skillPath(kind);
      let state: SkillInstallStatus["state"] = "not_installed";
      try {
        const content = fs.readFileSync(target, "utf8");
        state = parseSkillVersion(content) === OCTOPUNK_SKILL_VERSION ? "installed" : "update_available";
      } catch {
        // Missing or unreadable file → not_installed.
      }
      return { kind, state, path: target };
    });
  }

  async install(kind: SkillTargetKind): Promise<{ path: string; backupPath: string | null }> {
    const target = this.skillPath(kind);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let backupPath: string | null = null;
    if (fs.existsSync(target)) {
      backupPath = `${target}.octopunk.backup.${Math.floor(Date.now() / 1000)}`;
      fs.copyFileSync(target, backupPath);
    }
    const { command, args } = this.selfCommand();
    fs.writeFileSync(target, renderSkillMarkdown(kind, command, args), "utf8");
    return { path: target, backupPath };
  }

  private skillPath(kind: SkillTargetKind): string {
    return path.join(SKILL_DIRECTORIES[kind](this.homeDirectory), "SKILL.md");
  }
}
