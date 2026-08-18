// Batch delegation page: parent context, per-line task draft, parent/dependency
// selectors, agent/mode, batches list with join (extracted from RunDetailView).
// Presentation mirrors the Settings view: banner header, uppercase section
// labels, and rounded bordered row groups.

import { useCallback, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import type { JoinTasksDTO, RunSummaryDTO } from "../../../shared/dtos";
import { useAppState } from "@/appState";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-muted-foreground mb-1 text-sm font-semibold tracking-wider uppercase">
      {children}
    </h2>
  );
}

function RowGroup({ children }: { children: ReactNode }) {
  return (
    <div className="border-border divide-border divide-y rounded-xl border">{children}</div>
  );
}

function Row({ title, desc, children }: { title: string; desc?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-4">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium whitespace-nowrap">{title}</p>
        {desc != null && (
          <p className="text-muted-foreground mt-0.5 min-w-0 text-xs">{desc}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function BatchDelegatePanel({
  summary,
  onDone,
}: {
  summary: RunSummaryDTO | null;
  onDone: () => void;
}) {
  const appState = useAppState();
  const [joinSummary, setJoinSummary] = useState("");
  const [joinTimedOut, setJoinTimedOut] = useState(false);
  const runID = appState.selectedRunID;

  const join = useCallback(
    async (batchID: string) => {
      if (runID == null) return;
      try {
        const result = await window.octopunk.invoke<JoinTasksDTO>("team:join", { runID, batchID });
        setJoinSummary(result.markdownSummary);
        setJoinTimedOut(result.timedOut);
      } catch (error) {
        appState.setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [runID, appState],
  );

  const availability = appState.availability(appState.childAgentKind);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-border app-drag flex items-start gap-3 border-b px-8 py-6">
        <button
          type="button"
          aria-label="返回"
          onClick={onDone}
          className="border-border text-muted-foreground hover:bg-muted hover:text-foreground app-no-drag mt-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0">
          <h1 className="text-foreground text-xl font-semibold">委派任务批次</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            一行一个任务；超过 3 个并发后自动排队。
          </p>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col px-8 py-6">
        <section>
          <SectionLabel>父上下文</SectionLabel>
          <RowGroup>
            <div className="px-5 py-4">
              <p className="text-foreground text-sm font-medium">摘要</p>
              <p className="text-muted-foreground mt-0.5 mb-3 text-xs leading-relaxed">
                必填，≤16 KiB；将以脱敏快照形式下发给子 Agent。
              </p>
              <Textarea
                value={appState.childContextSummary}
                onChange={(event) => appState.setChildContextSummary(event.target.value)}
                placeholder="父上下文摘要（必填，≤16 KiB，将脱敏快照）"
                className="min-h-[65px] max-h-[110px]"
              />
            </div>
          </RowGroup>
        </section>

        <section className="mt-6">
          <SectionLabel>任务清单</SectionLabel>
          <RowGroup>
            <div className="px-5 py-4">
              <p className="text-foreground text-sm font-medium">批量草稿</p>
              <p className="text-muted-foreground mt-0.5 mb-3 text-xs leading-relaxed">
                每行一个任务：title | prompt；或 client_key | title | prompt | parent_key | dep1,dep2
              </p>
              <Textarea
                value={appState.childBatchDraft}
                onChange={(event) => appState.setChildBatchDraft(event.target.value)}
                placeholder="每行一个任务：title | prompt；或 client_key | title | prompt | parent_key | dep1,dep2"
                className="min-h-[100px] font-mono text-xs"
              />
            </div>
          </RowGroup>
        </section>

        <section className="mt-6">
          <SectionLabel>归属与依赖</SectionLabel>
          <RowGroup>
            <Row title="父任务" desc="批次挂载到哪个既有任务之下">
              <Select
                value={appState.childParentTaskID ?? "root"}
                onValueChange={(value) =>
                  appState.setChildParentTaskID(value === "root" ? null : value)
                }
              >
                <SelectTrigger className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="root">根任务</SelectItem>
                  {(summary?.tasks ?? []).map((task) => (
                    <SelectItem key={task.id} value={task.id}>
                      {task.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <div className="px-5 py-4">
              <p className="text-foreground text-sm font-medium">依赖</p>
              <p className="text-muted-foreground mt-0.5 mb-3 text-xs">全部完成后本批次才会启动</p>
              {(summary?.tasks ?? []).length === 0 ? (
                <p className="text-muted-foreground text-xs">暂无既有任务</p>
              ) : (
                <ScrollArea className="w-full">
                  <div className="flex flex-wrap gap-x-4 gap-y-2 pb-1">
                    {(summary?.tasks ?? []).map((task) => (
                      <label key={task.id} className="flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={appState.childDependencyIDs.has(task.id)}
                          onCheckedChange={(enabled) =>
                            appState.toggleChildDependency(task.id, enabled === true)
                          }
                        />
                        <span className="max-w-[160px] truncate">{task.title}</span>
                      </label>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
          </RowGroup>
        </section>

        <section className="mt-6">
          <SectionLabel>执行器</SectionLabel>
          <RowGroup>
            <Row title="子 Agent" desc="由哪个 CLI 执行本批次任务">
              <Select
                value={appState.childAgentKind}
                onValueChange={(value) => appState.setChildAgentKind(value as "claude_code" | "codex")}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {!appState.disabledAgents.has("claude_code") && (
                    <SelectItem value="claude_code">Claude Code</SelectItem>
                  )}
                  {!appState.disabledAgents.has("codex") && (
                    <SelectItem value="codex">Codex</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </Row>
            <Row title="执行模式" desc="只读或独立工作区写入">
              <Select
                value={appState.childExecutionMode}
                onValueChange={(value) =>
                  appState.setChildExecutionMode(value as "read_only" | "workspace_write")
                }
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read_only">只读</SelectItem>
                  <SelectItem value="workspace_write">工作区写入</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            {availability != null && (
              <div className="flex items-center justify-between gap-6 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-foreground text-sm font-medium whitespace-nowrap">可用性</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">检测所选 CLI 是否可调用</p>
                </div>
                <span
                  className={cn(
                    "flex items-center gap-1.5 font-mono text-[11px]",
                    availability.isAvailable ? "text-status-running" : "text-status-idle",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      availability.isAvailable ? "bg-status-running" : "bg-status-idle",
                    )}
                    aria-hidden
                  />
                  {availability.detail}
                </span>
              </div>
            )}
          </RowGroup>
        </section>

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button variant="outline" onClick={onDone}>
            返回
          </Button>
          <Button
            disabled={
              appState.disabledAgents.size >= 2 ||
              appState.childBatchDraft.trim().length === 0 ||
              appState.childContextSummary.trim().length === 0 ||
              availability?.isAvailable !== true
            }
            onClick={() => void appState.delegateChildBatch()}
          >
            委派批次
          </Button>
        </div>

        {(summary?.batches ?? []).length > 0 && (
          <section className="mt-8">
            <SectionLabel>历史批次</SectionLabel>
            <RowGroup>
              {(summary?.batches ?? []).map((batch) => (
                <div key={batch.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="font-mono text-xs">
                    {batch.id.slice(0, 8)} · {batch.taskIDs.length} 任务
                  </span>
                  <span className="text-muted-foreground line-clamp-1 min-w-0 flex-1 text-xs">
                    {batch.contextSummary}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => void join(batch.id)}
                  >
                    Join
                  </Button>
                </div>
              ))}
            </RowGroup>
          </section>
        )}

        {joinSummary.length > 0 && (
          <section className="mt-8">
            <SectionLabel>{joinTimedOut ? "Join 摘要 · 部分（仍在运行）" : "Join 摘要"}</SectionLabel>
            <div className="bg-muted/40 rounded-xl p-4">
              <Markdown className="prose-xs">{joinSummary}</Markdown>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
