# Data Model: v0.3 稳定性与多任务运行(Phase 1)

> 迁移版本:SQLite migrator v10 → **v11**(沿用既有 DDL 风格)。

## 迁移 v11

### team_runs 新列

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| priority | INTEGER NOT NULL DEFAULT 0 | 调度排序:priority DESC, created_at ASC;越大越先得配额 |
| paused_at | REAL | 暂停时间戳;NULL = 未暂停。暂停只停**新配额发放**,不影响运行中任务 |

### task_attempts 新列

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| pid | INTEGER | 子进程 PID(启动时写入,正常退出清 NULL);崩溃恢复的进程核对依据 |

### doctor_reports(体检报告)

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | UUID |
| triggered_by | TEXT | `user` / `codex`(MCP)/ `prestart`(启动拦截) |
| repository_path | TEXT | 体检针对的仓库(NULL = 全局项) |
| overall | TEXT | `pass` / `fail` / `degraded`(有 fail→fail;仅 unknown→degraded;全 pass→pass) |
| created_at | REAL | |

### doctor_check_items(体检逐项)

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | |
| report_id | TEXT | FK → doctor_reports |
| check_key | TEXT | `cli_path` / `gui_path` / `login` / `mcp_stdio` / `git_repo` / `worktree_disk` / `sandbox` / `provider_quota` / `db_health` |
| status | TEXT | `pass` / `fail` / `unknown`(无法确认/超时) |
| detail | TEXT | 结论摘要(redact ≤2KiB;fail 时含观测值) |
| impact | TEXT | 影响范围(如「委派将失败」) |
| suggestion | TEXT | 推荐处理方式 |
| duration_ms | INTEGER | 单项耗时 |

索引:doctor_check_items(report_id)。

## 设置键(settings.json,非治理配置)

| 键 | 默认 | 说明 |
| --- | --- | --- |
| OctoPunk.globalMaxChildren | 6 | 全局并发子进程上限(1–20) |
| OctoPunk.perProjectMaxChildren | 3 | 单仓库并发上限(1–10) |
| OctoPunk.perKindMaxChildren | 3 | 单 Agent 类型并发上限(1–10) |
| OctoPunk.resourcePauseEnabled | true | 高压时暂缓新任务 |
| OctoPunk.minFreeDiskBytes | 1073741824 | 高压磁盘阈值(1GiB) |
| OctoPunk.interactiveSlotReserved | true | 预留 1 个交互槽 |

**实际生效值 = min(全局, 项目, 单类型, run.maxConcurrentTasks)**,四级联检,UI 明示。

## 派生(不落库)

- **工作台六分区**:运行中(running 任务)/ 排队等待(queued 且闸门未放行)/
  等待用户输入(blocked)/ 执行失败(failed 未处理)/ 等待审查(awaiting_report
  / rework_required)/ 可以集成(accepted 且 run 未 complete)。数据源 =
  observeRunSummaries + 活跃 run 的 runSummary。
- **排队原因**:闸门拒绝级别(`global_budget` / `project_budget` / `kind_budget`
  / `resource_pressure` / `launch_stagger` / `run_paused`)+ 预计启动序号。
- **恢复视图**:非终态 run × 进程核对结果 × 孤儿扫描结果(启动时与手动刷新时计算)。

## 状态迁移(新)

- run 暂停/继续:`paused_at` NULL↔时间戳,无新 run status(不侵入状态机);
  暂停时禁止 start 内新任务,审计事件 `run.paused` / `run.resumed`。
- 恢复动作:每次 rerun/relink/cleanup 记 relay_events(kind `recovery.action`,
  payload 含动作、目标、结果),attempt 照常生成——证据链沿用宪法原则三。
