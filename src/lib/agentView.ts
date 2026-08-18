// View-model mapping: OctoPunk domain DTOs → the attached block structure.
// Team=TeamRun, Agent=ChildTask, SubAgent=TaskAttempt.

import type { RelayEventDTO, TaskAttemptDTO } from "../../shared/dtos";

export type AgentStatus = "running" | "idle" | "error" | "offline";

export const STATUS_LABEL: Record<AgentStatus, string> = {
  running: "运行中",
  idle: "空闲",
  error: "异常",
  offline: "离线",
};

export const STATUS_DOT: Record<AgentStatus, string> = {
  running: "bg-status-running",
  idle: "bg-status-idle",
  error: "bg-status-error",
  offline: "bg-status-offline",
};

export const STATUS_TEXT: Record<AgentStatus, string> = {
  running: "text-status-running",
  idle: "text-status-idle",
  error: "text-status-error",
  offline: "text-status-offline",
};

export function runStatusToAgent(status: string): AgentStatus {
  if (status === "completed") return "idle";
  if (status === "blocked" || status === "failed") return "error";
  if (status === "cancelled") return "offline";
  return "running";
}

export function taskStatusToAgent(status: string): AgentStatus {
  if (status === "running" || status === "rework_required") return "running";
  if (status === "awaiting_report" || status === "accepted") return "idle";
  if (status === "blocked" || status === "failed") return "error";
  return "offline";
}

export type StepStatus = "done" | "running" | "pending" | "failed";

export const STEP_LABEL: Record<StepStatus, string> = {
  done: "已完成",
  running: "执行中",
  pending: "等待中",
  failed: "失败",
};

export type ExecStep = {
  id: string;
  name: string;
  detail: string;
  status: StepStatus;
  durationMs: number;
};

export type LogLevel = "info" | "warn" | "error" | "debug";

export type LogLine = {
  time: string;
  level: LogLevel;
  message: string;
};

function payloadMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { message?: string };
    return parsed.message ?? raw;
  } catch {
    return raw;
  }
}

const ERROR_KINDS = new Set(["agent.failed", "task.failed", "task.blocked", "integration.conflict"]);
const DEBUG_KINDS = new Set(["agent.session", "agent.tool"]);

export function eventsToLogs(events: RelayEventDTO[]): LogLine[] {
  return events.map((event) => {
    const level: LogLevel = ERROR_KINDS.has(event.kind)
      ? "error"
      : DEBUG_KINDS.has(event.kind)
        ? "debug"
        : "info";
    const time = new Date(event.createdAt * 1000).toLocaleTimeString("en-GB", { hour12: false });
    return { time, level, message: `#${event.sequence} ${event.kind}: ${payloadMessage(event.payload)}` };
  });
}

/** Timeline from the task's audit events; the tail event is the live step. */
export function eventsToSteps(events: RelayEventDTO[], terminal: boolean): ExecStep[] {
  return events.map((event, index) => {
    const last = index === events.length - 1;
    let status: StepStatus;
    if (ERROR_KINDS.has(event.kind)) status = "failed";
    else if (last && !terminal) status = "running";
    else status = "done";
    const started = index === 0 ? event.createdAt : events[index - 1].createdAt;
    return {
      id: event.id,
      name: event.kind,
      detail: payloadMessage(event.payload),
      status,
      durationMs: Math.max(0, Math.round((event.createdAt - started) * 1000)),
    };
  });
}

export function attemptDurationMs(attempt: TaskAttemptDTO): number {
  const end = attempt.finishedAt ?? Date.now() / 1000;
  return Math.max(0, Math.round((end - attempt.startedAt) * 1000));
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Swimlane trace timeline (attached trace-timeline block) ────────────────

export type TraceLane = "input" | "model" | "tool";

export const TRACE_LANE_LABEL: Record<TraceLane, string> = {
  input: "Input",
  model: "Model",
  tool: "Tools",
};

export const TRACE_LANE_BG: Record<TraceLane, string> = {
  input: "bg-trace-input",
  model: "bg-trace-model",
  tool: "bg-trace-tool",
};

export type TraceEvent = {
  id: string;
  lane: TraceLane;
  label: string;
  turn: number;
  startMs: number;
  durationMs: number;
  failed?: boolean;
};

export type SubAgentTrace = {
  totalMs: number;
  turns: number;
  events: TraceEvent[];
};

const LANE_BY_KIND: Record<string, TraceLane> = {
  "team.started": "input",
  "task.delegated": "input",
  "task.baseline_prepared": "input",
  "task.started": "input",
  "task.reported": "input",
  "task.accepted": "input",
  "task.blocked": "input",
  "task.failed": "model",
  "task.resumed": "input",
  "task.cancelled": "input",
  "run.hidden": "input",
  "context.fetched": "input",
  "agent.session": "model",
  "agent.completed": "model",
  "agent.failed": "model",
  "agent.cancelled": "model",
  "agent.output": "tool",
  "agent.tool": "tool",
};

function shortKind(kind: string): string {
  return kind.includes("/") ? kind.split("/")[0] : kind.replace(/^(task|team|agent)\./, "");
}

function payloadAttemptID(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { metadata?: { attempt_id?: string } };
    return parsed.metadata?.attempt_id ?? null;
  } catch {
    return null;
  }
}

/** Builds the swimlane trace from the task's audit events. */
export function traceFromEvents(events: RelayEventDTO[], attemptID: string | null): SubAgentTrace {
  const scoped = attemptID == null ? events : events.filter((event) => {
    const id = payloadAttemptID(event.payload);
    return id == null || id === attemptID || !event.kind.startsWith("agent.");
  });
  if (scoped.length === 0) return { totalMs: 0, turns: 1, events: [] };

  const t0 = scoped[0].createdAt;
  const attemptIDs = new Set<string>();
  for (const event of scoped) {
    const id = payloadAttemptID(event.payload);
    if (id != null) attemptIDs.add(id);
  }
  const attemptIndex = new Map([...attemptIDs].map((id, index) => [id, index + 1]));

  const laneEvents: Record<TraceLane, TraceEvent[]> = { input: [], model: [], tool: [] };
  for (const event of scoped) {
    const lane = LANE_BY_KIND[event.kind] ?? "input";
    const id = payloadAttemptID(event.payload);
    laneEvents[lane].push({
      id: event.id,
      lane,
      label: shortKind(event.kind),
      turn: id != null ? (attemptIndex.get(id) ?? 1) : 1,
      startMs: Math.max(0, (event.createdAt - t0) * 1000),
      durationMs: 0,
      failed: ERROR_KINDS.has(event.kind),
    });
  }

  const endMs = (scoped[scoped.length - 1].createdAt - t0) * 1000;
  for (const lane of ["input", "model", "tool"] as TraceLane[]) {
    const list = laneEvents[lane];
    for (let index = 0; index < list.length; index += 1) {
      const next = list[index + 1];
      const gap = next ? next.startMs - list[index].startMs : Math.max(endMs - list[index].startMs, 120);
      list[index].durationMs = Math.min(Math.max(gap, 60), 60_000);
    }
  }

  return {
    totalMs: Math.max(endMs, 1),
    turns: Math.max(attemptIDs.size, 1),
    events: [...laneEvents.input, ...laneEvents.model, ...laneEvents.tool],
  };
}
