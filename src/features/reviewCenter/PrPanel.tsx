// GitHub PR 回灌小组件(specs/002-v04 User Story 4 / FR-015、FR-016):
// 无关联 PR 且已启用 →「创建 PR」(Dialog 可编辑 title/body);有关联 →
// 外开链接 + 「刷新状态」(state/检查汇总/最近 3 条评论,评论已在适配器 redact)。
// 任何 gh 错误只降级为本面板内的可读中文错误条,不影响审查与门禁。
// 默认关闭:未启用时不发起任何 gh 调用,仅提示到设置开启。

import { ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** pr:status 通道载荷(与 electron/ipc.ts PrStatusPayload 同构的渲染层投影)。 */
interface PrLinkLite {
  prURL: string;
  prNumber: number;
  lastSyncedAt: number;
}

interface PrStatusLite {
  state: string;
  statusChecks: { name: string; status: string; conclusion: string | null }[];
  comments: { author: string; body: string; createdAt: string }[];
}

interface PrStatusPayload {
  enabled: boolean;
  link: PrLinkLite | null;
  status: PrStatusLite | null;
  error: string | null;
}

function formatEpoch(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

function stateBadge(state: string): { label: string; variant: "secondary" | "destructive" | "default" } {
  if (state === "MERGED") return { label: "已合并", variant: "default" };
  if (state === "CLOSED") return { label: "已关闭", variant: "destructive" };
  if (state === "OPEN") return { label: "开放中", variant: "secondary" };
  return { label: state, variant: "secondary" };
}

function checkSummary(status: PrStatusLite): string {
  const passed = status.statusChecks.filter((check) => check.conclusion === "SUCCESS").length;
  return `检查 ${status.statusChecks.length} 项 · 通过 ${passed}`;
}

/** 最近 3 条评论(适配器按时间正序保留,取尾部倒序 = 最新在前)。 */
function latestComments(status: PrStatusLite): PrStatusLite["comments"] {
  return [...status.comments].slice(-3).reverse();
}

export function PrPanel({ runID, taskID, taskTitle }: { runID: string; taskID: string; taskTitle: string }) {
  const [payload, setPayload] = useState<PrStatusPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [bodyDraft, setBodyDraft] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setActionError(null);
    try {
      const result = await window.octopunk.invoke<PrStatusPayload>("pr:status", { runID, taskID });
      setPayload(result);
    } catch (caught) {
      // 通道本身失败(如 link 读取异常)也只降级为面板内错误条。
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [runID, taskID]);

  useEffect(() => {
    setPayload(null);
    setActionError(null);
    void load();
  }, [load]);

  const openCreateDialog = (): void => {
    setTitleDraft(`[OctoPunk] ${taskTitle}`);
    setBodyDraft("");
    setActionError(null);
    setDialogOpen(true);
  };

  const create = async (): Promise<void> => {
    setCreating(true);
    setActionError(null);
    try {
      await window.octopunk.invoke<{ url: string; number: number }>("pr:create", {
        runID,
        taskID,
        title: titleDraft,
        body: bodyDraft,
      });
      setDialogOpen(false);
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="border-border flex shrink-0 flex-col border-t">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
        <h2 className="text-sm font-semibold">GitHub PR</h2>
        {payload?.link != null && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">#{payload.link.prNumber}</Badge>}
        {payload?.status != null && (() => {
          const state = stateBadge(payload.status.state);
          return (
            <Badge variant={state.variant} className="px-1.5 py-0 text-[10px]">
              {state.label}
            </Badge>
          );
        })()}
        <span className="ml-auto flex items-center gap-1.5">
          {payload?.link == null && payload?.enabled === true && (
            <Button
              variant="outline"
              size="sm"
              onClick={openCreateDialog}
              className="app-no-drag cursor-pointer"
            >
              创建 PR
            </Button>
          )}
          {payload?.link != null && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="刷新 PR 状态"
              title="刷新 PR 状态"
              disabled={loading}
              onClick={() => void load()}
              className="app-no-drag cursor-pointer"
            >
              {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            </Button>
          )}
        </span>
      </div>
      {actionError != null && <p className="text-status-error px-3 pb-1.5 text-xs">{actionError}</p>}
      {payload?.error != null && <p className="text-status-error px-3 pb-1.5 text-xs">{payload.error}</p>}
      <div className="px-3 pb-3">
        {loading && payload == null ? null : payload == null ? (
          <p className="text-muted-foreground text-xs">GitHub 回灌状态未知。</p>
        ) : payload.link == null ? (
          <p className="text-muted-foreground text-xs">
            {payload.enabled
              ? "该任务尚未关联 PR;通过审查后可点击「创建 PR」(经本机 gh CLI,凭证不落库)。"
              : "GitHub 回灌未启用;可在 设置 → 连接与 MCP 开启后为通过审查的任务创建 PR。"}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" asChild className="app-no-drag h-7 px-2 text-xs">
                <a href={payload.link.prURL} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3" aria-hidden />
                  在 GitHub 打开
                </a>
              </Button>
              <span className="text-muted-foreground font-mono text-[10px]">
                最近同步 {formatEpoch(payload.link.lastSyncedAt)}
              </span>
            </div>
            {payload.status != null ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-muted-foreground text-xs">{checkSummary(payload.status)}</p>
                {latestComments(payload.status).map((comment, index) => (
                  <p
                    key={`${comment.author}:${comment.createdAt}:${index}`}
                    className="bg-muted text-foreground line-clamp-2 rounded-md px-2 py-1 text-xs leading-4"
                    title={comment.body}
                  >
                    <span className="text-muted-foreground font-medium">{comment.author}:</span>{" "}
                    {comment.body}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">尚未拉取状态;点击右上角刷新。</p>
            )}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="app-no-drag sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>创建 GitHub PR</DialogTitle>
            <DialogDescription>
              经本机 gh CLI 创建(head = 任务分支,base = 运行目标分支);OctoPunk 不保存任何 GitHub 凭证。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pr-title">标题</Label>
              <Input
                id="pr-title"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                placeholder="[OctoPunk] 任务标题"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pr-body">描述(可选)</Label>
              <Textarea
                id="pr-body"
                value={bodyDraft}
                onChange={(event) => setBodyDraft(event.target.value)}
                placeholder="留空则自动生成 OctoPunk 任务上下文摘要。"
                className="min-h-24"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={creating} onClick={() => setDialogOpen(false)} className="cursor-pointer">
              取消
            </Button>
            <Button disabled={creating || titleDraft.trim().length === 0} onClick={() => void create()} className="cursor-pointer">
              {creating ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
