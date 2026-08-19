// 跨模型审查仲裁面板:嵌入审查工作台右栏(门禁检查之下)。按六种审查模式
// 派发只读审查子任务(review:run-review,dispatch 立即返回),轮询审查任务
// 状态(review:review-tasks,5s)至全部到达后手动收集仲裁(review:collect-
// arbitration),三段呈现:共识(绿)/分歧(红,每位 reviewer 一行)/待验证
// (琥珀);autoPassed=false 时醒目提示「存在分歧,不会自动通过」。缓存经
// review:arbitration 恢复。仅用 shadcn/ui 原语,渲染层只经 window.octopunk.invoke。

import { LoaderCircle, Scale } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GateReviewMode } from "../../../shared/dtos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// 轻量 DTO(主进程 review:* 通道的载荷形状;领域模型不经渲染层直接引用)
// ---------------------------------------------------------------------------

interface ReviewTaskDTO {
  taskID: string;
  title: string;
  status: string;
  agentKind: string;
  model: string | null;
}

interface ArbitrationDisagreementDTO {
  reviewer: string;
  verdict: string;
  evidence: string;
}

interface ArbitrationToVerifyDTO {
  claim: string;
  howToVerify: string;
}

interface ArbitrationDTO {
  id: string;
  consensus: string;
  disagreements: ArbitrationDisagreementDTO[];
  toVerify: ArbitrationToVerifyDTO[];
  autoPassed: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// 展示映射(纯常量)
// ---------------------------------------------------------------------------

const MODE_OPTIONS: { value: GateReviewMode; label: string }[] = [
  { value: "standard", label: "常规审查" },
  { value: "cross_model", label: "对向互查" },
  { value: "dual_readonly", label: "双只读" },
  { value: "contest", label: "竞赛评审" },
  { value: "role_based", label: "角色分工" },
  { value: "arbitration", label: "仲裁" },
];

function modeLabel(mode: GateReviewMode): string {
  return MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

/** 审查任务状态徽标(与领域状态一一对应;未知值回退原值)。 */
const REVIEW_STATUS_BADGES: Record<string, { label: string; className: string }> = {
  queued: { label: "排队中", className: "text-muted-foreground border-border/60" },
  running: { label: "审查中", className: "border-transparent bg-emerald-500/10 text-status-running" },
  awaiting_report: { label: "报告就绪", className: "border-transparent bg-emerald-500/10 text-status-running" },
  rework_required: { label: "待返工", className: "border-amber-500/40 bg-amber-500/10 text-status-idle" },
  accepted: { label: "已通过", className: "border-transparent bg-emerald-500/10 text-status-running" },
  blocked: { label: "已阻断", className: "border-red-500/40 bg-red-500/10 text-status-error" },
  cancelled: { label: "已取消", className: "text-muted-foreground border-border/60" },
  failed: { label: "失败", className: "border-red-500/40 bg-red-500/10 text-status-error" },
};

/** 与主进程/服务的可收集判定同构:报告就绪、待返工或任一终态。 */
const COLLECTIBLE_STATUSES = new Set([
  "awaiting_report",
  "rework_required",
  "accepted",
  "blocked",
  "cancelled",
  "failed",
]);

function verdictBadge(verdict: string): { variant: "secondary" | "destructive"; className: string } {
  if (verdict === "PASS") {
    return { variant: "secondary", className: "border-transparent bg-emerald-500/10 text-status-running" };
  }
  if (verdict === "REWORK") {
    return { variant: "secondary", className: "border-amber-500/40 bg-amber-500/10 text-status-idle" };
  }
  return { variant: "destructive", className: "" };
}

const VERDICT_LABELS: Record<string, string> = {
  PASS: "通过",
  REWORK: "返工",
  BLOCKED: "阻断",
};

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function ReviewTaskRow({ task }: { task: ReviewTaskDTO }) {
  const badge = REVIEW_STATUS_BADGES[task.status] ?? {
    label: task.status,
    className: "text-muted-foreground border-border/60",
  };
  return (
    <div className="border-border/60 flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-xs" title={task.title}>
        {task.title}
      </span>
      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
        {task.agentKind}
      </Badge>
      {task.model != null && (
        <span className="text-muted-foreground max-w-24 truncate font-mono text-[10px]" title={task.model}>
          {task.model}
        </span>
      )}
      <Badge variant="secondary" className={cn("px-1.5 py-0 text-[10px]", badge.className)}>
        {badge.label}
      </Badge>
    </div>
  );
}

function ArbitrationResult({ arbitration }: { arbitration: ArbitrationDTO }) {
  return (
    <div className="space-y-2">
      {arbitration.autoPassed ? (
        <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-status-running">
          审查结论全体一致为 PASS,仲裁层自动通过(任务仍需通过门禁与既有 accept 流程)。
        </p>
      ) : (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-status-error">
          存在分歧或结论缺口,不会自动通过,需人工/主 Agent 决断。
        </p>
      )}

      {/* 共识(绿边卡) */}
      <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-2.5 py-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold">共识</h3>
          <Badge
            variant="secondary"
            className={cn(
              "px-1.5 py-0 text-[10px]",
              arbitration.autoPassed
                ? "border-transparent bg-emerald-500/10 text-status-running"
                : "border-amber-500/40 bg-amber-500/10 text-status-idle",
            )}
          >
            {arbitration.autoPassed ? "自动通过" : "不自动通过"}
          </Badge>
        </div>
        <pre className="text-foreground mt-1.5 w-full font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {arbitration.consensus}
        </pre>
      </div>

      {/* 分歧(红边,每位 reviewer 一行) */}
      {arbitration.disagreements.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-red-500/40 bg-red-500/5 px-2.5 py-2">
          <h3 className="text-xs font-semibold text-status-error">
            分歧({arbitration.disagreements.length} 位 reviewer)
          </h3>
          {arbitration.disagreements.map((entry, index) => {
            const badge = verdictBadge(entry.verdict);
            return (
              <div key={`${entry.reviewer}:${index}`} className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-foreground truncate text-xs font-medium">{entry.reviewer}</span>
                  <Badge variant={badge.variant} className={cn("px-1.5 py-0 text-[10px]", badge.className)}>
                    {VERDICT_LABELS[entry.verdict] ?? entry.verdict}
                  </Badge>
                </div>
                <pre className="text-muted-foreground mt-0.5 w-full font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                  {entry.evidence}
                </pre>
              </div>
            );
          })}
        </div>
      )}

      {/* 待验证(琥珀,claim + howToVerify) */}
      {arbitration.toVerify.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2.5 py-2">
          <h3 className="text-xs font-semibold text-status-idle">待验证({arbitration.toVerify.length})</h3>
          {arbitration.toVerify.map((entry, index) => (
            <div key={index} className="min-w-0">
              <p className="text-foreground text-[11px] leading-relaxed">{entry.claim}</p>
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                验证方法:{entry.howToVerify}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

const REVIEW_TASK_POLL_INTERVAL_MS = 5_000;

export function ArbitrationPanel({ runID, taskID }: { runID: string; taskID: string }) {
  const [mode, setMode] = useState<GateReviewMode>("standard");
  const [dispatching, setDispatching] = useState(false);
  const [reviewTaskIDs, setReviewTaskIDs] = useState<string[]>([]);
  const [reviewTasks, setReviewTasks] = useState<ReviewTaskDTO[] | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [arbitration, setArbitration] = useState<ArbitrationDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 切换任务时清空上一轮,并恢复该任务已记录的仲裁缓存(review:arbitration)。
  useEffect(() => {
    let stale = false;
    setArbitration(null);
    setError(null);
    setNotice(null);
    setReviewTaskIDs([]);
    setReviewTasks(null);
    window.octopunk
      .invoke<ArbitrationDTO | null>("review:arbitration", { runID, taskID })
      .then((result) => {
        if (!stale) setArbitration(result);
      })
      .catch(() => {
        // 恢复失败不阻塞面板;发起审查/收集时报错更醒目。
      });
    return () => {
      stale = true;
    };
  }, [runID, taskID]);

  // 恢复该任务已有的审查子任务(面板重挂载/切走再切回)。
  useEffect(() => {
    let stale = false;
    window.octopunk
      .invoke<ReviewTaskDTO[]>("review:review-tasks", { runID, taskID })
      .then((result) => {
        if (stale) return;
        setReviewTasks(result);
        setReviewTaskIDs(result.map((task) => task.taskID));
      })
      .catch(() => {
        if (!stale) setReviewTasks([]);
      });
    return () => {
      stale = true;
    };
  }, [runID, taskID]);

  // 模式下拉默认值:run 生效门禁配置的 reviewMode(queries:run-summary 提供
  // repositoryPath → gate:get-config 的 effective 快照);失败回落 standard。
  useEffect(() => {
    let stale = false;
    window.octopunk
      .invoke<{ run: { repositoryPath: string } }>("queries:run-summary", { runID })
      .then((summary) =>
        window.octopunk.invoke<{ effective: { reviewMode: GateReviewMode } | null }>(
          "gate:get-config",
          { repositoryPath: summary.run.repositoryPath, runID },
        ),
      )
      .then((config) => {
        if (!stale && config.effective != null) setMode(config.effective.reviewMode);
      })
      .catch(() => {
        // 默认值回填失败保持 standard,不阻塞面板。
      });
    return () => {
      stale = true;
    };
  }, [runID]);

  const refreshReviewTasks = useCallback(async (): Promise<void> => {
    try {
      const result = await window.octopunk.invoke<ReviewTaskDTO[]>("review:review-tasks", {
        runID,
        taskID,
      });
      setReviewTasks(result);
      setReviewTaskIDs((current) =>
        current.length > 0 ? current : result.map((task) => task.taskID),
      );
    } catch {
      // 轮询失败静默:下一轮或手动操作会再次尝试。
    }
  }, [runID, taskID]);

  const allArrived = useMemo(
    () =>
      reviewTasks != null &&
      reviewTasks.length > 0 &&
      reviewTasks.every((task) => COLLECTIBLE_STATUSES.has(task.status)),
    [reviewTasks],
  );

  // 派发后每 5s 轮询审查任务状态;全部到达即停(手动收集不阻塞 UI)。
  useEffect(() => {
    if (reviewTaskIDs.length === 0 || allArrived) return;
    const timer = window.setInterval(() => void refreshReviewTasks(), REVIEW_TASK_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [reviewTaskIDs.length, allArrived, refreshReviewTasks]);

  const dispatch = async (): Promise<void> => {
    setDispatching(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.octopunk.invoke<{ reviewTaskIDs: string[]; mode: GateReviewMode }>(
        "review:run-review",
        { runID, taskID, mode },
      );
      setReviewTaskIDs(result.reviewTaskIDs);
      if (result.reviewTaskIDs.length === 0) {
        setNotice(
          `「${modeLabel(result.mode)}」模式不派发审查任务,走既有常规审查流(门禁检查 + 行级评论 + accept/返工)。`,
        );
        setReviewTasks([]);
        return;
      }
      await refreshReviewTasks();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDispatching(false);
    }
  };

  const collect = async (): Promise<void> => {
    setCollecting(true);
    setError(null);
    try {
      const result = await window.octopunk.invoke<ArbitrationDTO>("review:collect-arbitration", {
        runID,
        taskID,
        reviewTaskIDs,
      });
      setArbitration(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCollecting(false);
    }
  };

  return (
    <div className="border-border flex max-h-72 shrink-0 flex-col border-t">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
        <h2 className="text-sm font-semibold">跨模型审查</h2>
        {arbitration != null && (
          <Badge
            variant={arbitration.autoPassed ? "secondary" : "destructive"}
            className={cn(
              "px-1.5 py-0 text-[10px]",
              arbitration.autoPassed && "border-transparent bg-emerald-500/10 text-status-running",
            )}
          >
            {arbitration.autoPassed ? "仲裁自动通过" : "仲裁不自动通过"}
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Select value={mode} onValueChange={(value) => setMode(value as GateReviewMode)}>
            <SelectTrigger size="sm" className="app-no-drag w-28 cursor-pointer" aria-label="审查模式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value} className="cursor-pointer">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={dispatching}
            onClick={() => void dispatch()}
            className="app-no-drag cursor-pointer"
          >
            {dispatching ? <LoaderCircle className="animate-spin" aria-hidden /> : <Scale aria-hidden />}
            {dispatching ? "派发中…" : "发起审查"}
          </Button>
        </span>
      </div>
      {error != null && <p className="text-status-error px-3 pb-1.5 text-xs">{error}</p>}
      {notice != null && <p className="text-status-idle px-3 pb-1.5 text-xs">{notice}</p>}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {reviewTasks != null && reviewTasks.length > 0 ? (
          <>
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold">审查任务({reviewTasks.length})</h3>
              <span className="text-muted-foreground text-[11px]">
                {allArrived ? "全部到达" : "等待审查报告…每 5s 自动刷新"}
              </span>
              {allArrived && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={collecting}
                  onClick={() => void collect()}
                  className="app-no-drag ml-auto h-6 cursor-pointer px-2 text-[11px]"
                >
                  {collecting ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
                  {collecting ? "收集中…" : "收集仲裁结论"}
                </Button>
              )}
            </div>
            {reviewTasks.map((task) => (
              <ReviewTaskRow key={task.taskID} task={task} />
            ))}
          </>
        ) : (
          <p className="text-muted-foreground text-xs">
            尚未发起跨模型审查;选择模式后点击「发起审查」,按模式派发只读审查者并在全部到达后收集仲裁结论。
          </p>
        )}
        {arbitration != null && <ArbitrationResult arbitration={arbitration} />}
      </div>
    </div>
  );
}
