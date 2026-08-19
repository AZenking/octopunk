// New TeamRun page (extracted from the former dashboard start form).

import { FolderGit2, Play, Users } from "lucide-react";
import { useState } from "react";
import { useAppState, type ChildAgentKindValue } from "@/appState";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { GateReviewMode, GateStartOverrideDTO } from "../../../shared/dtos";
import { cn } from "@/lib/utils";

const GATE_REVIEW_MODES: { value: GateReviewMode; label: string }[] = [
  { value: "standard", label: "标准(standard)" },
  { value: "cross_model", label: "跨模型(cross_model)" },
  { value: "dual_readonly", label: "双只读(dual_readonly)" },
  { value: "contest", label: "竞赛(contest)" },
  { value: "role_based", label: "角色分工(role_based)" },
  { value: "arbitration", label: "仲裁(arbitration)" },
];

export function StartForm({ onStarted }: { onStarted?: () => void }) {
  const appState = useAppState();
  const availability = appState.availability(appState.childAgentKind);
  const agentDisabled = appState.disabledAgents.has(appState.childAgentKind);
  const canStart =
    appState.repositoryPath.trim().length > 0 && appState.teamTask.trim().length > 0;
  const canDelegate =
    appState.selectedRunID != null &&
    !agentDisabled &&
    appState.childTitle.length > 0 &&
    appState.childPrompt.length > 0 &&
    appState.availability(appState.childAgentKind)?.isAvailable === true;

  // 门禁覆盖(仅本次运行的轻量覆盖;完整配置在「设置 → 质量门禁」)。
  const [gateOverrideOn, setGateOverrideOn] = useState(false);
  const [gateMaxRiskFindings, setGateMaxRiskFindings] = useState(0);
  const [gateReviewMode, setGateReviewMode] = useState<GateReviewMode>("standard");
  const [gateRequireDependencies, setGateRequireDependencies] = useState(false);
  const [gateRequireBaselineSafe, setGateRequireBaselineSafe] = useState(false);
  const [gateManualConfirmHighRisk, setGateManualConfirmHighRisk] = useState(false);

  const gateOverride: GateStartOverrideDTO | undefined = gateOverrideOn
    ? {
        maxRiskFindings: Math.max(0, gateMaxRiskFindings),
        reviewMode: gateReviewMode,
        requireDependenciesAccepted: gateRequireDependencies,
        requireTargetBaselineSafe: gateRequireBaselineSafe,
        manualConfirmHighRisk: gateManualConfirmHighRisk,
      }
    : undefined;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-8">
      <div className="flex items-start gap-4">
        <div className="bg-primary/15 text-primary ring-primary/20 flex size-11 shrink-0 items-center justify-center rounded-xl ring-1">
          <Play className="size-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">新建 TeamRun</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            锚定仓库 HEAD 建立运行，然后委派受控的子 Agent 任务。
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FolderGit2 className="text-primary size-4" aria-hidden />
            仓库与任务
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_150px]">
            <div className="flex flex-col gap-2">
              <Label htmlFor="repository-path">Git 仓库路径</Label>
              <div className="flex gap-2">
                <Input
                  id="repository-path"
                  value={appState.repositoryPath}
                  onChange={(event) => appState.setRepositoryPath(event.target.value)}
                  placeholder="/path/to/repository"
                  className="font-mono text-xs"
                />
                <Button variant="outline" onClick={() => void appState.pickRepository()}>
                  选择…
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="review-rounds">审查轮次</Label>
              <Input
                id="review-rounds"
                type="number"
                min={1}
                max={20}
                value={appState.maxReviewRounds}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(value)) {
                    appState.setMaxReviewRounds(Math.min(20, Math.max(1, value)));
                  }
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="team-task">团队任务</Label>
            <Textarea
              id="team-task"
              value={appState.teamTask}
              onChange={(event) => appState.setTeamTask(event.target.value)}
              className="min-h-[100px]"
            />
          </div>
          <div className="border-border flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-foreground text-sm font-medium">门禁覆盖</p>
                <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                  仅本次运行覆盖项目门禁配置的轻量字段;完整配置在「设置 → 质量门禁」。
                </p>
              </div>
              <Switch
                aria-label="启用门禁覆盖"
                checked={gateOverrideOn}
                onCheckedChange={setGateOverrideOn}
                className="app-no-drag"
              />
            </div>
            {gateOverrideOn && (
              <div className="border-border/60 flex flex-col gap-4 rounded-lg border bg-muted/30 p-3">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-[120px_1fr]">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="gate-max-risk">风险发现上限</Label>
                    <Input
                      id="gate-max-risk"
                      type="number"
                      min={0}
                      value={gateMaxRiskFindings}
                      onChange={(event) => {
                        const value = Number.parseInt(event.target.value, 10);
                        if (Number.isFinite(value)) {
                          setGateMaxRiskFindings(Math.max(0, value));
                        }
                      }}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>审查模式</Label>
                    <Select
                      value={gateReviewMode}
                      onValueChange={(value) => setGateReviewMode(value as GateReviewMode)}
                    >
                      <SelectTrigger size="sm" className="app-no-drag w-full cursor-pointer">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {GATE_REVIEW_MODES.map((mode) => (
                          <SelectItem key={mode.value} value={mode.value} className="cursor-pointer">
                            {mode.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex flex-col gap-2.5">
                  <Label className="text-xs">布尔条件覆盖</Label>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                    {(
                      [
                        {
                          label: "依赖任务须全部接受",
                          checked: gateRequireDependencies,
                          setter: setGateRequireDependencies,
                        },
                        {
                          label: "目标基线须安全",
                          checked: gateRequireBaselineSafe,
                          setter: setGateRequireBaselineSafe,
                        },
                        {
                          label: "高风险须人工确认",
                          checked: gateManualConfirmHighRisk,
                          setter: setGateManualConfirmHighRisk,
                        },
                      ] as const
                    ).map((item) => (
                      <Label
                        key={item.label}
                        className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-transparent px-1 py-0.5 text-xs font-normal"
                      >
                        {item.label}
                        <Switch
                          aria-label={item.label}
                          checked={item.checked}
                          onCheckedChange={item.setter}
                          className="app-no-drag"
                        />
                      </Label>
                    ))}
                  </div>
                  <p className="text-muted-foreground text-[11px] leading-relaxed">
                    命令检查等完整覆盖不支持在此设置;「竞赛」模式与「依赖任务须全部接受」互斥。
                  </p>
                </div>
              </div>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            运行锚定仓库当前 HEAD；未提交变更将被提示并忽略。
          </p>
          <Button
            className="w-fit"
            disabled={!canStart}
            onClick={() =>
              void appState.startTeam(gateOverride).then(() => {
                onStarted?.();
              })
            }
          >
            <Play aria-hidden />
            启动 TeamRun
          </Button>
        </CardContent>
      </Card>

      {appState.selectedRunID != null && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="text-primary size-4" aria-hidden />
              委派单个外部 Agent
            </CardTitle>
            <CardDescription>显式 Agent 类型与最小权限执行模式。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_160px_150px_180px]">
              <div className="flex flex-col gap-2">
                <Label htmlFor="child-title">任务标题</Label>
                <Input
                  id="child-title"
                  value={appState.childTitle}
                  onChange={(event) => appState.setChildTitle(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>Agent</Label>
                <Select
                  value={appState.childAgentKind}
                  onValueChange={(value) =>
                    appState.setChildAgentKind(value as ChildAgentKindValue)
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {!appState.disabledAgents.has("claude_code") && (
                      <SelectItem value="claude_code">Claude Code</SelectItem>
                    )}
                    {!appState.disabledAgents.has("codex") && <SelectItem value="codex">Codex</SelectItem>}
                    {!appState.disabledAgents.has("pi") && <SelectItem value="pi">Pi</SelectItem>}
                  </SelectContent>
                </Select>
                {appState.disabledAgents.size >= 3 && (
                  <p className="text-muted-foreground text-xs">
                    所有 Agent 均已停用；请在设置的「外部 Agent」中启用后再委派。
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <Label>执行模式</Label>
                <Select
                  value={appState.childExecutionMode}
                  onValueChange={(value) =>
                    appState.setChildExecutionMode(value as "read_only" | "workspace_write")
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read_only">只读</SelectItem>
                    <SelectItem value="workspace_write">工作区写入</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="child-model">模型（可选）</Label>
                <Input
                  id="child-model"
                  value={appState.childModelOverride}
                  onChange={(event) => appState.setChildModelOverride(event.target.value)}
                  placeholder={
                    appState.childAgentKind === "claude_code"
                      ? "如 glm-5.2；留空用全局"
                      : appState.childAgentKind === "pi"
                        ? "如 anthropic/claude-sonnet-4-5"
                        : "如 gpt-5.5-codex"
                  }
                  className="font-mono text-xs"
                />
                <p className="text-muted-foreground text-xs">
                  仅对本任务生效；留空使用设置中的全局模型覆盖。
                </p>
              </div>
            </div>
            {availability != null && (
              <div
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-2 font-mono text-xs",
                  availability.isAvailable
                    ? "border-emerald-500/25 bg-emerald-500/5 text-status-running"
                    : "border-amber-500/25 bg-amber-500/5 text-status-idle",
                )}
              >
                {availability.detail}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="child-prompt">提示词</Label>
              <Textarea
                id="child-prompt"
                value={appState.childPrompt}
                onChange={(event) => appState.setChildPrompt(event.target.value)}
                className="min-h-[120px]"
              />
            </div>
            <Button
              className="w-fit"
              disabled={!canDelegate}
              onClick={() => void appState.delegateChildTask()}
            >
              <Users aria-hidden />
              委派任务
            </Button>
          </CardContent>
        </Card>
      )}

      {appState.migrationMessage != null && (
        <p className="text-muted-foreground text-xs">{appState.migrationMessage}</p>
      )}
    </div>
  );
}
