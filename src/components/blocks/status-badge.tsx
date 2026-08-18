"use client";

import { cn } from "@/lib/utils";
import { STATUS_DOT, STATUS_LABEL, STATUS_TEXT, type AgentStatus } from "@/lib/agentView";

export function StatusDot({ status, pulse = true }: { status: AgentStatus; pulse?: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0">
      {pulse && status === "running" && (
        <span
          className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", STATUS_DOT[status])}
        />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", STATUS_DOT[status])} />
    </span>
  );
}

export function StatusBadge({ status, className }: { status: AgentStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs",
        STATUS_TEXT[status],
        className,
      )}
    >
      <StatusDot status={status} />
      {STATUS_LABEL[status]}
      <span className="sr-only">({status})</span>
    </span>
  );
}
