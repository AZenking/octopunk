// 质量门禁面板:嵌入审查工作台右栏(评论/交付摘要之下),对选中任务运行
// gate:evaluate 并逐项呈现(pass/waived/fail/unknown);fail 项经 Dialog 附理由
// 逐项豁免(gate:waive-item)后自动重评。仅用 shadcn/ui 原语,渲染层只经
// window.octopunk.invoke。

import { LoaderCircle, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  GateCheckKey,
  GateEvaluationDTO,
  GateEvaluationItemDTO,
} from "../../../shared/dtos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** 检查项中文名(与 GateCheckKey 一一对应;未知键回退原值)。 */
const CHECK_LABELS: Record<GateCheckKey, string> = {
  tests: "测试",
  lint: "静态检查",
  typecheck: "类型检查",
  build: "构建",
  risk_findings: "风险发现",
  scope: "变更范围",
  dependencies: "依赖任务",
  target_baseline: "目标基线",
  reviewers: "审查者",
  high_risk_confirm: "高风险确认",
  todo_clean: "Todo 清理",
};

function checkLabel(key: GateCheckKey): string {
  return CHECK_LABELS[key] ?? key;
}

/** unknown 不渲染为失败色:灰色徽标 + 琥珀色醒目提示(不阻塞,建议人工复核)。 */
const ITEM_BADGES: Record<
  GateEvaluationItemDTO["status"],
  { label: string; variant: "secondary" | "destructive" | "outline"; className: string }
> = {
  pass: {
    label: "通过",
    variant: "secondary",
    className: "border-transparent bg-emerald-500/10 text-status-running",
  },
  fail: { label: "失败", variant: "destructive", className: "" },
  waived: {
    label: "已豁免",
    variant: "secondary",
    className: "border-transparent bg-amber-500/10 text-status-idle",
  },
  unknown: {
    label: "无法确认",
    variant: "outline",
    className: "text-muted-foreground border-border/60",
  },
};

const OVERALL_BADGES: Record<
  GateEvaluationDTO["overall"],
  { label: string; variant: "secondary" | "destructive"; className: string }
> = {
  pass: {
    label: "门禁通过",
    variant: "secondary",
    className: "border-transparent bg-emerald-500/10 text-status-running",
  },
  fail: { label: "门禁未通过", variant: "destructive", className: "" },
  waived: {
    label: "失败项已全部豁免",
    variant: "secondary",
    className: "border-transparent bg-amber-500/10 text-status-idle",
  },
};

function ItemBadge({ status }: { status: GateEvaluationItemDTO["status"] }) {
  const badge = ITEM_BADGES[status];
  return (
    <Badge variant={badge.variant} className={cn("px-1.5 py-0 text-[10px]", badge.className)}>
      {badge.label}
    </Badge>
  );
}

function GateItem({
  item,
  onWaive,
}: {
  item: GateEvaluationItemDTO;
  onWaive: (item: GateEvaluationItemDTO) => void;
}) {
  return (
    <div
      className={cn(
        "border-border/60 flex flex-col gap-1.5 rounded-lg border px-2.5 py-2",
        // unknown 项醒目呈现但绝不使用失败色。
        item.status === "unknown" && "border-amber-500/40 bg-amber-500/5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-foreground text-xs font-medium">{checkLabel(item.checkKey)}</span>
        <span className="text-muted-foreground/60 font-mono text-[10px]">{item.checkKey}</span>
        <ItemBadge status={item.status} />
        {item.status === "fail" && (
          <Button
            variant="outline"
            size="sm"
            className="app-no-drag ml-auto h-6 cursor-pointer px-2 text-[11px]"
            onClick={() => onWaive(item)}
          >
            豁免
          </Button>
        )}
      </div>
      {item.status === "unknown" && (
        <p className="text-status-idle text-[11px] leading-relaxed">
          无法确认(命令超时或输出不可判定):该结果不阻塞门禁,建议人工复核。
        </p>
      )}
      <pre className="bg-muted text-foreground w-full rounded-md p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {item.detail}
      </pre>
      {item.status === "fail" && item.fixSuggestion != null && (
        <p className="text-status-error text-[11px] leading-relaxed">
          修复建议:{item.fixSuggestion}
        </p>
      )}
      {item.status === "waived" && item.waivedReason != null && (
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          豁免留痕({item.waivedBy ?? "user"}):{item.waivedReason}
        </p>
      )}
    </div>
  );
}

export function GatePanel({ runID, taskID }: { runID: string; taskID: string }) {
  const [evaluation, setEvaluation] = useState<GateEvaluationDTO | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 豁免 Dialog:待豁免项 + 必填理由。
  const [waivingItem, setWaivingItem] = useState<GateEvaluationItemDTO | null>(null);
  const [waiveReason, setWaiveReason] = useState("");
  const [waiving, setWaiving] = useState(false);
  const [waiveError, setWaiveError] = useState<string | null>(null);

  // 切换任务时清空上一轮结果,避免跨任务串显。
  useEffect(() => {
    setEvaluation(null);
    setError(null);
  }, [runID, taskID]);

  const evaluate = useCallback(async (): Promise<void> => {
    setEvaluating(true);
    setError(null);
    try {
      const result = await window.octopunk.invoke<GateEvaluationDTO>("gate:evaluate", {
        requestID: crypto.randomUUID(),
        runID,
        taskID,
      });
      setEvaluation(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setEvaluating(false);
    }
  }, [runID, taskID]);

  const waive = async (): Promise<void> => {
    if (waivingItem == null) return;
    const reason = waiveReason.trim();
    if (reason.length === 0) {
      setWaiveError("豁免理由为必填项。");
      return;
    }
    setWaiving(true);
    setWaiveError(null);
    try {
      // 主进程在豁免后重算 overall 并返回完整判定;若通道只回空值则回退为
      // 重新评估(命令类检查会重跑,代价更高)。
      const result = await window.octopunk.invoke<GateEvaluationDTO | null>(
        "gate:waive-item",
        {
          requestID: crypto.randomUUID(),
          evaluationID: waivingItem.evaluationID,
          itemID: waivingItem.id,
          waivedBy: "user",
          waivedReason: reason,
        },
      );
      setWaivingItem(null);
      setWaiveReason("");
      if (result != null && Array.isArray(result.items)) {
        setEvaluation(result);
      } else {
        await evaluate();
      }
    } catch (caught) {
      setWaiveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWaiving(false);
    }
  };

  const overall = evaluation != null ? OVERALL_BADGES[evaluation.overall] : null;

  return (
    <div className="border-border flex max-h-72 shrink-0 flex-col border-t">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
        <h2 className="text-sm font-semibold">门禁检查</h2>
        {overall != null && (
          <Badge variant={overall.variant} className={cn("px-1.5 py-0 text-[10px]", overall.className)}>
            {overall.label}
          </Badge>
        )}
        <span className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            disabled={evaluating}
            onClick={() => void evaluate()}
            className="app-no-drag cursor-pointer"
          >
            {evaluating ? (
              <LoaderCircle className="animate-spin" aria-hidden />
            ) : (
              <ShieldCheck aria-hidden />
            )}
            {evaluating ? "评估中…" : "运行门禁检查"}
          </Button>
        </span>
      </div>
      {error != null && (
        <p className="text-status-error px-3 pb-1.5 text-xs">{error}</p>
      )}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {evaluation == null ? (
          <p className="text-muted-foreground text-xs">
            尚未运行门禁检查;点击「运行门禁检查」按当前项目门禁配置评估此任务。
          </p>
        ) : evaluation.items.length === 0 ? (
          <p className="text-muted-foreground text-xs">未配置门禁,视为全部通过。</p>
        ) : (
          evaluation.items.map((item) => (
            <GateItem
              key={item.id}
              item={item}
              onWaive={(target) => {
                setWaivingItem(target);
                setWaiveReason("");
                setWaiveError(null);
              }}
            />
          ))
        )}
      </div>

      <Dialog
        open={waivingItem != null}
        onOpenChange={(open) => {
          if (!open && !waiving) {
            setWaivingItem(null);
            setWaiveError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          {waivingItem != null && (
            <>
              <DialogHeader>
                <DialogTitle>豁免「{checkLabel(waivingItem.checkKey)}」检查项?</DialogTitle>
                <DialogDescription>
                  豁免将留痕(操作人、时间与理由)并计入交付摘要的豁免清单;其余检查项不受影响,豁免后自动重新评估。
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="waive-reason">豁免理由(必填)</Label>
                <Textarea
                  id="waive-reason"
                  value={waiveReason}
                  onChange={(event) => setWaiveReason(event.target.value)}
                  placeholder="例如:该测试依赖外部服务,已知在本地环境不可用。"
                  className="min-h-[80px] text-xs"
                />
                {waiveError != null && (
                  <p className="text-status-error text-xs">{waiveError}</p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={waiving}
                  onClick={() => {
                    setWaivingItem(null);
                    setWaiveError(null);
                  }}
                >
                  取消
                </Button>
                <Button disabled={waiving} onClick={() => void waive()}>
                  {waiving ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
                  确认豁免
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
