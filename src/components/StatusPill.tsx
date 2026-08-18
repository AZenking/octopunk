// Shared status pill: colored dot + label, readable without relying on
// color alone (constitution VI, accessibility).

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  completed: { dot: "bg-status-running", label: "text-status-running" },
  accepted: { dot: "bg-status-running", label: "text-status-running" },
  awaiting_report: { dot: "bg-sky-400", label: "text-status-info" },
  awaiting_final_review: { dot: "bg-sky-400", label: "text-status-info" },
  running: { dot: "bg-status-info", label: "text-status-info" },
  reviewing: { dot: "bg-status-debug", label: "text-status-debug" },
  rework_required: { dot: "bg-status-idle", label: "text-status-idle" },
  queued: { dot: "bg-status-offline", label: "text-muted-foreground" },
  ready: { dot: "bg-status-offline", label: "text-muted-foreground" },
  blocked: { dot: "bg-red-400", label: "text-status-error" },
  failed: { dot: "bg-red-400", label: "text-status-error" },
  cancelled: { dot: "bg-status-offline", label: "text-muted-foreground" },
};

export function StatusPill({ status, className }: { status: string; className?: string }) {
  const style = STATUS_STYLES[status] ?? {
    dot: "bg-status-offline",
    label: "text-muted-foreground",
  };
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 border-transparent bg-secondary/60 px-2 py-0.5 font-mono text-[11px]", style.label, className)}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", style.dot)} aria-hidden />
      {status}
      <span className="sr-only">status: {status}</span>
    </Badge>
  );
}
