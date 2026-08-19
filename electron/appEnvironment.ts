// Port of OctoPunk/OctoPunk/App/AppEnvironment.swift — composition root for
// the Electron main process.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { OctoPunkDatabase } from "./data/database";
import { SqliteTeamRunRepository } from "./data/repository";
import { LocalProcessAdapter, isExecutable } from "./platform/processAdapter";
import { GitAdapter } from "./platform/gitAdapter";
import { ClaudeCLIAdapter } from "./platform/claudeCliAdapter";
import { PiCLIAdapter } from "./platform/piCliAdapter";
import { CodexAppServerAdapter, ChildAgentRegistry } from "./platform/codexAppServerAdapter";
import { GhCliAdapter } from "./platform/ghCliAdapter";
import { OctoPunkToolLocator } from "./platform/toolLocator";
import { KeychainTokenStore } from "./platform/keychainTokenStore";
import { FileCodexConfigAdapter } from "./platform/codexConfigAdapter";
import { FilePiConfigAdapter } from "./platform/piConfigAdapter";
import { FileSkillInstaller } from "./platform/skillInstaller";
import { MainAppLoginItemAdapter } from "./platform/loginItemAdapter";
import { NotificationAdapter } from "./platform/notificationAdapter";
import { ChildExecutionService } from "./application/childExecutionService";
import { TaskIntegrationService } from "./application/taskIntegrationService";
import { AgentTeamApplicationService } from "./application/agentTeamService";
import { TeamQueryService } from "./application/teamQueryService";
import {
  ConcurrencyBudget,
  makeSettingsStoreBudgetSettings,
} from "./application/concurrencyBudget";
import { WorkbenchService } from "./application/workbenchService";
import { ContextFetchService } from "./application/contextFetchService";
import { ReviewCenterService } from "./application/reviewCenterService";
import { QualityGateService } from "./application/qualityGateService";
import { ReviewModeService } from "./application/reviewModeService";
import { TaskEventHub } from "./domain/events";
import { OctoPunkMCPServer } from "./mcp/server";
import {
  CLAUDE_CHILD_MODEL_KEY,
  CLAUDE_EXECUTABLE_KEY,
  CODEX_CHILD_MODEL_KEY,
  CODEX_EXECUTABLE_KEY,
  CUSTOM_INSTRUCTIONS_KEY,
  GITHUB_FEEDBACK_ENABLED_KEY,
  LAUNCH_STAGGER_SECONDS_KEY,
  LEGACY_CLAUDE_EXECUTABLE_KEY,
  MAX_CONCURRENT_TASKS_KEY,
  PI_CHILD_MODEL_KEY,
  PI_EXECUTABLE_KEY,
  TASK_RETRY_LIMIT_KEY,
  SettingsStore,
  octoPunkSupportDirectory,
} from "./settingsStore";
import {
  clampLaunchStaggerSeconds,
  clampTaskRetryLimit,
  DEFAULT_MAX_CONCURRENT_TASKS,
  MAX_CONCURRENT_TASKS_LIMIT,
} from "../shared/ipc";
import { ChildAgentDiagnostics, type ChildAgentAvailability } from "./application/ports";

export class AppEnvironment {
  readonly database: OctoPunkDatabase;
  readonly repository: SqliteTeamRunRepository;
  readonly process: LocalProcessAdapter;
  readonly git: GitAdapter;
  readonly gh: GhCliAdapter;
  readonly claude: ClaudeCLIAdapter;
  readonly codex: CodexAppServerAdapter;
  readonly pi: PiCLIAdapter;
  readonly childAgents: ChildAgentRegistry;
  readonly childExecution: ChildExecutionService;
  readonly integration: TaskIntegrationService;
  readonly teamService: AgentTeamApplicationService;
  readonly queryService: TeamQueryService;
  /** 中央并发预算(US4/IPC 呈现四级生效上限的只读投影 getConcurrencyCounts)。 */
  readonly concurrencyBudget: ConcurrencyBudget;
  readonly workbench: WorkbenchService;
  readonly reviewCenter: ReviewCenterService;
  readonly qualityGate: QualityGateService;
  readonly reviewModes: ReviewModeService;
  readonly contextFetch: ContextFetchService;
  readonly eventHub: TaskEventHub;
  readonly keychain: KeychainTokenStore;
  readonly codexConfig: FileCodexConfigAdapter;
  readonly piConfig: FilePiConfigAdapter;
  readonly skillInstaller: FileSkillInstaller;
  readonly loginItem: MainAppLoginItemAdapter;
  readonly mcpServer: OctoPunkMCPServer;
  readonly notifications: NotificationAdapter;
  readonly settings: SettingsStore;
  readonly claudeExecutable: string;
  readonly codexExecutable: string;
  readonly piExecutable: string;

  constructor(input?: {
    databaseURL?: string | null;
    claudeExecutable?: string | null;
    codexExecutable?: string | null;
    piExecutable?: string | null;
  }) {
    this.settings = new SettingsStore();
    // OCTOPUNK_DATABASE_URL isolates the instance (used by tests/diagnostics)
    // without touching ~/Library/Application Support/OctoPunk/octopunk.sqlite.
    const databaseOverride =
      input?.databaseURL ?? (process.env.OCTOPUNK_DATABASE_URL || null);
    this.database =
      databaseOverride != null ? OctoPunkDatabase.open(databaseOverride) : OctoPunkDatabase.live();
    this.repository = new SqliteTeamRunRepository(this.database.writer);
    this.process = new LocalProcessAdapter();
    this.git = new GitAdapter(this.process);
    // GitHub PR 回灌(specs/002-v04 US4 / FR-016):默认关闭;enabled 每次调用
    // 现读设置(settings 写入会同步更新 SettingsStore 内存缓存),凭证由本机
    // gh CLI 自管,OctoPunk 不保存任何 GitHub 凭证。
    this.gh = new GhCliAdapter({
      process: this.process,
      enabled: () => this.settings.string(GITHUB_FEEDBACK_ENABLED_KEY) === "true",
    });
    this.settings.migrateKey(LEGACY_CLAUDE_EXECUTABLE_KEY, CLAUDE_EXECUTABLE_KEY);
    // A bare configured name (e.g. "claude") resolves through the locator so
    // fnm/volta/npm-global installs are found; explicit paths are trusted.
    this.claudeExecutable = OctoPunkToolLocator.resolveConfigured(
      this.settings.string(CLAUDE_EXECUTABLE_KEY) ?? input?.claudeExecutable ?? null,
      "claude",
    );
    this.claude = new ClaudeCLIAdapter(this.claudeExecutable, this.process);
    this.codexExecutable = OctoPunkToolLocator.resolveConfigured(
      this.settings.string(CODEX_EXECUTABLE_KEY) ?? input?.codexExecutable ?? null,
      "codex",
    );
    this.codex = new CodexAppServerAdapter(this.codexExecutable, this.process);
    this.piExecutable = OctoPunkToolLocator.resolveConfigured(
      this.settings.string(PI_EXECUTABLE_KEY) ?? input?.piExecutable ?? null,
      "pi",
    );
    this.pi = new PiCLIAdapter(this.piExecutable, this.process);
    this.childAgents = new ChildAgentRegistry(this.claude, this.codex, this.pi);
    // Claude must reach its model endpoint. Its built-in network tools and
    // commit/push commands remain denied by each adapter's explicit policy.
    this.childExecution = new ChildExecutionService({
      childAgent: this.childAgents,
      git: this.git,
      repository: this.repository,
      allowNetwork: true,
      selfExecutablePath: resolveSelfExecutable(),
      // Host-wide custom instructions from Settings; the SettingsStore cache
      // is updated in-process by settings:set-custom-instructions, so reads
      // here always see the latest saved value.
      globalInstructions: () => this.settings.string(CUSTOM_INSTRUCTIONS_KEY) ?? null,
      // Settings → 外部 Agent → 模型覆盖, read per execution.
      childModel: (kind) =>
        this.settings.string(
          kind === "claude_code"
            ? CLAUDE_CHILD_MODEL_KEY
            : kind === "pi"
              ? PI_CHILD_MODEL_KEY
              : CODEX_CHILD_MODEL_KEY,
        ) ?? null,
    });
    this.integration = new TaskIntegrationService(this.git);
    this.eventHub = new TaskEventHub();
    // Quality Gate 与 Review Center 存在构造环:门禁判定需要 Review Center 的
    // 两个只读视图,而 Review Center 的返工用例又需要 teamService(teamService
    // 又要注入 qualityGate)。用延迟绑定的结构端口断环——箭头函数在调用期才读
    // this.reviewCenter,届时它已完成构造。
    this.qualityGate = new QualityGateService({
      repository: this.repository,
      git: this.git,
      process: this.process,
      reviewCenter: {
        unresolvedFindings: (runID, taskID) => this.reviewCenter.unresolvedFindings(runID, taskID),
        getDiffTree: (runID, taskID, side) => this.reviewCenter.getDiffTree(runID, taskID, side),
      },
    });
    // 中央并发预算(specs/001-v03 T008):四级联检的单一记账源,构造先于
    // teamService——后者会在自己的构造里经 setCapacityFreedHandler(ifAbsent)
    // 把释放/恢复回调接回调度 drain。设置键经 makeSettingsStoreBudgetSettings
    // 每次现读(SettingsStore 自带内存缓存);settings.string 需保持绑定。
    this.concurrencyBudget = new ConcurrencyBudget({
      settings: () => makeSettingsStoreBudgetSettings((key) => this.settings.string(key)),
    });
    this.teamService = new AgentTeamApplicationService({
      repository: this.repository,
      childExecution: this.childExecution,
      integration: this.integration,
      eventHub: this.eventHub,
      // Settings → 常规: auto-retry budget + launch pacing, read per use.
      executionPolicy: () => ({
        taskRetryLimit: clampTaskRetryLimit(this.settings.string(TASK_RETRY_LIMIT_KEY)),
        launchStaggerSeconds: clampLaunchStaggerSeconds(this.settings.string(LAUNCH_STAGGER_SECONDS_KEY)),
      }),
      // accept 前强制门禁判定 + 启动时配置快照(specs/002-v04 B 节 / R4)。
      qualityGate: this.qualityGate,
      concurrencyBudget: this.concurrencyBudget,
    });
    this.queryService = new TeamQueryService(this.repository);
    // 全局工作台六分区聚合(US2):结构性端口只取 teamService 的排队原因
    // 内存态,GUI 与 MCP 同构(interfaces.md B 节 workbench:summary)。
    this.workbench = new WorkbenchService({
      repository: this.repository,
      agentTeamService: this.teamService,
    });
    // Review Center shares the same repository/git/teamService instances as the
    // MCP tools (constitution principle two) — GUI and MCP stay isomorphic.
    // gh(可选)承担 GitHub PR 回灌用例,未启用时错误在服务层可读透传。
    this.reviewCenter = new ReviewCenterService({
      repository: this.repository,
      git: this.git,
      teamService: this.teamService,
      gh: this.gh,
    });
    // 跨模型审查仲裁(User Story 3):同样共享 repository/teamService 实例,
    // GUI 与 MCP 同构;依赖已就绪(qualityGate/reviewCenter 均已构造)。
    this.reviewModes = new ReviewModeService({
      repository: this.repository,
      teamService: this.teamService,
      gate: this.qualityGate,
      reviewCenter: this.reviewCenter,
    });
    this.keychain = new KeychainTokenStore();
    this.codexConfig = new FileCodexConfigAdapter();
    this.piConfig = new FilePiConfigAdapter();
    // Same self-launch command the Codex MCP writer uses, embedded into the
    // installed skill's Connection section.
    this.skillInstaller = new FileSkillInstaller({
      selfCommand: () => {
        const appRoot = app.getAppPath();
        return {
          command: process.execPath,
          args: app.isPackaged ? ["--mcp-stdio"] : [appRoot, "--mcp-stdio"],
        };
      },
    });
    this.loginItem = new MainAppLoginItemAdapter();
    this.notifications = new NotificationAdapter();
    this.contextFetch = new ContextFetchService(this.repository);
    this.mcpServer = new OctoPunkMCPServer({
      service: this.teamService,
      git: this.git,
      keychain: this.keychain,
      eventHub: this.eventHub,
      readOnlyContext: this.contextFetch,
      defaultMaxConcurrentTasks: () => storedDefaultMaxConcurrentTasks(this.settings),
      reviewCenter: this.reviewCenter,
      qualityGate: this.qualityGate,
      reviewModes: this.reviewModes,
      workbench: this.workbench,
    });
  }

  async checkAgent(
    kind: "claude_code" | "codex" | "pi",
    executableOverride?: string | null,
  ): Promise<ChildAgentAvailability> {
    const executable = OctoPunkToolLocator.resolveConfigured(
      executableOverride,
      kind === "claude_code" ? "claude" : kind === "pi" ? "pi" : "codex",
    );
    if (!isExecutable(executable)) {
      return {
        kind,
        executable,
        isAvailable: false,
        detail: "Executable not found or not executable.",
      };
    }
    try {
      const result = await this.process.run({
        id: crypto.randomUUID(),
        executable,
        arguments: ["--version"],
        environment: {},
      });
      const version = [result.stdout, result.stderr].join(" ").trim();
      return {
        kind,
        executable,
        isAvailable: true,
        detail: version.length === 0 ? "CLI started successfully." : version,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind,
        executable,
        isAvailable: false,
        detail: ChildAgentDiagnostics.redact(message, 512),
      };
    }
  }
}

/**
 * The per-task restricted context MCP server needs a command that launches
 * this app with `--mcp-stdio`. Packaged builds use the app executable
 * directly; `electron .` dev runs get a generated launcher script.
 */
function storedDefaultMaxConcurrentTasks(settings: SettingsStore): number {
  const parsed = Number.parseInt(settings.string(MAX_CONCURRENT_TASKS_KEY) ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CONCURRENT_TASKS;
  return Math.min(MAX_CONCURRENT_TASKS_LIMIT, Math.max(1, Math.round(parsed)));
}

export function resolveSelfExecutable(): string {
  const appRoot = app.getAppPath();
  const packaged = app.isPackaged;
  if (packaged) {
    return process.execPath;
  }
  try {
    const script = path.join(octoPunkSupportDirectory(), "octopunk-dev-launcher.sh");
    const electron = process.execPath.replace(/"/g, '\\"');
    const root = appRoot.replace(/"/g, '\\"');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, `#!/bin/sh\nexec "${electron}" "${root}" --mcp-stdio\n`, "utf8");
    fs.chmodSync(script, 0o755);
    return isExecutable(script) ? script : process.execPath;
  } catch {
    return process.execPath;
  }
}

export function applicationSupportTempHint(): string {
  return os.homedir();
}
