// 质量门禁 — 项目级门禁配置(project_gate_configs):按仓库路径编辑四类
// 命令检查与判定条件;保存经 gate:set-config,矛盾配置由主进程以
// DomainError 拒绝并经既有错误提示机制展示。加载经 gate:get-config 回填。

import { useEffect, useState } from "react";
import { LoaderCircle, FolderGit2 } from "lucide-react";
import { useAppState, type ChildAgentKindValue } from "@/appState";
import { agentLabel } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { GateConfigDTO, GateReviewMode } from "../../../../shared/dtos";
import { Row, RowGroup, SectionLabel } from "@/features/settings/parts";

type CommandKey = "tests" | "lint" | "typecheck" | "build";

interface CheckDraft {
  enabled: boolean;
  command: string;
  timeoutSeconds: number;
}

/** 与 electron/domain/policy.ts 的保存校验一致(超时 1–600 秒)。 */
const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 600;

const COMMAND_CHECKS: { key: CommandKey; label: string; placeholder: string }[] = [
  { key: "tests", label: "测试", placeholder: "如 pnpm test" },
  { key: "lint", label: "静态检查", placeholder: "如 pnpm lint" },
  { key: "typecheck", label: "类型检查", placeholder: "如 pnpm run typecheck" },
  { key: "build", label: "构建", placeholder: "如 pnpm build" },
];

const REVIEWER_KINDS: ChildAgentKindValue[] = ["claude_code", "codex", "pi"];

const REVIEW_MODES: { value: GateReviewMode; label: string }[] = [
  { value: "standard", label: "标准(standard)" },
  { value: "cross_model", label: "跨模型(cross_model)" },
  { value: "dual_readonly", label: "双只读(dual_readonly)" },
  { value: "contest", label: "竞赛(contest)" },
  { value: "role_based", label: "角色分工(role_based)" },
  { value: "arbitration", label: "仲裁(arbitration)" },
];

function clampTimeout(value: number): number {
  return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(value)));
}

/** 默认草稿:与 spec 002 的归一化默认一致(review_mode=standard、max_risk_findings=0、列表为空)。 */
function defaultDraft(): {
  checks: Record<CommandKey, CheckDraft>;
  maxRiskFindings: number;
  scopeAllowedPathsText: string;
  requireDependenciesAccepted: boolean;
  requireTargetBaselineSafe: boolean;
  manualConfirmHighRisk: boolean;
  requireTodoClean: boolean;
  requiredReviewers: string[];
  reviewMode: GateReviewMode;
} {
  return {
    checks: {
      tests: { enabled: false, command: "", timeoutSeconds: 120 },
      lint: { enabled: false, command: "", timeoutSeconds: 120 },
      typecheck: { enabled: false, command: "", timeoutSeconds: 120 },
      build: { enabled: false, command: "", timeoutSeconds: 300 },
    },
    maxRiskFindings: 0,
    scopeAllowedPathsText: "",
    requireDependenciesAccepted: false,
    requireTargetBaselineSafe: false,
    manualConfirmHighRisk: false,
    requireTodoClean: false,
    requiredReviewers: [],
    reviewMode: "standard",
  };
}

export function GateSettings() {
  const appState = useAppState();
  const [repositoryPath, setRepositoryPath] = useState(appState.repositoryPath.trim());
  const [draft, setDraft] = useState(defaultDraft);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const path = repositoryPath.trim();

  // 路径变化时回填已保存配置(default 优先,其次 effective)。
  useEffect(() => {
    if (path.length === 0) return;
    let stale = false;
    setLoading(true);
    window.octopunk
      .invoke<{ default: GateConfigDTO | null; effective: GateConfigDTO | null }>(
        "gate:get-config",
        { repositoryPath: path },
      )
      .then((result) => {
        if (stale) return;
        const config = result.default ?? result.effective;
        if (config == null) {
          setDraft(defaultDraft());
          return;
        }
        setDraft(() => ({
          checks: {
            tests: {
              enabled: config.checks.tests != null,
              command: config.checks.tests?.command ?? "",
              timeoutSeconds: clampTimeout(config.checks.tests?.timeoutSeconds ?? 120),
            },
            lint: {
              enabled: config.checks.lint != null,
              command: config.checks.lint?.command ?? "",
              timeoutSeconds: clampTimeout(config.checks.lint?.timeoutSeconds ?? 120),
            },
            typecheck: {
              enabled: config.checks.typecheck != null,
              command: config.checks.typecheck?.command ?? "",
              timeoutSeconds: clampTimeout(config.checks.typecheck?.timeoutSeconds ?? 120),
            },
            build: {
              enabled: config.checks.build != null,
              command: config.checks.build?.command ?? "",
              timeoutSeconds: clampTimeout(config.checks.build?.timeoutSeconds ?? 300),
            },
          },
          maxRiskFindings: Math.max(0, config.maxRiskFindings),
          scopeAllowedPathsText: config.scopeAllowedPaths.join("\n"),
          requireDependenciesAccepted: config.requireDependenciesAccepted,
          requireTargetBaselineSafe: config.requireTargetBaselineSafe,
          manualConfirmHighRisk: config.manualConfirmHighRisk,
          requireTodoClean: config.requireTodoClean,
          requiredReviewers: config.requiredReviewers.filter((kind): kind is ChildAgentKindValue =>
            REVIEWER_KINDS.includes(kind as ChildAgentKindValue),
          ),
          reviewMode: config.reviewMode,
        }));
      })
      .catch(() => {
        // 未注册/读取失败:保持默认草稿,保存时仍会给出错误。
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [path]);

  const pickRepository = async (): Promise<void> => {
    try {
      const result = await window.octopunk.invoke<{ path: string | null }>("app:pick-repository");
      if (result.path != null) {
        setRepositoryPath(result.path);
      }
    } catch (error) {
      appState.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const updateCheck = (key: CommandKey, patch: Partial<CheckDraft>): void => {
    setDraft((current) => ({
      ...current,
      checks: { ...current.checks, [key]: { ...current.checks[key], ...patch } },
    }));
  };

  const toggleReviewer = (kind: ChildAgentKindValue, enabled: boolean): void => {
    setDraft((current) => ({
      ...current,
      requiredReviewers: enabled
        ? [...new Set([...current.requiredReviewers, kind])]
        : current.requiredReviewers.filter((value) => value !== kind),
    }));
  };

  const save = async (): Promise<void> => {
    if (path.length === 0) {
      appState.setErrorMessage("请先填写项目仓库路径,门禁配置按仓库保存。");
      return;
    }
    // 空命令 = 未启用该检查(null);reviewers 按固定顺序输出,保证幂等保存。
    const commandConfig = (key: CommandKey): { command: string; timeoutSeconds: number } | null => {
      const check = draft.checks[key];
      const command = check.command.trim();
      if (!check.enabled || command.length === 0) return null;
      return { command, timeoutSeconds: clampTimeout(check.timeoutSeconds) };
    };
    const config: GateConfigDTO = {
      checks: {
        tests: commandConfig("tests"),
        lint: commandConfig("lint"),
        typecheck: commandConfig("typecheck"),
        build: commandConfig("build"),
      },
      maxRiskFindings: Math.max(0, draft.maxRiskFindings),
      scopeAllowedPaths: draft.scopeAllowedPathsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      requireDependenciesAccepted: draft.requireDependenciesAccepted,
      requireTargetBaselineSafe: draft.requireTargetBaselineSafe,
      requiredReviewers: REVIEWER_KINDS.filter((kind) => draft.requiredReviewers.includes(kind)),
      manualConfirmHighRisk: draft.manualConfirmHighRisk,
      requireTodoClean: draft.requireTodoClean,
      reviewMode: draft.reviewMode,
    };
    setSaving(true);
    try {
      await window.octopunk.invoke("gate:set-config", { repositoryPath: path, config });
      appState.setStatusMessage(`门禁配置已保存:${path}`);
    } catch (error) {
      // 矛盾配置等 DomainError 消息经既有错误提示机制展示。
      appState.setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <section>
        <SectionLabel>项目仓库</SectionLabel>
        <div className="border-border flex items-center gap-3 rounded-xl border px-5 py-4">
          <FolderGit2 className="text-primary size-4 shrink-0" aria-hidden />
          <Input
            aria-label="项目仓库路径"
            value={repositoryPath}
            onChange={(event) => setRepositoryPath(event.target.value)}
            placeholder="/path/to/repository"
            className="font-mono text-xs"
          />
          <Button variant="outline" onClick={() => void pickRepository()}>
            选择…
          </Button>
        </div>
        <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
          门禁配置按仓库路径保存;修改路径会自动加载该仓库的现有配置。启动 TeamRun
          时会冻结当时的配置快照,后续修改不影响进行中的运行。
        </p>
      </section>

      <section>
        <SectionLabel>命令检查</SectionLabel>
        <div className="border-border divide-border divide-y rounded-xl border">
          {COMMAND_CHECKS.map((check) => {
            const state = draft.checks[check.key];
            return (
              <div key={check.key} className="flex flex-col gap-2 px-5 py-4">
                <div className="flex items-center gap-2">
                  <Switch
                    aria-label={`启用${check.label}检查`}
                    checked={state.enabled}
                    onCheckedChange={(enabled) => updateCheck(check.key, { enabled })}
                  />
                  <p className="text-foreground text-sm font-medium">{check.label}检查</p>
                  <span className="text-muted-foreground/60 font-mono text-[11px]">{check.key}</span>
                  {loading && (
                    <LoaderCircle className="text-muted-foreground ml-auto size-3.5 animate-spin" aria-hidden />
                  )}
                </div>
                <div className="grid grid-cols-[1fr_120px] gap-2">
                  <Input
                    aria-label={`${check.label}命令`}
                    value={state.command}
                    onChange={(event) => updateCheck(check.key, { command: event.target.value })}
                    placeholder={check.placeholder}
                    disabled={!state.enabled}
                    className="font-mono text-xs"
                  />
                  <Input
                    aria-label={`${check.label}超时秒数`}
                    type="number"
                    min={TIMEOUT_MIN}
                    max={TIMEOUT_MAX}
                    value={state.timeoutSeconds}
                    onChange={(event) => {
                      const value = Number.parseInt(event.target.value, 10);
                      if (Number.isFinite(value)) {
                        updateCheck(check.key, { timeoutSeconds: clampTimeout(value) });
                      }
                    }}
                    disabled={!state.enabled}
                    className="text-center font-mono text-xs"
                  />
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
          命令在任务 worktree 内受控执行,退出码 0 判定通过;超时({TIMEOUT_MIN}–{TIMEOUT_MAX}
          秒)或无法确认时判定为「无法确认」,不阻塞但需人工复核。命令留空或开关关闭表示未启用该检查。
        </p>
      </section>

      <section>
        <SectionLabel>判定条件</SectionLabel>
        <RowGroup>
          <Row
            title="风险发现上限"
            desc="未解决 risk 发现超过该值时判定失败"
            control={
              <Input
                type="number"
                min={0}
                value={draft.maxRiskFindings}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(value)) {
                    setDraft((current) => ({ ...current, maxRiskFindings: Math.max(0, value) }));
                  }
                }}
                className="w-20 text-center font-mono"
                aria-label="风险发现上限"
              />
            }
          />
          <Row
            title="依赖任务须全部接受"
            desc="否则 dependencies 判定失败"
            hint="与「竞赛(contest)」审查模式互斥:竞赛模式的提案并行执行、不依赖彼此接受,同时启用会在保存时被拒绝。"
            control={
              <Switch
                aria-label="依赖任务须全部接受"
                checked={draft.requireDependenciesAccepted}
                onCheckedChange={(enabled) =>
                  setDraft((current) => ({ ...current, requireDependenciesAccepted: enabled }))
                }
              />
            }
          />
          <Row
            title="目标基线须安全"
            desc="否则 target_baseline 判定失败"
            control={
              <Switch
                aria-label="目标基线须安全"
                checked={draft.requireTargetBaselineSafe}
                onCheckedChange={(enabled) =>
                  setDraft((current) => ({ ...current, requireTargetBaselineSafe: enabled }))
                }
              />
            }
          />
          <Row
            title="高风险须人工确认"
            desc="存在 risk 发现时须人工确认后方可接受"
            control={
              <Switch
                aria-label="高风险须人工确认"
                checked={draft.manualConfirmHighRisk}
                onCheckedChange={(enabled) =>
                  setDraft((current) => ({ ...current, manualConfirmHighRisk: enabled }))
                }
              />
            }
          />
          <Row
            title="要求 Todo 清理"
            desc="工作区无遗留 Todo 方可通过"
            hint="todo_clean 检查依赖变更范围白名单;请先在下方配置白名单后再启用。"
            control={
              <Switch
                aria-label="要求 Todo 清理"
                checked={draft.requireTodoClean}
                onCheckedChange={(enabled) =>
                  setDraft((current) => ({ ...current, requireTodoClean: enabled }))
                }
              />
            }
          />
          <div className="flex flex-col gap-2 px-5 py-4">
            <div className="flex items-center gap-1.5">
              <p className="text-foreground text-sm font-medium whitespace-nowrap">必须到场审查者</p>
              <p className="text-muted-foreground text-xs">reviewers 检查要求到场的 Agent</p>
            </div>
            <div className="flex items-center gap-4">
              {REVIEWER_KINDS.map((kind) => (
                <Label
                  key={kind}
                  className="flex cursor-pointer items-center gap-1.5 text-xs font-normal"
                >
                  <Checkbox
                    aria-label={`${agentLabel(kind)} 到场`}
                    checked={draft.requiredReviewers.includes(kind)}
                    onCheckedChange={(checked) => toggleReviewer(kind, checked === true)}
                  />
                  {agentLabel(kind)}
                </Label>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2 px-5 py-4">
            <div className="flex items-center gap-1.5">
              <p className="text-foreground text-sm font-medium whitespace-nowrap">变更范围白名单</p>
              <p className="text-muted-foreground text-xs">scope 检查允许变更的路径前缀</p>
            </div>
            <Textarea
              aria-label="变更范围白名单"
              value={draft.scopeAllowedPathsText}
              onChange={(event) =>
                setDraft((current) => ({ ...current, scopeAllowedPathsText: event.target.value }))
              }
              placeholder={"src/\npackages/app/src/"}
              className="min-h-[72px] font-mono text-xs"
            />
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              每行一个路径前缀,按行拆分保存;留空表示不限制变更范围。
            </p>
          </div>
          <Row
            title="审查模式"
            desc="reviewMode"
            control={
              <Select
                value={draft.reviewMode}
                onValueChange={(value) =>
                  setDraft((current) => ({ ...current, reviewMode: value as GateReviewMode }))
                }
              >
                <SelectTrigger size="sm" className="app-no-drag w-48 cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REVIEW_MODES.map((mode) => (
                    <SelectItem key={mode.value} value={mode.value} className="cursor-pointer">
                      {mode.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </RowGroup>
      </section>

      <div>
        <Button disabled={saving} onClick={() => void save()} className="w-fit cursor-pointer">
          {saving ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          保存门禁配置
        </Button>
      </div>
    </div>
  );
}
