// Main shell following the attached block layout exactly:
// team-sidebar → agent-list → agent-detail ⇄ sub-agent-execution, plus
// settings and new-run pages — all wired to the live OctoPunk data.

import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, CircleStop, ListPlus, RotateCw, Trash2 } from "lucide-react";
import type {
  EventTailDTO,
  RelayEventDTO,
  RunSummaryDTO,
  TaskAttemptDTO,
  TeamRunSummaryDTO,
} from "../../../shared/dtos";
import { useAppState } from "@/appState";
import { TeamSidebar } from "@/components/blocks/team-sidebar";
import { SettingsSidebar } from "@/components/blocks/settings-sidebar";
import type { SettingsSection } from "@/features/settings/sections";
import { AgentList } from "@/components/blocks/agent-list";
import { AgentDetail } from "@/components/blocks/agent-detail";
import { SubAgentExecution } from "@/components/blocks/sub-agent-execution";
import { StatusDot } from "@/components/blocks/status-badge";
import { runStatusToAgent } from "@/lib/agentView";
import { SettingsView } from "@/features/settings/SettingsView";
import { StartForm } from "@/features/dashboard/StartForm";
import { BatchDelegatePanel } from "@/features/dashboard/BatchDelegatePanel";
import { ReviewCenterView } from "@/features/reviewCenter/ReviewCenterView";
import { WorkbenchView } from "@/features/workbench/WorkbenchView";
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
import { SidebarProvider } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Page = "run" | "new-run" | "delegate" | "settings" | "review-center" | "workbench";

const TOOLBAR_BUTTON =
  "border-border text-muted-foreground hover:bg-muted hover:text-foreground app-no-drag flex size-7 cursor-pointer items-center justify-center rounded-md border transition-colors";

const EMPTY_SUMMARY: RunSummaryDTO = {
  run: {
    id: "",
    repositoryPath: "",
    task: "加载中…",
    baselineCommit: "",
    targetBranch: "",
    status: "running",
    currentReviewRound: 0,
    maxReviewRounds: 0,
    revision: 0,
    priority: 0,
    pausedAt: null,
    createdAt: 0,
    updatedAt: 0,
  },
  batches: [],
  tasks: [],
  dependencies: [],
  treeDepth: {},
};

export function TeamDashboardView() {
  const appState = useAppState();
  const [page, setPage] = useState<Page>("run");
  // Remembers the last-open settings section across exits (while mounted).
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeAttemptId, setActiveAttemptId] = useState<string | null>(null);
  const [reviewSummary, setReviewSummary] = useState("");
  const [summary, setSummary] = useState<RunSummaryDTO | null>(null);
  const [events, setEvents] = useState<RelayEventDTO[]>([]);
  const [attempts, setAttempts] = useState<TaskAttemptDTO[]>([]);
  const [runPendingCancellation, setRunPendingCancellation] = useState<TeamRunSummaryDTO | null>(null);
  const [runPendingDiscard, setRunPendingDiscard] = useState<TeamRunSummaryDTO | null>(null);
  const [discardTaskID, setDiscardTaskID] = useState<string | null>(null);

  const runID = appState.selectedRunID;

  const runSummary = useMemo(
    () => appState.runs.find((run) => run.id === runID) ?? null,
    [appState.runs, runID],
  );
  const cancellable =
    runSummary != null && ["ready", "running", "reviewing", "awaiting_final_review"].includes(runSummary.status);
  const terminal =
    runSummary != null && ["completed", "blocked", "cancelled", "failed"].includes(runSummary.status);
  const archived = runSummary?.archivedAt != null;

  // Live run summary + audit tail for the selected run.
  useEffect(() => {
    setSummary(null);
    setEvents([]);
    setAttempts([]);
    setActiveTaskId(null);
    setActiveAttemptId(null);
    if (runID == null) return;
    const unsubscribeSummary = window.octopunk.subscribe("run:summary", (payload) => {
      const change = payload as { runID: string; summary: RunSummaryDTO };
      if (change.runID !== runID) return;
      setSummary(change.summary);
    });
    const unsubscribeTail = window.octopunk.subscribe("run:event-tail", (payload) => {
      const change = payload as { runID: string; tail: EventTailDTO };
      if (change.runID !== runID) return;
      setEvents((current) => {
        const windowStart = change.tail.events[0]?.sequence;
        if (windowStart == null) return current;
        return [...current.filter((event) => event.sequence < windowStart), ...change.tail.events];
      });
    });
    // Subscribe BEFORE observing: the main process pumps the initial summary
    // as soon as run:observe arrives.
    window.octopunk.observeRun(runID);
    return () => {
      window.octopunk.unobserveRun(runID);
      unsubscribeSummary();
      unsubscribeTail();
    };
  }, [runID]);

  // Attempts arrive with the full status snapshot (one call per task change).
  const taskSignature = useMemo(
    () => (summary ? summary.tasks.map((task) => task.status).join(",") : ""),
    [summary],
  );
  useEffect(() => {
    if (runID == null) return;
    void window.octopunk
      .invoke<{ attempts: TaskAttemptDTO[] }>("queries:status", { runID })
      .then((status) => setAttempts(status.attempts))
      .catch(() => {});
  }, [runID, taskSignature]);

  const activeTask = useMemo(
    () => summary?.tasks.find((task) => task.id === activeTaskId) ?? null,
    [summary, activeTaskId],
  );
  const activeAttempt = useMemo(
    () => attempts.find((attempt) => attempt.id === activeAttemptId) ?? null,
    [attempts, activeAttemptId],
  );

  const review = async (action: "accept" | "rework" | "block") => {
    if (runID == null || activeTask == null) return;
    try {
      await window.octopunk.invoke("team:review", {
        action,
        runID,
        taskID: activeTask.id,
        summary: reviewSummary,
      });
      setReviewSummary("");
    } catch (error) {
      appState.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const taskAction = async (channel: "team:cancel-task" | "team:resume-task") => {
    if (runID == null || activeTask == null) return;
    try {
      await window.octopunk.invoke(channel, { runID, taskID: activeTask.id });
    } catch (error) {
      appState.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <SidebarProvider>
      <main className="bg-background flex h-dvh w-full overflow-hidden">
        {page === "settings" ? (
          <SettingsSidebar
            active={settingsSection}
            onSelect={setSettingsSection}
            onExit={() => setPage("run")}
          />
        ) : (
          <TeamSidebar
            runs={appState.runs}
            activeRunId={runID}
            onSelectRun={(id) => {
              appState.setSelectedRunID(id);
              setPage("run");
            }}
            onNewRun={() => {
              appState.setSelectedRunID(null);
              setPage("new-run");
            }}
            onOpenWorkbench={() => setPage("workbench")}
            workbenchActive={page === "workbench"}
            onOpenReviewCenter={() => setPage("review-center")}
            reviewActive={page === "review-center"}
            onOpenSettings={() => setPage("settings")}
            onCancelRun={(run) => setRunPendingCancellation(run)}
            onDeleteRun={(run) => setRunPendingDiscard(run)}
            onArchiveRun={(run) => void appState.archiveRun(run.id)}
            onRestoreRun={(run) => void appState.unarchiveRun(run.id)}
          />
        )}

        {page === "settings" ? (
          <div className="flex-1 overflow-y-auto">
            <SettingsView section={settingsSection} />
          </div>
        ) : page === "review-center" ? (
          <ReviewCenterView />
        ) : page === "workbench" ? (
          <WorkbenchView
            onSelectRun={(id) => {
              appState.setSelectedRunID(id);
              setPage("run");
            }}
          />
        ) : page === "new-run" || runID == null ? (
          <div className="flex-1 overflow-y-auto">
            <StartForm onStarted={() => setPage("run")} />
          </div>
        ) : page === "delegate" ? (
          <div className="flex-1 overflow-y-auto">
            <BatchDelegatePanel summary={summary} onDone={() => setPage("run")} />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="border-border app-drag bg-background flex h-11 shrink-0 items-center gap-3 border-b px-3">
              <span className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm">
                <StatusDot status={runStatusToAgent(runSummary?.status ?? "running")} pulse={false} />
                <span className="text-foreground truncate font-medium">{runSummary?.task ?? "加载中…"}</span>
                {runSummary != null && (
                  <span className="shrink-0 font-mono text-xs">
                    {runSummary.acceptedTaskCount}/{runSummary.taskCount}
                  </span>
                )}
              </span>
              {appState.migrationMessage != null && (
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                  {appState.migrationMessage}
                </span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {!terminal && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="委派任务"
                        onClick={() => setPage("delegate")}
                        className={TOOLBAR_BUTTON}
                      >
                        <ListPlus className="size-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">委派任务批次（父任务/依赖/多任务）</TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="刷新"
                      onClick={() => void appState.refresh()}
                      className={TOOLBAR_BUTTON}
                    >
                      <RotateCw className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">刷新运行列表与 Agent 可用性</TooltipContent>
                </Tooltip>
                {cancellable && runSummary != null && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="强制取消"
                        onClick={() => setRunPendingCancellation(runSummary)}
                        className={TOOLBAR_BUTTON}
                      >
                        <CircleStop className="size-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">强制取消 TeamRun（停止所有子 Agent）</TooltipContent>
                  </Tooltip>
                )}
                {terminal && runSummary != null && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={archived ? "恢复" : "归档"}
                        onClick={() =>
                          void (archived
                            ? appState.unarchiveRun(runSummary.id)
                            : appState.archiveRun(runSummary.id))
                        }
                        className={TOOLBAR_BUTTON}
                      >
                        {archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {archived ? "从归档恢复到活动列表" : "归档 TeamRun（可随时恢复）"}
                    </TooltipContent>
                  </Tooltip>
                )}
                {terminal && runSummary != null && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="删除"
                        onClick={() => setRunPendingDiscard(runSummary)}
                        className={cn(TOOLBAR_BUTTON, "hover:text-status-error")}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">删除 TeamRun（清理工作区，审计记录保留）</TooltipContent>
                  </Tooltip>
                )}
              </span>
            </header>
            <div className="flex min-h-0 flex-1">
              <AgentList
                summary={summary ?? EMPTY_SUMMARY}
                activeTaskId={activeTaskId}
                onSelectTask={(id) => {
                  setActiveTaskId(id);
                  setActiveAttemptId(null);
                }}
              />
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {summary == null ? null : activeTask != null && activeAttempt != null ? (
                  <SubAgentExecution
                    task={activeTask}
                    attempt={activeAttempt}
                    events={events}
                    onBack={() => setActiveAttemptId(null)}
                  />
                ) : activeTask != null ? (
                  <AgentDetail
                    task={activeTask}
                    attempts={attempts.filter((attempt) => attempt.taskID === activeTask.id)}
                    reviewSummary={reviewSummary}
                    onReviewSummaryChange={setReviewSummary}
                    onAccept={() => void review("accept")}
                    onRework={() => void review("rework")}
                    onBlock={() => void review("block")}
                    onResume={() => void taskAction("team:resume-task")}
                    onCancel={() => void taskAction("team:cancel-task")}
                    onDiscard={() => setDiscardTaskID(activeTask.id)}
                    onSelectAttempt={(attemptID) => setActiveAttemptId(attemptID)}
                  />
                ) : (
                  <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-sm">
                    从左侧选择一个任务查看详情
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <AlertDialog
          open={appState.errorMessage != null}
          onOpenChange={(open) => {
            if (!open) appState.setErrorMessage(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>OctoPunk</AlertDialogTitle>
              <AlertDialogDescription>{appState.errorMessage ?? ""}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>OK</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={runPendingCancellation != null}
          onOpenChange={(open) => {
            if (!open) setRunPendingCancellation(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>强制取消 TeamRun？</AlertDialogTitle>
              <AlertDialogDescription>
                将停止「{runPendingCancellation?.task}」的所有子 Agent 并标记为 cancelled。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>继续运行</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => {
                  const run = runPendingCancellation;
                  setRunPendingCancellation(null);
                  if (run) void appState.cancelTeam(run.id);
                }}
              >
                强制取消
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={runPendingDiscard != null}
          onOpenChange={(open) => {
            if (!open) setRunPendingDiscard(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除 TeamRun？</AlertDialogTitle>
              <AlertDialogDescription>
                将「{runPendingDiscard?.task}」移出列表并永久删除 worktree 与临时分支；审计记录保留在数据库。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => {
                  const run = runPendingDiscard;
                  setRunPendingDiscard(null);
                  if (run) void appState.deleteRun(run.id);
                }}
              >
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={discardTaskID != null}
          onOpenChange={(open) => {
            if (!open) setDiscardTaskID(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>丢弃任务 worktree？</AlertDialogTitle>
              <AlertDialogDescription>
                移除该任务的独立 worktree 与临时分支；共享只读基线保留至 TeamRun 清理。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => {
                  const taskID = discardTaskID;
                  setDiscardTaskID(null);
                  if (taskID == null || runID == null) return;
                  void window.octopunk
                    .invoke("team:discard-task", { runID, taskID })
                    .then(() => {
                      appState.setMigrationMessage(
                        `已丢弃任务 ${taskID.slice(0, 8)}：worktree 与临时分支已移除。`,
                      );
                      window.setTimeout(() => appState.setMigrationMessage(null), 5000);
                      if (activeTaskId === taskID) {
                        setActiveTaskId(null);
                        setActiveAttemptId(null);
                      }
                      void appState.refreshSelectedRun();
                    })
                    .catch((error) => {
                      appState.setErrorMessage(error instanceof Error ? error.message : String(error));
                    });
                }}
              >
                丢弃
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </main>
    </SidebarProvider>
  );
}
