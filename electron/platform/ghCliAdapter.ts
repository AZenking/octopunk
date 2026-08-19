// GitHub PR back-fill adapter (spec 002-v04 User Story 4 / R7): every GitHub
// interaction goes through the user's local `gh` CLI. OctoPunk never stores a
// GitHub token — gh owns authentication. The feature is off by default; the
// composition root supplies `enabled` from settings. Missing CLI or missing
// login degrade to readable Chinese errors and never affect local review.

import { randomUUID } from "node:crypto";
import os from "node:os";
import { ChildAgentDiagnostics, type ProcessPort, type ProcessRequest, type ProcessResult } from "../application/ports";
import { OctoPunkToolLocator } from "./toolLocator";

/** Cap for PR comment bodies returned to the app (redacted first, then cut). */
const COMMENT_BODY_BUDGET = 1024;
/** Only the most recent comments are kept per PR status probe. */
const COMMENT_WINDOW = 50;

export type GhCliErrorKind = "missing" | "not_authenticated" | "unavailable";

export class GhCliError extends Error {
  readonly kind: GhCliErrorKind;

  constructor(kind: GhCliErrorKind, message: string) {
    super(message);
    this.name = "GhCliError";
    this.kind = kind;
  }

  static missing(executable: string): GhCliError {
    return new GhCliError(
      "missing",
      `未检测到 GitHub CLI（gh，尝试路径 ${executable}）。请先安装 gh（macOS 可执行 brew install gh）后重试。`,
    );
  }

  static notAuthenticated(): GhCliError {
    return new GhCliError(
      "not_authenticated",
      "gh CLI 尚未登录 GitHub。请在终端执行 gh auth login 完成登录后重试；OctoPunk 不保存任何 GitHub 凭证。",
    );
  }

  static unavailable(detail: string): GhCliError {
    return new GhCliError("unavailable", `GitHub 回灌暂不可用：${detail}`);
  }

  /** Same classification as unavailable, without the double-wrapped prefix. */
  static disabled(): GhCliError {
    return new GhCliError("unavailable", "GitHub 回灌未在设置中启用");
  }
}

export interface GhCliAvailability {
  available: boolean;
  detail: string;
}

export interface GhCreatePrInput {
  repositoryURL: string;
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
}

export interface GhPrRef {
  url: string;
  number: number;
}

export interface GhPrStatusInput {
  repositoryURL: string;
  number: number;
}

export interface GhStatusCheck {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GhPrComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface GhPrStatus {
  state: string;
  statusChecks: GhStatusCheck[];
  comments: GhPrComment[];
}

interface GhFailure {
  /** null when the executable itself could not be launched. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  message: string;
}

export class GhCliAdapter {
  private readonly process: ProcessPort;
  private readonly enabled: () => boolean;
  private readonly ghExecutable: string;

  constructor(input: { process: ProcessPort; enabled: () => boolean; ghExecutable?: string }) {
    this.process = input.process;
    this.enabled = input.enabled;
    this.ghExecutable = input.ghExecutable ?? OctoPunkToolLocator.locate("gh");
  }

  /**
   * Probe `gh --version` + `gh auth status`; never throws. `ignoreEnabled`
   * bypasses the settings gate for this harmless read-only probe — the
   * Settings page checks availability *before* the user flips the switch.
   */
  async checkAvailability(ignoreEnabled = false): Promise<GhCliAvailability> {
    if (!ignoreEnabled) {
      this.requireEnabled();
    }
    let version: ProcessResult;
    try {
      version = await this.runGh(["--version"]);
    } catch (error) {
      const failure = describeFailure(error);
      if (failure.exitCode == null) {
        return { available: false, detail: GhCliError.missing(this.ghExecutable).message };
      }
      return { available: false, detail: GhCliError.unavailable(readableDetail(failure)).message };
    }
    const ghVersion = firstLine(version.stdout) || firstLine(version.stderr);
    let auth: ProcessResult;
    try {
      auth = await this.runGh(["auth", "status"]);
    } catch (error) {
      const failure = describeFailure(error);
      if (failure.exitCode == null) {
        return { available: false, detail: GhCliError.missing(this.ghExecutable).message };
      }
      if (!looksUnauthenticated(failure)) {
        return { available: false, detail: GhCliError.unavailable(readableDetail(failure)).message };
      }
      return { available: false, detail: GhCliError.notAuthenticated().message };
    }
    const login = extractLogin(auth.stdout);
    const accountSuffix = login != null ? `账号 ${login}` : "已登录";
    const versionSuffix = ghVersion.length > 0 ? `（${ghVersion}）` : "";
    return { available: true, detail: `GitHub CLI 可用，${accountSuffix}${versionSuffix}。` };
  }

  /** `gh pr create`; an "already exists" failure resolves to the existing PR. */
  async createPr(input: GhCreatePrInput): Promise<GhPrRef> {
    this.requireEnabled();
    for (const [label, value] of [
      ["repositoryURL", input.repositoryURL],
      ["title", input.title],
      ["headBranch", input.headBranch],
      ["baseBranch", input.baseBranch],
    ] as const) {
      if (value.trim().length === 0) {
        throw GhCliError.unavailable(`创建 PR 缺少必填参数 ${label}。`);
      }
    }
    let created: ProcessResult;
    try {
      created = await this.runGh(
        [
          "pr",
          "create",
          "--title",
          input.title,
          "--body",
          input.body,
          "--head",
          input.headBranch,
          "--base",
          input.baseBranch,
          "--json",
          "url,number",
        ],
        input.repositoryURL,
      );
    } catch (error) {
      const failure = describeFailure(error);
      if (failure.exitCode != null && mentionsAlreadyExists(failure)) {
        return await this.findExistingPr(input.repositoryURL, input.headBranch);
      }
      throw this.toGhCliError(failure);
    }
    return parsePrRef(created.stdout, "gh pr create");
  }

  /** `gh pr view` — state, check rollup and the latest 50 redacted comments. */
  async prStatus(input: GhPrStatusInput): Promise<GhPrStatus> {
    this.requireEnabled();
    if (!Number.isInteger(input.number) || input.number <= 0) {
      throw GhCliError.unavailable(`无效的 PR 编号（${String(input.number)}）。`);
    }
    let view: ProcessResult;
    try {
      view = await this.runGh(
        ["pr", "view", String(input.number), "--json", "state,statusCheckRollup,comments"],
        input.repositoryURL,
      );
    } catch (error) {
      throw this.toGhCliError(describeFailure(error));
    }
    return parsePrStatus(view.stdout);
  }

  /** `gh pr list --head <branch>` — fallback lookup when create reports a duplicate. */
  private async findExistingPr(repositoryURL: string, headBranch: string): Promise<GhPrRef> {
    let listed: ProcessResult;
    try {
      listed = await this.runGh(["pr", "list", "--head", headBranch, "--json", "url,number"], repositoryURL);
    } catch (error) {
      throw GhCliError.unavailable(
        `该分支已存在同名 PR，但查询现有 PR 失败：${readableDetail(describeFailure(error))}`,
      );
    }
    let entries: unknown;
    try {
      entries = JSON.parse(listed.stdout);
    } catch {
      throw GhCliError.unavailable("该分支已存在同名 PR，但 gh pr list 返回了无法解析的内容。");
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw GhCliError.unavailable(
        `gh 报告分支 ${headBranch} 已存在同名 PR，但按该分支未查询到任何 PR，请在 GitHub 上手动确认。`,
      );
    }
    return parsePrRef(JSON.stringify(entries[0]), "gh pr list");
  }

  private requireEnabled(): void {
    if (!this.enabled()) {
      throw GhCliError.disabled();
    }
  }

  private toGhCliError(failure: GhFailure): GhCliError {
    if (failure.exitCode == null) {
      return GhCliError.missing(this.ghExecutable);
    }
    if (looksUnauthenticated(failure)) {
      return GhCliError.notAuthenticated();
    }
    return GhCliError.unavailable(readableDetail(failure));
  }

  private async runGh(arguments_: string[], workingDirectory?: string): Promise<ProcessResult> {
    const request: ProcessRequest = {
      id: randomUUID(),
      executable: this.ghExecutable,
      arguments: arguments_,
      workingDirectory: workingDirectory ?? null,
      environment: minimalGhEnvironment(),
    };
    return await this.process.run(request);
  }
}

/**
 * gh needs exactly HOME (config/keyring lookup) and PATH (git helper); the
 * ProcessPort implementation may already inject the allow-listed minimum, so
 * this stays additive and never leaks the full desktop environment.
 */
function minimalGhEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  environment.HOME = process.env.HOME ?? os.homedir();
  environment.PATH =
    process.env.PATH && process.env.PATH.length > 0
      ? process.env.PATH
      : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return environment;
}

/** Normalizes any ProcessPort failure (launch error or non-zero exit). */
function describeFailure(error: unknown): GhFailure {
  const candidate = error as { exitCode?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
  const exitCode =
    typeof candidate.exitCode === "number" && Number.isFinite(candidate.exitCode) ? candidate.exitCode : null;
  const stdout = typeof candidate.stdout === "string" ? candidate.stdout : "";
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr : "";
  const message = error instanceof Error ? error.message : String(error);
  return { exitCode, stdout, stderr, message };
}

function combinedText(failure: GhFailure): string {
  return [failure.stderr, failure.stdout, failure.message].filter((value) => value.length > 0).join("\n");
}

function readableDetail(failure: GhFailure): string {
  const detail = ChildAgentDiagnostics.redact(combinedText(failure), 512).trim();
  return detail.length > 0 ? detail : `gh 命令执行失败（退出码 ${failure.exitCode ?? "未知"}）。`;
}

function looksUnauthenticated(failure: GhFailure): boolean {
  const text = combinedText(failure).toLowerCase();
  return (
    text.includes("not logged in") ||
    text.includes("not logged into") ||
    text.includes("no accounts logged in") ||
    text.includes("gh auth login") ||
    text.includes("authentication required") ||
    text.includes("http 401")
  );
}

function mentionsAlreadyExists(failure: GhFailure): boolean {
  return combinedText(failure).toLowerCase().includes("already exists");
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

/** "Logged in to github.com as <login>" → <login> (best effort). */
function extractLogin(text: string): string | null {
  const match = /logged in to \S+ account ([^\s(]+)/i.exec(text) ?? /logged in to \S+ as (\S+)/i.exec(text);
  return match?.[1] ?? null;
}

function parsePrRef(raw: string, command: string): GhPrRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw GhCliError.unavailable(`${command} 返回了无法解析的内容。`);
  }
  const candidate = parsed as { url?: unknown; number?: unknown };
  if (typeof candidate.url !== "string" || candidate.url.length === 0 || typeof candidate.number !== "number") {
    throw GhCliError.unavailable(`${command} 返回的内容缺少 PR 链接或编号。`);
  }
  return { url: candidate.url, number: candidate.number };
}

function parsePrStatus(raw: string): GhPrStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw GhCliError.unavailable("gh pr view 返回了无法解析的内容。");
  }
  const candidate = parsed as {
    state?: unknown;
    statusCheckRollup?: unknown;
    comments?: unknown;
  };
  const state = typeof candidate.state === "string" && candidate.state.length > 0 ? candidate.state : "UNKNOWN";
  const rollup = Array.isArray(candidate.statusCheckRollup) ? candidate.statusCheckRollup : [];
  const statusChecks = rollup.map((entry) => {
    const check = entry as { name?: unknown; context?: unknown; status?: unknown; state?: unknown; conclusion?: unknown };
    return {
      name: typeof check.name === "string" && check.name.length > 0 ? check.name
        : typeof check.context === "string" ? check.context
        : "未命名检查",
      status: typeof check.status === "string" ? check.status : typeof check.state === "string" ? check.state : "UNKNOWN",
      conclusion: typeof check.conclusion === "string" ? check.conclusion : null,
    };
  });
  const rawComments = Array.isArray(candidate.comments) ? candidate.comments : [];
  const comments = rawComments
    .slice(-COMMENT_WINDOW)
    .map((entry) => {
      const comment = entry as { author?: { login?: unknown }; body?: unknown; createdAt?: unknown };
      return {
        author:
          comment.author != null && typeof comment.author === "object" && typeof comment.author.login === "string"
            ? comment.author.login
            : "未知用户",
        body: ChildAgentDiagnostics.redact(typeof comment.body === "string" ? comment.body : "", COMMENT_BODY_BUDGET),
        createdAt: typeof comment.createdAt === "string" ? comment.createdAt : "",
      };
    });
  return { state, statusChecks, comments };
}
