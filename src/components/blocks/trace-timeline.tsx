"use client";

// Attached block `trace-timeline` ported verbatim: swimlane trace with
// Duration / Turns / Calls view modes, search dimming, failed-event rings.

import { useMemo, useState } from "react";
import { Clock, Hash, Layers, Search } from "lucide-react";
import {
  type SubAgentTrace,
  type TraceEvent,
  type TraceLane,
  TRACE_LANE_BG,
  TRACE_LANE_LABEL,
} from "@/lib/agentView";

type ViewMode = "duration" | "turns" | "calls";

const LANES: TraceLane[] = ["input", "model", "tool"];

const MODES: { id: ViewMode; label: string; icon: React.ReactNode }[] = [
  { id: "duration", label: "Duration", icon: <Clock className="size-3.5" /> },
  { id: "turns", label: "Turns", icon: <Layers className="size-3.5" /> },
  { id: "calls", label: "Calls", icon: <Hash className="size-3.5" /> },
];

function formatDuration(ms: number) {
  if (ms <= 0) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// 计算某个事件在当前视图下的 left / width 百分比
function getGeometry(
  event: TraceEvent,
  mode: ViewMode,
  trace: SubAgentTrace,
  laneEvents: TraceEvent[],
): { left: number; width: number } {
  if (mode === "duration") {
    const total = trace.totalMs || 1;
    return { left: (event.startMs / total) * 100, width: Math.max((event.durationMs / total) * 100, 1.2) };
  }
  if (mode === "turns") {
    const colW = 100 / Math.max(trace.turns, 1);
    const idxInTurn = laneEvents.filter((e) => e.turn === event.turn).indexOf(event);
    const countInTurn = laneEvents.filter((e) => e.turn === event.turn).length;
    const sub = colW / Math.max(countInTurn, 1);
    return { left: (event.turn - 1) * colW + idxInTurn * sub + 0.4, width: Math.max(sub - 0.8, 1) };
  }
  // calls：同一泳道内按顺序等宽排布
  const n = Math.max(laneEvents.length, 1);
  const w = 100 / n;
  const index = laneEvents.indexOf(event);
  return { left: index * w + 0.4, width: Math.max(w - 0.8, 1) };
}

export function TraceTimeline({ trace }: { trace: SubAgentTrace }) {
  const [mode, setMode] = useState<ViewMode>("duration");
  const [query, setQuery] = useState("");

  const eventsByLane = useMemo(() => {
    const map: Record<TraceLane, TraceEvent[]> = { input: [], model: [], tool: [] };
    for (const e of trace.events) map[e.lane].push(e);
    for (const lane of LANES) map[lane].sort((a, b) => a.startMs - b.startMs);
    return map;
  }, [trace]);

  const q = query.trim().toLowerCase();

  if (trace.events.length === 0) {
    return (
      <div className="bg-card border-border rounded-xl border px-4 py-10 text-center text-sm text-muted-foreground">
        该子 Agent 暂无执行轨迹
      </div>
    );
  }

  const ticks = mode === "duration" ? 5 : trace.turns;

  return (
    <div className="bg-card border-border overflow-hidden rounded-xl border">
      {/* 工具栏 */}
      <div className="border-border flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2.5">
        <div className="flex items-center gap-1">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={
                "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors " +
                (mode === m.id
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")
              }
            >
              {m.icon}
              {m.label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索事件"
            className="border-border bg-background text-foreground placeholder:text-muted-foreground focus:ring-ring/40 h-8 w-44 rounded-md border pr-2 pl-8 text-xs outline-none focus:ring-2"
          />
        </div>
      </div>

      {/* 泳道 */}
      <div className="px-3 py-3">
        {LANES.map((lane) => {
          const laneEvents = eventsByLane[lane];
          return (
            <div key={lane} className="flex items-center gap-3 py-1.5">
              <div className="flex w-14 shrink-0 items-center gap-1.5">
                <span className={"rounded-[3px] size-2 " + TRACE_LANE_BG[lane]} aria-hidden />
                <span className="text-muted-foreground text-xs">{TRACE_LANE_LABEL[lane]}</span>
              </div>
              <div className="bg-muted/40 relative h-7 flex-1 rounded-md">
                {laneEvents.map((event) => {
                  const { left, width } = getGeometry(event, mode, trace, laneEvents);
                  const dim = q.length > 0 && !event.label.toLowerCase().includes(q);
                  return (
                    <div
                      key={event.id}
                      title={`${TRACE_LANE_LABEL[lane]} · ${event.label} · ${formatDuration(event.durationMs)}`}
                      className={
                        "group absolute top-1/2 flex h-5 -translate-y-1/2 items-center overflow-hidden rounded-[4px] px-1.5 text-[10px] font-medium text-white transition-opacity " +
                        TRACE_LANE_BG[lane] +
                        (event.failed ? " ring-status-error ring-card ring-2 ring-offset-1" : "") +
                        (dim ? " opacity-20" : " hover:brightness-110 opacity-100")
                      }
                      style={{ left: `${left}%`, width: `${width}%` }}
                    >
                      <span className="truncate">{event.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* 轴刻度 */}
        <div className="mt-2 flex items-center gap-3">
          <div className="w-14 shrink-0" aria-hidden />
          <div className="text-muted-foreground flex flex-1 justify-between font-mono text-[10px]">
            {Array.from({ length: ticks + 1 }).map((_, i) => (
              <span key={i}>
                {mode === "duration"
                  ? formatDuration(Math.round((trace.totalMs / ticks) * i))
                  : i === 0
                    ? ""
                    : `#${i}`}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 图例 */}
      <div className="border-border text-muted-foreground flex items-center gap-4 border-t px-3 py-2.5 text-xs">
        {LANES.map((lane) => (
          <span key={lane} className="inline-flex items-center gap-1.5">
            <span className={"rounded-[3px] size-2.5 " + TRACE_LANE_BG[lane]} aria-hidden />
            {TRACE_LANE_LABEL[lane]}
          </span>
        ))}
        <span className="ml-auto font-mono">
          {trace.turns} turns · {trace.events.length} calls · {formatDuration(trace.totalMs)}
        </span>
      </div>
    </div>
  );
}
