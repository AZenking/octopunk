// Writes the octopunk MCP server entry into pi's config (the
// pi-mcp-extension reads ~/.pi/agent/mcp.json). Mirrors FileCodexConfigAdapter:
// injectable home directory, backup before overwrite, idempotent JSON merge
// that preserves the user's other servers and settings.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface PiMCPConfig {
  settings?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export class FilePiConfigAdapter {
  private readonly homeDirectory: string;

  constructor(homeDirectory?: string | null) {
    this.homeDirectory = homeDirectory ?? os.homedir();
  }

  async connectStdio(command: string, arguments_: string[] = ["--mcp-stdio"]): Promise<string | null> {
    const configDirectory = path.join(this.homeDirectory, ".pi", "agent");
    fs.mkdirSync(configDirectory, { recursive: true });
    const configURL = path.join(configDirectory, "mcp.json");
    const backupURL = this.backupExisting(configURL);
    const config = this.readConfig(configURL);
    config.mcpServers = {
      ...(config.mcpServers ?? {}),
      octopunk: {
        command,
        args: arguments_,
        transport: "stdio",
        lifecycle: "eager",
      },
    };
    fs.writeFileSync(configURL, JSON.stringify(config, null, 2) + "\n", "utf8");
    return backupURL;
  }

  /** 只读探测:mcp.json 是否已含 octopunk 条目(设置页连接状态徽标)。 */
  async hasOctoPunkEntry(): Promise<boolean> {
    try {
      const configURL = path.join(this.homeDirectory, ".pi", "agent", "mcp.json");
      const parsed = JSON.parse(fs.readFileSync(configURL, "utf8")) as PiMCPConfig;
      return parsed.mcpServers?.octopunk != null;
    } catch {
      return false;
    }
  }

  private backupExisting(configURL: string): string | null {
    if (!fs.existsSync(configURL)) return null;
    const backup = path.join(
      path.dirname(configURL),
      `mcp.json.octopunk.backup.${Math.floor(Date.now() / 1000)}`,
    );
    fs.copyFileSync(configURL, backup);
    return backup;
  }

  private readConfig(configURL: string): PiMCPConfig {
    try {
      const parsed = JSON.parse(fs.readFileSync(configURL, "utf8")) as PiMCPConfig;
      return typeof parsed === "object" && parsed != null ? parsed : {};
    } catch {
      return {};
    }
  }
}
