// Per-agent brand tile: one glance tells Claude Code from Codex, and the
// mode ring tells read-only from workspace-write (not color-only: labels
// travel with the UI elsewhere).

import { Bot, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";

const MARKS: Record<string, { tile: string; icon: typeof Bot; label: string }> = {
  claude_code: {
    tile: "bg-status-idle/10 text-status-idle ring-status-idle/30",
    icon: Bot,
    label: "Claude Code",
  },
  codex: {
    tile: "bg-status-running/10 text-status-running ring-emerald-400/25",
    icon: Terminal,
    label: "Codex",
  },
};

export function AgentMark({
  agentKind,
  size = "md",
  className,
}: {
  agentKind: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const mark = MARKS[agentKind] ?? {
    tile: "bg-secondary text-muted-foreground ring-border",
    icon: Bot,
    label: agentKind,
  };
  const Icon = mark.icon;
  return (
    <div
      title={mark.label}
      className={cn(
        "ring-inset flex shrink-0 items-center justify-center rounded-lg ring-1",
        mark.tile,
        size === "sm" && "size-6 rounded-md",
        size === "md" && "size-8",
        size === "lg" && "size-10",
        className,
      )}
      aria-hidden
    >
      <Icon className={size === "sm" ? "size-3.5" : size === "lg" ? "size-5" : "size-4"} />
    </div>
  );
}

export function agentLabel(agentKind: string): string {
  return MARKS[agentKind]?.label ?? agentKind;
}
