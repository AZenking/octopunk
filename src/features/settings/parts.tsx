// Shared building blocks for the settings detail pages: row layout with
// title/description + right control, section labels, and small helpers.

import { Info } from "lucide-react";
import type { AvailabilityPayload } from "../../../shared/ipc";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function Row({
  title,
  desc,
  hint,
  meta,
  control,
}: {
  title: string;
  desc?: string;
  hint?: string;
  meta?: React.ReactNode;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-4">
      <div className="flex min-w-0 items-center gap-1.5">
        <p className="text-foreground text-sm font-medium whitespace-nowrap">{title}</p>
        {desc != null && (
          <p className="text-muted-foreground min-w-0 truncate text-xs">{desc}</p>
        )}
        {hint != null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="text-muted-foreground/60 hover:text-muted-foreground cursor-help">
                <Info className="size-3.5" aria-hidden />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-72 text-xs leading-relaxed">
              {hint}
            </TooltipContent>
          </Tooltip>
        )}
        {meta != null && <div className="ml-1 shrink-0">{meta}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-muted-foreground mb-1 text-sm font-semibold tracking-wider uppercase">
      {children}
    </h2>
  );
}

export function RowGroup({ children }: { children: React.ReactNode }) {
  return <div className="border-border divide-border divide-y rounded-xl border">{children}</div>;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function AvailabilityMeta({ result }: { result: AvailabilityPayload | null }) {
  if (result == null) return null;
  return (
    <span
      className={cn(
        "block max-w-44 truncate font-mono text-[11px]",
        result.isAvailable ? "text-status-running" : "text-status-idle",
      )}
      title={result.detail}
    >
      {result.detail}
    </span>
  );
}
