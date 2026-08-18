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
import { CodexAppServerAdapter, ChildAgentRegistry } from "./platform/codexAppServerAdapter";
import { OctoPunkToolLocator } from "./platform/toolLocator";
import { KeychainTokenStore } from "./platform/keychainTokenStore";
import { FileCodexConfigAdapter } from "./platform/codexConfigAdapter";
import { FileSkillInstaller } from "./platform/skillInstaller";
import { MainAppLoginItemAdapter } from "./platform/loginItemAdapter";
import { NotificationAdapter } from "./platform/notificationAdapter";
import { ChildExecutionService } from "./application/childExecutionService";
import { TaskIntegrationService } from "./application/taskIntegrationService";
import { AgentTeamApplicationService } from "./application/agentTeamService";
import { TeamQueryService } from "./application/teamQueryService";
import { ContextFetchService } from "./application/contextFetchService";
import { TaskEventHub } from "./domain/events";
import { OctoPunkMCPServer } from "./mcp/server";
import {
  CLAUDE_EXECUTABLE_KEY,
  CODEX_EXECUTABLE_KEY,
  CUSTOM_INSTRUCTIONS_KEY,
  LEGACY_CLAUDE_EXECUTABLE_KEY,
  SettingsStore,
  octoPunkSupportDirectory,
} from "./settingsStore";
import { ChildAgentDiagnostics, type ChildAgentAvailability } from "./application/ports";

export class AppEnvironment {
  readonly database: OctoPunkDatabase;
  readonly repository: SqliteTeamRunRepository;
  readonly process: LocalProcessAdapter;
  readonly git: GitAdapter;
  readonly claude: ClaudeCLIAdapter;
  readonly codex: CodexAppServerAdapter;
  readonly childAgents: ChildAgentRegistry;
  readonly childExecution: ChildExecutionService;
  readonly integration: TaskIntegrationService;
  readonly teamService: AgentTeamApplicationService;
  readonly queryService: TeamQueryService;
  readonly contextFetch: ContextFetchService;
  readonly eventHub: TaskEventHub;
  readonly keychain: KeychainTokenStore;
  readonly codexConfig: FileCodexConfigAdapter;
  readonly skillInstaller: FileSkillInstaller;
  readonly loginItem: MainAppLoginItemAdapter;
  readonly mcpServer: OctoPunkMCPServer;
  readonly notifications: NotificationAdapter;
  readonly settings: SettingsStore;
  readonly claudeExecutable: string;
  readonly codexExecutable: string;

  constructor(input?: { databaseURL?: string | null; claudeExecutable?: string | null; codexExecutable?: string | null }) {
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
    this.childAgents = new ChildAgentRegistry(this.claude, this.codex);
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
    });
    this.integration = new TaskIntegrationService(this.git);
    this.eventHub = new TaskEventHub();
    this.teamService = new AgentTeamApplicationService({
      repository: this.repository,
      childExecution: this.childExecution,
      integration: this.integration,
      eventHub: this.eventHub,
    });
    this.queryService = new TeamQueryService(this.repository);
    this.keychain = new KeychainTokenStore();
    this.codexConfig = new FileCodexConfigAdapter();
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
    });
  }

  async checkAgent(
    kind: "claude_code" | "codex",
    executableOverride?: string | null,
  ): Promise<ChildAgentAvailability> {
    const executable = OctoPunkToolLocator.resolveConfigured(
      executableOverride,
      kind === "claude_code" ? "claude" : "codex",
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
