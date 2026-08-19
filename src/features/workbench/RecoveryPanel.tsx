// 崩溃恢复面板(v0.3 T020):recovery:status 分组展示非终态 run 的进程核对
// 与孤儿资源扫描结果。动作全部显式确认——「标记失败」(Dialog+原因输入,
// recovery:mark-failed)、「重跑」(可选含下游 Switch,recovery:rerun)、
// 「清理所选」(勾选 + 二次确认 Dialog,recovery:cleanup-orphans,confirmed:
// true);process_alive 仅展示与建议,不提供自动接管。所有动作带 requestID
// 留痕;渲染进程只经 window.octopunk.invoke,仅用 shadcn/ui 原语。

import {
  ChevronDown,
  CircleStop,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecoveryItemDTO, RecoveryStatusDTO } from "../../../shared/dtos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** kind 中文文案(条目徽标与分组标题共用;未知值回退原值)。 */
const KIND_LABEL: Record<RecoveryItemDTO["kind"], string> = {
  interrupted: "中断任务",
  process_alive: "进程仍在",
  orphan_worktree: "孤儿 worktree",
  orphan_branch: "孤儿分支",
  stale_lock: "过期锁",
};

function kindLabel(kind: RecoveryItemDTO["kind"]): string {
  return KIND_LABEL[kind] ?? kind;
}

/** 分组渲染顺序:可执行动作的排前面,空分组不渲染。 */
const KIND_ORDER: RecoveryItemDTO["kind"][] = [
  "interrupted",
  "process_alive",
  "orphan_worktree",
  "orphan_branch",
  "stale_lock",
];

/** 分组说明(灰字,说明该分区的判定与可执行动作)。 */
const KIND_NOTE: Record<RecoveryItemDTO["kind"], string> = {
  interrupted: "进程已死或状态未知,需人工确认后标记失败或重跑",
  process_alive: "进程仍在运行但已脱离本应用管理,仅展示与建议",
  orphan_worktree: "不受任何已知运行登记的 worktree 目录,可勾选后清理",
  orphan_branch: "不属于任何已知运行前缀的 octopunk/* 分支,可勾选后清理",
  stale_lock: "疑似过期的锁目标,可勾选后清理",
};

/** kind 徽标配色:中断=红、仍在=蓝、孤儿=琥珀、锁=紫(text 用已注册 token/调色板,确保可编译)。 */
const KIND_BADGE_CLASS: Record<RecoveryItemDTO["kind"], string> = {
  interrupted: "border-red-500/40 bg-red-500/10 text-status-error",
  process_alive: "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  orphan_worktree: "border-amber-500/40 bg-amber-500/10 text-status-idle",
  orphan_branch: "border-amber-500/40 bg-amber-500/10 text-status-idle",
  stale_lock: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
};

/** cleanup-orphans 载荷里的单个目标(与 electron 侧 RecoveryCleanupTarget 对齐)。 */
interface OrphanCleanupTarget {
  kind: RecoveryItemDTO["kind"];
  path?: string;
  repositoryURL?: string;
  branchName?: string;
}

/** 是否为可勾选清理的孤儿类别(interrupted/process_alive 不是可清理资源)。 */
function isOrphanKind(kind: RecoveryItemDTO["kind"]): boolean {
  return kind === "orphan_worktree" || kind === "orphan_branch" || kind === "stale_lock";
}

/** 条目选择键:kind 前缀避免不同类别 detail 撞键。 */
function itemKey(item: RecoveryItemDTO): string {
  return `${item.kind}:${item.detail}`;
}

/**
 * 从 detail 解析清理目标(DTO 不携带结构化 path/branch,均为扫描侧拼进
 * detail 的约定格式):worktree/锁为「绝对路径:说明」;分支为
 * 「仓库 X 分支 Y:说明」。解析失败返回 null(该条目不可勾选,不盲清)。
 */
function parseCleanupTarget(item: RecoveryItemDTO): OrphanCleanupTarget | null {
  if (item.kind === "orphan_branch") {
    const match = /^仓库 (.+) 分支 ([^:]+):/.exec(item.detail);
    return match == null ? null : { kind: item.kind, repositoryURL: match[1], branchName: match[2] };
  }
  if (isOrphanKind(item.kind)) {
    const separator = item.detail.indexOf(":");
    const path = separator > 0 ? item.detail.slice(0, separator) : item.detail;
    return path.startsWith("/") ? { kind: item.kind, path } : null;
  }
  return null;
}

/** 清理确认 Dialog 里展示的目标描述(解析失败回退整段 detail)。 */
function describeCleanupTarget(item: RecoveryItemDTO): string {
  const target = parseCleanupTarget(item);
  if (target == null) return item.detail;
  return target.kind === "orphan_branch"
    ? `${target.repositoryURL ?? ""} · 分支 ${target.branchName ?? ""}`
    : (target.path ?? "");
}

function formatScannedAt(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

/** runID/taskID 缩略(UUID 前 8 位;完整值放 title)。 */
function shortID(id: string): string {
  return id.slice(0, 8);
}

/** 单条恢复项:徽标 + 缩略 ID(可点击跳运行详情)+ detail + suggestion 灰字 + 分类别操作。 */
function RecoveryItemRow({
  item,
  checked,
  onToggle,
  busy,
  onSelectRun,
  onMarkFailed,
  onRerun,
}: {
  item: RecoveryItemDTO;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  busy: boolean;
  onSelectRun: (runID: string) => void;
  onMarkFailed: (item: RecoveryItemDTO) => void;
  onRerun: (item: RecoveryItemDTO) => void;
}) {
  const cleanable = isOrphanKind(item.kind);
  const parseable = parseCleanupTarget(item) != null;
  return (
    <li className="flex items-start gap-2.5 rounded-lg border px-3 py-2">
      {cleanable && (
        <Checkbox
          className="mt-0.5"
          checked={checked}
          disabled={!parseable || busy}
          onCheckedChange={(value) => onToggle(value === true)}
          aria-label={`选择清理:${kindLabel(item.kind)}`}
        />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <span className="flex w-full flex-wrap items-center gap-1.5">
          <Badge
            variant="outline"
            className={cn("px-1.5 py-0 text-[10px]", KIND_BADGE_CLASS[item.kind])}
          >
            {kindLabel(item.kind)}
          </Badge>
          {item.runID != null ? (
            <Button
              variant="link"
              size="xs"
              className="app-no-drag h-auto cursor-pointer gap-1 px-0 font-mono text-[10px]"
              title={`运行 ${item.runID}${item.taskID != null ? ` · 任务 ${item.taskID}` : ""}(点击查看运行详情)`}
              onClick={() => {
                if (item.runID != null) onSelectRun(item.runID);
              }}
            >
              run:{shortID(item.runID)}
              {item.taskID != null && (
                <span className="text-muted-foreground">/ task:{shortID(item.taskID)}</span>
              )}
            </Button>
          ) : (
            <span className="text-muted-foreground font-mono text-[10px]">无关联运行</span>
          )}
        </span>
        <p className="text-xs leading-relaxed break-all">{item.detail}</p>
        {item.suggestion.length > 0 && (
          <p className="text-muted-foreground text-xs leading-relaxed break-all">
            {item.suggestion}
          </p>
        )}
      </div>
      {item.kind === "interrupted" && (
        <span className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => onMarkFailed(item)}
            className="app-no-drag cursor-pointer"
            title="经 Dialog 确认并填写原因后标记失败"
          >
            <CircleStop aria-hidden />
            标记失败
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => onRerun(item)}
            className="app-no-drag cursor-pointer"
            title="重跑该任务(可选连带恢复被阻塞的下游)"
          >
            <RotateCw aria-hidden />
            重跑
          </Button>
        </span>
      )}
    </li>
  );
}

/**
 * 工作台内的崩溃恢复分区:首载 + 手动刷新(扫描含进程探测与全量
 * worktree 对比,不做自动轮询)。点击缩略 ID 复用 WorkbenchView 的
 * onSelectRun 跳转运行详情。
 */
export function RecoveryPanel({ onSelectRun }: { onSelectRun: (runID: string) => void }) {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState<RecoveryStatusDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [failTarget, setFailTarget] = useState<RecoveryItemDTO | null>(null);
  const [failReason, setFailReason] = useState("");
  const [rerunTarget, setRerunTarget] = useState<RecoveryItemDTO | null>(null);
  const [includeDownstream, setIncludeDownstream] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<{ cleaned: string[]; skipped: string[] } | null>(
    null,
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadStatus = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await window.octopunk.invoke<RecoveryStatusDTO>("recovery:status", {});
      if (!mountedRef.current) return;
      setStatus(result);
      setError(null);
      // 刷新后仍存在且可解析的孤儿项才保留勾选,避免对陈旧目标执行清理。
      const selectable = new Set(
        result.items.filter((item) => parseCleanupTarget(item) != null).map(itemKey),
      );
      setSelected((current) => new Set([...current].filter((key) => selectable.has(key))));
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus({ items: [], scannedAt: Date.now() / 1000 });
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // 仅首载 + 手动刷新(与工作台 5s 轮询不同:恢复扫描含进程探测,代价高)。
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const closeFailDialog = (): void => {
    setFailTarget(null);
    setFailReason("");
  };

  const submitMarkFailed = async (): Promise<void> => {
    if (failTarget?.runID == null || failTarget.taskID == null) return;
    const target = failTarget;
    setBusy(`mark-failed:${itemKey(target)}`);
    try {
      await window.octopunk.invoke("recovery:mark-failed", {
        requestID: crypto.randomUUID(),
        runID: target.runID,
        taskID: target.taskID,
        reason: failReason.trim(),
      });
      closeFailDialog();
      await loadStatus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const submitRerun = async (): Promise<void> => {
    if (rerunTarget?.runID == null || rerunTarget.taskID == null) return;
    const target = rerunTarget;
    setBusy(`rerun:${itemKey(target)}`);
    try {
      await window.octopunk.invoke("recovery:rerun", {
        requestID: crypto.randomUUID(),
        runID: target.runID,
        taskID: target.taskID,
        includeDownstream,
      });
      setRerunTarget(null);
      await loadStatus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const selectedItems =
    status?.items.filter((item) => selected.has(itemKey(item)) && parseCleanupTarget(item) != null) ??
    [];

  const submitCleanup = async (): Promise<void> => {
    const targets = selectedItems
      .map(parseCleanupTarget)
      .filter((target): target is OrphanCleanupTarget => target != null);
    if (targets.length === 0) return;
    setBusy("cleanup-orphans");
    try {
      const result = await window.octopunk.invoke<{ cleaned: string[]; skipped: string[] }>(
        "recovery:cleanup-orphans",
        {
          requestID: crypto.randomUUID(),
          targets,
          confirmed: true,
        },
      );
      setCleanupResult(result);
      setCleanupOpen(false);
      setSelected(new Set());
      await loadStatus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const items = status?.items ?? [];
  const total = items.length;
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    entries: items.filter((item) => item.kind === kind),
  })).filter((group) => group.entries.length > 0);
  const orphanCount = items.filter((item) => isOrphanKind(item.kind)).length;
  const actionBusy = busy != null;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-4 shrink-0">
      <div className="bg-card overflow-hidden rounded-xl border shadow-xs">
        <div className="flex h-10 shrink-0 items-center gap-2 px-2">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="app-no-drag cursor-pointer gap-1.5 px-2"
              aria-label={open ? "折叠崩溃恢复分区" : "展开崩溃恢复分区"}
            >
              <ChevronDown
                className={cn("size-3.5 transition-transform", !open && "-rotate-90")}
                aria-hidden
              />
              <ShieldCheck className="text-primary size-4" aria-hidden />
              <span className="text-sm font-semibold">崩溃恢复</span>
            </Button>
          </CollapsibleTrigger>
          <Badge
            variant="secondary"
            className={cn("px-1.5 py-0 font-mono text-[10px]", total === 0 && "opacity-60")}
            title="需要恢复的项目总数"
          >
            {status == null ? "…" : total}
          </Badge>
          {status != null && (
            <span
              className="text-muted-foreground hidden truncate font-mono text-[10px] md:inline"
              title={`扫描于 ${formatScannedAt(status.scannedAt)}`}
            >
              扫描于 {formatScannedAt(status.scannedAt)}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {orphanCount > 0 && (
              <Button
                variant="outline"
                size="xs"
                disabled={selected.size === 0 || actionBusy}
                onClick={() => setCleanupOpen(true)}
                className="app-no-drag cursor-pointer"
                title="勾选孤儿项后,经二次确认清理所选目标"
              >
                <Trash2 aria-hidden />
                清理所选{selected.size > 0 ? `(${selected.size})` : ""}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="重新扫描恢复状态"
              title="重新扫描恢复状态"
              disabled={loading}
              onClick={() => void loadStatus()}
              className="app-no-drag cursor-pointer"
            >
              {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            </Button>
          </span>
        </div>

        <CollapsibleContent className="border-border border-t">
          {error != null && (
            <div className="border-border bg-destructive/5 flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
              <p className="text-status-error min-w-0 truncate text-xs" title={error}>
                {error}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadStatus()}
                className="app-no-drag shrink-0 cursor-pointer"
              >
                重试
              </Button>
            </div>
          )}

          {cleanupResult != null && (
            <div className="border-border bg-status-running/5 flex shrink-0 items-start justify-between gap-2 border-b px-3 py-2">
              <div className="min-w-0 space-y-0.5 text-xs">
                <p className="text-status-running font-medium">
                  已清理 {cleanupResult.cleaned.length} 项
                </p>
                {cleanupResult.skipped.length > 0 && (
                  <p
                    className="text-status-idle truncate"
                    title={cleanupResult.skipped.join("\n")}
                  >
                    跳过 {cleanupResult.skipped.length} 项:{cleanupResult.skipped.join(";")}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="关闭清理结果"
                onClick={() => setCleanupResult(null)}
                className="app-no-drag shrink-0 cursor-pointer"
              >
                <X aria-hidden />
              </Button>
            </div>
          )}

          <div className="p-2">
            {status == null && loading ? (
              <div className="space-y-2 p-1">
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-16 w-full rounded-lg" />
              </div>
            ) : total === 0 ? (
              <div className="text-muted-foreground flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-center text-xs">
                <ShieldCheck className="size-5 opacity-50" aria-hidden />
                <p>未发现需要恢复的项目</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {groups.map((group) => (
                  <section key={group.kind}>
                    <div className="flex items-center gap-2 px-1 pb-1">
                      <Badge
                        variant="outline"
                        className={cn("px-1.5 py-0 text-[10px]", KIND_BADGE_CLASS[group.kind])}
                      >
                        {kindLabel(group.kind)}
                      </Badge>
                      <span className="text-muted-foreground min-w-0 flex-1 truncate text-[10px]">
                        {KIND_NOTE[group.kind]}
                      </span>
                      <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                        {group.entries.length}
                      </span>
                    </div>
                    <ul className="space-y-1">
                      {group.entries.map((item) => (
                        <RecoveryItemRow
                          key={itemKey(item)}
                          item={item}
                          checked={selected.has(itemKey(item))}
                          onToggle={(checked) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (checked) next.add(itemKey(item));
                              else next.delete(itemKey(item));
                              return next;
                            })
                          }
                          busy={actionBusy}
                          onSelectRun={onSelectRun}
                          onMarkFailed={(target) => {
                            setFailReason("");
                            setFailTarget(target);
                          }}
                          onRerun={(target) => {
                            setIncludeDownstream(false);
                            setRerunTarget(target);
                          }}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>

      {/* 标记失败:显式确认 + 原因留痕(failTask 幂等;运行保持阻塞直至人工重跑)。 */}
      <Dialog
        open={failTarget != null}
        onOpenChange={(next) => {
          if (!next) closeFailDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          {failTarget != null && (
            <>
              <DialogHeader>
                <DialogTitle>将中断任务标记为失败?</DialogTitle>
                <DialogDescription>
                  任务 {failTarget.taskID}
                  将被置为失败并留痕(原因写入任务摘要);运行保持阻塞,直到人工重跑。
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="recovery-fail-reason">失败原因</Label>
                <Textarea
                  id="recovery-fail-reason"
                  value={failReason}
                  onChange={(event) => setFailReason(event.target.value)}
                  placeholder="例如:进程已死,经人工确认无法继续"
                  className="min-h-20"
                />
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={closeFailDialog}
                  disabled={actionBusy}
                  className="app-no-drag cursor-pointer"
                >
                  取消
                </Button>
                <Button
                  variant="destructive"
                  disabled={actionBusy}
                  onClick={() => void submitMarkFailed()}
                  className="app-no-drag cursor-pointer"
                >
                  {busy?.startsWith("mark-failed") ? (
                    <LoaderCircle className="animate-spin" aria-hidden />
                  ) : (
                    <CircleStop aria-hidden />
                  )}
                  确认标记失败
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 重跑:目标节点复位为 queued;Switch 决定是否连带恢复被阻塞的下游。 */}
      <Dialog
        open={rerunTarget != null}
        onOpenChange={(next) => {
          if (!next) setRerunTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          {rerunTarget != null && (
            <>
              <DialogHeader>
                <DialogTitle>重跑该任务?</DialogTitle>
                <DialogDescription>
                  任务 {rerunTarget.taskID}
                  将复位排队、运行回到运行中;已排队与已成功的任务不受影响。
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <Label htmlFor="recovery-rerun-downstream">同时恢复被阻塞的下游任务</Label>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    仅恢复因依赖失败被显式阻塞的下游;重跑目标被接受后即依次调度。
                  </p>
                </div>
                <Switch
                  id="recovery-rerun-downstream"
                  checked={includeDownstream}
                  onCheckedChange={(enabled) => setIncludeDownstream(enabled)}
                />
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setRerunTarget(null)}
                  disabled={actionBusy}
                  className="app-no-drag cursor-pointer"
                >
                  取消
                </Button>
                <Button
                  disabled={actionBusy}
                  onClick={() => void submitRerun()}
                  className="app-no-drag cursor-pointer"
                >
                  {busy?.startsWith("rerun") ? (
                    <LoaderCircle className="animate-spin" aria-hidden />
                  ) : (
                    <RotateCw aria-hidden />
                  )}
                  确认重跑
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 孤儿清理:二次确认逐项列明目标;confirmed: true 才会执行(不可逆)。 */}
      <Dialog open={cleanupOpen} onOpenChange={setCleanupOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>清理所选孤儿资源?</DialogTitle>
            <DialogDescription>
              将删除以下 {selectedItems.length} 个目标(目录删除 / 分支删除均不可逆);逐项独立执行,失败项计入跳过。
            </DialogDescription>
          </DialogHeader>
          <ul className="border-border max-h-56 space-y-0.5 overflow-y-auto rounded-lg border p-2">
            {selectedItems.map((item) => (
              <li
                key={itemKey(item)}
                className="truncate font-mono text-xs"
                title={describeCleanupTarget(item)}
              >
                <span className="text-muted-foreground">[{kindLabel(item.kind)}]</span>{" "}
                {describeCleanupTarget(item)}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCleanupOpen(false)}
              disabled={actionBusy}
              className="app-no-drag cursor-pointer"
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={actionBusy || selectedItems.length === 0}
              onClick={() => void submitCleanup()}
              className="app-no-drag cursor-pointer"
            >
              {busy === "cleanup-orphans" ? (
                <LoaderCircle className="animate-spin" aria-hidden />
              ) : (
                <Trash2 aria-hidden />
              )}
              确认清理
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Collapsible>
  );
}
