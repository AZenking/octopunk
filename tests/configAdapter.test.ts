// Codex/Pi 配置适配器:connectStdio 写入 + hasOctoPunkEntry 只读探测。
// 注入临时 home,绝不触碰真实 ~/.codex 与 ~/.pi;本文件不依赖 better-sqlite3,
// 单独运行(vitest run tests/configAdapter.test.ts)无需 ABI 切换。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCodexConfigAdapter } from "../electron/platform/codexConfigAdapter";
import { FilePiConfigAdapter } from "../electron/platform/piConfigAdapter";

let root: string;

function makeHome(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "octopunk-config-"));
  return root;
}

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("FileCodexConfigAdapter", () => {
  it("未写入时 hasOctoPunkEntry 为 false(文件缺失或无条目)", async () => {
    const adapter = new FileCodexConfigAdapter(makeHome());
    expect(await adapter.hasOctoPunkEntry()).toBe(false);

    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), '[mcp_servers.other]\ncommand = "x"\n');
    expect(await adapter.hasOctoPunkEntry()).toBe(false);
  });

  it("connectStdio 写入后 hasOctoPunkEntry 为 true,且替换而非追加已有条目", async () => {
    const adapter = new FileCodexConfigAdapter(makeHome());
    await adapter.connectStdio("/usr/bin/electron", ["/repo", "--mcp-stdio"]);
    expect(await adapter.hasOctoPunkEntry()).toBe(true);

    await adapter.connectStdio("/new/path/electron", ["--mcp-stdio"]);
    const config = fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8");
    expect(config.match(/\[mcp_servers\.octopunk\]/g)).toHaveLength(1);
    expect(config).toContain('/new/path/electron"');
    expect(config).not.toContain("/usr/bin/electron");
  });

  it("写入保留同文件中的其他 section", async () => {
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".codex", "config.toml"),
      '[model]\nname = "gpt-5"\n\n[mcp_servers.keep]\ncommand = "keep"\n',
    );
    const adapter = new FileCodexConfigAdapter(root);
    await adapter.connectStdio("/usr/bin/electron", ["--mcp-stdio"]);

    const config = fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8");
    expect(config).toContain("[mcp_servers.keep]");
    expect(config).toContain('[model]');
    expect(await adapter.hasOctoPunkEntry()).toBe(true);
  });
});

describe("FilePiConfigAdapter", () => {
  it("未写入时 hasOctoPunkEntry 为 false(文件缺失/损坏 JSON/无条目)", async () => {
    const adapter = new FilePiConfigAdapter(makeHome());
    expect(await adapter.hasOctoPunkEntry()).toBe(false);

    fs.mkdirSync(path.join(root, ".pi", "agent"), { recursive: true });
    const configURL = path.join(root, ".pi", "agent", "mcp.json");
    fs.writeFileSync(configURL, "{ not json");
    expect(await adapter.hasOctoPunkEntry()).toBe(false);

    fs.writeFileSync(configURL, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    expect(await adapter.hasOctoPunkEntry()).toBe(false);
  });

  it("connectStdio 写入后 hasOctoPunkEntry 为 true,并保留其他 server 与 settings", async () => {
    fs.mkdirSync(path.join(root, ".pi", "agent"), { recursive: true });
    const configURL = path.join(root, ".pi", "agent", "mcp.json");
    fs.writeFileSync(
      configURL,
      JSON.stringify({ settings: { theme: "dark" }, mcpServers: { existing: { command: "keep" } } }),
    );

    const adapter = new FilePiConfigAdapter(root);
    const backup = await adapter.connectStdio("/usr/bin/electron", ["/repo", "--mcp-stdio"]);
    expect(backup).not.toBeNull(); // 原文件存在 → 必须有备份

    const parsed = JSON.parse(fs.readFileSync(configURL, "utf8"));
    expect(await adapter.hasOctoPunkEntry()).toBe(true);
    expect(parsed.mcpServers.existing).toEqual({ command: "keep" });
    expect(parsed.settings).toEqual({ theme: "dark" });
    expect(parsed.mcpServers.octopunk).toMatchObject({ transport: "stdio", lifecycle: "eager" });
  });
});
