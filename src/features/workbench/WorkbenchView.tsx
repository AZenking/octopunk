// 工作台主视图:六分区聚合(workbench:summary)+ run 级调度控制
// (run:pause / run:resume / run:set-priority)。点击条目选中对应 run 并
// 跳转运行详情(复用 TeamDashboardView 的 appState 选中机制)。
// 仅用 shadcn/ui 原语与 Tailwind 工具类;渲染进程只经 window.octopunk.invoke。

import { Gauge, Inbox, LoaderCircle, MoreHorizontal, Pause, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueReasonDTO, WorkbenchEntryDTO, WorkbenchSectionDTO } from "../../../shared/dtos";
import { displayNameForAgentKind } from "../../../shared/dtos";
import { StatusDot } from "@/components/blocks/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { taskStatusToAgent } from "@/lib/agentView";
import { cn } from "@/lib/utils";

/** 轮询间隔:工作台聚合视图按 5s 自动刷新(手动刷新随时可用)。 */
const REFRESH_INTERVAL_MS = 5_000;

/** 六分区固定渲染顺序与中文名(空缺分区也占位展示)。 */
const SECTION_META: { section: WorkbenchSectionDTO["section"]; label: string }[] = [
  { section: "running", label: "运行中" },
  { section: "queued", label: "排队中" },
  { section: "awaiting_input", label: "等待输入" },
  { section: "failed", label: "已失败" },
  { section: "awaiting_review", label: "待审查" },
  { section: "integratable", label: "可集成" },
];

/** queueReason(闸门拒绝级别)中文映射;仅 queued 分区条目携带。 */
const QUEUE_REASON_LABEL: Record<QueueReasonDTO, string> = {
  global_budget: "全局预算满",
  project_budget: "项目预算满",
  kind_budget: "单类型满",
  resource_pressure: "资源高压",
  launch_stagger: "错峰等待",
  run_paused: "运行已暂停",
};

/** run 优先级取值范围 -5..5;越大越先获得配额。 */
const PRIORITY_CHOICES = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];

function formatEpoch(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

function formatPriority(priority: number): string {
  return priority > 0 ? `+${priority}` : String(priority);
}

/** 工作台条目:点击跳转运行详情;右侧 DropdownMenu 提供 run 级调度操作。 */
function WorkbenchEntryCard({
  entry,
  busy,
  onSelectRun,
  onPause,
  onResume,
  onSetPriority,
}: {
  entry: WorkbenchEntryDTO;
  busy: boolean;
  onSelectRun: (runID: string) => void;
  onPause: (runID: string) => void;
  onResume: (runID: string) => void;
  onSetPriority: (runID: string, priority: number) => void;
}) {
  return (
    <div className="group relative">
      <Button
        variant="ghost"
        onClick={() => onSelectRun(entry.runID)}
        className="app-no-drag h-auto w-full cursor-pointer flex-col items-start gap-1 rounded-lg px-3 py-2 pr-9 text-left"
      >
        <span className="flex w-full min-w-0 items-center justify-between gap-2">
          <span className="truncate text-sm font-medium" title={entry.title}>
            {entry.title}
          </span>
        </span>
        <span className="text-muted-foreground w-full truncate text-xs" title={entry.runTitle}>
          {entry.runTitle}
        </span>
        <span className="flex w-full flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            {displayNameForAgentKind(entry.agentKind)}
          </Badge>
          {entry.queueReason != null && (
            <Badge
              variant="secondary"
              className="border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[10px] text-status-idle"
            >
              {QUEUE_REASON_LABEL[entry.queueReason]}
            </Badge>
          )}
          <span className="text-muted-foreground flex items-center gap-1 font-mono text-[10px]">
            <StatusDot status={taskStatusToAgent(entry.status)} pulse={false} />
            {entry.status}
          </span>
          <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[10px]">
            {formatEpoch(entry.updatedAt)}
          </span>
        </span>
      </Button>
      <span className="absolute top-1.5 right-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`运行操作:${entry.title}`}
              title="暂停 / 继续 / 优先级"
              disabled={busy}
              className="app-no-drag size-6 cursor-pointer opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="app-no-drag w-52">
            <DropdownMenuLabel className="text-muted-foreground max-w-44 truncate font-mono text-[10px]">
              {entry.runTitle}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="cursor-pointer" onClick={() => onPause(entry.runID)}>
              <Pause aria-hidden />
              暂停运行
            </DropdownMenuItem>
            <DropdownMenuItem className="cursor-pointer" onClick={() => onResume(entry.runID)}>
              <Play aria-hidden />
              继续运行
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="cursor-pointer">
                <Gauge aria-hidden />
                优先级(-5..5)
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                {PRIORITY_CHOICES.map((priority) => (
                  <DropdownMenuItem
                    key={priority}
                    className="cursor-pointer font-mono"
                    onClick={() => onSetPriority(entry.runID, priority)}
                  >
                    {formatPriority(priority)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  );
}

export function WorkbenchView({ onSelectRun }: { onSelectRun: (runID: string) => void }) {
  const [sections, setSections] = useState<WorkbenchSectionDTO[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadSummary = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await window.octopunk.invoke<WorkbenchSectionDTO[]>("workbench:summary");
      if (!mountedRef.current) return;
      setSections(result);
      setError(null);
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setSections([]);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // 首载 + 5s 自动轮询;手动刷新共用同一路径。
  useEffect(() => {
    void loadSummary();
    const timer = window.setInterval(() => void loadSummary(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadSummary]);

  const runAction = async (channel: "run:pause" | "run:resume", runID: string): Promise<void> => {
    setActionBusy(`${channel}:${runID}`);
    try {
      await window.octopunk.invoke(channel, { requestID: crypto.randomUUID(), runID });
      await loadSummary();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionBusy(null);
    }
  };

  const setPriority = async (runID: string, priority: number): Promise<void> => {
    setActionBusy(`run:set-priority:${runID}`);
    try {
      await window.octopunk.invoke("run:set-priority", {
        requestID: crypto.randomUUID(),
        runID,
        priority,
      });
      await loadSummary();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionBusy(null);
    }
  };

  const sectionEntries = (section: WorkbenchSectionDTO["section"]): WorkbenchEntryDTO[] =>
    sections?.find((candidate) => candidate.section === section)?.entries ?? [];

  const totalEntries =
    sections?.reduce((sum, section) => sum + section.entries.length, 0) ?? 0;

  return (
    <div className="bg-background flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="border-border app-drag flex h-11 shrink-0 items-center gap-2.5 border-b px-4">
        <Gauge className="text-primary size-4 shrink-0" aria-hidden />
        <h1 className="text-sm font-semibold">工作台</h1>
        <span className="text-muted-foreground text-xs">全局调度总览 · 六分区 · 暂停/继续/优先级</span>
        <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs" title="全部分区条目总数">
          {sections == null ? "…" : totalEntries}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="刷新工作台"
          title="刷新工作台"
          disabled={loading}
          onClick={() => void loadSummary()}
          className="app-no-drag cursor-pointer"
        >
          {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
        </Button>
      </header>

      {error != null && (
        <div className="border-border bg-destructive/5 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
          <p className="text-status-error min-w-0 truncate text-xs">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadSummary()}
            className="app-no-drag shrink-0 cursor-pointer"
          >
            重试
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {sections == null && loading ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {SECTION_META.map((meta) => (
              <Skeleton key={meta.section} className="h-64 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {SECTION_META.map((meta) => {
              const entries = sectionEntries(meta.section);
              return (
                <Card key={meta.section} className="gap-3 py-4">
                  <CardHeader className="px-4">
                    <CardTitle className="text-sm">{meta.label}</CardTitle>
                    <CardAction>
                      <Badge
                        variant="secondary"
                        className={cn("px-1.5 py-0 font-mono text-[10px]", entries.length === 0 && "opacity-60")}
                      >
                        {entries.length}
                      </Badge>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="px-3">
                    {entries.length === 0 ? (
                      <div className="text-muted-foreground flex h-28 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-center text-xs">
                        <Inbox className="size-5 opacity-50" aria-hidden />
                        <p>当前没有{meta.label}的任务</p>
                      </div>
                    ) : (
                      <div className="max-h-96 space-y-1 overflow-y-auto pr-1">
                        {entries.map((entry) => (
                          <WorkbenchEntryCard
                            key={`${entry.runID}:${entry.taskID}`}
                            entry={entry}
                            busy={actionBusy != null}
                            onSelectRun={onSelectRun}
                            onPause={(runID) => void runAction("run:pause", runID)}
                            onResume={(runID) => void runAction("run:resume", runID)}
                            onSetPriority={(runID, priority) => void setPriority(runID, priority)}
                          />
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
