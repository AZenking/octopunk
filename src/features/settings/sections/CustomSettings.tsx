// 自定义 — host-wide custom instructions injected into every child agent
// prompt (AGENTS.md-style global guidance).

import { useEffect, useState } from "react";
import { useAppState } from "@/appState";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RowGroup, SectionLabel } from "@/features/settings/parts";

export function CustomSettings() {
  const appState = useAppState();
  const [customInstructions, setCustomInstructions] = useState("");
  const [savedCustomInstructions, setSavedCustomInstructions] = useState("");

  const persistCustomInstructions = (): void => {
    if (customInstructions === savedCustomInstructions) return;
    void window.octopunk
      .invoke("settings:set-custom-instructions", { text: customInstructions })
      .then(() => {
        setSavedCustomInstructions(customInstructions);
        appState.setStatusMessage(
          customInstructions.trim().length === 0
            ? "自定义指令已清空。"
            : "自定义指令已保存，将附加到此主机上的所有子 Agent 任务。",
        );
      })
      .catch((error) => {
        appState.setErrorMessage(error instanceof Error ? error.message : String(error));
      });
  };

  useEffect(() => {
    void window.octopunk
      .invoke<{ customInstructions: string }>("settings:get-custom-instructions")
      .then((value) => {
        setCustomInstructions(value.customInstructions);
        setSavedCustomInstructions(value.customInstructions);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <SectionLabel>全局指导</SectionLabel>
        <RowGroup>
          <div className="px-5 py-4">
            <div className="flex items-start justify-between gap-6">
              <div className="min-w-0">
                <p className="text-foreground text-sm font-medium">自定义指令</p>
                <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                  向 Claude Code / Codex 子 Agent
                  提供适用于此主机上所有任务的额外说明和上下文（类似 AGENTS.md 全局指导）。
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={customInstructions === savedCustomInstructions}
                onClick={persistCustomInstructions}
              >
                保存
              </Button>
            </div>
            <div className="mt-3 max-w-xl">
              <Textarea
                aria-label="自定义指令"
                value={customInstructions}
                onChange={(event) => setCustomInstructions(event.target.value)}
                onBlur={persistCustomInstructions}
                placeholder={"例如：\n- 使用 pnpm 管理依赖\n- 修改代码后运行相关测试\n- 汇报使用中文"}
                className="max-h-64 min-h-28 overflow-y-auto font-mono text-xs leading-relaxed"
              />
              <p className="text-muted-foreground mt-1.5 text-[11px]">
                {customInstructions.length > 0 ? `${customInstructions.length} 字符 · ` : ""}
                每次任务启动时注入到子 Agent 提示词（任务专属指令优先）；保存后对下一个任务生效，上限 32 KiB。
              </p>
            </div>
          </div>
        </RowGroup>
      </section>
    </div>
  );
}
