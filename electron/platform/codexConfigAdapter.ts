// Port of OctoPunk/OctoPunk/Platform/MCP/CodexConfigAdapter.swift.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexConfigPort } from "../application/ports";

export class FileCodexConfigAdapter implements CodexConfigPort {
  private readonly homeDirectory: string;

  constructor(homeDirectory?: string | null) {
    this.homeDirectory = homeDirectory ?? os.homedir();
  }

  async connect(endpoint: string, tokenEnvironmentVariable: string): Promise<string | null> {
    const codexDirectory = path.join(this.homeDirectory, ".codex");
    fs.mkdirSync(codexDirectory, { recursive: true });
    const configURL = path.join(codexDirectory, "config.toml");
    const backupURL = this.backupExisting(configURL);
    const current = this.readConfig(configURL);
    const section = `[mcp_servers.octopunk]
url = "${endpoint}"
bearer_token_env_var = "${tokenEnvironmentVariable}"`;
    const updated = replacingSection("mcp_servers.octopunk", current, section);
    fs.writeFileSync(configURL, updated, "utf8");
    return backupURL;
  }

  async connectStdio(command: string, arguments_: string[] = ["--mcp-stdio"]): Promise<string | null> {
    const codexDirectory = path.join(this.homeDirectory, ".codex");
    fs.mkdirSync(codexDirectory, { recursive: true });
    const configURL = path.join(codexDirectory, "config.toml");
    const backupURL = this.backupExisting(configURL);
    const tomlArguments = arguments_.map((value) => `"${tomlEscape(value)}"`).join(", ");
    const section = `[mcp_servers.octopunk]
command = "${tomlEscape(command)}"
args = [${tomlArguments}]`;
    const current = this.readConfig(configURL);
    const updated = replacingSection("mcp_servers.octopunk", current, section);
    fs.writeFileSync(configURL, updated, "utf8");
    return backupURL;
  }

  private backupExisting(configURL: string): string | null {
    if (!fs.existsSync(configURL)) return null;
    const backup = path.join(
      path.dirname(configURL),
      `config.toml.octopunk.backup.${Math.floor(Date.now() / 1000)}`,
    );
    fs.copyFileSync(configURL, backup);
    return backup;
  }

  private readConfig(configURL: string): string {
    try {
      return fs.readFileSync(configURL, "utf8");
    } catch {
      return "";
    }
  }
}

function replacingSection(name: string, content: string, replacement: string): string {
  const lines = content.split("\n");
  const marker = `[${name}]`;
  const startIndex = lines.indexOf(marker);
  if (startIndex !== -1) {
    let end = lines.length;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      if (lines[index].startsWith("[")) {
        end = index;
        break;
      }
    }
    const result = [
      ...lines.slice(0, startIndex),
      ...replacement.split("\n").filter((line) => line.length > 0),
      ...lines.slice(end),
    ];
    return result.join("\n");
  }
  return content.trim() + "\n\n" + replacement + "\n";
}

function tomlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
