// 连接与 MCP — how OctoPunk (as an MCP server) is reached: default STDIO
// transport, the Codex config writer, the optional HTTP compatibility bridge,
// plus a protocol reference card.

import { useAppState } from "@/appState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Row, RowGroup, SectionLabel } from "@/features/settings/parts";

const PROTOCOLS: { name: string; desc: string }[] = [
  {
    name: "STDIO",
    desc: "本地进程直连，默认传输；适合 Codex、Claude Code 等 CLI 客户端。",
  },
  {
    name: "HTTP POST",
    desc: "有状态兼容桥（127.0.0.1:51931/mcp），按会话分发 JSON-RPC；不支持 SSE。",
  },
  {
    name: "Bearer",
    desc: "HTTP 传输的访问令牌，经 macOS Keychain（safeStorage）加密存储。",
  },
];

export function ConnectionsSettings() {
  const appState = useAppState();

  return (
    <div className="flex flex-col gap-8">
      <section>
        <SectionLabel>OctoPunk MCP 服务器</SectionLabel>
        <RowGroup>
          <Row
            title="STDIO 传输"
            desc="本地进程直连"
            hint="OctoPunk 作为 MCP 服务器经 STDIO 暴露全部团队工具；令牌经 Keychain 加密，通过 OCTOPUNK_MCP_TOKEN 环境变量注入受限会话。"
            control={
              <Badge variant="secondary" className="font-mono text-[10px]">
                默认
              </Badge>
            }
          />
          <Row
            title="连接 Codex"
            desc="写入 ~/.codex/config.toml"
            hint={
              "向 ~/.codex/config.toml 写入命令式 STDIO 条目，原配置自动备份。" +
              (appState.codexBackupPath != null ? `\n备份：${appState.codexBackupPath}` : "")
            }
            control={
              <Button variant="outline" size="sm" onClick={() => void appState.connectCodex()}>
                连接 Codex
              </Button>
            }
          />
          <Row
            title="HTTP 兼容"
            desc="127.0.0.1:51931/mcp"
            hint="Bearer 令牌存 Keychain；仅显式开启，STDIO 始终为默认传输。开关即当前状态。"
            control={
              <Switch
                checked={appState.isHTTPRunning}
                onCheckedChange={(enabled) =>
                  void (enabled
                    ? appState.startHTTPCompatibility()
                    : appState.stopHTTPCompatibility())
                }
              />
            }
          />
        </RowGroup>
      </section>

      <section>
        <SectionLabel>连接协议</SectionLabel>
        <RowGroup>
          {PROTOCOLS.map((protocol) => (
            <div key={protocol.name} className="flex items-start gap-3 px-5 py-4">
              <span className="text-foreground mt-0.5 w-20 shrink-0 font-mono text-xs font-medium">
                {protocol.name}
              </span>
              <p className="text-muted-foreground min-w-0 text-xs leading-relaxed">
                {protocol.desc}
              </p>
            </div>
          ))}
        </RowGroup>
      </section>
    </div>
  );
}
