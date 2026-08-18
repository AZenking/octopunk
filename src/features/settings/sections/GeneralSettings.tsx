// 常规 — app-level behavior: launch-at-login and worktree disk maintenance.

import { useState } from "react";
import { useAppState, type ChildAgentKindValue } from "@/appState";
import { AgentMark, agentLabel } from "@/components/AgentMark";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { MAX_CONCURRENT_TASKS_LIMIT } from "../../../../shared/ipc";
import { Row, RowGroup, SectionLabel, formatBytes } from "@/features/settings/parts";
import { cn } from "@/lib/utils";

interface WorktreeEntry {
  path: string;
  kind: string;
  runStatus: string | null;
  sizeBytes: number;
  cleanable: boolean;
  reason: string;
}

const SKILL_TARGETS: ChildAgentKindValue[] = ["claude_code", "codex"];

function SkillStateBadge({ state }: { state: "not_installed" | "installed" | "update_available" }) {
  if (state === "installed") {
    return (
      <Badge variant="outline" className="border-transparent bg-secondary/60 font-mono text-[10px] text-status-running">
        已安装
      </Badge>
    );
  }
  if (state === "update_available") {
    return (
      <Badge variant="outline" className="border-transparent bg-amber-500/10 font-mono text-[10px] text-status-idle">
        可更新
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground font-mono text-[10px]">
      未安装
    </Badge>
  );
}

export function GeneralSettings() {
  const appState = useAppState();
  const [loginItemEnabled, setLoginItemEnabled] = useState(false);
  const [installingSkill, setInstallingSkill] = useState<ChildAgentKindValue | null>(null);
  const [worktreeEntries, setWorktreeEntries] = useState<WorktreeEntry[] | null>(null);
  const [worktreeScanning, setWorktreeScanning] = useState(false);
  const [worktreeCleanOpen, setWorktreeCleanOpen] = useState(false);

  const scanWorktrees = async (): Promise<void> => {
    setWorktreeScanning(true);
    try {
      const result = await window.octopunk.invoke<{ entries: WorktreeEntry[] }>("worktree:scan");
      setWorktreeEntries(result.entries);
    } catch (error) {
      appState.setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorktreeScanning(false);
    }
  };

  const cleanWorktrees = async (): Promise<void> => {
    const targets = (worktreeEntries ?? []).filter((entry) => entry.cleanable).map((entry) => entry.path);
    if (targets.length === 0) return;
    try {
      const result = await window.octopunk.invoke<{
        removed: string[];
        failed: { path: string; error: string }[];
      }>("worktree:cleanup", { paths: targets });
      appState.setStatusMessage(
        `Worktree 清理：移除 ${result.removed.length} 项，失败 ${result.failed.length}${
          result.failed.length > 0 ? `（${result.failed[0].error.slice(0, 60)}）` : ""
        }`,
      );
      await scanWorktrees();
    } catch (error) {
      appState.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const cleanable = worktreeEntries?.filter((entry) => entry.cleanable) ?? [];

  return (
    <div className="flex flex-col gap-8">
      <section>
        <SectionLabel>启动</SectionLabel>
        <RowGroup>
          <Row
            title="开机自启"
            desc="登录 macOS 时自动启动 OctoPunk"
            control={
              <Switch
                checked={loginItemEnabled}
                onCheckedChange={(enabled) => {
                  setLoginItemEnabled(enabled);
                  void appState.registerLoginItem(enabled);
                }}
              />
            }
          />
          <Row
            title="并发限制"
            desc="每个 TeamRun 同时运行的子 Agent 数"
            hint={`1–${MAX_CONCURRENT_TASKS_LIMIT}；提高并发会同时启动更多 Claude Code / Codex 子进程，实际吞吐仍受机器性能与模型套餐并发额度约束。仅对之后新建的 TeamRun 生效。`}
            control={
              <Input
                type="number"
                min={1}
                max={MAX_CONCURRENT_TASKS_LIMIT}
                value={appState.maxConcurrentTasks}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(value)) {
                    appState.setMaxConcurrentTasks(
                      Math.min(MAX_CONCURRENT_TASKS_LIMIT, Math.max(1, value)),
                    );
                  }
                }}
                className="w-20 text-center font-mono"
                aria-label="并发限制"
              />
            }
          />
        </RowGroup>
      </section>

      <section>
        <SectionLabel>OctoPunk Skill</SectionLabel>
        <div className="border-border divide-border divide-y rounded-xl border">
          {SKILL_TARGETS.map((kind) => {
            const status = appState.skillStatus.find((entry) => entry.kind === kind);
            const state = status?.state ?? "not_installed";
            const installing = installingSkill === kind;
            return (
              <div key={kind} className="flex items-center gap-3 px-5 py-4">
                <AgentMark agentKind={kind} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-foreground text-sm font-medium">{agentLabel(kind)}</p>
                    <SkillStateBadge state={state} />
                  </div>
                  {status != null && (
                    <p
                      className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]"
                      title={status.path}
                    >
                      {status.path.replace(/^\/Users\/[^/]+/, "~")}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={installingSkill != null}
                  onClick={() => {
                    setInstallingSkill(kind);
                    void appState.installSkill(kind).finally(() => setInstallingSkill(null));
                  }}
                >
                  {installing ? "安装中…" : state === "not_installed" ? "安装" : state === "update_available" ? "更新" : "重新安装"}
                </Button>
              </div>
            );
          })}
        </div>
        <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
          将 OctoPunk 编排技能（start_team / delegate_tasks / join_tasks 等 MCP 工作流）安装到各 Agent 的
          skills 目录。Claude Code 需按 skill 内说明执行一次 claude mcp add 注册 MCP；Codex
          可用「连接与 MCP → 连接 Codex」自动写入。不影响 OctoPunk 自己派发的子 Agent（隔离运行、禁止递归编排）；覆盖安装会自动备份原文件。
        </p>
      </section>

      <section>
        <SectionLabel>Worktree 清理</SectionLabel>
        <div className="border-destructive/30 bg-destructive/5 rounded-xl border px-5">
          <div className="py-4">
            <div className="flex items-center justify-between gap-6">
              <div className="min-w-0">
                <p className="text-foreground text-sm font-medium">托管 Worktree</p>
                <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                  扫描托管 worktree 根目录，清理终态/孤儿运行残留；活跃运行的可恢复 worktree 不会被触碰。
                </p>
                {worktreeEntries != null && (
                  <p className="text-muted-foreground mt-1.5 font-mono text-[11px]">
                    {worktreeEntries.length} 项 · 可清理 {cleanable.length} 项 ·{" "}
                    {formatBytes(cleanable.reduce((sum, entry) => sum + entry.sizeBytes, 0))}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={worktreeScanning}
                  onClick={() => void scanWorktrees()}
                >
                  {worktreeScanning ? "扫描中…" : "扫描"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cleanable.length === 0}
                  onClick={() => setWorktreeCleanOpen(true)}
                  className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  清理
                </Button>
              </div>
            </div>
            {worktreeEntries != null && worktreeEntries.length > 0 && (
              <ScrollArea className="mt-3 max-h-40 rounded-lg border border-destructive/15 bg-background/40">
                <div className="divide-y divide-destructive/10">
                  {worktreeEntries.map((entry) => (
                    <div key={entry.path} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <Badge
                        variant="outline"
                        className={cn(
                          "font-mono text-[10px]",
                          entry.cleanable
                            ? "border-transparent bg-amber-500/10 text-status-idle"
                            : "border-transparent bg-secondary/60 text-status-running",
                        )}
                      >
                        {entry.cleanable ? "可清理" : "活跃"}
                      </Badge>
                      <span className="truncate font-mono">{entry.path}</span>
                      <span className="text-muted-foreground ml-auto shrink-0 font-mono">
                        {formatBytes(entry.sizeBytes)} · {entry.reason}
                      </span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </div>
      </section>

      <AlertDialog open={worktreeCleanOpen} onOpenChange={setWorktreeCleanOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清理 Worktree？</AlertDialogTitle>
            <AlertDialogDescription>
              将永久移除 {cleanable.length} 个终态/孤儿 worktree 及其临时分支，并回收空运行目录；活跃运行不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                setWorktreeCleanOpen(false);
                void cleanWorktrees();
              }}
            >
              清理
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
