// Review Center 变更树:按目录分组展示 DiffTreeEntryDTO,带 changeType 图标、
// +增/-删计数与二进制/超大/敏感标记。仅用 shadcn/ui 原语与 Tailwind 工具类。

import { ArrowRightLeft, Binary, FileMinus2, FilePen, FilePlus2, FileWarning } from "lucide-react";
import type { DiffTreeEntryDTO } from "../../../shared/dtos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * 敏感路径启发式:与主进程纯函数
 * electron/application/reviewCenterService.ts 的 sensitivePath(spec FR-004)保持
 * 同等规则——迁移目录、.env/.pem/key/secret/credential 文件名从宽标记。
 * 规则从宽:误标只是多一层提示,漏标才是风险。
 */
function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  // 数据库迁移目录(migrations/…)视为高风险变更来源。
  if (/(^|\/)migrations?\//.test(normalized)) return true;
  const fileName = normalized.substring(normalized.lastIndexOf("/") + 1);
  return (
    fileName.includes(".env") ||
    fileName.endsWith(".pem") ||
    fileName.includes("key") ||
    fileName.includes("secret") ||
    fileName.includes("credential")
  );
}

const CHANGE_TYPE_META: Record<
  DiffTreeEntryDTO["changeType"],
  { label: string; icon: typeof FilePen; className: string }
> = {
  added: { label: "新增", icon: FilePlus2, className: "text-status-running" },
  deleted: { label: "删除", icon: FileMinus2, className: "text-status-error" },
  modified: { label: "修改", icon: FilePen, className: "text-status-idle" },
  renamed: { label: "重命名", icon: ArrowRightLeft, className: "text-status-info" },
};

function FileRow({
  entry,
  active,
  onSelect,
}: {
  entry: DiffTreeEntryDTO;
  active: boolean;
  onSelect: (path: string) => void;
}) {
  const meta = CHANGE_TYPE_META[entry.changeType];
  const ChangeIcon = meta.icon;
  const dirEnd = entry.path.lastIndexOf("/");
  const baseName = dirEnd >= 0 ? entry.path.slice(dirEnd + 1) : entry.path;
  const sensitive = isSensitivePath(entry.path);

  return (
    <Button
      variant="ghost"
      size="sm"
      title={entry.path}
      onClick={() => onSelect(entry.path)}
      className={cn(
        "app-no-drag h-auto w-full cursor-pointer justify-start gap-2 rounded-md px-2 py-1.5 font-mono text-xs",
        active && "bg-accent text-accent-foreground",
      )}
    >
      <ChangeIcon className={cn("size-3.5 shrink-0", meta.className)} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{baseName}</span>
      {sensitive && (
        <Badge variant="outline" className="border-red-500/40 bg-red-500/10 px-1 py-0 text-[10px] text-status-error">
          敏感
        </Badge>
      )}
      {entry.isBinary && (
        <Badge variant="secondary" className="px-1 py-0 text-[10px]">
          <Binary className="size-2.5" aria-hidden />
          二进制
        </Badge>
      )}
      {entry.oversize && (
        <Badge variant="secondary" className="px-1 py-0 text-[10px]">
          <FileWarning className="size-2.5" aria-hidden />
          超大
        </Badge>
      )}
      <span className="flex shrink-0 items-center gap-1 font-mono tabular-nums">
        <span className="text-status-running">+{entry.additions}</span>
        <span className="text-status-error">-{entry.deletions}</span>
      </span>
    </Button>
  );
}

export function DiffTree({
  entries,
  activePath,
  loading,
  error,
  onSelect,
  onRetry,
}: {
  entries: DiffTreeEntryDTO[];
  activePath: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (path: string) => void;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="flex w-full flex-col gap-2 p-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-7 w-full" />
        ))}
      </div>
    );
  }

  if (error != null) {
    return (
      <div className="flex w-full flex-col items-center gap-2 p-4 text-center">
        <p className="text-status-error text-xs">{error}</p>
        <Button variant="outline" size="sm" onClick={onRetry} className="app-no-drag cursor-pointer">
          重试
        </Button>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="text-muted-foreground flex h-full w-full items-center justify-center p-4 text-center text-xs">
        该侧没有变更文件
      </div>
    );
  }

  // 平铺列表按文件所在目录分组渲染(根文件归入“(根目录)”)。
  const groups = new Map<string, DiffTreeEntryDTO[]>();
  for (const entry of [...entries].sort((lhs, rhs) => (lhs.path < rhs.path ? -1 : 1))) {
    const dirEnd = entry.path.lastIndexOf("/");
    const dir = dirEnd >= 0 ? entry.path.slice(0, dirEnd) : "";
    const label = dir.length === 0 ? "(根目录)" : dir;
    const bucket = groups.get(label);
    if (bucket == null) {
      groups.set(label, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  return (
    <nav className="flex w-full flex-col gap-3 overflow-y-auto p-2">
      {[...groups.entries()].map(([dir, files]) => (
        <div key={dir} className="flex flex-col gap-0.5">
          <p
            className="text-muted-foreground truncate px-2 py-1 font-mono text-[10px] font-medium tracking-wider uppercase"
            title={dir}
          >
            {dir}
          </p>
          {files.map((entry) => (
            <FileRow
              key={entry.path}
              entry={entry}
              active={entry.path === activePath}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}
