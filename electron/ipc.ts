// IPC surface wiring the renderer's AppState (port of OctoPunk/App/AppState.swift)
// to the main-process AppEnvironment, plus the live observers that replace
// SwiftUI's database-driven sidebar/detail updates (spec 001 FR-002a).

import { randomUUID } from "node:crypto";
import { BrowserWindow, dialog, ipcMain } from "electron";
import type { AppEnvironment } from "./appEnvironment";
import {
  CLAUDE_CHILD_MODEL_KEY,
  CLAUDE_EXECUTABLE_KEY,
  CODEX_CHILD_MODEL_KEY,
  CODEX_EXECUTABLE_KEY,
  CUSTOM_INSTRUCTIONS_KEY,
  DISABLED_AGENTS_KEY,
  GITHUB_FEEDBACK_ENABLED_KEY,
  GLOBAL_MAX_CHILDREN_KEY,
  INTERACTIVE_SLOT_RESERVED_KEY,
  LAUNCH_STAGGER_SECONDS_KEY,
  MAX_CONCURRENT_TASKS_KEY,
  MIN_FREE_DISK_BYTES_KEY,
  PER_KIND_MAX_CHILDREN_KEY,
  PER_PROJECT_MAX_CHILDREN_KEY,
  PI_CHILD_MODEL_KEY,
  PI_EXECUTABLE_KEY,
  RESOURCE_PAUSE_ENABLED_KEY,
  TASK_RETRY_LIMIT_KEY,
} from "./settingsStore";
import type { AsyncStream } from "./domain/repositoryPort";
import type { PrLink } from "./domain/repositoryPort";
import type { GithubPrStatus } from "./application/reviewCenterService";
import {
  clampGlobalMaxChildren,
  clampLaunchStaggerSeconds,
  clampMinFreeDiskBytes,
  clampPerKindMaxChildren,
  clampPerProjectMaxChildren,
  clampTaskRetryLimit,
  DEFAULT_MAX_CONCURRENT_TASKS,
  MAX_CONCURRENT_TASKS_LIMIT,
  type AvailabilityPayload,
  type ChildModelsPayload,
  type DelegateTaskItemPayload,
  type ExecutionPolicyPayload,
  type MaxConcurrentTasksPayload,
  type SchedulerSettingsPayload,
} from "../shared/ipc";
import type {
  DiffPageDTO,
  DiffTreeEntryDTO,
  DoctorReportDTO,
  GateConfigDTO,
  GateStartOverrideDTO,
  RunControlDTO,
} from "../shared/dtos";
import type { GateConfigInput } from "./domain/policy";
import type { RecoveryCleanupTarget } from "./application/recoveryService";
import {
  DOCTOR_CHECK_KEYS,
  GATE_REVIEW_MODES,
  type DoctorCheckKey,
  type GateReviewMode,
} from "./domain/models";

/** review:run-review 的 mode 参数:六值枚举外给可读错误(领域派发按枚举分派)。 */
function reviewModeOrThrow(value: string): GateReviewMode {
  if (!(GATE_REVIEW_MODES as readonly string[]).includes(value)) {
    throw new Error(`Unsupported review mode. Use one of: ${GATE_REVIEW_MODES.join(", ")}.`);
  }
  return value as GateReviewMode;
}

/** doctor:rerun-item 的 checkKey 参数:九值枚举外给可读错误(单项重检按枚举分派)。 */
function doctorCheckKeyOrThrow(value: unknown): DoctorCheckKey {
  if (typeof value !== "string" || !(DOCTOR_CHECK_KEYS as readonly string[]).includes(value)) {
    throw new Error(`Unsupported doctor check key. Use one of: ${DOCTOR_CHECK_KEYS.join(", ")}.`);
  }
  return value as DoctorCheckKey;
}

export interface RegisteredObservers {
  dispose: () => void;
}

/**
 * config_json 安全解码:解析失败/非对象视为无配置(null),与
 * QualityGateService 内部的解码语义一致(该函数未导出,此处镜像)。
 */
function decodeGateConfigJSON(json: string | null): GateConfigInput | null {
  if (json == null || json.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as GateConfigInput;
  } catch {
    return null;
  }
}

/**
 * 渲染层按完整 GateConfigDTO 解引用(config.checks.tests 等);MCP set_gate_config
 * 允许保存部分字段的部分配置,回填前补齐缺省,避免渲染层解引用 undefined。
 */
function gateConfigDTOOf(config: GateConfigInput | null): GateConfigDTO | null {
  if (config == null) return null;
  const command = (key: "tests" | "lint" | "typecheck" | "build") => {
    const value = config.checks?.[key];
    return value == null ? null : { command: value.command, timeoutSeconds: value.timeoutSeconds };
  };
  return {
    checks: {
      tests: command("tests"),
      lint: command("lint"),
      typecheck: command("typecheck"),
      build: command("build"),
    },
    maxRiskFindings: typeof config.maxRiskFindings === "number" ? config.maxRiskFindings : 0,
    scopeAllowedPaths: Array.isArray(config.scopeAllowedPaths) ? config.scopeAllowedPaths : [],
    requireDependenciesAccepted: config.requireDependenciesAccepted === true,
    requireTargetBaselineSafe: config.requireTargetBaselineSafe === true,
    requiredReviewers: Array.isArray(config.requiredReviewers) ? config.requiredReviewers : [],
    manualConfirmHighRisk: config.manualConfirmHighRisk === true,
    requireTodoClean: config.requireTodoClean === true,
    reviewMode: config.reviewMode ?? "standard",
  };
}

function clampMaxConcurrentTasks(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(MAX_CONCURRENT_TASKS_LIMIT, Math.max(1, Math.round(parsed)));
}

function storedMaxConcurrentTasks(environment: AppEnvironment): number {
  return (
    clampMaxConcurrentTasks(environment.settings.string(MAX_CONCURRENT_TASKS_KEY)) ??
    DEFAULT_MAX_CONCURRENT_TASKS
  );
}

/** GitHub 回灌开关现读(FR-016 默认关闭;settings 写入同步更新内存缓存)。 */
function githubFeedbackEnabled(environment: AppEnvironment): boolean {
  return environment.settings.string(GITHUB_FEEDBACK_ENABLED_KEY) === "true";
}

/**
 * scheduler:settings 六键读取(specs/001-v03 B 节):数值键缺省/越界钳回默认,
 * 布尔键沿用 settingsStore 惯例(缺省即开;仅显式 "false" 关闭)——与
 * makeSettingsStoreBudgetSettings 同一语义,GUI 读取值即调度器生效值。
 */
function schedulerSettingsPayload(environment: AppEnvironment): SchedulerSettingsPayload {
  return {
    globalMaxChildren: clampGlobalMaxChildren(environment.settings.string(GLOBAL_MAX_CHILDREN_KEY)),
    perProjectMaxChildren: clampPerProjectMaxChildren(
      environment.settings.string(PER_PROJECT_MAX_CHILDREN_KEY),
    ),
    perKindMaxChildren: clampPerKindMaxChildren(environment.settings.string(PER_KIND_MAX_CHILDREN_KEY)),
    resourcePauseEnabled: environment.settings.string(RESOURCE_PAUSE_ENABLED_KEY) !== "false",
    minFreeDiskBytes: clampMinFreeDiskBytes(environment.settings.string(MIN_FREE_DISK_BYTES_KEY)),
    interactiveSlotReserved: environment.settings.string(INTERACTIVE_SLOT_RESERVED_KEY) !== "false",
  };
}

/** pr:status 载荷:link 恒可展示,status 仅在 link 存在且启用时拉取,失败给可读 error。 */
interface PrStatusPayload {
  enabled: boolean;
  link: PrLink | null;
  status: GithubPrStatus | null;
  error: string | null;
}

export function registerIpc(environment: AppEnvironment): (window: BrowserWindow) => void {
  const handle = <T>(channel: string, handler: (payload: unknown) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return await handler(payload);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    });
  };

  handle("git:inspect", (payload) => {
    const request = payload as { path: string };
    return environment.git.inspect(request.path);
  });

  handle("team:start", async (payload) => {
    const request = payload as {
      repositoryPath: string;
      task: string;
      maxReviewRounds: number;
      maxConcurrentTasks?: number;
      /** StartForm 收集的门禁覆盖;null = 沿用项目默认(specs/002-v04 §C)。 */
      gateOverride?: GateStartOverrideDTO | null;
    };
    const inspection = await environment.git.inspect(request.repositoryPath);
    const dto = await environment.teamService.startTeam({
      requestID: randomUUID(),
      // specs/001-v03 T007 (research R1): every GUI start owns an independent
      // session, so the repository's per-session active-run check no longer
      // serializes the GUI to a single run — multiple GUI runs may be active
      // at once. MCP session semantics ("one run per MCP session") untouched.
      sessionID: `gui-${randomUUID()}`,
      repositoryPath: request.repositoryPath,
      task: request.task,
      baselineCommit: inspection.head,
      targetBranch: inspection.branchName ?? "",
      // The renderer owns the value from Settings → General; the stored setting
      // covers callers that omit it (and stays the fallback for safety).
      maxConcurrentTasks:
        clampMaxConcurrentTasks(request.maxConcurrentTasks) ??
        storedMaxConcurrentTasks(environment),
      maxReviewRounds: request.maxReviewRounds,
      // 主进程在启动事务成功后把 项目默认 ⊕ 覆盖 冻结成运行快照(R4)。
      gateOverride: request.gateOverride ?? null,
    });
    return { run: dto.run, inspection };
  });

  handle("team:delegate-task", (payload) => {
    const request = payload as {
      runID: string;
      title: string;
      prompt: string;
      agentKind: "claude_code" | "codex" | "pi";
      model: string | null;
      executionMode: "read_only" | "workspace_write";
      /** 交互槽标记(specs/001-v03 T026);缺省 false。 */
      interactive?: boolean;
    };
    return environment.teamService.delegateTask({
      requestID: randomUUID(),
      runID: request.runID,
      title: request.title,
      prompt: request.prompt,
      agentKind: request.agentKind,
      model: request.model ?? null,
      executionMode: request.executionMode,
      dependencies: [],
      interactive: request.interactive === true,
    });
  });

  handle("team:delegate-batch", (payload) => {
    const request = payload as {
      runID: string;
      contextSummary: string;
      tasks: (DelegateTaskItemPayload & { interactive?: boolean })[];
    };
    return environment.teamService.delegateTasks({
      requestID: randomUUID(),
      runID: request.runID,
      contextSummary: request.contextSummary,
      // interactive 归一化为严格布尔(渲染层载荷不做类型保证)。
      tasks: request.tasks.map((task) => ({ ...task, interactive: task.interactive === true })),
    });
  });

  handle("queries:status", (payload) => {
    const request = payload as { runID: string };
    return environment.queryService.status(request.runID);
  });

  handle("queries:summaries", () => environment.repository.listRuns());

  handle("queries:run-summary", (payload) => {
    const request = payload as { runID: string };
    return environment.queryService.runSummary(request.runID);
  });

  handle("queries:event-page", (payload) => {
    const request = payload as { runID: string; before: number };
    return environment.queryService.eventPage(request.runID, request.before, 100);
  });

  handle("queries:execution-log", (payload) => {
    const request = payload as { runID: string; taskID: string };
    return environment.queryService.executionLogDetail(request.runID, request.taskID);
  });

  // Review Center (specs/002-v04 interfaces.md §C): same ReviewCenterService
  // the MCP tools call, so GUI and MCP results are isomorphic for equal input.
  handle("review:pending-list", () => environment.reviewCenter.pendingReviewTasks());

  handle("review:get-diff", (payload): Promise<DiffTreeEntryDTO[] | DiffPageDTO> => {
    const request = payload as {
      runID: string;
      taskID: string;
      side: "baseline" | "worktree" | "integration";
      path?: string;
      cursor?: string | null;
    };
    // A file path selects the per-hunk paged view; without one the change
    // tree is returned (the entry point the diff browser starts from).
    if (request.path != null && request.path.length > 0) {
      return environment.reviewCenter.getDiffPage(
        request.runID,
        request.taskID,
        request.side,
        request.path,
        request.cursor ?? null,
      );
    }
    return environment.reviewCenter.getDiffTree(request.runID, request.taskID, request.side);
  });

  handle("review:add-comments", (payload) => {
    const request = payload as {
      requestID?: string;
      runID: string;
      taskID: string;
      comments: {
        file: string;
        lineStart: number;
        lineEnd?: number;
        body: string;
        severity?: "info" | "risk";
        author?: "user" | "claude_code" | "codex" | "pi";
        contextSnapshot?: string;
      }[];
    };
    return environment.reviewCenter.addComments({
      requestID: request.requestID ?? randomUUID(),
      runID: request.runID,
      taskID: request.taskID,
      comments: request.comments,
    });
  });

  handle("review:rework-batch", (payload) => {
    const request = payload as {
      requestID?: string;
      runID: string;
      taskID: string;
      commentIDs: string[];
      summary: string;
      reviewer?: string;
    };
    return environment.reviewCenter.reworkBatch({
      requestID: request.requestID ?? randomUUID(),
      runID: request.runID,
      taskID: request.taskID,
      commentIDs: request.commentIDs ?? [],
      summary: request.summary ?? "",
      reviewer: request.reviewer ?? "user",
    });
  });

  handle("review:get-summary", (payload) => {
    const request = payload as { runID: string; taskID?: string | null };
    return environment.reviewCenter.getDeliverySummary(request.runID, request.taskID ?? null);
  });

  handle("review:generate-summary", (payload) => {
    const request = payload as {
      runID: string;
      taskID?: string | null;
      verdict: "PASS" | "REWORK" | "BLOCKED";
      summaryLines?: string[];
    };
    return environment.reviewCenter.generateDeliverySummary({
      runID: request.runID,
      taskID: request.taskID ?? null,
      verdict: request.verdict,
      summaryLines: request.summaryLines,
    });
  });

  handle("review:unresolved-findings", (payload) => {
    const request = payload as { runID: string; taskID: string };
    return environment.reviewCenter.unresolvedFindings(request.runID, request.taskID);
  });

  // 跨模型审查仲裁(specs/002-v04 User Story 3):与 MCP run_review/get_arbitration
  // 共享同一 ReviewModeService(GUI 与 MCP 同构)。派发与收集分通道:dispatch 立即
  // 返回,收集由 UI 在审查任务全部到达后触发(collect 内部等待上限 10 分钟,不
  // 适合与派发合在一个 invoke 里阻塞 GUI)。
  handle("review:run-review", (payload) => {
    const request = payload as {
      runID: string;
      taskID: string;
      mode?: GateReviewMode;
      contestModels?: string[];
    };
    return environment.reviewModes.dispatchReview({
      runID: request.runID,
      taskID: request.taskID,
      mode: request.mode != null ? reviewModeOrThrow(request.mode) : undefined,
      contestModels: request.contestModels,
    });
  });

  handle("review:collect-arbitration", (payload) => {
    const request = payload as { runID: string; taskID: string; reviewTaskIDs: string[] };
    return environment.reviewModes.collectArbitration({
      runID: request.runID,
      taskID: request.taskID,
      reviewTaskIDs: request.reviewTaskIDs ?? [],
    });
  });

  handle("review:arbitration", (payload) => {
    const request = payload as { runID: string; taskID: string };
    return environment.reviewModes.getArbitration(request.runID, request.taskID);
  });

  // 审查子任务轻量 DTO(标题/状态/kind;latestReviewTasks 的渲染层投影)。
  handle("review:review-tasks", async (payload) => {
    const request = payload as { runID: string; taskID: string };
    const tasks = await environment.reviewModes.latestReviewTasks(request.runID, request.taskID);
    return tasks.map((task) => ({
      taskID: task.id,
      title: task.title,
      status: task.status,
      agentKind: task.agentKind,
      model: task.model,
    }));
  });

  // GitHub PR 回灌(specs/002-v04 US4 / interfaces.md §C):与 MCP create_pr /
  // get_pr_status 共享同一 ReviewCenterService + GhCliAdapter(GUI 与 MCP 同构)。
  // 凭证由本机 gh CLI 自管;任何 gh 失败都降级为可读中文错误,不影响审查/门禁。
  handle("pr:settings", (payload): { enabled: boolean } => {
    const request = payload as { enabled?: boolean };
    if (typeof request.enabled === "boolean") {
      environment.settings.set(GITHUB_FEEDBACK_ENABLED_KEY, request.enabled ? "true" : "false");
    }
    return { enabled: githubFeedbackEnabled(environment) };
  });

  handle("pr:check", async (): Promise<{
    enabled: boolean;
    available: boolean;
    detail: string;
  }> => {
    // ignoreEnabled=true:设置页在开启开关之前即可探测(只读无害探测)。
    const availability = await environment.gh.checkAvailability(true);
    return { enabled: githubFeedbackEnabled(environment), ...availability };
  });

  handle("pr:create", (payload): Promise<{ url: string; number: number }> => {
    const request = payload as { runID: string; taskID: string; title?: string; body?: string };
    return environment.reviewCenter.createPrForTask({
      runID: request.runID,
      taskID: request.taskID,
      title: request.title,
      body: request.body,
    });
  });

  handle("pr:status", async (payload): Promise<PrStatusPayload> => {
    const request = payload as { runID: string; taskID: string };
    const enabled = githubFeedbackEnabled(environment);
    const link = await environment.reviewCenter.getPrLink(request.runID, request.taskID);
    if (link == null) return { enabled, link: null, status: null, error: null };
    if (!enabled) {
      return { enabled, link, status: null, error: "GitHub 回灌未在设置中启用。" };
    }
    try {
      const refreshed = await environment.reviewCenter.refreshPrStatus({
        runID: request.runID,
        taskID: request.taskID,
      });
      return {
        enabled,
        link: refreshed?.link ?? link,
        status: refreshed?.status ?? null,
        error: null,
      };
    } catch (error) {
      // gh 拉取失败:link 仍返回供 UI 展示,可读错误交给 UI 呈现(FR-016 降级)。
      return {
        enabled,
        link,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // Quality Gate(specs/002-v04 interfaces.md §C):与 MCP gate 工具共享同一
  // QualityGateService,GUI 与 MCP 对同一输入产生同构结果(契约不变量 1)。
  handle("gate:get-config", async (payload) => {
    const request = payload as { repositoryPath: string; runID?: string | null };
    const project = await environment.repository.getGateConfig(request.repositoryPath);
    const def = decodeGateConfigJSON(project?.configJson ?? null);
    // 带 runID 时返回该 run 冻结的生效快照(启动后项目默认修改不影响);否则生效
    // 配置即项目默认。
    const effective =
      request.runID != null && request.runID.length > 0
        ? await environment.qualityGate.getEffectiveConfig(request.runID)
        : def;
    return { default: gateConfigDTOOf(def), effective: gateConfigDTOOf(effective) };
  });

  handle("gate:set-config", async (payload) => {
    const request = payload as { repositoryPath: string; config: GateConfigInput };
    await environment.qualityGate.saveProjectDefault(
      randomUUID(),
      request.repositoryPath,
      request.config,
    );
    return null;
  });

  handle("gate:evaluate", (payload) => {
    const request = payload as { requestID: string; runID: string; taskID: string };
    return environment.qualityGate.evaluate({
      requestID: request.requestID,
      runID: request.runID,
      taskID: request.taskID,
    });
  });

  handle("gate:waive-item", (payload) => {
    const request = payload as {
      requestID: string;
      evaluationID: string;
      itemID: string;
      waivedReason: string;
    };
    return environment.qualityGate.waive({
      requestID: request.requestID,
      evaluationID: request.evaluationID,
      itemID: request.itemID,
      // GUI 侧豁免主体固定为用户(MCP 侧为 "codex");理由必填由服务层校验。
      waivedBy: "user",
      waivedReason: request.waivedReason,
    });
  });

  handle("team:join", (payload) => {
    const request = payload as { runID: string; batchID: string };
    return environment.teamService.joinTasks({
      runID: request.runID,
      batchID: request.batchID,
      taskIDs: [],
      timeoutSeconds: 45,
    });
  });

  handle("team:review", async (payload) => {
    const request = payload as {
      action: "accept" | "rework" | "block";
      runID: string;
      taskID: string;
      summary: string;
    };
    const verdict =
      request.action === "accept" ? "PASS" : request.action === "rework" ? "REWORK" : "BLOCKED";
    const input = {
      requestID: randomUUID(),
      runID: request.runID,
      taskID: request.taskID,
      reviewer: "codex.ui",
      verdict: verdict as "PASS" | "REWORK" | "BLOCKED",
      summary: request.summary.length === 0 ? "Reviewed in OctoPunk UI" : request.summary,
      findings: [],
    };
    if (request.action === "accept") {
      const accepted = await environment.teamService.acceptTask(input);
      // 契约 B 节:accept 成功后自动生成交付摘要。await + catch:摘要生成失败
      // (如仓储抖动)不得拖垮已成功的 accept 结果,摘要可经 review:generate-summary
      // 手动补生成。
      await environment.reviewCenter
        .generateDeliverySummary({
          runID: request.runID,
          taskID: request.taskID,
          verdict: "PASS",
        })
        .catch(() => null);
      return accepted;
    }
    if (request.action === "rework") return environment.teamService.requestRework(input);
    return environment.teamService.blockTask(input);
  });

  handle("team:cancel-task", (payload) => {
    const request = payload as { runID: string; taskID: string };
    return environment.teamService.cancelTask({
      requestID: randomUUID(),
      runID: request.runID,
      taskID: request.taskID,
    });
  });

  handle("team:discard-task", (payload) => {
    const request = payload as { runID: string; taskID: string };
    return environment.teamService.discardTask({
      requestID: randomUUID(),
      runID: request.runID,
      taskID: request.taskID,
    });
  });

  handle("team:cancel-team", (payload) => {
    const request = payload as { runID: string };
    return environment.teamService.cancelTeam({
      requestID: randomUUID(),
      runID: request.runID,
    });
  });

  handle("team:delete-run", async (payload) => {
    const request = payload as { runID: string };
    await environment.teamService.discardTeam({
      requestID: randomUUID(),
      runID: request.runID,
    });
    await environment.repository.hideRun({
      requestID: randomUUID(),
      runID: request.runID,
    });
    return null;
  });

  handle("team:archive-run", (payload) => {
    const request = payload as { runID: string };
    return environment.teamService.archiveTeam({
      requestID: randomUUID(),
      runID: request.runID,
    });
  });

  handle("team:unarchive-run", (payload) => {
    const request = payload as { runID: string };
    return environment.teamService.unarchiveTeam({
      requestID: randomUUID(),
      runID: request.runID,
    });
  });

  // ---- v0.3 运行控制与调度 IPC(specs/001-v03 T011 / interfaces.md B 节)----
  // 与 MCP 工具共享同一 workbench / teamService(GUI 与 MCP 同构);pause/resume/
  // set-priority 返回 RunControlDTO 投影(priority + pausedAt,渲染层以
  // workbench:summary 重载为准),审计事件已由仓储落 relay_events。

  /**
   * 资源感知状态(T026/T027):ResourceMonitor 最近一轮采样快照(负载/磁盘/
   * 是否高压)。只读投影,不触发采样;未完成首轮时 sampledAt=null。
   */
  handle("scheduler:resource-status", () => environment.resourceMonitor.latest());

  /** 工作台六分区聚合:running/queued/awaiting_input/failed/awaiting_review/integratable。 */
  handle("workbench:summary", () => environment.workbench.summary());

  /** 暂停 run:停发该 run 新配额,运行中任务照常完成(interfaces.md C 节不变量 4)。 */
  handle("run:pause", async (payload): Promise<RunControlDTO & { runID: string }> => {
    const request = payload as { requestID?: string; runID: string };
    const run = await environment.teamService.pauseRun({
      requestID: request.requestID ?? randomUUID(),
      runID: request.runID,
    });
    return { runID: run.id, priority: run.priority, pausedAt: run.pausedAt };
  });

  /** 恢复已暂停 run:drain 镜像 paused_at=null 后,排队任务按优先级继续领配额。 */
  handle("run:resume", async (payload): Promise<RunControlDTO & { runID: string }> => {
    const request = payload as { requestID?: string; runID: string };
    const run = await environment.teamService.resumeRun({
      requestID: request.requestID ?? randomUUID(),
      runID: request.runID,
    });
    return { runID: run.id, priority: run.priority, pausedAt: run.pausedAt };
  });

  /** 调整 run 调度优先级(-5..5 整数,越大约先得配额);非整数/越界给可读错误。 */
  handle("run:set-priority", async (payload): Promise<RunControlDTO & { runID: string }> => {
    const request = payload as { requestID?: string; runID: string; priority?: unknown };
    const parsed =
      typeof request.priority === "number"
        ? request.priority
        : Number.parseInt(String(request.priority ?? ""), 10);
    if (!Number.isInteger(parsed) || parsed < -5 || parsed > 5) {
      throw new Error("Priority must be an integer between -5 and 5.");
    }
    const run = await environment.teamService.setRunPriority({
      requestID: request.requestID ?? randomUUID(),
      runID: request.runID,
      priority: parsed,
    });
    return { runID: run.id, priority: run.priority, pausedAt: run.pausedAt };
  });

  // ---- v0.3 恢复与体检 IPC(specs/001-v03 T019/T023 / interfaces.md B 节)----
  // 与 MCP 工具共享同一 RecoveryService / DoctorService(GUI 与 MCP 同构,
  // 宪法原则二)。恢复类动作全部经显式确认与幂等 requestID 落库留痕;扫描
  // 只读,启动扫描结果由 AppEnvironment.recoveryStatus 缓存复用一次。

  /** 恢复视图:非终态 run × 进程核对 + 孤儿 worktree/分支扫描(best effort)。 */
  handle("recovery:status", (payload) => {
    const request = payload as { runID?: string };
    return environment.recoveryStatus(request.runID);
  });

  /** 人工确认后把已死的中断任务标记失败(failTask 幂等;不做任何自动标记)。 */
  handle("recovery:mark-failed", (payload) => {
    const request = payload as { requestID?: string; runID: string; taskID: string; reason?: string };
    return environment.recovery.markInterruptedFailed({
      requestID: request.requestID ?? randomUUID(),
      runID: request.runID,
      taskID: request.taskID,
      reason: request.reason ?? "",
    });
  });

  /** 节点重跑:目标节点复位为 queued,可选连带恢复被阻塞的下游(resumeTask 幂等)。 */
  handle("recovery:rerun", (payload) => {
    const request = payload as {
      requestID?: string;
      runID: string;
      taskID: string;
      includeDownstream?: boolean;
    };
    return environment.recovery.rerunTask({
      requestID: request.requestID ?? randomUUID(),
      runID: request.runID,
      taskID: request.taskID,
      includeDownstream: request.includeDownstream === true,
    });
  });

  /** 孤儿清理:必须 confirmed=true(契约 C 节不变量 5);逐项 best effort,失败落 skipped。 */
  handle("recovery:cleanup-orphans", (payload) => {
    const request = payload as {
      requestID?: string;
      targets: RecoveryCleanupTarget[];
      confirmed?: boolean;
    };
    return environment.recovery.cleanupOrphans({
      requestID: request.requestID ?? randomUUID(),
      targets: Array.isArray(request.targets) ? request.targets : [],
      confirmed: request.confirmed === true,
    });
  });

  /** 体检执行(GUI 侧触发来源固定 user);单项超时 → unknown,整体不失败。 */
  handle("doctor:run", (payload) => {
    const request = payload as { repositoryPath?: string | null };
    return environment.doctor.runCheckup({
      requestID: randomUUID(),
      repositoryPath: request.repositoryPath ?? null,
      triggeredBy: "user",
    });
  });

  /** 最近体检报告(repositoryPath 省略 = 全局报告;null = 尚无报告)。 */
  handle("doctor:latest", (payload) => {
    const request = payload as { repositoryPath?: string | null };
    return environment.doctor.latestReport(request.repositoryPath ?? null);
  });

  /** 单项重检:只重跑该检查器并更新对应行,overall 由仓储重算。 */
  handle("doctor:rerun-item", (payload) => {
    const request = payload as { requestID?: string; reportID: string; checkKey: unknown };
    return environment.doctor.rerunItem({
      requestID: request.requestID ?? randomUUID(),
      reportID: request.reportID,
      checkKey: doctorCheckKeyOrThrow(request.checkKey),
    });
  });

  /** 脱敏诊断包(FR-013):report 省略时导出最新全局报告;无报告给可读错误。 */
  handle("doctor:bundle", async (payload): Promise<string> => {
    const request = payload as { report?: DoctorReportDTO | null };
    if (request.report != null) {
      return await environment.doctor.exportDiagnosticBundle(request.report);
    }
    const latest = await environment.doctor.latestReport(null);
    if (latest == null) {
      throw new Error("还没有可导出的体检报告,请先运行一次体检(doctor:run)。");
    }
    return await environment.doctor.exportDiagnosticBundle(latest);
  });

  handle("agent:check", (payload) => {
    const request = payload as { kind: "claude_code" | "codex" | "pi"; override?: string | null };
    return environment.checkAgent(request.kind, request.override ?? null);
  });

  handle("settings:get-executables", () => ({
    claudeExecutable: environment.settings.string(CLAUDE_EXECUTABLE_KEY) ?? "",
    codexExecutable: environment.settings.string(CODEX_EXECUTABLE_KEY) ?? "",
    piExecutable: environment.settings.string(PI_EXECUTABLE_KEY) ?? "",
    resolved: {
      claudeExecutable: environment.claudeExecutable,
      codexExecutable: environment.codexExecutable,
      piExecutable: environment.piExecutable,
    },
  }));

  handle("settings:set-executable", (payload) => {
    const request = payload as { kind: "claude_code" | "codex" | "pi"; path: string };
    environment.settings.set(
      request.kind === "claude_code"
        ? CLAUDE_EXECUTABLE_KEY
        : request.kind === "pi"
          ? PI_EXECUTABLE_KEY
          : CODEX_EXECUTABLE_KEY,
      request.path,
    );
    return null;
  });

  handle("settings:get-custom-instructions", () => ({
    customInstructions: environment.settings.string(CUSTOM_INSTRUCTIONS_KEY) ?? "",
  }));

  handle("settings:set-custom-instructions", (payload) => {
    const request = payload as { text?: string };
    // An empty value clears the guidance (SettingsStore.string treats "" as unset).
    environment.settings.set(CUSTOM_INSTRUCTIONS_KEY, request.text ?? "");
    return null;
  });

  handle("settings:get-disabled-agents", () => {
    const stored = environment.settings.string(DISABLED_AGENTS_KEY);
    let disabled: string[] = [];
    try {
      const parsed = stored != null ? (JSON.parse(stored) as unknown) : [];
      if (Array.isArray(parsed)) {
        disabled = parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      disabled = [];
    }
    return { disabledAgents: disabled };
  });

  handle("settings:set-disabled-agents", (payload) => {
    const request = payload as { kinds?: string[] };
    const kinds = Array.isArray(request.kinds)
      ? request.kinds.filter((value): value is string => typeof value === "string")
      : [];
    // An empty array clears the key (SettingsStore.string treats "" as unset).
    environment.settings.set(DISABLED_AGENTS_KEY, JSON.stringify(kinds));
    return null;
  });

  handle("settings:get-max-concurrent-tasks", (): MaxConcurrentTasksPayload => ({
    maxConcurrentTasks: storedMaxConcurrentTasks(environment),
  }));

  handle("settings:set-max-concurrent-tasks", (payload): MaxConcurrentTasksPayload => {
    const request = payload as { value?: number };
    const value = clampMaxConcurrentTasks(request.value) ?? DEFAULT_MAX_CONCURRENT_TASKS;
    environment.settings.set(MAX_CONCURRENT_TASKS_KEY, String(value));
    return { maxConcurrentTasks: value };
  });

  handle("settings:get-execution-policy", (): ExecutionPolicyPayload => ({
    taskRetryLimit: clampTaskRetryLimit(environment.settings.string(TASK_RETRY_LIMIT_KEY)),
    launchStaggerSeconds: clampLaunchStaggerSeconds(
      environment.settings.string(LAUNCH_STAGGER_SECONDS_KEY),
    ),
  }));

  handle("settings:set-execution-policy", (payload): ExecutionPolicyPayload => {
    const request = payload as { taskRetryLimit?: unknown; launchStaggerSeconds?: unknown };
    const taskRetryLimit = clampTaskRetryLimit(request.taskRetryLimit);
    const launchStaggerSeconds = clampLaunchStaggerSeconds(request.launchStaggerSeconds);
    environment.settings.set(TASK_RETRY_LIMIT_KEY, String(taskRetryLimit));
    environment.settings.set(LAUNCH_STAGGER_SECONDS_KEY, String(launchStaggerSeconds));
    return { taskRetryLimit, launchStaggerSeconds };
  });

  // 调度设置读写一体(specs/001-v03 B 节,照 execution-policy 的读写一体模式):
  // 空载荷/六个调度字段全缺 = 读;带任一调度字段 = 全量逐键钳制后写回(调用方
  // 约定一次提交完整六键,与 execution-policy 相同),两种路径都返回钳定值。
  handle("scheduler:settings", (payload): SchedulerSettingsPayload => {
    const request = (payload ?? {}) as Partial<SchedulerSettingsPayload>;
    const isWrite =
      request.globalMaxChildren != null ||
      request.perProjectMaxChildren != null ||
      request.perKindMaxChildren != null ||
      request.resourcePauseEnabled != null ||
      request.minFreeDiskBytes != null ||
      request.interactiveSlotReserved != null;
    if (!isWrite) return schedulerSettingsPayload(environment);
    const next: SchedulerSettingsPayload = {
      globalMaxChildren: clampGlobalMaxChildren(request.globalMaxChildren),
      perProjectMaxChildren: clampPerProjectMaxChildren(request.perProjectMaxChildren),
      perKindMaxChildren: clampPerKindMaxChildren(request.perKindMaxChildren),
      resourcePauseEnabled: request.resourcePauseEnabled === true,
      minFreeDiskBytes: clampMinFreeDiskBytes(request.minFreeDiskBytes),
      interactiveSlotReserved: request.interactiveSlotReserved === true,
    };
    environment.settings.set(GLOBAL_MAX_CHILDREN_KEY, String(next.globalMaxChildren));
    environment.settings.set(PER_PROJECT_MAX_CHILDREN_KEY, String(next.perProjectMaxChildren));
    environment.settings.set(PER_KIND_MAX_CHILDREN_KEY, String(next.perKindMaxChildren));
    environment.settings.set(RESOURCE_PAUSE_ENABLED_KEY, next.resourcePauseEnabled ? "true" : "false");
    environment.settings.set(MIN_FREE_DISK_BYTES_KEY, String(next.minFreeDiskBytes));
    environment.settings.set(INTERACTIVE_SLOT_RESERVED_KEY, next.interactiveSlotReserved ? "true" : "false");
    return next;
  });

  handle("settings:get-child-models", (): ChildModelsPayload => ({
    claudeModel: environment.settings.string(CLAUDE_CHILD_MODEL_KEY) ?? "",
    codexModel: environment.settings.string(CODEX_CHILD_MODEL_KEY) ?? "",
    piModel: environment.settings.string(PI_CHILD_MODEL_KEY) ?? "",
  }));

  handle("settings:set-child-model", (payload): ChildModelsPayload => {
    const request = payload as { kind?: "claude_code" | "codex" | "pi"; model?: string };
    // Empty model clears the override (SettingsStore.string treats "" as unset).
    const model = (request.model ?? "").trim().slice(0, 100);
    if (request.kind === "claude_code" || request.kind === "codex" || request.kind === "pi") {
      environment.settings.set(
        request.kind === "claude_code"
          ? CLAUDE_CHILD_MODEL_KEY
          : request.kind === "pi"
            ? PI_CHILD_MODEL_KEY
            : CODEX_CHILD_MODEL_KEY,
        model,
      );
    }
    return {
      claudeModel: environment.settings.string(CLAUDE_CHILD_MODEL_KEY) ?? "",
      codexModel: environment.settings.string(CODEX_CHILD_MODEL_KEY) ?? "",
      piModel: environment.settings.string(PI_CHILD_MODEL_KEY) ?? "",
    };
  });

  handle("settings:get-skill-status", () => environment.skillInstaller.status());

  handle("settings:install-skill", (payload) => {
    const request = payload as { kind: "claude_code" | "codex" | "pi" };
    return environment.skillInstaller.install(request.kind);
  });

  handle("settings:connect-codex", async () => {
    const { app } = await import("electron");
    // Packaged: the app executable. Dev: `electron .` needs the app root.
    const appRoot = app.getAppPath();
    const command = app.isPackaged ? process.execPath : process.execPath;
    const args = app.isPackaged ? ["--mcp-stdio"] : [appRoot, "--mcp-stdio"];
    const backup = await environment.codexConfig.connectStdio(command, args);
    return { backupPath: backup };
  });

  handle("settings:connect-pi", async () => {
    const { app } = await import("electron");
    const appRoot = app.getAppPath();
    const command = process.execPath;
    const args = app.isPackaged ? ["--mcp-stdio"] : [appRoot, "--mcp-stdio"];
    const backup = await environment.piConfig.connectStdio(command, args);
    return { backupPath: backup };
  });

  handle("http:start", async () => {
    await environment.mcpServer.startHTTP();
    return { endpoint: "http://127.0.0.1:51931/mcp" };
  });

  handle("http:stop", async () => {
    await environment.mcpServer.stop();
    return null;
  });

  handle("settings:register-login-item", async (payload) => {
    const request = payload as { enabled: boolean };
    if (request.enabled) {
      await environment.loginItem.register();
    } else {
      await environment.loginItem.unregister();
    }
    return null;
  });

  handle("worktree:scan", () => {
    const { WorktreeMaintenanceService } = require("./platform/worktreeMaintenance") as typeof import("./platform/worktreeMaintenance");
    const service = new WorktreeMaintenanceService(environment.git, () => environment.repository.allRunWorkspaces());
    return { entries: service.scan() };
  });

  handle("worktree:cleanup", (payload) => {
    const request = payload as { paths: string[] };
    const { WorktreeMaintenanceService } = require("./platform/worktreeMaintenance") as typeof import("./platform/worktreeMaintenance");
    const service = new WorktreeMaintenanceService(environment.git, () => environment.repository.allRunWorkspaces());
    return service.cleanup(request.paths ?? []);
  });

  handle("app:pick-repository", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
  });

  handle("legacy:import", async () => {
    const { LegacySessionImporter } = await import("./data/legacySessionImporter");
    const importer = new LegacySessionImporter();
    const imported = await importer.importIfPresent(environment.repository);
    return imported == null ? null : { runID: imported.run.id };
  });

  return (window: BrowserWindow): void => {
    attachObservers(environment, window);
  };
}

function attachObservers(environment: AppEnvironment, window: BrowserWindow): RegisteredObservers {
  const stopExternalWatch = environment.repository.watchExternalChanges();
  const send = (channel: string, payload: unknown): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  };

  const summariesStream: AsyncStream<import("../shared/dtos").TeamRunSummaryDTO[]> =
    environment.queryService.observeSummaries();
  const summariesTask = (async () => {
    try {
      for await (const summaries of summariesStream) {
        send("runs:changed", summaries);
      }
    } catch {
      // Manual refresh remains the fallback path.
    }
  })();

  const detailObservers = new Map<string, () => void>();
  const onObserve = (_event: Electron.IpcMainEvent, runID: string): void => {
    if (detailObservers.has(runID)) return;
    const summaryStream = environment.queryService.observeRunSummary(runID);
    const tailStream = environment.queryService.observeEventTail(runID, 100);
    const logStreams = new Map<string, AsyncStream<import("./domain/models").TaskExecutionLog | null>>();
    const pumpSummary = (async () => {
      try {
        for await (const summary of summaryStream) {
          send("run:summary", { runID, summary });
        }
      } catch {
        // The persisted relay log stays authoritative.
      }
    })();
    const pumpTail = (async () => {
      try {
        for await (const tail of tailStream) {
          send("run:event-tail", { runID, tail });
        }
      } catch {
        // Live preview pauses only.
      }
    })();
    void pumpSummary;
    void pumpTail;
    const onObserveLog = (_logEvent: Electron.IpcMainEvent, taskID: string): void => {
      if (logStreams.has(taskID)) return;
      const stream = environment.repository.observeExecutionLog(runID, taskID);
      logStreams.set(taskID, stream);
      void (async () => {
        try {
          for await (const log of stream) {
            send("task-log", { taskID, log });
          }
        } catch {
          // The persisted log stays authoritative.
        }
      })();
    };
    const onUnobserveLog = (_logEvent: Electron.IpcMainEvent, taskID: string): void => {
      logStreams.get(taskID)?.cancel();
      logStreams.delete(taskID);
    };
    ipcMain.on("log:observe", onObserveLog);
    ipcMain.on("log:unobserve", onUnobserveLog);
    detailObservers.set(runID, () => {
      summaryStream.cancel();
      tailStream.cancel();
      for (const stream of logStreams.values()) stream.cancel();
      logStreams.clear();
      ipcMain.removeListener("log:observe", onObserveLog);
      ipcMain.removeListener("log:unobserve", onUnobserveLog);
      detailObservers.delete(runID);
    });
  };
  const onUnobserve = (_event: Electron.IpcMainEvent, runID: string): void => {
    detailObservers.get(runID)?.();
  };
  ipcMain.on("run:observe", onObserve);
  ipcMain.on("run:unobserve", onUnobserve);

  window.on("closed", () => {
    stopExternalWatch();
    summariesStream.cancel();
    for (const dispose of [...detailObservers.values()]) dispose();
    ipcMain.removeListener("run:observe", onObserve);
    ipcMain.removeListener("run:unobserve", onUnobserve);
    void summariesTask;
  });

  return {
    dispose: (): void => {
      stopExternalWatch();
      summariesStream.cancel();
      for (const dispose of [...detailObservers.values()]) dispose();
      ipcMain.removeListener("run:observe", onObserve);
      ipcMain.removeListener("run:unobserve", onUnobserve);
    },
  };
}

export type { AvailabilityPayload };
