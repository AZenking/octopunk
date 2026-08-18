"use client";

// Attached block `agent-list` adapted: agents = the run's child tasks.

import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChildTaskDTO, RunSummaryDTO } from "../../../shared/dtos";
import { taskStatusToAgent } from "@/lib/agentView";
import { StatusBadge } from "@/components/blocks/status-badge";

export function AgentList({
  summary,
  activeTaskId,
  onSelectTask,
}: {
  summary: RunSummaryDTO;
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
}) {
  return (
    <section className="bg-background border-border flex min-h-0 w-80 shrink-0 flex-col overflow-hidden border-r">
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">任务列表</span>
        <span className="text-muted-foreground font-mono text-xs">{summary.tasks.length} 个</span>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-4">
        {summary.tasks.length === 0 && (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            暂无任务，点击工具栏的 + 委派子 Agent 任务
          </p>
        )}
        {summary.tasks.map((task: ChildTaskDTO) => {
          const active = task.id === activeTaskId;
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => onSelectTask(task.id)}
              className={cn(
                "group flex w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors",
                active
                  ? "border-primary/30 bg-muted"
                  : "border-transparent hover:border-border hover:bg-muted/50",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-sm font-medium">{task.title}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <StatusBadge status={taskStatusToAgent(task.status)} />
                  <span className="text-muted-foreground truncate font-mono text-xs">
                    {task.agentKind === "codex" ? "codex" : "claude"}·
                    {task.executionMode === "read_only" ? "RO" : "RW"}
                  </span>
                </div>
              </div>
              <ChevronRight
                className={cn(
                  "text-muted-foreground size-4 shrink-0 transition-transform",
                  active ? "translate-x-0" : "-translate-x-1 opacity-0 group-hover:translate-x-0 group-hover:opacity-100",
                )}
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}
