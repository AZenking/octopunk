// Port of OctoPunk/OctoPunk/Platform/FileSystem/ToolLocator.swift, extended
// for the fnm/volta/npm-global layouts this machine actually uses (the Swift
// version only probed the four Homebrew/system directories).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isExecutable } from "./processAdapter";

function fnmNodeVersionDirectories(): string[] {
  const root = path.join(os.homedir(), ".local", "share", "fnm", "node-versions");
  try {
    return fs
      .readdirSync(root)
      .filter((entry) => entry.startsWith("v"))
      .sort((a, b) => compareVersions(a, b))
      .reverse()
      .map((entry) => path.join(root, entry, "installation", "bin"));
  } catch {
    return [];
  }
}

function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const lhs = parse(a);
  const rhs = parse(b);
  for (let index = 0; index < 3; index += 1) {
    if ((lhs[index] ?? 0) !== (rhs[index] ?? 0)) {
      return (lhs[index] ?? 0) - (rhs[index] ?? 0);
    }
  }
  return 0;
}

function homeCandidateDirectories(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".npm-global", "bin"),
    ...fnmNodeVersionDirectories(),
  ];
}

function pathDirectories(): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
}

export const OctoPunkToolLocator = {
  /** Deterministic probe order: Homebrew/system, home layouts, then PATH. */
  locate(name: string): string {
    const candidates = [
      "/opt/homebrew/bin/" + name,
      "/usr/local/bin/" + name,
      "/usr/bin/" + name,
      "/bin/" + name,
    ];
    if (name === "codex") {
      candidates.unshift("/Applications/ChatGPT.app/Contents/Resources/codex");
    }
    const seen = new Set<string>();
    for (const directory of [...candidates.map((entry) => path.dirname(entry)), ...homeCandidateDirectories(), ...pathDirectories()]) {
      if (seen.has(directory)) continue;
      seen.add(directory);
      const candidate = path.join(directory, name);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
    return name;
  },

  /**
   * Resolves a user-configured value: an explicit path (contains a separator)
   * is trusted as-is; a bare name is probed through the candidate order.
   */
  resolveConfigured(value: string | null | undefined, name: string): string {
    const trimmed = (value ?? "").trim();
    if (trimmed.length === 0) {
      return OctoPunkToolLocator.locate(name);
    }
    if (trimmed.includes("/")) {
      return trimmed;
    }
    return OctoPunkToolLocator.locate(trimmed);
  },
};
