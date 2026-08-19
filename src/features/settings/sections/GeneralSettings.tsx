// 常规 — app-level behavior: launch-at-login, scheduler concurrency and
// worktree disk maintenance.

import { useEffect, useState } from "react";
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
import {
  GLOBAL_MAX_CHILDREN_MAX,
  LAUNCH_STAGGER_SECONDS_MAX,
  MAX_CONCURRENT_TASKS_LIMIT,
  MIN_FREE_DISK_BYTES_FLOOR,
  PER_KIND_MAX_CHILDREN_MAX,
  PER_PROJECT_MAX_CHILDREN_MAX,
  TASK_RETRY_LIMIT_MAX,
  clampGlobalMaxChildren,
  clampMinFreeDiskBytes,
  clampPerKindMaxChildren,
  clampPerProjectMaxChildren,
  type SchedulerSettingsPayload,
} from "../../../../shared/ipc";
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

const SKILL_TARGETS: ChildAgentKindValue[] = ["claude_code", "codex", "pi"];

/** 磁盘阈值换算:设置页以 GB 呈现,IPC 载荷为字节(1 GB = 1024 MiB)。 */
const GIB_BYTES = 1024 ** 3;

function formatGB(bytes: number): string {
  return `${(bytes / GIB_BYTES).toFixed(1)} GB`;
}

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

  // 调度设置(specs/001-v03 B 节):scheduler:settings 空载荷读、带载荷写。
  const [scheduler, setScheduler] = useState<SchedulerSettingsPayload | null>(null);
  const [schedulerDraft, setSchedulerDraft] = useState<SchedulerSettingsPayload | null>(null);
  const [schedulerSaving, setSchedulerSaving] = useState(false);
  const [schedulerError, setSchedulerError] = useState<string | null>(null);
  const [diskGBText, setDiskGBText] = useState("");

  useEffect(() => {
    let stale = false;
    window.octopunk
      .invoke<SchedulerSettingsPayload>("scheduler:settings", {})
      .then((payload) => {
        if (stale) return;
        setScheduler(payload);
        setSchedulerDraft(payload);
        setDiskGBText(String(payload.minFreeDiskBytes / GIB_BYTES));
      })
      .catch((error) => {
        if (!stale) setSchedulerError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      stale = true;
    };
  }, []);

  const schedulerDirty =
    schedulerDraft != null &&
    (scheduler == null || JSON.stringify(scheduler) !== JSON.stringify(schedulerDraft));

  const saveScheduler = async (): Promise<void> => {
    if (schedulerDraft == null) return;
    setSchedulerSaving(true);
    try {
      const result = await window.octopunk.invoke<SchedulerSettingsPayload>("scheduler:settings", {
        globalMaxChildren: clampGlobalMaxChildren(schedulerDraft.globalMaxChildren),
        perProjectMaxChildren: clampPerProjectMaxChildren(schedulerDraft.perProjectMaxChildren),
        perKindMaxChildren: clampPerKindMaxChildren(schedulerDraft.perKindMaxChildren),
        resourcePauseEnabled: schedulerDraft.resourcePauseEnabled,
        minFreeDiskBytes: clampMinFreeDiskBytes(schedulerDraft.minFreeDiskBytes),
        interactiveSlotReserved: schedulerDraft.interactiveSlotReserved,
      });
      setScheduler(result);
      setSchedulerDraft(result);
      setDiskGBText(String(result.minFreeDiskBytes / GIB_BYTES));
      setSchedulerError(null);
      appState.setStatusMessage(
        `调度设置已保存：全局 ${result.globalMaxChildren} · 项目 ${result.perProjectMaxChildren} · 单类型 ${result.perKindMaxChildren}（实际以四级最严为准）。`,
      );
    } catch (error) {
      setSchedulerError(error instanceof Error ? error.message : String(error));
    } finally {
      setSchedulerSaving(false);
    }
  };

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
          <Row
            title="自动重试"
            desc="限流/超时等瞬时失败自动重试"
            hint="对限流（529/429）、超时、协议错误按 5s→15s→45s 指数退避自动重试；认证、配置类错误不重试。0 = 关闭。"
            control={
              <Input
                type="number"
                min={0}
                max={TASK_RETRY_LIMIT_MAX}
                value={appState.executionPolicy.taskRetryLimit}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(value)) {
                    appState.updateExecutionPolicy({
                      taskRetryLimit: Math.min(TASK_RETRY_LIMIT_MAX, Math.max(0, value)),
                    });
                  }
                }}
                className="w-20 text-center font-mono"
                aria-label="自动重试次数"
              />
            }
          />
          <Row
            title="启动间隔"
            desc="批次内子 Agent 错峰拉起"
            hint="相邻两个子进程启动的最小间隔秒数，避免批次同时打到模型端点触发并发限制。0 = 不间隔。"
            control={
              <Input
                type="number"
                min={0}
                max={LAUNCH_STAGGER_SECONDS_MAX}
                value={appState.executionPolicy.launchStaggerSeconds}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(value)) {
                    appState.updateExecutionPolicy({
                      launchStaggerSeconds: Math.min(LAUNCH_STAGGER_SECONDS_MAX, Math.max(0, value)),
                    });
                  }
                }}
                className="w-20 text-center font-mono"
                aria-label="启动间隔秒数"
              />
            }
          />
        </RowGroup>
      </section>

      <section>
        <SectionLabel>调度</SectionLabel>
        <RowGroup>
          <Row
            title="全局并发"
            desc="所有 TeamRun 合计的子 Agent 进程上限"
            hint={`1–${GLOBAL_MAX_CHILDREN_MAX}；跨 run 的总闸门，与项目/单类型/run 级上限取最小后生效。`}
            control={
              <Input
                type="number"
                min={1}
                max={GLOBAL_MAX_CHILDREN_MAX}
                value={schedulerDraft?.globalMaxChildren ?? ""}
                disabled={schedulerDraft == null}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(value) && schedulerDraft != null) {
                    setSchedulerDraft({
                      ...schedulerDraft,
                      globalMaxChildren: Math.min(GLOBAL_MAX_CHILDREN_MAX, Math.max(1, value)),
                    });
                  }
                }}
                className="w-20 text-center font-mono"
                aria-label="全局并发上限"
              />
            }
          />
          <Row
            title="项目并发"
            desc="同一仓库(项目)内的子 Agent 进程上限"
            hint={`1–${PER_PROJECT_MAX_CHILDREN_MAX}；按仓库路径分组计数，防止单项目挤占全局配额。`}
            control={
              <Input
                type="number"
                min={1}
                max={PER_PROJECT_MAX_CHILDREN_MAX}
                value={schedulerDraft?.perProjectMaxChildren ?? ""}
                disabled={schedulerDraft == null}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(value) && schedulerDraft != null) {
                    setSchedulerDraft({
                      ...schedulerDraft,
                      perProjectMaxChildren: Math.min(PER_PROJECT_MAX_CHILDREN_MAX, Math.max(1, value)),
                    });
                  }
                }}
                className="w-20 text-center font-mono"
                aria-label="项目并发上限"
              />
            }
          />
          <Row
            title="单类型并发"
            desc="同一 Agent 类型的子进程上限"
            hint={`1–${PER_KIND_MAX_CHILDREN_MAX}；按 Claude Code / Codex / pi 分别计数，避免单一执行器 saturate 模型端点。`}
            control={
              <Input
                type="number"
                min={1}
                max={PER_KIND_MAX_CHILDREN_MAX}
                value={schedulerDraft?.perKindMaxChildren ?? ""}
                disabled={schedulerDraft == null}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(value) && schedulerDraft != null) {
                    setSchedulerDraft({
                      ...schedulerDraft,
                      perKindMaxChildren: Math.min(PER_KIND_MAX_CHILDREN_MAX, Math.max(1, value)),
                    });
                  }
                }}
                className="w-20 text-center font-mono"
                aria-label="单类型并发上限"
              />
            }
          />
          <Row
            title="资源暂缓"
            desc="资源高压时暂停发放新配额"
            hint="磁盘剩余低于阈值(或系统探测到高压)时进入 resource_pressure：已运行任务不受影响，新任务排队等待。"
            control={
              <Switch
                checked={schedulerDraft?.resourcePauseEnabled ?? false}
                disabled={schedulerDraft == null}
                onCheckedChange={(enabled) => {
                  if (schedulerDraft != null) {
                    setSchedulerDraft({ ...schedulerDraft, resourcePauseEnabled: enabled });
                  }
                }}
              />
            }
          />
          <Row
            title="磁盘阈值"
            desc="剩余磁盘低于该值时进入资源高压"
            hint={`以 GB 输入、按字节保存（1 GB = 1024 MiB）；下限 ${(MIN_FREE_DISK_BYTES_FLOOR / 1024 / 1024).toFixed(0)} MiB。当前生效：${scheduler == null ? "—" : formatGB(scheduler.minFreeDiskBytes)}。`}
            control={
              <Input
                type="number"
                min={0}
                step={1}
                value={diskGBText}
                disabled={schedulerDraft == null}
                onChange={(event) => {
                  const text = event.target.value;
                  setDiskGBText(text);
                  const value = Number.parseFloat(text);
                  if (Number.isFinite(value) && schedulerDraft != null) {
                    setSchedulerDraft({
                      ...schedulerDraft,
                      minFreeDiskBytes: Math.max(0, Math.round(value * GIB_BYTES)),
                    });
                  }
                }}
                className="w-24 text-center font-mono"
                aria-label="磁盘剩余阈值(GB)"
              />
            }
          />
          <Row
            title="交互槽保留"
            desc="为交互式会话保留一个配额槽位"
            hint="开启后全局配额中始终预留 1 个槽位给交互式(MCP 会话)请求，避免后台批任务占满导致交互无响应。"
            control={
              <Switch
                checked={schedulerDraft?.interactiveSlotReserved ?? false}
                disabled={schedulerDraft == null}
                onCheckedChange={(enabled) => {
                  if (schedulerDraft != null) {
                    setSchedulerDraft({ ...schedulerDraft, interactiveSlotReserved: enabled });
                  }
                }}
              />
            }
          />
        </RowGroup>
        <div className="mt-2 flex items-start gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={schedulerDraft == null || schedulerSaving || !schedulerDirty}
            onClick={() => void saveScheduler()}
            className="app-no-drag shrink-0 cursor-pointer"
          >
            {schedulerSaving ? "保存中…" : "保存调度设置"}
          </Button>
          <p className="text-muted-foreground min-w-0 text-[11px] leading-relaxed">
            生效值四级联检：全局 {scheduler?.globalMaxChildren ?? "—"} · 项目{" "}
            {scheduler?.perProjectMaxChildren ?? "—"} · 单类型 {scheduler?.perKindMaxChildren ?? "—"}
            ，与各 TeamRun 自身的并发上限(run 级 maxConcurrentTasks)取最小——实际以四级最严为准。
          </p>
        </div>
        {schedulerError != null && (
          <p className="text-status-error mt-1.5 text-xs">{schedulerError}</p>
        )}
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
          可用「连接与 MCP → 连接 Codex」自动写入；pi 需先安装 pi-mcp-extension 扩展并按说明配置
          ~/.pi/agent/mcp.json。不影响 OctoPunk 自己派发的子 Agent（隔离运行、禁止递归编排）；覆盖安装会自动备份原文件。
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
