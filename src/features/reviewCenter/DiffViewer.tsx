// Review Center Diff 查看器:side 三方(baseline/worktree/integration)由父级
// Tabs 切换;这里负责单文件 Diff 的分页加载(≤64KiB/页)、hunk/行渲染、
// 行级评论入口。仅用 shadcn/ui 原语与 Tailwind 工具类。

import { LoaderCircle, MessageSquarePlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffHunkDTO, DiffLineDTO, DiffPageDTO, DiffTreeEntryDTO } from "../../../shared/dtos";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Diff 对比侧(与 shared/dtos.ts DiffPageDTO.side 同源)。 */
export type DiffSide = DiffPageDTO["side"];

/** 行级评论锚点(基线侧行号 + 现场行内容快照),由 DiffViewer 捕获。 */
export interface CommentAnchor {
  path: string;
  lineStart: number;
  lineEnd: number;
  contextSnapshot: string;
}

interface DiffViewerProps {
  runID: string;
  taskID: string;
  side: DiffSide;
  path: string | null;
  /** 变更树条目(用于二进制/超大友好提示);该侧无此文件时为 null。 */
  entry: DiffTreeEntryDTO | null;
  onLineComment: (anchor: CommentAnchor) => void;
}

const LINE_ROW_CLASS: Record<DiffLineDTO["origin"], string> = {
  add: "bg-emerald-500/10",
  del: "bg-red-500/10",
  ctx: "",
  hunk: "bg-muted",
};

function DiffLineRow({
  line,
  path,
  onLineComment,
}: {
  line: DiffLineDTO;
  path: string;
  onLineComment: (anchor: CommentAnchor) => void;
}) {
  // hunk 头行:两侧行号区间的 @@ 标记行,非内容行。
  if (line.origin === "hunk") {
    return (
      <div className="text-muted-foreground bg-muted sticky top-0 px-3 py-1 font-mono text-xs">
        {line.text}
      </div>
    );
  }

  const sign = line.origin === "add" ? "+" : line.origin === "del" ? "-" : " ";
  // 评论锚点为基线侧行号;新增行无基线行号时锚定新行号(快照仍可追溯)。
  const anchorLine = line.oldLine ?? line.newLine;

  return (
    <div
      className={cn(
        "group grid grid-cols-[3rem_3rem_1.25rem_1fr] items-start font-mono text-xs leading-5",
        LINE_ROW_CLASS[line.origin],
      )}
    >
      <span className="text-muted-foreground/70 pr-2 text-right tabular-nums select-none">
        {line.oldLine ?? ""}
      </span>
      <span className="text-muted-foreground/70 pr-2 text-right tabular-nums select-none">
        {line.newLine ?? ""}
      </span>
      <span
        className={cn(
          "pr-1 text-center select-none",
          line.origin === "add" && "text-status-running",
          line.origin === "del" && "text-status-error",
        )}
      >
        {sign}
      </span>
      <span className="relative min-w-0 pr-16">
        <span className="whitespace-pre-wrap break-all">{line.text.length === 0 ? "\u00A0" : line.text}</span>
        {anchorLine != null && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`评论第 ${anchorLine} 行`}
            title={`评论第 ${anchorLine} 行`}
            onClick={() =>
              onLineComment({
                path,
                lineStart: anchorLine,
                lineEnd: anchorLine,
                contextSnapshot: line.text,
              })
            }
            className="app-no-drag absolute top-0 right-0 cursor-pointer opacity-0 transition-opacity group-hover:opacity-100"
          >
            <MessageSquarePlus className="size-3.5" aria-hidden />
          </Button>
        )}
      </span>
    </div>
  );
}

function HunkBlock({
  hunk,
  path,
  onLineComment,
}: {
  hunk: DiffHunkDTO;
  path: string;
  onLineComment: (anchor: CommentAnchor) => void;
}) {
  const hasHunkHeader = hunk.lines.some((line) => line.origin === "hunk");
  return (
    <div className="border-border/60 border-b last:border-b-0">
      {!hasHunkHeader && (
        <div className="text-muted-foreground bg-muted px-3 py-1 font-mono text-xs">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </div>
      )}
      {hunk.lines.map((line, index) => (
        <DiffLineRow key={index} line={line} path={path} onLineComment={onLineComment} />
      ))}
    </div>
  );
}

export function DiffViewer({ runID, taskID, side, path, entry, onLineComment }: DiffViewerProps) {
  const [hunks, setHunks] = useState<DiffHunkDTO[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reloadToken = useRef(0);

  const loadPage = useCallback(
    async (cursor: string | null, token: number, append: boolean): Promise<void> => {
      if (!append) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);
      try {
        const page = await window.octopunk.invoke<DiffPageDTO>("review:get-diff", {
          runID,
          taskID,
          side,
          path,
          cursor,
        });
        if (reloadToken.current !== token) return; // 请求已被更新的切换作废
        setHunks((current) => (append ? [...current, ...page.hunks] : page.hunks));
        setNextCursor(page.nextCursor);
        setTruncated(page.truncated);
      } catch (caught) {
        if (reloadToken.current !== token) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        if (!append) {
          setHunks([]);
          setNextCursor(null);
        }
      } finally {
        if (reloadToken.current === token) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [runID, taskID, side, path],
  );

  useEffect(() => {
    if (path == null) return;
    const token = ++reloadToken.current;
    setHunks([]);
    setNextCursor(null);
    setTruncated(false);
    void loadPage(null, token, false);
  }, [loadPage, path]);

  if (path == null) {
    return (
      <div className="text-muted-foreground flex h-full flex-1 flex-col items-center justify-center gap-2 text-sm">
        <MessageSquarePlus className="size-5 opacity-50" aria-hidden />
        <p>从左侧变更树选择文件查看 Diff</p>
      </div>
    );
  }

  if (entry?.isBinary) {
    return (
      <div className="text-muted-foreground flex h-full flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm">
        <p className="text-foreground font-medium">二进制文件</p>
        <p className="text-xs">{path} 为二进制内容,无法逐行展示差异。</p>
        <Button
          variant="outline"
          size="sm"
          className="app-no-drag cursor-pointer"
          onClick={() =>
            onLineComment({ path, lineStart: 1, lineEnd: 1, contextSnapshot: "(二进制文件)" })
          }
        >
          <MessageSquarePlus aria-hidden />
          添加文件级评论
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {entry?.oversize && (
        <p className="border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-status-idle">
          文件超出单页读取上限,内容分页加载;未能加载的部分可在评论中人工备注。
        </p>
      )}
      {loading ? (
        <div className="flex flex-1 flex-col gap-1.5 p-3">
          {Array.from({ length: 10 }, (_, index) => (
            <Skeleton key={index} className="h-5 w-full" />
          ))}
        </div>
      ) : error != null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-status-error text-sm">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="app-no-drag cursor-pointer"
            onClick={() => {
              const token = ++reloadToken.current;
              void loadPage(null, token, false);
            }}
          >
            重试
          </Button>
        </div>
      ) : hunks.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-sm">
          该文件在此侧没有差异内容
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {hunks.map((hunk, index) => (
            <HunkBlock key={index} hunk={hunk} path={path} onLineComment={onLineComment} />
          ))}
          {nextCursor != null && (
            <div className="flex items-center justify-center gap-2 border-t p-2">
              <Button
                variant="outline"
                size="sm"
                disabled={loadingMore}
                className="app-no-drag cursor-pointer"
                onClick={() => void loadPage(nextCursor, reloadToken.current, true)}
              >
                {loadingMore ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
                {loadingMore ? "加载中…" : "加载更多"}
              </Button>
            </div>
          )}
          {truncated && (
            <p className="text-muted-foreground px-3 py-2 text-center text-xs">
              内容已截断(单文件过大),仅展示已加载部分。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
