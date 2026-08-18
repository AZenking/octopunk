// Review Center 评论面板:行级评论输入(DiffViewer 行入口弹出)、未解决发现
// 清单(open/risk 置顶,line_changed 展示锚点快照)与勾选批量返工(summary 必填)。
// 仅用 shadcn/ui 原语与 Tailwind 工具类。

import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ReviewCommentDTO } from "../../../shared/dtos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { CommentAnchor } from "./DiffViewer";

type CommentSeverity = ReviewCommentDTO["severity"];

function formatEpoch(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

function SeverityBadge({ severity }: { severity: CommentSeverity }) {
  if (severity === "risk") {
    return (
      <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
        risk
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
      info
    </Badge>
  );
}

function StatusBadge({ status }: { status: ReviewCommentDTO["status"] }) {
  if (status === "open") return null;
  const label =
    status === "line_changed" ? "行已变更" : status === "resolved" ? "已解决" : "已驳回";
  return (
    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
      {label}
    </Badge>
  );
}

function CommentRow({
  comment,
  checked,
  onToggle,
}: {
  comment: ReviewCommentDTO;
  checked: boolean;
  onToggle: (commentID: string, enabled: boolean) => void;
}) {
  const selectable = comment.status === "open";
  return (
    <li className="border-border border-b px-3 py-2.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <Checkbox
          aria-label={`选择评论 ${comment.filePath}:${comment.lineStart}`}
          disabled={!selectable}
          checked={checked}
          onCheckedChange={(value) => onToggle(comment.id, value === true)}
          className="app-no-drag mt-0.5"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={comment.severity} />
            <StatusBadge status={comment.status} />
            <span className="text-muted-foreground truncate font-mono text-xs">
              {comment.filePath}:{comment.lineStart}
              {comment.lineEnd > comment.lineStart ? `-${comment.lineEnd}` : ""}
            </span>
          </div>
          <p className="text-foreground text-sm whitespace-pre-wrap">{comment.body}</p>
          {comment.status === "line_changed" && comment.contextSnapshot.length > 0 && (
            <blockquote className="border-muted-foreground/40 text-muted-foreground ml-1 border-l-2 pl-2 text-xs whitespace-pre-wrap italic">
              锚点快照:{comment.contextSnapshot}
            </blockquote>
          )}
          <p className="text-muted-foreground text-xs">
            {comment.author} · 第 {comment.reviewRound} 轮 · {formatEpoch(comment.createdAt)}
          </p>
        </div>
      </div>
    </li>
  );
}

export function CommentPanel({
  runID,
  taskID,
  draft,
  onDraftClear,
}: {
  runID: string;
  taskID: string;
  /** 行级评论草稿(DiffViewer 行入口);null 表示无待输入评论。 */
  draft: CommentAnchor | null;
  onDraftClear: () => void;
}) {
  const [comments, setComments] = useState<ReviewCommentDTO[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIDs, setSelectedIDs] = useState<Set<string>>(new Set());
  // 行级评论输入(Dialog 内)。
  const [draftBody, setDraftBody] = useState("");
  const [draftSeverity, setDraftSeverity] = useState<CommentSeverity>("info");
  const [submitting, setSubmitting] = useState(false);
  // 批量返工 Dialog。
  const [reworkOpen, setReworkOpen] = useState(false);
  const [reworkSummary, setReworkSummary] = useState("");
  const [reworking, setReworking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      // 服务端已按 severity DESC 排序(risk 置顶),此处保持原序。
      const result = await window.octopunk.invoke<ReviewCommentDTO[]>("review:unresolved-findings", {
        runID,
        taskID,
      });
      setComments(result);
      setSelectedIDs(new Set());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setComments([]);
    } finally {
      setLoading(false);
    }
  }, [runID, taskID]);

  useEffect(() => {
    setComments(null);
    setSelectedIDs(new Set());
    setNotice(null);
    void reload();
  }, [reload]);

  // 新草稿到达时重置输入(保留 Dialog 状态由 draft 是否为 null 驱动)。
  useEffect(() => {
    if (draft != null) {
      setDraftBody("");
      setDraftSeverity("info");
    }
  }, [draft]);

  const submitComment = async (): Promise<void> => {
    if (draft == null) return;
    const body = draftBody.trim();
    if (body.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      // 载荷契约见 specs/002-v04 contracts(interfaces.md)add_review_comments 的
      // camelCase 形态:`file` 与服务层 ReviewCommentInput 一致;`filePath` 为对
      // DTO 命名的兼容别名,主进程按已注册字段名取值,多余键被忽略。
      await window.octopunk.invoke<ReviewCommentDTO[]>("review:add-comments", {
        requestID: crypto.randomUUID(),
        runID,
        taskID,
        comments: [
          {
            file: draft.path,
            filePath: draft.path,
            lineStart: draft.lineStart,
            lineEnd: draft.lineEnd,
            contextSnapshot: draft.contextSnapshot,
            body,
            severity: draftSeverity,
            author: "user",
          },
        ],
      });
      onDraftClear();
      setNotice(`已添加评论:${draft.path}:${draft.lineStart}`);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const submitRework = async (): Promise<void> => {
    const summary = reworkSummary.trim();
    if (summary.length === 0 || selectedIDs.size === 0) return;
    setReworking(true);
    setError(null);
    try {
      await window.octopunk.invoke("review:rework-batch", {
        requestID: crypto.randomUUID(),
        runID,
        taskID,
        commentIDs: [...selectedIDs],
        summary,
      });
      setReworkOpen(false);
      setReworkSummary("");
      setNotice(`已发起批量返工(聚合 ${selectedIDs.size} 条评论),等待新报告。`);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setReworking(false);
    }
  };

  const openComments = comments?.filter((comment) => comment.status === "open") ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-semibold">行级评论</h2>
        <span className="text-muted-foreground font-mono text-xs">{openComments.length} 条未解决</span>
      </div>

      {notice != null && (
        <p className="border-b border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-status-running">
          {notice}
        </p>
      )}
      {error != null && (
        <p className="text-status-error border-b border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading || comments == null ? (
          <div className="flex flex-col gap-2 p-3">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
        ) : comments.length === 0 ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-xs">
            <p>暂无未解决发现</p>
            <p>在 Diff 行上悬停并点击评论图标即可添加行级评论。</p>
          </div>
        ) : (
          <ul>
            {comments.map((comment) => (
              <CommentRow
                key={comment.id}
                comment={comment}
                checked={selectedIDs.has(comment.id)}
                onToggle={(commentID, enabled) =>
                  setSelectedIDs((current) => {
                    const next = new Set(current);
                    if (enabled) {
                      next.add(commentID);
                    } else {
                      next.delete(commentID);
                    }
                    return next;
                  })
                }
              />
            ))}
          </ul>
        )}
      </div>

      {selectedIDs.size > 0 && (
        <div className="border-border bg-muted/40 flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2">
          <span className="text-muted-foreground text-xs">已选 {selectedIDs.size} 条 open 评论</span>
          <Button
            variant="destructive"
            size="sm"
            className="app-no-drag cursor-pointer"
            onClick={() => setReworkOpen(true)}
          >
            批量返工
          </Button>
        </div>
      )}

      {/* 行级评论输入(DiffViewer 行入口弹出) */}
      <Dialog open={draft != null} onOpenChange={(open) => !open && onDraftClear()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>添加行级评论</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {draft ? `${draft.path}:${draft.lineStart}` : ""}
            </DialogDescription>
          </DialogHeader>
          {draft != null && draft.contextSnapshot.length > 0 && (
            <blockquote className="bg-muted text-muted-foreground max-h-24 overflow-y-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap">
              {draft.contextSnapshot}
            </blockquote>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="review-comment-body">评论内容</Label>
            <Textarea
              id="review-comment-body"
              value={draftBody}
              onChange={(event) => setDraftBody(event.target.value)}
              placeholder="描述问题、期望修复方式或风险依据…"
              className="min-h-24"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>严重级别</Label>
            <Select
              value={draftSeverity}
              onValueChange={(value) => setDraftSeverity(value as CommentSeverity)}
            >
              <SelectTrigger className="app-no-drag w-full cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="info" className="cursor-pointer">
                  info — 一般意见
                </SelectItem>
                <SelectItem value="risk" className="cursor-pointer">
                  risk — 风险发现(计入高风险,置顶呈现)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" className="app-no-drag cursor-pointer">
                取消
              </Button>
            </DialogClose>
            <Button
              disabled={submitting || draftBody.trim().length === 0}
              onClick={() => void submitComment()}
              className="app-no-drag cursor-pointer"
            >
              {submitting ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
              提交评论
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量返工(summary 必填) */}
      <Dialog open={reworkOpen} onOpenChange={setReworkOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>批量返工</DialogTitle>
            <DialogDescription>
              将勾选的 {selectedIDs.size} 条 open 评论聚合为一次返工(转为 findings 走既有返工流,复用审查轮次)。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rework-summary">
              返工说明<span className="text-status-error">*(必填)</span>
            </Label>
            <Textarea
              id="rework-summary"
              value={reworkSummary}
              onChange={(event) => setReworkSummary(event.target.value)}
              placeholder="概括本次返工目标与验收标准…"
              className={cn("min-h-24", reworkSummary.trim().length === 0 && "border-status-error/50")}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" className="app-no-drag cursor-pointer">
                取消
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={reworking || reworkSummary.trim().length === 0}
              onClick={() => void submitRework()}
              className="app-no-drag cursor-pointer"
            >
              {reworking ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
              发起返工
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
