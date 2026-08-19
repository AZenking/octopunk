// 体检中心(Doctor)— 九项环境体检:CLI/GUI 路径、登录会话、MCP 控制面、
// Git 仓库、工作区磁盘、沙箱、Provider 配额与数据库健康。整体运行经
// doctor:run(耗时数秒,期间以 skeleton 占位);单项重检经
// doctor:rerun-item(只刷新对应行与 overall);脱敏诊断包经
// doctor:bundle 复制到剪贴板。最近报告经 doctor:latest 按仓库回读。

import { useEffect, useState } from "react";
import { Copy, FolderGit2, LoaderCircle } from "lucide-react";
import { useAppState } from "@/appState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { RowGroup, SectionLabel } from "@/features/settings/parts";
import { cn } from "@/lib/utils";
import type {
  DoctorCheckItemDTO,
  DoctorCheckKeyDTO,
  DoctorReportDTO,
} from "../../../shared/dtos";

/** 九项检查的中文标注(与 doctor_check_items.check_key 对齐)。 */
const CHECK_LABELS: Record<DoctorCheckKeyDTO, string> = {
  cli_path: "CLI 路径与版本",
  gui_path: "GUI 继承 PATH",
  login: "登录会话",
  mcp_stdio: "MCP 控制面",
  git_repo: "Git 仓库",
  worktree_disk: "工作区与磁盘",
  sandbox: "沙箱能力",
  provider_quota: "Provider 配额",
  db_health: "数据库健康",
};

/** 列表按固定顺序展示(与后端检查器的产出顺序一致)。 */
const CHECK_ORDER: readonly DoctorCheckKeyDTO[] = [
  "cli_path",
  "gui_path",
  "login",
  "mcp_stdio",
  "git_repo",
  "worktree_disk",
  "sandbox",
  "provider_quota",
  "db_health",
];

/** overall 三态:pass 绿 / degraded 琥珀 / fail 红。 */
const OVERALL_BADGES: Record<
  DoctorReportDTO["overall"],
  { label: string; variant: "secondary" | "destructive"; className: string }
> = {
  pass: {
    label: "全部通过",
    variant: "secondary",
    className: "border-transparent bg-emerald-500/10 text-status-running",
  },
  degraded: {
    label: "部分降级",
    variant: "secondary",
    className: "border-transparent bg-amber-500/10 text-status-idle",
  },
  fail: { label: "存在问题", variant: "destructive", className: "" },
};

/** 逐项三态:unknown 用琥珀呈现(不阻塞,绝不使用失败色)。 */
const ITEM_BADGES: Record<
  DoctorCheckItemDTO["status"],
  { label: string; variant: "secondary" | "destructive"; className: string }
> = {
  pass: {
    label: "通过",
    variant: "secondary",
    className: "border-transparent bg-emerald-500/10 text-status-running",
  },
  fail: { label: "失败", variant: "destructive", className: "" },
  unknown: {
    label: "无法确认",
    variant: "secondary",
    className: "border-transparent bg-amber-500/10 text-status-idle",
  },
};

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

export function DoctorView() {
  const appState = useAppState();
  const [repositoryPath, setRepositoryPath] = useState(appState.repositoryPath.trim());
  const [report, setReport] = useState<DoctorReportDTO | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(true);
  const [running, setRunning] = useState(false);
  const [rerunningKey, setRerunningKey] = useState<DoctorCheckKeyDTO | null>(null);
  const [copying, setCopying] = useState(false);

  const path = repositoryPath.trim();

  // 路径变化时回读该仓库的最近报告(留空 = 全局报告);体检进行中不回读,
  // 避免覆盖 doctor:run 即将写入的新结果。
  useEffect(() => {
    if (running) return;
    let stale = false;
    setLoadingLatest(true);
    window.octopunk
      .invoke<DoctorReportDTO | null>("doctor:latest", {
        repositoryPath: path.length > 0 ? path : null,
      })
      .then((result) => {
        if (!stale) setReport(result);
      })
      .catch(() => {
        if (!stale) setReport(null);
      })
      .finally(() => {
        if (!stale) setLoadingLatest(false);
      });
    return () => {
      stale = true;
    };
  }, [path, running]);

  const runCheckup = async (): Promise<void> => {
    if (running) return;
    setRunning(true);
    try {
      const result = await window.octopunk.invoke<DoctorReportDTO>("doctor:run", {
        repositoryPath: path.length > 0 ? path : null,
      });
      setReport(result);
    } catch (error) {
      appState.setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  const rerunItem = async (checkKey: DoctorCheckKeyDTO): Promise<void> => {
    if (report == null || running || rerunningKey != null) return;
    setRerunningKey(checkKey);
    try {
      const updated = await window.octopunk.invoke<DoctorReportDTO>("doctor:rerun-item", {
        requestID: crypto.randomUUID(),
        reportID: report.id,
        checkKey,
      });
      setReport(updated);
    } catch (error) {
      appState.setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRerunningKey(null);
    }
  };

  const copyBundle = async (): Promise<void> => {
    if (report == null || copying) return;
    setCopying(true);
    try {
      const bundle = await window.octopunk.invoke<string>("doctor:bundle", { report });
      await navigator.clipboard.writeText(bundle);
      appState.setStatusMessage("脱敏诊断包已复制到剪贴板,可直接分享给排查人员。");
    } catch (error) {
      appState.setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCopying(false);
    }
  };

  const busy = running || (loadingLatest && report == null);
  const items =
    report == null
      ? []
      : [...report.items].sort(
          (a, b) => CHECK_ORDER.indexOf(a.checkKey) - CHECK_ORDER.indexOf(b.checkKey),
        );

  return (
    <div className="flex flex-col gap-8">
      <section>
        <SectionLabel>体检对象</SectionLabel>
        <div className="border-border flex items-center gap-3 rounded-xl border px-5 py-4">
          <FolderGit2 className="text-primary size-4 shrink-0" aria-hidden />
          <Input
            aria-label="体检仓库路径"
            value={repositoryPath}
            onChange={(event) => setRepositoryPath(event.target.value)}
            placeholder="/path/to/repository(留空则只检查全局项)"
            className="font-mono text-xs"
          />
          <Button
            disabled={running}
            onClick={() => void runCheckup()}
            className="app-no-drag shrink-0 cursor-pointer"
          >
            {running ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
            运行体检
          </Button>
          {report != null && (
            <Button
              variant="outline"
              disabled={copying}
              onClick={() => void copyBundle()}
              className="app-no-drag shrink-0 cursor-pointer"
            >
              {copying ? (
                <LoaderCircle className="animate-spin" aria-hidden />
              ) : (
                <Copy aria-hidden />
              )}
              复制诊断包
            </Button>
          )}
        </div>
        <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
          体检覆盖 CLI 路径与版本、GUI 继承 PATH、登录会话、MCP 控制面、Git
          仓库、工作区与磁盘、沙箱能力、Provider 配额、数据库健康共九项;仓库路径留空时只检查与仓库无关的全局项。运行可能需要数秒,结果按仓库保留最近一份。
        </p>
      </section>

      <section>
        <SectionLabel>体检结果</SectionLabel>
        {busy ? (
          <div className="border-border divide-border divide-y rounded-xl border">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="flex flex-col gap-2.5 px-5 py-4">
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        ) : report == null ? (
          <div className="border-border text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
            <p className="text-foreground text-sm font-medium">还没有体检报告</p>
            <p className="max-w-md text-xs leading-relaxed">
              确认上方仓库路径后点击「运行体检」,即可对 CLI 与 GUI
              环境、登录会话、MCP 控制面、Git 仓库与磁盘等九项能力做一次快速体检;遇到问题可复制脱敏诊断包分享排查。
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="border-border flex items-center gap-3 rounded-xl border px-5 py-4">
              <Badge
                variant={OVERALL_BADGES[report.overall].variant}
                className={OVERALL_BADGES[report.overall].className}
              >
                {OVERALL_BADGES[report.overall].label}
              </Badge>
              <p className="text-muted-foreground text-xs">
                报告时间:{formatTime(report.createdAt)}
              </p>
              {report.repositoryPath != null && (
                <p className="text-muted-foreground/70 min-w-0 truncate font-mono text-[11px]">
                  {report.repositoryPath}
                </p>
              )}
            </div>

            <RowGroup>
              {items.map((item) => {
                const badge = ITEM_BADGES[item.status];
                const rerunning = rerunningKey === item.checkKey;
                return (
                  <div key={item.checkKey} className="flex flex-col gap-2 px-5 py-4">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="text-foreground text-sm font-medium">
                        {CHECK_LABELS[item.checkKey]}
                      </p>
                      <span className="text-muted-foreground/60 font-mono text-[11px]">
                        {item.checkKey}
                      </span>
                      <Badge
                        variant={badge.variant}
                        className={cn("px-1.5 py-0 text-[10px]", badge.className)}
                      >
                        {badge.label}
                      </Badge>
                      <span className="text-muted-foreground/60 ml-auto font-mono text-[11px]">
                        {item.durationMs} ms
                      </span>
                      {item.status !== "pass" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={running || rerunningKey != null}
                          onClick={() => void rerunItem(item.checkKey)}
                          className="app-no-drag h-6 shrink-0 cursor-pointer px-2 text-[11px]"
                        >
                          {rerunning ? (
                            <LoaderCircle className="animate-spin" aria-hidden />
                          ) : null}
                          重新检测
                        </Button>
                      )}
                    </div>
                    {item.status === "unknown" && (
                      <p className="text-status-idle text-[11px] leading-relaxed">
                        {item.checkKey === "provider_quota"
                          ? "无法确认(不阻塞):Provider 配额无法在本机可靠读取,该项固定显示为「无法确认」,不代表异常;如需核对请前往对应 Provider 控制台查看。"
                          : "无法确认(不阻塞):该检查超时或结果不可判定,不影响其他项,建议人工复核或点击「重新检测」。"}
                      </p>
                    )}
                    <pre className="bg-muted text-foreground w-full rounded-md p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                      {item.detail}
                    </pre>
                    {item.impact.length > 0 && (
                      <p
                        className={cn(
                          "text-xs leading-relaxed",
                          item.status === "fail" ? "text-status-error" : "text-foreground/80",
                        )}
                      >
                        影响:{item.impact}
                      </p>
                    )}
                    {item.suggestion.length > 0 && (
                      <p className="text-muted-foreground text-xs leading-relaxed">
                        建议:{item.suggestion}
                      </p>
                    )}
                  </div>
                );
              })}
            </RowGroup>

            <p className="text-muted-foreground text-[11px] leading-relaxed">
              overall 判定:任一项失败即「存在问题」;无失败但有「无法确认」项即「部分降级」;九项全部通过即「全部通过」。「复制诊断包」导出的内容已经脱敏,不含令牌等敏感信息,可放心分享。
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
