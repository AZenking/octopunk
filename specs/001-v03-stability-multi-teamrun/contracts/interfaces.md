# Interface Contracts: v0.3 稳定性与多任务运行(Phase 1)

> GUI 与 MCP 共享同一服务(宪法原则二);命名沿用既有约定。载荷 camelCase(IPC)/
> snake_case(MCP 入参),幂等 requestID 仅变更类需要。

## A. MCP 工具(新增)

| 工具 | 语义 | 关键入参 | 输出 |
| --- | --- | --- | --- |
| `pause_team` | 暂停 run(停发新任务配额,运行中不受影响) | `request_id`, `run_id?` | 更新后 run(priority/pausedAt) |
| `resume_team` | 继续已暂停 run | `request_id`, `run_id?` | 更新后 run |
| `set_run_priority` | 调整优先级(调度排序) | `request_id`, `run_id?`, `priority: -5..5` | 更新后 run |
| `get_workbench` | 六分区聚合 + 排队原因 | (无) | {running, queued, awaitingInput, failed, awaitingReview, integratable}[] |
| `run_doctor` | 执行体检(九项,单项超时 unknown) | `request_id`, `repository_path?` | 报告 + 逐项明细 |
| `get_doctor_report` | 读最近体检 | `repository_path?` | 报告或 null(readOnly) |
| `get_recovery_status` | 恢复视图(进程核对/孤儿/待决) | `run_id?` | 恢复项列表(readOnly) |
| `rerun_task` | 节点重跑(可选含下游重置) | `request_id`, `run_id?`, `task_id`, `include_downstream: bool` | 重置后的任务列表 |

### 既有工具语义扩展

- `start_team`:**无破坏变化**;MCP 会话仍一 run;排队即正常排队(闸门原因经
  事件流呈现)。GUI 路径经 IPC 走独立 sessionID(research R1)。
- `get_team_status`:输出追加 `priority` / `pausedAt` 与排队任务的 `queueReason`。

## B. IPC 通道(渲染层)

| 通道 | 方向 | 载荷 |
| --- | --- | --- |
| `workbench:summary` | invoke | 六分区聚合(同 get_workbench) |
| `workbench:observe` | stream | 复用 runs:changed 增量,聚合视图渲染层推导或主进程订阅——实现取简单者并在 tasks 定稿 |
| `run:pause` / `run:resume` / `run:set-priority` | invoke | 同 MCP 对应工具 |
| `doctor:run` / `doctor:latest` / `doctor:rerun-item` | invoke | 体检执行/最近报告/单项重检(单项 key) |
| `recovery:status` / `recovery:rerun` / `recovery:cleanup-orphans` | invoke | 恢复视图/节点重跑/孤儿清理(清理需 `{targetIDs, confirm: true}` 显式确认) |
| `scheduler:settings` | invoke | 三级并发与资源阈值读写(设置页) |

preload 白名单按字母序追加全部;事件流追加 kind:`run.paused` / `run.resumed` /
`run.priorityChanged` / `doctor.completed` / `recovery.action` / `queue.reasonChanged`。

## C. 契约不变量(测试断言点)

1. 四级并发取最严:`min(global, project, kind, run.maxConcurrentTasks)`,任何
   时刻活跃子进程数不得超出生效值;设置界面与 get_team_status 呈现同一生效值。
2. 多 run 并行 0 串扰:两个仓库各一 run 并行执行,任务/worktree/报告/事件互不
   出现对方 ID(交叉断言)。
3. 同仓库集成串行:两个同仓库 run 先后 complete_team,同一时刻仅一个执行
   applyIntegration;后者基线已移动 → 拒绝并可读提示。
4. 暂停不影响运行中:暂停 run 后运行中任务照常完成;queued 任务保持 queued 且
   queueReason 含 `run_paused`;恢复后按优先级继续。
5. 进程核对只认带 OctoPunk 会话标识的进程;孤儿清理必须显式确认且逐项留痕;
   任何自动恢复动作不得绕过人工确认点(宪法原则五)。
6. 体检单项超时 → unknown;overall 有 fail 即 fail,仅 unknown 即 degraded;
   诊断包导出内容与报告一致且经 redact。
7. MCP 与 IPC 对同一操作同构结果(共享服务)。
