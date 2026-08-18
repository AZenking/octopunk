"use client";

// Attached block `sub-agent-execution` adapted: an attempt's execution
// timeline (from the task's audit events) + live log lines.

import { ArrowLeft, Clock, Cpu, Gauge } from "lucide-react";
import type { ChildTaskDTO, RelayEventDTO, TaskAttemptDTO } from "../../../shared/dtos";
import {
  attemptDurationMs,
  eventsToLogs,
  formatDuration,
  taskStatusToAgent,
  traceFromEvents,
  type LogLevel,
} from "@/lib/agentView";
import { StatusBadge } from "@/components/blocks/status-badge";
import { TraceTimeline } from "@/components/blocks/trace-timeline";
import { Markdown } from "@/components/Markdown";

const LOG_LEVEL_CHIP: Record<LogLevel, string> = {
  info: "bg-sky-500/15 text-status-info",
  debug: "bg-violet-500/15 text-status-debug",
  warn: "bg-amber-500/15 text-status-idle",
  error: "bg-red-500/15 text-status-error",
};

/** Lines containing markdown signals render as markdown; otherwise JSON coloring. */
const LOOKS_LIKE_MARKDOWN = /(``|`\S|\*\*|^#{1,6}\s|\n\s*[-*+] |\[[^\]]+\]\([^)]+\))/;

/** Subtle row tint for escalated lines. */
const LOG_ROW_TINT: Partial<Record<LogLevel, string>> = {
  warn: "border-l-2 border-l-amber-500/50 pl-1.5",
  error: "border-l-2 border-l-red-500/60 pl-1.5",
};

const JSON_TOKEN =
  /("(?:[^"\\]|\\.)*"\s*:)|("(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)|(\b(?:true|false|null)\b)|([{}[\],])/g;

const TOKEN_CLASS = [
  "text-status-info", // keys
  "text-status-running", // strings
  "text-status-idle", // numbers
  "text-status-debug", // booleans / null
  "text-muted-foreground/70", // punctuation
];

/** Regex-based JSON-ish coloring for log message bodies. */
function highlightContent(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(text.slice(lastIndex, index));
    const groupIndex = match.slice(1).findIndex((group) => group != null);
    nodes.push(
      <span key={key++} className={TOKEN_CLASS[groupIndex] ?? ""}>
        {match[0]}
      </span>,
    );
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

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

export function SubAgentExecution({
  task,
  attempt,
  events,
  onBack,
}: {
  task: ChildTaskDTO;
  attempt: TaskAttemptDTO;
  events: RelayEventDTO[];
  onBack: () => void;
}) {
  const taskEvents = events.filter((event) => event.taskID === task.id);
  const trace = traceFromEvents(taskEvents, attempt.id);
  const logs = eventsToLogs(taskEvents);
  const status = taskStatusToAgent(task.status);

  return (
    <div className="flex min-h-0 flex-col overflow-y-auto">
      <header className="border-border border-b px-8 py-6">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground mb-4 inline-flex cursor-pointer items-center gap-1.5 text-xs transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          返回 {task.title}
        </button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="text-foreground text-xl font-semibold">第 {attempt.number} 次执行</h1>
              <StatusBadge status={status} />
            </div>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{task.title}</p>
            <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="border-border bg-muted/40 rounded border px-1.5 py-0.5 font-mono text-[11px]">
                session {attempt.sessionID?.slice(0, 12) ?? "—"}
              </span>
              <span className="border-border bg-muted/40 rounded border px-1.5 py-0.5 font-mono text-[11px]">
                {task.agentKind} · {task.executionMode}
              </span>
              <span className="border-border bg-muted/40 rounded border px-1.5 py-0.5 font-mono text-[11px]">
                {task.branchName || "detached"}
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 px-8 py-6 lg:grid-cols-4">
        <Stat label="事件数" value={String(taskEvents.length)} icon={<Gauge className="size-3.5" />} />
        <Stat
          label="耗时"
          value={formatDuration(attemptDurationMs(attempt))}
          icon={<Clock className="size-3.5" />}
        />
        <Stat label="状态" value={attempt.status} icon={<Cpu className="size-3.5" />} />
        <Stat
          label="开始于"
          value={new Date(attempt.startedAt * 1000).toLocaleTimeString("en-GB", { hour12: false })}
          icon={<Clock className="size-3.5" />}
        />
      </div>

      <section className="px-8 pb-6">
        <h2 className="text-foreground mb-3 text-sm font-semibold">执行时间线</h2>
        <TraceTimeline trace={trace} />
      </section>

      <section className="px-8 pb-10">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-foreground text-sm font-semibold">审计日志</h2>
          <span className="text-muted-foreground font-mono text-xs">{logs.length} 条</span>
        </div>
        <div className="bg-card border-border max-h-96 overflow-y-auto rounded-xl border p-4 font-mono text-xs leading-relaxed">
          {logs.length === 0 && <p className="text-muted-foreground">暂无日志</p>}
          {logs.map((log, i) => (
            <div key={i} className={"flex gap-2.5 py-0.5 " + (LOG_ROW_TINT[log.level] ?? "")}>
              <span className="text-muted-foreground shrink-0">{log.time}</span>
              <span
                className={
                  "shrink-0 rounded px-1.5 py-px font-semibold uppercase " +
                  LOG_LEVEL_CHIP[log.level]
                }
              >
                {log.level}
              </span>
              {/^|\n/.test("") ? null : null}
              {LOOKS_LIKE_MARKDOWN.test(log.message) ? (
                <div className="min-w-0 flex-1 break-all">
                  <Markdown className="prose-p:my-0 prose-headings:mb-0.5 prose-headings:mt-1 prose-li:my-0 prose-code:text-[11px]">
                    {log.message}
                  </Markdown>
                </div>
              ) : (
                <span className="text-foreground/90 break-all">{highlightContent(log.message)}</span>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
