"use client";

// Attached block `agent-detail` adapted: agent = child task, its "sub agents"
// are the task's execution attempts (drill into the execution view).

import { Activity, ChevronRight, CircleStop, Clock, Cpu, GitBranch, RotateCw, Trash2 } from "lucide-react";
import type { ChildTaskDTO, TaskAttemptDTO } from "../../../shared/dtos";
import { attemptDurationMs, formatDuration, taskStatusToAgent } from "@/lib/agentView";
import { StatusBadge, StatusDot } from "@/components/blocks/status-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/Markdown";

const ATTEMPT_STATUS_LABEL: Record<string, string> = {
  running: "执行中",
  reported: "已上报",
  failed: "失败",
  cancelled: "已取消",
};

function Stat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="bg-card border-border rounded-lg border p-4">
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {icon}
        {label}
      </div>
      <p className="text-foreground mt-2 truncate font-mono text-2xl font-semibold">{value}</p>
    </div>
  );
}

export function AgentDetail({
  task,
  attempts,
  reviewSummary,
  onReviewSummaryChange,
  onAccept,
  onRework,
  onBlock,
  onResume,
  onCancel,
  onDiscard,
  onSelectAttempt,
}: {
  task: ChildTaskDTO;
  attempts: TaskAttemptDTO[];
  reviewSummary: string;
  onReviewSummaryChange: (value: string) => void;
  onAccept: () => void;
  onRework: () => void;
  onBlock: () => void;
  onResume: () => void;
  onCancel: () => void;
  onDiscard: () => void;
  onSelectAttempt: (attemptID: string) => void;
}) {
  const status = taskStatusToAgent(task.status);
  const reviewable = task.status === "awaiting_report" || task.status === "rework_required";
  const resumable = ["blocked", "failed", "cancelled"].includes(task.status);
  const cancellable = task.status !== "accepted" && task.status !== "cancelled";

  return (
    <div className="flex min-h-0 flex-col overflow-y-auto">
      <header className="border-border border-b px-8 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="text-foreground text-xl font-semibold">{task.title}</h1>
              <StatusBadge status={status} />
            </div>
            <p className="text-muted-foreground mt-2 line-clamp-2 max-w-xl text-sm leading-relaxed">
              {task.contextSnapshot || task.title}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {resumable && (
              <Button variant="outline" size="sm" onClick={onResume}>
                <RotateCw className="size-4" />
                恢复
              </Button>
            )}
            {cancellable && (
              <Button
                variant="outline"
                size="sm"
                onClick={onCancel}
                title="停止该任务；worktree 保留以便恢复"
              >
                <CircleStop className="size-4" />
                停止任务
              </Button>
            )}
            {task.status !== "accepted" && (
              <Button variant="outline" size="icon" aria-label="Discard worktree" onClick={onDiscard}>
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 px-8 py-6 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="执行次数" value={String(attempts.length)} icon={<Activity className="size-3.5" />} />
        <Stat label="审查轮次" value={String(task.reviewRound)} icon={<GitBranch className="size-3.5" />} />
        <Stat
          label="Agent / 模式"
          value={`${task.agentKind === "codex" ? "codex" : task.agentKind === "pi" ? "pi" : "claude"}·${task.executionMode === "read_only" ? "RO" : "RW"}`}
          icon={<Clock className="size-3.5" />}
        />
        <Stat label="模型" value={task.model ?? "全局覆盖"} icon={<Cpu className="size-3.5" />} />
      </div>

      {(reviewable || cancellable) && (
        <section className="px-8 pb-6">
          <Textarea
            value={reviewSummary}
            onChange={(event) => onReviewSummaryChange(event.target.value)}
            placeholder="Codex 审查摘要（accept / rework / block 共用）"
            className="min-h-[56px]"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" disabled={!reviewable} onClick={onAccept}>
              Accept PASS
            </Button>
            <Button size="sm" variant="outline" disabled={!reviewable} onClick={onRework}>
              Request REWORK
            </Button>
            <Button size="sm" variant="outline" disabled={!cancellable} onClick={onBlock}>
              BLOCK
            </Button>
          </div>
        </section>
      )}

      {task.latestReport != null && (
        <section className="px-8 pb-6">
          <h2 className="text-foreground mb-3 text-sm font-semibold">Agent 报告</h2>
          <div className="bg-primary/5 border-primary/15 rounded-xl border p-4">
            <Markdown>{task.latestReport}</Markdown>
          </div>
        </section>
      )}

      <section className="px-8 pb-10">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-foreground text-sm font-semibold">执行记录（Attempt）</h2>
            <span className="text-muted-foreground font-mono text-xs">{attempts.length} 个</span>
          </div>
        </div>

        <div className="border-border overflow-hidden rounded-xl border">
          {attempts.length === 0 && (
            <p className="text-muted-foreground px-4 py-6 text-center text-xs">尚无执行记录</p>
          )}
          {attempts
            .slice()
            .reverse()
            .map((attempt, index, list) => (
              <button
                key={attempt.id}
                type="button"
                onClick={() => onSelectAttempt(attempt.id)}
                className={
                  "hover:bg-muted/40 border-border flex w-full cursor-pointer items-center gap-4 px-4 py-3.5 text-left transition-colors" +
                  (index !== list.length - 1 ? " border-b" : "")
                }
              >
                <div className="bg-muted/40 border-border flex size-9 shrink-0 items-center justify-center rounded-lg border">
                  <StatusDot
                    status={
                      attempt.status === "running"
                        ? "running"
                        : attempt.status === "failed"
                          ? "error"
                          : attempt.status === "reported"
                            ? "idle"
                            : "offline"
                    }
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-foreground truncate text-sm font-medium">
                      第 {attempt.number} 次执行
                    </p>
                    <span className="border-border bg-muted/40 text-muted-foreground rounded border px-1.5 py-0.5 font-mono text-[11px]">
                      {ATTEMPT_STATUS_LABEL[attempt.status] ?? attempt.status}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
                    {attempt.sessionID ?? "—"}
                  </p>
                </div>
                <span className="text-muted-foreground shrink-0 font-mono text-xs">
                  {formatDuration(attemptDurationMs(attempt))}
                </span>
                <ChevronRight className="text-muted-foreground size-4 shrink-0" />
              </button>
            ))}
        </div>
      </section>
    </div>
  );
}
