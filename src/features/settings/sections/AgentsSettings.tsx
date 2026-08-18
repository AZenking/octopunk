// 外部 Agent — delegation executors: enable/disable per agent and configure
// the executable path (with availability check) in a dialog.

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { useAppState, type ChildAgentKindValue } from "@/appState";
import { AgentMark, agentLabel } from "@/components/AgentMark";
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
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AvailabilityMeta, SectionLabel } from "@/features/settings/parts";
import { cn } from "@/lib/utils";

const AGENTS: { kind: ChildAgentKindValue; placeholder: string; hint: string }[] = [
  {
    kind: "claude_code",
    placeholder: "claude",
    hint: "留空或裸名自动解析（Homebrew / fnm / volta / PATH），显式路径原样使用；保存后重启生效。",
  },
  {
    kind: "codex",
    placeholder: "codex",
    hint: "app-server JSON-RPC 适配；权限审批按任务策略评估，不自动放行；保存后重启生效。",
  },
];

export function AgentsSettings() {
  const appState = useAppState();
  const [executables, setExecutables] = useState<Record<ChildAgentKindValue, string>>({
    claude_code: "",
    codex: "",
  });
  const [dialogKind, setDialogKind] = useState<ChildAgentKindValue | null>(null);
  const dialogAgent = AGENTS.find((agent) => agent.kind === dialogKind) ?? null;

  useEffect(() => {
    void window.octopunk
      .invoke<{ claudeExecutable: string; codexExecutable: string }>("settings:get-executables")
      .then((value) => {
        setExecutables({ claude_code: value.claudeExecutable, codex: value.codexExecutable });
      })
      .catch(() => {});
  }, []);

  const persistExecutable = (kind: ChildAgentKindValue, path: string): void => {
    void window.octopunk
      .invoke("settings:set-executable", { kind, path })
      .catch((error) => {
        appState.setErrorMessage(error instanceof Error ? error.message : String(error));
      });
  };

  return (
    <div className="flex flex-col gap-8">
      <section>
        <SectionLabel>执行器</SectionLabel>
        <div className="border-border divide-border divide-y rounded-xl border">
          {AGENTS.map((agent) => {
            const disabled = appState.disabledAgents.has(agent.kind);
            const availability =
              agent.kind === "claude_code" ? appState.claudeAvailability : appState.codexAvailability;
            return (
              <div key={agent.kind} className="flex items-center gap-3 px-5 py-4">
                <AgentMark agentKind={agent.kind} className={cn(disabled && "opacity-50")} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className={cn("text-foreground text-sm font-medium", disabled && "opacity-60")}>
                      {agentLabel(agent.kind)}
                    </p>
                    <span className="text-muted-foreground/60 font-mono text-[11px]">
                      {agent.placeholder}
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          tabIndex={0}
                          className="text-muted-foreground/60 hover:text-muted-foreground cursor-help"
                        >
                          <Info className="size-3.5" aria-hidden />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-72 text-xs leading-relaxed">
                        {agent.hint}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    {disabled ? (
                      <span className="text-muted-foreground text-[11px]">已停用 · 不再出现在委派入口</span>
                    ) : (
                      <AvailabilityMeta result={availability} />
                    )}
                  </div>
                </div>
                <Switch
                  aria-label={`启用 ${agentLabel(agent.kind)}`}
                  checked={!disabled}
                  onCheckedChange={(enabled) => void appState.setAgentEnabled(agent.kind, enabled)}
                />
                <Button variant="outline" size="sm" onClick={() => setDialogKind(agent.kind)}>
                  配置
                </Button>
              </div>
            );
          })}
        </div>
        <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
          停用仅影响新的委派入口；进行中任务与历史运行不受影响。全部停用后将无法委派新任务。
        </p>
      </section>

      <Dialog
        open={dialogKind != null}
        onOpenChange={(open) => {
          if (!open) setDialogKind(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          {dialogAgent != null && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <AgentMark agentKind={dialogAgent.kind} size="sm" />
                  配置 {agentLabel(dialogAgent.kind)}
                </DialogTitle>
                <DialogDescription>{dialogAgent.hint}</DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`${agentLabel(dialogAgent.kind)} 可执行文件`}
                  value={executables[dialogAgent.kind]}
                  onChange={(event) =>
                    setExecutables((current) => ({
                      ...current,
                      [dialogAgent.kind]: event.target.value,
                    }))
                  }
                  onBlur={() =>
                    persistExecutable(dialogAgent.kind, executables[dialogAgent.kind])
                  }
                  placeholder={dialogAgent.placeholder}
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  onClick={() => {
                    persistExecutable(dialogAgent.kind, executables[dialogAgent.kind]);
                    void appState.testAgentExecutable(
                      dialogAgent.kind,
                      executables[dialogAgent.kind],
                    );
                  }}
                >
                  检测
                </Button>
              </div>
              <div className="text-muted-foreground min-h-4 text-[11px]">
                <AvailabilityMeta
                  result={
                    dialogAgent.kind === "claude_code"
                      ? appState.claudeAvailability
                      : appState.codexAvailability
                  }
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogKind(null)}>
                  关闭
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
