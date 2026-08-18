// Transport indicator: dot + text keep the state readable without relying
// on color alone (constitution VI, accessibility).

import { Cable, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function HTTPStatusBadge({ isRunning }: { isRunning: boolean }) {
  const label = isRunning ? "HTTP MCP on" : "STDIO";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={
            isRunning
              ? "gap-1.5 border-transparent bg-secondary/60 font-mono text-[11px] text-status-running"
              : "gap-1.5 border-transparent bg-secondary/60 font-mono text-[11px] text-muted-foreground"
          }
        >
          {isRunning ? (
            <span className="relative flex size-1.5" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-status-running opacity-60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-status-running" />
            </span>
          ) : (
            <span className="size-1.5 rounded-full bg-slate-400" aria-hidden />
          )}
          {label}
          <span className="sr-only">
            {isRunning ? "Optional HTTP MCP is running" : "Using local STDIO transport"}
          </span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="right">
        {isRunning ? "Optional HTTP MCP listening on 127.0.0.1:51931" : "Default transport: local STDIO"}
      </TooltipContent>
    </Tooltip>
  );
}
