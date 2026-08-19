// Review Center 主视图:左侧跨 Run 待审查任务列表(review:pending-list),
// 右侧选中任务的审查工作台(变更树 + 三方 Diff + 行级评论 + 交付摘要)。
// 仅用 shadcn/ui 原语与 Tailwind 工具类;渲染进程只经 window.octopunk.invoke。

import { ClipboardCheck, FileSearch, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  DeliverySummaryDTO,
  DiffTreeEntryDTO,
  ReviewPendingTaskDTO,
  ReviewVerdict,
} from "../../../shared/dtos";
import { displayNameForAgentKind, displayNameForExecutionMode } from "../../../shared/dtos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ArbitrationPanel } from "./ArbitrationPanel";
import { CommentPanel } from "./CommentPanel";
import { DiffTree } from "./DiffTree";
import { DiffViewer, type CommentAnchor, type DiffSide } from "./DiffViewer";
import { GatePanel } from "./GatePanel";
import { PrPanel } from "./PrPanel";

const SIDE_TABS: { value: DiffSide; label: string }[] = [
  { value: "baseline", label: "基线" },
  { value: "worktree", label: "工作树" },
  { value: "integration", label: "集成" },
];

function formatEpoch(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

function statusBadge(status: string): { label: string; className: string } {
  if (status === "rework_required") {
    return {
      label: "待返工",
      className: "border-amber-500/40 bg-amber-500/10 text-status-idle",
    };
  }
  return { label: "待报告", className: "" };
}

function PendingTaskCard({
  task,
  active,
  onSelect,
}: {
  task: ReviewPendingTaskDTO;
  active: boolean;
  onSelect: (task: ReviewPendingTaskDTO) => void;
}) {
  const status = statusBadge(task.status);
  return (
    <Button
      variant="ghost"
      onClick={() => onSelect(task)}
      className={cn(
        "app-no-drag h-auto w-full cursor-pointer flex-col items-start gap-1.5 rounded-lg px-3 py-2.5 text-left",
        active && "bg-accent text-accent-foreground",
      )}
    >
      <span className="flex w-full min-w-0 items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{task.title}</span>
        {task.hasRiskFinding && (
          <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
            risk
          </Badge>
        )}
      </span>
      <span className="text-muted-foreground w-full truncate text-xs">{task.runTitle}</span>
      <span className="flex w-full flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {displayNameForAgentKind(task.agentKind)}
        </Badge>
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {displayNameForExecutionMode(task.executionMode)}
        </Badge>
        <Badge variant="secondary" className={cn("px-1.5 py-0 text-[10px]", status.className)}>
          {status.label}
        </Badge>
        <span className="text-muted-foreground font-mono text-[10px]">第 {task.reviewRound} 轮</span>
      </span>
      <span className="text-muted-foreground flex w-full items-center justify-between gap-2 text-xs">
        <span
          className={cn(
            "truncate",
            task.unresolvedFindingCount > 0 && "text-status-error font-medium",
          )}
        >
          未解决发现 {task.unresolvedFindingCount}
        </span>
        <span className="shrink-0 font-mono text-[10px]">{formatEpoch(task.updatedAt)}</span>
      </span>
      {task.latestReport != null && (
        <span className="text-muted-foreground line-clamp-2 w-full text-xs leading-4">
          {task.latestReport}
        </span>
      )}
    </Button>
  );
}

/** 交付摘要:读取(review:get-summary)与生成(review:generate-summary)。 */
function SummaryPanel({ runID, taskID }: { runID: string; taskID: string }) {
  const [summary, setSummary] = useState<DeliverySummaryDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [verdict, setVerdict] = useState<ReviewVerdict>("PASS");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setSummary(null);
    setError(null);
    setLoading(true);
    window.octopunk
      .invoke<DeliverySummaryDTO | null>("review:get-summary", { runID, taskID })
      .then((result) => {
        if (!stale) setSummary(result);
      })
      .catch((caught) => {
        if (!stale) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [runID, taskID]);

  const generate = async (): Promise<void> => {
    setGenerating(true);
    setError(null);
    try {
      const result = await window.octopunk.invoke<DeliverySummaryDTO>("review:generate-summary", {
        runID,
        taskID,
        verdict,
      });
      setSummary(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="border-border flex max-h-72 shrink-0 flex-col border-t">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
        <h2 className="text-sm font-semibold">交付摘要</h2>
        {summary != null && (
          <span className="flex items-center gap-1.5">
            <Badge
              variant={summary.verdict === "PASS" ? "secondary" : "destructive"}
              className="px-1.5 py-0 text-[10px]"
            >
              {summary.verdict}
            </Badge>
            <span className="text-muted-foreground text-xs">
              豁免 {summary.waiverCount} · 遗留 {summary.openFindingCount}
            </span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Label className="sr-only">审查结论</Label>
          <Select value={verdict} onValueChange={(value) => setVerdict(value as ReviewVerdict)}>
            <SelectTrigger size="sm" className="app-no-drag w-28 cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PASS" className="cursor-pointer">
                PASS
              </SelectItem>
              <SelectItem value="REWORK" className="cursor-pointer">
                REWORK
              </SelectItem>
              <SelectItem value="BLOCKED" className="cursor-pointer">
                BLOCKED
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={generating}
            onClick={() => void generate()}
            className="app-no-drag cursor-pointer"
          >
            {generating ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
            {summary == null ? "生成摘要" : "重新生成"}
          </Button>
        </span>
      </div>
      {error != null && (
        <p className="text-status-error px-3 pb-1.5 text-xs">{error}</p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : summary == null ? (
          <p className="text-muted-foreground text-xs">
            尚未生成交付摘要;选择结论后点击「生成摘要」归档(结论/证据/豁免清单/遗留项)。
          </p>
        ) : (
          // summaryMd 为结构化 Markdown;Markdown 组件存在预存 typecheck 问题,
          // 此处用等宽纯文本最小自渲染,避免新依赖。
          <pre className="bg-muted text-foreground w-full rounded-md p-2 font-mono text-xs whitespace-pre-wrap">
            {summary.summaryMd}
          </pre>
        )}
      </div>
    </div>
  );
}

export function ReviewCenterView() {
  const [tasks, setTasks] = useState<ReviewPendingTaskDTO[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReviewPendingTaskDTO | null>(null);
  const [side, setSide] = useState<DiffSide>("worktree");
  const [tree, setTree] = useState<DiffTreeEntryDTO[] | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeReloadToken, setTreeReloadToken] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState<CommentAnchor | null>(null);

  const loadList = useCallback(async (): Promise<void> => {
    setListLoading(true);
    setListError(null);
    try {
      const result = await window.octopunk.invoke<ReviewPendingTaskDTO[]>("review:pending-list");
      setTasks(result);
      setSelected((current) =>
        current != null && result.some((task) => task.taskID === current.taskID) ? current : null,
      );
    } catch (caught) {
      setListError(caught instanceof Error ? caught.message : String(caught));
      setTasks([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // 变更树随选中任务、side 切换与手动重试(treeReloadToken)重载;
  // 保留仍在树中的文件选择,否则回落首项。
  useEffect(() => {
    if (selected == null) {
      setTree(null);
      setSelectedPath(null);
      setTreeError(null);
      return;
    }
    let stale = false;
    setTreeLoading(true);
    setTreeError(null);
    window.octopunk
      .invoke<DiffTreeEntryDTO[]>("review:get-diff", {
        runID: selected.runID,
        taskID: selected.taskID,
        side,
      })
      .then((entries) => {
        if (stale) return;
        setTree(entries);
        setSelectedPath((current) =>
          current != null && entries.some((entry) => entry.path === current)
            ? current
            : (entries[0]?.path ?? null),
        );
      })
      .catch((caught) => {
        if (stale) return;
        setTree([]);
        setSelectedPath(null);
        setTreeError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!stale) setTreeLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [selected, side, treeReloadToken]);

  const activeEntry = tree?.find((entry) => entry.path === selectedPath) ?? null;

  return (
    <div className="bg-background flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="border-border app-drag flex h-11 shrink-0 items-center gap-2.5 border-b px-4">
        <ClipboardCheck className="text-primary size-4 shrink-0" aria-hidden />
        <h1 className="text-sm font-semibold">审查中心</h1>
        <span className="text-muted-foreground text-xs">
          跨 Run 待审查任务 · Diff · 行级评论 · 批量返工
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="刷新待审查列表"
            title="刷新待审查列表"
            disabled={listLoading}
            onClick={() => void loadList()}
            className="app-no-drag cursor-pointer"
          >
            {listLoading ? (
              <LoaderCircle className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw aria-hidden />
            )}
          </Button>
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 待审查任务列表 */}
        <aside className="border-border flex w-80 shrink-0 flex-col border-r">
          <div className="border-border flex shrink-0 items-center justify-between border-b px-3 py-2">
            <h2 className="text-sm font-semibold">待审查任务</h2>
            <span className="text-muted-foreground font-mono text-xs">{tasks?.length ?? 0}</span>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {tasks == null || listLoading ? (
              Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-24 w-full" />)
            ) : listError != null ? (
              <div className="flex flex-col items-center gap-2 p-4 text-center">
                <p className="text-status-error text-xs">{listError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadList()}
                  className="app-no-drag cursor-pointer"
                >
                  重试
                </Button>
              </div>
            ) : tasks.length === 0 ? (
              <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-xs">
                <FileSearch className="size-5 opacity-50" aria-hidden />
                <p>当前没有待审查任务</p>
                <p>任务进入「待报告 / 待返工」状态后会出现在这里。</p>
              </div>
            ) : (
              tasks.map((task) => (
                <PendingTaskCard
                  key={`${task.runID}:${task.taskID}`}
                  task={task}
                  active={selected?.runID === task.runID && selected?.taskID === task.taskID}
                  onSelect={(next) => {
                    setSelected(next);
                    setCommentDraft(null);
                  }}
                />
              ))
            )}
          </div>
        </aside>

        {/* 审查工作台 */}
        {selected == null ? (
          <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-sm">
            <FileSearch className="size-5 opacity-50" aria-hidden />
            <p>从左侧选择待审查任务</p>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
              <span className="truncate text-sm font-medium">{selected.title}</span>
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {displayNameForAgentKind(selected.agentKind)}
              </Badge>
              <span className="text-muted-foreground font-mono text-xs">
                第 {selected.reviewRound} 轮
              </span>
              {selected.hasRiskFinding && (
                <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                  risk
                </Badge>
              )}
              <span
                className={cn(
                  "text-xs",
                  selected.unresolvedFindingCount > 0 ? "text-status-error font-medium" : "text-muted-foreground",
                )}
              >
                未解决 {selected.unresolvedFindingCount}
              </span>
              <Separator orientation="vertical" className="mx-1! h-4!" />
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                {selected.runTitle}
              </span>
            </div>

            <div className="flex min-h-0 flex-1">
              <aside className="border-border flex w-64 shrink-0 flex-col border-r">
                <div className="border-border flex shrink-0 items-center justify-between border-b px-3 py-2">
                  <h2 className="text-sm font-semibold">变更树</h2>
                  <span className="text-muted-foreground font-mono text-xs">{tree?.length ?? 0}</span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <DiffTree
                    entries={tree ?? []}
                    activePath={selectedPath}
                    loading={treeLoading}
                    error={treeError}
                    onSelect={setSelectedPath}
                    onRetry={() => setTreeReloadToken((token) => token + 1)}
                  />
                </div>
              </aside>

              <div className="flex min-w-0 flex-1 flex-col">
                <div className="border-border flex shrink-0 items-center gap-3 border-b px-3 py-2">
                  <Tabs value={side} onValueChange={(value) => setSide(value as DiffSide)}>
                    <TabsList>
                      {SIDE_TABS.map((tab) => (
                        <TabsTrigger key={tab.value} value={tab.value}>
                          {tab.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                  <span
                    className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs"
                    title={selectedPath ?? undefined}
                  >
                    {selectedPath ?? "未选择文件"}
                  </span>
                </div>
                <div className="flex min-h-0 flex-1">
                  <DiffViewer
                    runID={selected.runID}
                    taskID={selected.taskID}
                    side={side}
                    path={selectedPath}
                    entry={activeEntry}
                    onLineComment={setCommentDraft}
                  />
                  <div className="border-border flex w-96 shrink-0 flex-col border-l">
                    <CommentPanel
                      runID={selected.runID}
                      taskID={selected.taskID}
                      draft={commentDraft}
                      onDraftClear={() => setCommentDraft(null)}
                    />
                    <SummaryPanel runID={selected.runID} taskID={selected.taskID} />
                    {/* GitHub PR 回灌(specs/002-v04 US4):默认关闭;任何 gh 失败只降级为面板内错误条。 */}
                    <PrPanel runID={selected.runID} taskID={selected.taskID} taskTitle={selected.title} />
                    <GatePanel runID={selected.runID} taskID={selected.taskID} />
                    <ArbitrationPanel runID={selected.runID} taskID={selected.taskID} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
