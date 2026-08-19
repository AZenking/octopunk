// Shared DTO contracts between the Electron main process and the React
// renderer. Types only plus pure helpers (no Node APIs) so both tsconfigs
// can include this directory. Mirrors OctoPunk/OctoPunk/Application/DTOs.

export type TeamRunStatus =
  | "ready"
  | "running"
  | "reviewing"
  | "awaiting_final_review"
  | "completed"
  | "blocked"
  | "cancelled"
  | "failed";

export type ChildTaskStatus =
  | "queued"
  | "running"
  | "awaiting_report"
  | "rework_required"
  | "accepted"
  | "blocked"
  | "cancelled"
  | "failed";

export type ChildAgentKind = "claude_code" | "codex" | "pi";
export type TaskExecutionMode = "read_only" | "workspace_write";
export type TaskWorkspaceKind = "shared_read_only" | "isolated_write";
export type ReviewVerdict = "PASS" | "REWORK" | "BLOCKED";
export type ReviewFindingSeverity = "blocker" | "high" | "medium" | "low" | "info";

/** 质量门禁检查项种类(与 gate_evaluation_items.check_key 对齐)。 */
export type GateCheckKey =
  | "tests"
  | "lint"
  | "typecheck"
  | "build"
  | "risk_findings"
  | "scope"
  | "dependencies"
  | "target_baseline"
  | "reviewers"
  | "high_risk_confirm"
  | "todo_clean";

/** 审查模式(门禁配置 review_mode,spec 002)。 */
export type GateReviewMode =
  | "standard"
  | "cross_model"
  | "dual_readonly"
  | "contest"
  | "role_based"
  | "arbitration";

/** Timestamps are REAL epoch seconds, exactly like the SQLite storage. */
export type EpochSeconds = number;

export interface TeamRunDTO {
  id: string;
  repositoryPath: string;
  task: string;
  baselineCommit: string;
  targetBranch: string;
  status: string;
  currentReviewRound: number;
  maxReviewRounds: number;
  revision: number;
  /** 调度优先级(-5..5,越大越先得并发配额;v0.3)。 */
  priority: number;
  /** 暂停时间戳;null = 未暂停(v0.3)。 */
  pausedAt: EpochSeconds | null;
  createdAt: EpochSeconds;
  updatedAt: EpochSeconds;
}

export interface ChildTaskDTO {
  id: string;
  runID: string;
  batchID: string | null;
  clientKey: string | null;
  parentTaskID: string | null;
  title: string;
  status: string;
  agentKind: string;
  /** Per-task model override; null falls back to the per-kind setting. */
  model: string | null;
  executionMode: string;
  workspaceKind: string;
  sessionID: string | null;
  currentAttemptID: string | null;
  branchName: string;
  worktreePath: string;
  baselineCommit: string;
  contextSnapshot: string;
  latestReport: string | null;
  latestError: string | null;
  reviewRound: number;
  updatedAt: EpochSeconds;
}

export interface TaskBatchDTO {
  id: string;
  runID: string;
  contextSummary: string;
  createdAt: EpochSeconds;
  taskIDs: string[];
}

export interface DelegateTaskMappingDTO {
  clientKey: string;
  task: ChildTaskDTO;
}

export interface DelegateTasksResultDTO {
  batch: TaskBatchDTO;
  tasks: ChildTaskDTO[];
  taskMapping: DelegateTaskMappingDTO[];
}

export interface TaskExecutionLogDTO {
  id: string;
  runID: string;
  taskID: string;
  attemptID: string;
  stdoutTail: string;
  stderrTail: string;
  latestActivity: string | null;
  toolSummary: string[];
  updatedAt: EpochSeconds;
}

export interface ReviewFindingDTO {
  id: string;
  taskID: string | null;
  severity: string;
  file: string | null;
  line: number | null;
  evidence: string;
  expectedFix: string | null;
}

export interface RelayEventDTO {
  id: string;
  runID: string;
  taskID: string | null;
  sequence: number;
  kind: string;
  payload: string;
  createdAt: EpochSeconds;
}

export interface TaskDependencyDTO {
  id: string;
  runID: string;
  taskID: string;
  dependsOnTaskID: string;
}

export interface ReviewCycleDTO {
  id: string;
  runID: string;
  taskID: string | null;
  round: number;
  reviewer: string;
  verdict: string;
  summary: string;
  createdAt: EpochSeconds;
}

export interface TaskAttemptDTO {
  id: string;
  runID: string;
  taskID: string;
  number: number;
  prompt: string;
  sessionID: string | null;
  status: string;
  startedAt: EpochSeconds;
  finishedAt: EpochSeconds | null;
  failure: string | null;
}

export interface TaskExecutionReportDTO {
  id: string;
  runID: string;
  taskID: string;
  attemptID: string;
  sessionID: string;
  summary: string;
  rawOutput: string;
  tests: string[];
  changedFiles: string[];
  diffSummary: string | null;
  blocker: string | null;
  createdAt: EpochSeconds;
}

/** First-screen payload for the run detail view (spec 001 US1). */
export interface RunSummaryDTO {
  run: TeamRunDTO;
  batches: TaskBatchDTO[];
  tasks: ChildTaskDTO[];
  dependencies: TaskDependencyDTO[];
  /** Precomputed tree-depth index (O(n)); capped at 8. */
  treeDepth: Record<string, number>;
}

export function treeTitleFor(task: ChildTaskDTO, treeDepth: Record<string, number>): string {
  const depth = treeDepth[task.id] ?? 0;
  return "  ".repeat(depth) + (depth > 0 ? "↳ " : "") + task.title;
}

/** Audit-event tail; `lastSequence` is the backward-paging cursor. */
export interface EventTailDTO {
  events: RelayEventDTO[];
  lastSequence: number;
}

export interface TeamStatusDTO {
  run: TeamRunDTO;
  batches: TaskBatchDTO[];
  tasks: ChildTaskDTO[];
  dependencies: TaskDependencyDTO[];
  reviewCycles: ReviewCycleDTO[];
  findings: ReviewFindingDTO[];
  attempts: TaskAttemptDTO[];
  reports: TaskExecutionReportDTO[];
  executionLogs: TaskExecutionLogDTO[];
  events: RelayEventDTO[];
}

export interface TeamReviewContextDTO {
  run: TeamRunDTO;
  batches: TaskBatchDTO[];
  tasks: ChildTaskDTO[];
  reports: Record<string, string>;
  findings: ReviewFindingDTO[];
  attempts: TaskAttemptDTO[];
  executionReports: TaskExecutionReportDTO[];
  executionLogs: TaskExecutionLogDTO[];
  latestEvents: RelayEventDTO[];
}

export interface TaskExecutionLogSliceDTO {
  taskID: string;
  log: TaskExecutionLogDTO | null;
  events: RelayEventDTO[];
}

export interface TaskReportDTO {
  task: ChildTaskDTO;
  report: string | null;
  status: string;
  executionReport: TaskExecutionReportDTO | null;
}

export interface JoinedTaskDTO {
  id: string;
  clientKey: string | null;
  parentTaskID: string | null;
  title: string;
  status: string;
  agentKind: string;
  executionMode: string;
  report: string | null;
  latestError: string | null;
  executionReport: TaskExecutionReportDTO | null;
  elapsedSeconds: number;
}

export interface JoinTasksDTO {
  runID: string;
  batchID: string | null;
  tasks: JoinedTaskDTO[];
  pendingTaskIDs: string[];
  timedOut: boolean;
  latestEventSequence: number;
  markdownSummary: string;
}

export interface TeamRunSummaryDTO {
  id: string;
  repositoryPath: string;
  task: string;
  status: TeamRunStatus;
  taskCount: number;
  acceptedTaskCount: number;
  updatedAt: EpochSeconds;
  archivedAt: EpochSeconds | null;
}

export interface ContextTaskDigestDTO {
  id: string;
  title: string;
  status: string;
  agentKind: string;
  executionMode: string;
  hasReport: boolean;
  reportBytes: number;
}

export interface ContextFetchDigestDTO {
  summary: string;
  tasks: ContextTaskDigestDTO[];
  generatedAt: EpochSeconds;
}

export interface TaskReportPayloadDTO {
  taskID: string;
  report: string;
  truncated: boolean;
}

export interface ChildAgentAvailabilityDTO {
  kind: ChildAgentKind;
  executable: string;
  isAvailable: boolean;
  detail: string;
}

export interface TaskEventUpdateDTO {
  runID: string;
  batchID: string | null;
  taskID: string | null;
  parentTaskID: string | null;
  sequence: number;
  kind: string;
  status: string | null;
  activityPreview: string | null;
  createdAt: EpochSeconds;
}

/** 跨 run 待审查任务聚合项(Review Center 列表,status 为 awaiting_report / rework_required)。 */
export interface ReviewPendingTaskDTO {
  runID: string;
  /** 所属运行的顶层任务描述(TeamRun.task)。 */
  runTitle: string;
  taskID: string;
  title: string;
  agentKind: string;
  model: string | null;
  executionMode: string;
  reviewRound: number;
  status: string;
  /** 最新报告摘要(已截断的预览文本);无报告为 null。 */
  latestReport: string | null;
  unresolvedFindingCount: number;
  /** 存在未解决 severity=risk 的发现(severity 风险置顶呈现)。 */
  hasRiskFinding: boolean;
  updatedAt: EpochSeconds;
}

/** Diff 变更树条目(单文件变更统计)。 */
export interface DiffTreeEntryDTO {
  path: string;
  changeType: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  isBinary: boolean;
  /** 超出单文件读取上限,内容需分页或降级展示。 */
  oversize: boolean;
}

/** Diff 单行;行不存在于某一侧时对应行号为 null。 */
export interface DiffLineDTO {
  origin: "add" | "del" | "ctx" | "hunk";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

/** Diff hunk(old/new 两侧起始行号与行数的连续差异块)。 */
export interface DiffHunkDTO {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLineDTO[];
}

/** 任务 Diff 分页(单页 ≤64KiB 且经 redact;nextCursor 为 null 表示末页)。 */
export interface DiffPageDTO {
  taskID: string;
  side: "baseline" | "worktree" | "integration";
  path: string;
  hunks: DiffHunkDTO[];
  nextCursor: string | null;
  truncated: boolean;
}

/** 行级评论(锚点为基线侧行号,contextSnapshot 防返工后行漂移)。 */
export interface ReviewCommentDTO {
  id: string;
  runID: string;
  taskID: string;
  reviewRound: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  /** 锚点行内容快照(≤2KiB)。 */
  contextSnapshot: string;
  body: string;
  /** risk 计入高风险发现;dismiss 需附理由。 */
  severity: "info" | "risk";
  /** 作者:user / codex / claude_code / pi。 */
  author: string;
  /** open → resolved / dismissed / line_changed,终态不可逆。 */
  status: "open" | "resolved" | "dismissed" | "line_changed";
  createdAt: EpochSeconds;
  updatedAt: EpochSeconds;
}

/** 单条门禁检查命令(在任务 worktree 内受控执行,超时判定 unknown)。 */
export interface GateCommandConfigDTO {
  command: string;
  timeoutSeconds: number;
}

/** 四类命令检查的条件开关;null 表示该项目未启用该检查。 */
export interface GateChecksConfigDTO {
  tests: GateCommandConfigDTO | null;
  lint: GateCommandConfigDTO | null;
  typecheck: GateCommandConfigDTO | null;
  build: GateCommandConfigDTO | null;
}

/** 项目默认门禁配置(project_gate_configs.config_json 的结构;保存时拒绝矛盾组合)。 */
export interface GateConfigDTO {
  checks: GateChecksConfigDTO;
  /** 未解决 risk 发现数超过该值时 risk_findings 判定失败。 */
  maxRiskFindings: number;
  /** scope 检查允许变更的路径前缀白名单;空数组表示未配置限制。 */
  scopeAllowedPaths: string[];
  /** 要求依赖任务全部 accepted,否则 dependencies 判定失败。 */
  requireDependenciesAccepted: boolean;
  /** 要求目标基线安全,否则 target_baseline 判定失败。 */
  requireTargetBaselineSafe: boolean;
  /** reviewers 检查要求到场的审查者(引用 Agent 类型,不存在则保存报错)。 */
  requiredReviewers: string[];
  /** 存在 risk 发现时须人工确认后方可 accept。 */
  manualConfirmHighRisk: boolean;
  /** 要求工作区无遗留 Todo(todo_clean 检查,需先配置白名单)。 */
  requireTodoClean: boolean;
  reviewMode: GateReviewMode;
}

/** 门禁判定(gate_evaluations;幂等重跑生成新 evaluation)。 */
export interface GateEvaluationDTO {
  id: string;
  runID: string;
  taskID: string;
  /** 幂等键(cachedResponse 复用既有机制)。 */
  requestID: string;
  /** pass / fail / waived(全部失败项已豁免时重算为 waived)。 */
  overall: "pass" | "fail" | "waived";
  evaluatedAt: EpochSeconds;
  items: GateEvaluationItemDTO[];
}

/** 门禁逐项明细(gate_evaluation_items;unknown 不阻塞仅醒目呈现)。 */
export interface GateEvaluationItemDTO {
  id: string;
  evaluationID: string;
  checkKey: GateCheckKey;
  /** unknown 表示命令超时或无法确认。 */
  status: "pass" | "fail" | "waived" | "unknown";
  /** 结论摘要(含命令输出尾段,redact ≤2KiB)。 */
  detail: string;
  /** 失败时的可执行修复建议;非失败项为 null。 */
  fixSuggestion: string | null;
  /** 豁免留痕(主 Agent 或用户,逐项豁免必须附理由)。 */
  waivedBy: string | null;
  waivedReason: string | null;
  waivedAt: EpochSeconds | null;
}

/** TeamRun 启动时的轻量门禁覆盖(StartForm 收集,随 team:start 传给主进程;
 *  仅覆盖 maxRiskFindings/reviewMode/三个布尔开关。字段缺省(undefined)=不
 *  覆盖,与主进程 mergeGateConfigs 的合并语义对齐;整体为 null = 沿用项目默认)。 */
export interface GateStartOverrideDTO {
  maxRiskFindings?: number;
  reviewMode?: GateReviewMode;
  requireDependenciesAccepted?: boolean;
  requireTargetBaselineSafe?: boolean;
  manualConfirmHighRisk?: boolean;
}

/** 交付摘要(delivery_summaries;accept 通过后自动生成)。 */
export interface DeliverySummaryDTO {
  id: string;
  runID: string;
  /** 任务级摘要为任务 id;run 终审摘要为 null。 */
  taskID: string | null;
  verdict: ReviewVerdict;
  /** 结构化 Markdown(结论/证据链接/豁免清单/遗留项)。 */
  summaryMd: string;
  /** 证据引用集(report/log/diff/gate/review 的 id)。 */
  evidence: string[];
  waiverCount: number;
  openFindingCount: number;
  createdAt: EpochSeconds;
}

export const AGENT_KINDS: ChildAgentKind[] = ["claude_code", "codex"];
export const EXECUTION_MODES: TaskExecutionMode[] = ["read_only", "workspace_write"];

// ---- v0.3 稳定性与多任务运行(specs/001-v03-stability-multi-teamrun)----

/** 任务排队原因 = 闸门拒绝级别(queued 任务的派生字段;null = 未在排队)。 */
export type QueueReasonDTO =
  | "global_budget"
  | "project_budget"
  | "kind_budget"
  | "resource_pressure"
  | "launch_stagger"
  | "run_paused";

/** 工作台条目 = 六分区聚合视图的最小任务投影(数据源:observeRunSummaries + runSummary)。 */
export interface WorkbenchEntryDTO {
  runID: string;
  /** 所属运行的顶层任务描述(TeamRun.task)。 */
  runTitle: string;
  repositoryPath: string;
  taskID: string;
  title: string;
  agentKind: string;
  status: string;
  /** 仅 queued 分区有值,标注闸门拒绝级别;其余分区为 null。 */
  queueReason: QueueReasonDTO | null;
  updatedAt: EpochSeconds;
}

/** 工作台单个分区(派生视图,不落库;entries 已按分区语义过滤)。 */
export interface WorkbenchSectionDTO {
  section: "running" | "queued" | "awaiting_input" | "failed" | "awaiting_review" | "integratable";
  entries: WorkbenchEntryDTO[];
}

/** run 级调度控制字段(team_runs.priority / paused_at;不并入既有摘要 DTO,独立返回)。 */
export interface RunControlDTO {
  /** 调度排序权重:priority DESC, created_at ASC;越大越先得配额(MCP 允许 -5..5)。 */
  priority: number;
  /** 暂停时间戳;null = 未暂停。暂停只停新配额发放,不影响运行中任务。 */
  pausedAt: EpochSeconds | null;
}

/** 体检检查项种类(与 doctor_check_items.check_key 对齐,共九项)。 */
export type DoctorCheckKeyDTO =
  | "cli_path"
  | "gui_path"
  | "login"
  | "mcp_stdio"
  | "git_repo"
  | "worktree_disk"
  | "sandbox"
  | "provider_quota"
  | "db_health";

/** 体检逐项明细(doctor_check_items;unknown 表示无法确认或单项超时)。 */
export interface DoctorCheckItemDTO {
  checkKey: DoctorCheckKeyDTO;
  status: "pass" | "fail" | "unknown";
  /** 结论摘要(redact ≤2KiB;fail 时含观测值)。 */
  detail: string;
  /** 影响范围(如「委派将失败」)。 */
  impact: string;
  /** 推荐处理方式。 */
  suggestion: string;
  /** 单项耗时(毫秒)。 */
  durationMs: number;
}

/** 体检报告(doctor_reports;overall 有 fail 即 fail,仅 unknown 即 degraded,全 pass 即 pass)。 */
export interface DoctorReportDTO {
  id: string;
  /** 触发来源:user(手动)/ codex(MCP)/ prestart(启动拦截)。 */
  triggeredBy: string;
  /** 体检针对的仓库;null = 全局项。 */
  repositoryPath: string | null;
  overall: "pass" | "fail" | "degraded";
  items: DoctorCheckItemDTO[];
  createdAt: EpochSeconds;
}

/** 恢复视图单项(启动时与手动刷新时派生,不落库)。 */
export interface RecoveryItemDTO {
  kind: "interrupted" | "process_alive" | "orphan_worktree" | "orphan_branch" | "stale_lock";
  runID: string | null;
  taskID: string | null;
  detail: string;
  suggestion: string;
}

/** 恢复视图 = 非终态 run × 进程核对结果 × 孤儿扫描结果。 */
export interface RecoveryStatusDTO {
  items: RecoveryItemDTO[];
  scannedAt: EpochSeconds;
}

export function displayNameForAgentKind(kind: string): string {
  return kind === "codex" ? "Codex" : kind === "claude_code" ? "Claude Code" : kind;
}

export function displayNameForExecutionMode(mode: string): string {
  return mode === "read_only" ? "Read only" : mode === "workspace_write" ? "Workspace write" : mode;
}

export function displayNameForWorkspaceKind(kind: string): string {
  return kind === "shared_read_only"
    ? "Shared read-only baseline"
    : kind === "isolated_write"
      ? "Isolated write worktree"
      : kind;
}

export function displayNameForRunStatus(status: string): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "running":
      return "Running";
    case "reviewing":
      return "Reviewing";
    case "awaiting_final_review":
      return "Final review";
    case "completed":
      return "Completed";
    case "blocked":
      return "Blocked";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

export function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "blocked" || status === "cancelled" || status === "failed";
}

export function canForceCancelRun(status: string): boolean {
  return !isTerminalRunStatus(status);
}

/** Terminal states whose worktrees can still be cleaned up; completed runs never discard. */
export function canDiscardRun(status: string): boolean {
  return status === "blocked" || status === "failed" || status === "cancelled";
}
