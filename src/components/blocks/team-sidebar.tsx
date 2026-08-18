"use client";

// Attached block `team-sidebar` adapted: teams = TeamRuns.

import { useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, Bot, ChevronDown, ChevronRight, ClipboardCheck, Plus, Settings, Users } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { TeamRunSummaryDTO } from "../../../shared/dtos";
import { runStatusToAgent } from "@/lib/agentView";
import { StatusDot } from "@/components/blocks/status-badge";

const TERMINAL_STATUSES = ["completed", "blocked", "cancelled", "failed"];

function RunRow({
  run,
  active,
  onSelect,
  actions,
  wideActions,
}: {
  run: TeamRunSummaryDTO;
  active: boolean;
  onSelect: (id: string) => void;
  actions: ReactNode;
  wideActions?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(run.id)}
      className={cn(
        "group relative flex w-full cursor-pointer flex-col gap-1 rounded-lg px-3 py-2.5 pr-9 text-left transition-colors app-no-drag",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
        run.archivedAt != null && "opacity-70",
        wideActions && "pr-16",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{run.task}</span>
        <span className="text-muted-foreground shrink-0 font-mono text-xs">
          {run.acceptedTaskCount}/{run.taskCount}
        </span>
      </span>
      <span className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs">
        <StatusDot status={runStatusToAgent(run.status)} pulse={false} />
        {run.status}
      </span>
      {actions}
    </button>
  );
}

function RowAction({
  label,
  onActivate,
  children,
}: {
  label: string;
  onActivate: () => void;
  children: ReactNode;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onActivate();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.stopPropagation();
          onActivate();
        }
      }}
      className="text-muted-foreground hover:text-status-error grid size-6 cursor-pointer place-items-center rounded-md text-xs"
    >
      {children}
    </span>
  );
}

function actionCluster(actions: ReactNode): ReactNode {
  return (
    <span className="text-muted-foreground absolute top-2 right-2 flex cursor-pointer items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      {actions}
    </span>
  );
}

export function TeamSidebar({
  runs,
  activeRunId,
  onSelectRun,
  onNewRun,
  onOpenReviewCenter,
  reviewActive = false,
  onOpenSettings,
  onCancelRun,
  onDeleteRun,
  onArchiveRun,
  onRestoreRun,
}: {
  runs: TeamRunSummaryDTO[];
  activeRunId: string | null;
  onSelectRun: (id: string) => void;
  onNewRun: () => void;
  onOpenReviewCenter: () => void;
  reviewActive?: boolean;
  onOpenSettings: () => void;
  onCancelRun: (run: TeamRunSummaryDTO) => void;
  onDeleteRun: (run: TeamRunSummaryDTO) => void;
  onArchiveRun: (run: TeamRunSummaryDTO) => void;
  onRestoreRun: (run: TeamRunSummaryDTO) => void;
}) {
  const [archiveOpen, setArchiveOpen] = useState(false);
  // "Unarchived" = the sidebar's main section; several of these may be
  // concurrently active now that each MCP session owns its own run.
  const unarchivedRuns = runs.filter((run) => run.archivedAt == null);
  const archivedRuns = runs.filter((run) => run.archivedAt != null);

  return (
    <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border app-drag flex h-full w-64 shrink-0 flex-col border-r">
      <div className="flex items-center gap-2.5 px-4 pb-4 pt-11">
        <div className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-md">
          <Bot className="size-4.5" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold">OctoPunk</p>
          <p className="text-muted-foreground font-mono text-xs">Git Agent Team</p>
        </div>
      </div>

      <div className="flex items-center justify-between px-4 pt-2 pb-2">
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wider uppercase">
          <Users className="size-3.5" />
          TeamRun
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="新建 TeamRun"
              onClick={onNewRun}
              className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground app-no-drag flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors"
            >
              <Plus className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">新建 TeamRun（锚定 Git 基线）</TooltipContent>
        </Tooltip>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-1">
        {runs.length === 0 && (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            还没有运行记录，点击 + 新建 TeamRun
          </p>
        )}
        {unarchivedRuns.map((run) => {
          const active = run.id === activeRunId;
          const terminal = TERMINAL_STATUSES.includes(run.status);
          const actions = terminal
            ? actionCluster(
                <>
                  <RowAction label="归档" onActivate={() => onArchiveRun(run)}>
                    <Archive className="size-3.5" />
                  </RowAction>
                  <RowAction label="删除" onActivate={() => onDeleteRun(run)}>
                    ⌫
                  </RowAction>
                </>,
              )
            : actionCluster(
                <RowAction label="强制取消" onActivate={() => onCancelRun(run)}>
                  ✕
                </RowAction>,
              );
          return (
            <RunRow
              key={run.id}
              run={run}
              active={active}
              onSelect={onSelectRun}
              actions={actions}
              wideActions={terminal}
            />
          );
        })}

        {archivedRuns.length > 0 && (
          <div className="border-sidebar-border mt-3 border-t pt-2">
            <button
              type="button"
              onClick={() => setArchiveOpen((open) => !open)}
              className="text-muted-foreground hover:text-sidebar-foreground app-no-drag flex w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium tracking-wider uppercase"
            >
              {archiveOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              <Archive className="size-3.5" />
              已归档
              <span className="font-mono">{archivedRuns.length}</span>
            </button>
            {archiveOpen &&
              archivedRuns.map((run) => {
                const active = run.id === activeRunId;
                return (
                  <RunRow
                    key={run.id}
                    run={run}
                    active={active}
                    onSelect={onSelectRun}
                    wideActions
                    actions={actionCluster(
                      <>
                        <RowAction label="恢复" onActivate={() => onRestoreRun(run)}>
                          <ArchiveRestore className="size-3.5" />
                        </RowAction>
                        <RowAction label="删除" onActivate={() => onDeleteRun(run)}>
                          ⌫
                        </RowAction>
                      </>,
                    )}
                  />
                );
              })}
          </div>
        )}
      </nav>

      <div className="border-sidebar-border space-y-0.5 border-t p-2">
        <button
          type="button"
          onClick={onOpenReviewCenter}
          className={cn(
            "app-no-drag flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
            reviewActive
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
          )}
        >
          <ClipboardCheck className="size-4" />
          审查中心
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground app-no-drag flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors"
        >
          <Settings className="size-4" />
          设置
        </button>
      </div>
    </aside>
  );
}
