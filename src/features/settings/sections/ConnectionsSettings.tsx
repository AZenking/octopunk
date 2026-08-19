// 连接与 MCP — how OctoPunk (as an MCP server) is reached: default STDIO
// transport, the Codex config writer, the optional HTTP compatibility bridge,
// plus a protocol reference card.

import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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

/** pr:check 通道载荷(与 electron/ipc.ts 同构的渲染层投影)。 */
interface GhProbePayload {
  enabled: boolean;
  available: boolean;
  detail: string;
}

/** GitHub 回灌分区:开关(默认关)+ gh 只读可用性探测(开启前即可用)。 */
function GithubFeedbackSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<GhProbePayload | null>(null);

  useEffect(() => {
    let stale = false;
    window.octopunk
      .invoke<{ enabled: boolean }>("pr:settings")
      .then((result) => {
        if (!stale) setEnabled(result.enabled);
      })
      .catch(() => {
        if (!stale) setEnabled(false);
      });
    return () => {
      stale = true;
    };
  }, []);

  const toggle = useCallback(async (next: boolean): Promise<void> => {
    setEnabled(next);
    try {
      const result = await window.octopunk.invoke<{ enabled: boolean }>("pr:settings", { enabled: next });
      setEnabled(result.enabled);
    } catch {
      // 写入失败回读当前值;分区内的降级不影响设置页其他区域。
      try {
        const result = await window.octopunk.invoke<{ enabled: boolean }>("pr:settings");
        setEnabled(result.enabled);
      } catch {
        setEnabled(false);
      }
    }
  }, []);

  const runProbe = useCallback(async (): Promise<void> => {
    setProbing(true);
    try {
      setProbe(await window.octopunk.invoke<GhProbePayload>("pr:check"));
    } catch (caught) {
      setProbe({
        enabled: enabled === true,
        available: false,
        detail: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setProbing(false);
    }
  }, [enabled]);

  return (
    <section>
      <SectionLabel>GitHub 回灌</SectionLabel>
      <RowGroup>
        <Row
          title="启用 GitHub 回灌"
          desc="默认关闭（FR-016）"
          hint="开启后可在审查中心为通过审查的任务创建 GitHub PR 并回灌 CI 状态与 Review 评论。凭证完全由本机 gh CLI 托管（gh auth login），OctoPunk 不保存任何 GitHub 凭证。"
          control={
            <Switch
              checked={enabled === true}
              disabled={enabled == null}
              onCheckedChange={(next) => void toggle(next)}
            />
          }
        />
        <Row
          title="gh CLI 可用性"
          desc="只读探测 gh --version / gh auth status"
          hint={
            probe == null
              ? "探测不修改任何状态,开启开关前即可执行;未安装 gh 或未登录时仅提示,不影响本地审查与门禁。"
              : probe.detail
          }
          control={
            <span className="flex items-center gap-2">
              {probe != null && (
                <Badge variant={probe.available ? "secondary" : "destructive"} className="px-1.5 py-0 text-[10px]">
                  {probe.available ? "可用" : "不可用"}
                </Badge>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={probing}
                onClick={() => void runProbe()}
                className="cursor-pointer"
              >
                {probing ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
                检测 gh
              </Button>
            </span>
          }
        />
      </RowGroup>
    </section>
  );
}

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
            title="连接 Pi"
            desc="写入 ~/.pi/agent/mcp.json"
            hint="向 pi 的 MCP 配置合并 octopunk STDIO 条目（eager），保留其他 server；原文件自动备份。需先安装 pi-mcp-extension 扩展（pi install npm:pi-mcp-extension），pi 本身不内置 MCP 客户端。"
            control={
              <Button variant="outline" size="sm" onClick={() => void appState.connectPi()}>
                连接 Pi
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

      <GithubFeedbackSection />

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
