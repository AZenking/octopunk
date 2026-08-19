# Interface Contracts: v0.4 Review Center 与质量门禁(Phase 1)

> GUI 与 MCP 共享同一应用服务(宪法原则二);下述 MCP 工具与 IPC 通道一一对应,
> 命名沿用既有约定(MCP: snake_case + `request_id` 幂等;IPC: `review:*` /
> `gate:*` 前缀 + preload 白名单放行)。字段类型见 data-model.md,此处不重复。

## A. MCP 工具(新增)

| 工具 | 语义 | 关键入参 | 输出 |
| --- | --- | --- | --- |
| `get_task_diff` | 读取任务 Diff(分页) | `run_id?`, `task_id`, `side: baseline\|worktree\|integration`, `path_prefix?`, `cursor?` | 变更树 + 按 hunk 分页的 Diff 文本(≤64KiB/页) + 下一页 cursor |
| `add_review_comments` | 批量添加行级评论 | `request_id`, `run_id?`, `task_id`, `comments: [{file, line_start, line_end?, body, severity?}]` | 创建的评论(含 context_snapshot) |
| `request_rework_batch` | 勾选评论聚合为一次返工 | `request_id`, `run_id?`, `task_id`, `comment_ids: []`, `summary` | 更新后任务(内部走既有 request_rework + findings) |
| `set_gate_config` | 写项目默认门禁 | `request_id`, `repository_path`, `config`(结构见 data-model) | 保存后配置(矛盾组合报错) |
| `get_gate_config` | 读项目默认 + 运行快照 | `repository_path`, `run_id?` | 默认配置与该运行生效快照 |
| `run_quality_gate` | 执行门禁判定 | `request_id`, `run_id?`, `task_id` | overall + 逐项明细(幂等,重跑生成新 evaluation) |
| `waive_gate_item` | 豁免失败项 | `request_id`, `evaluation_id`, `item_id`, `reason` | 更新后明细(全失败项已豁免时 overall→waived) |
| `run_review` | 按审查模式派发只读审查并收集仲裁 | `request_id`, `run_id?`, `task_id`, `mode?`(standard/cross_model/dual_readonly/contest/role_based/arbitration,缺省读运行生效配置), `contest_models?`, `collect_timeout_seconds?`(60–600,默认 300) | `{mode, review_task_ids, arbitration}`(共识/分歧/待验证 + auto_passed);standard 不派发、返回提示;超时未到齐不落库,返回可重试提示 |
| `get_arbitration` | 读仲裁结论 | `run_id?`, `task_id` | 共识/分歧/待验证 + auto_passed |
| `create_pr` | GitHub PR(需开启回灌) | `request_id`, `run_id?`, `task_id`, `title?`(缺省 `[OctoPunk] <任务标题>`), `body?` | pr_url + pr_number(gh 缺失/未登录报可读错误) |
| `get_pr_status` | 读任务关联 PR 状态(只读) | `run_id?`, `task_id` | 关联链接 + state/检查汇总/最近评论(无关联 → null;gh 失败报可读错误) |

## B. 既有工具语义扩展(不破坏)

- `accept_task`:执行前**强制**先行门禁判定(无配置视为全 pass);overall=fail
  且存在未豁免失败项 → 拒绝并返回逐项明细;成功后自动生成 delivery_summary。
- `request_rework`:新增可选 `comment_ids`(与 summary/findings 并存,均归档)。
- `get_task_review_context`:输出追加 unresolved findings、门禁最近判定、
  仲裁结论、交付摘要链接。

## C. IPC 通道(渲染层 ↔ 主进程)

| 通道 | 方向 | 载荷 |
| --- | --- | --- |
| `review:pending-list` | invoke | 跨 run 待审查任务聚合(Review Center 列表) |
| `review:get-diff` | invoke | 同 `get_task_diff` |
| `review:add-comments` / `review:rework-batch` | invoke | 同 MCP 对应工具 |
| `review:get-summary` / `review:generate-summary` | invoke | 交付摘要读/生成 |
| `gate:get-config` / `gate:set-config` | invoke | 项目默认门禁(设置页) |
| `gate:evaluate` / `gate:waive-item` | invoke | 同 MCP 对应工具 |
| `gate:start-team-override` | invoke | 启动 TeamRun 时的临时覆盖(随运行留档) |
| `review:arbitration` | invoke | 仲裁结论读取 |
| `pr:create` / `pr:status` | invoke | 回灌操作(设置开关默认 off) |
| `octopunk/task_event` | push | 既有事件流追加 `review_comment_added` / `gate_evaluated` / `arbitration_recorded` / `summary_generated` 事件 kind |

## D. 契约不变量(测试断言点)

1. 任一 MCP 工具与对应 IPC 通道对同一输入产生同构结果(共享 service,仅序列化差异)。
2. 所有变更类调用携带 `request_id` 且幂等(重放返回缓存结果,不产生副作用)。
3. `get_task_diff` 单页输出 ≤64KiB 且经过 redact;`side=integration` 在集成
   worktree 缺失时返回可读错误而非空结果。
4. 门禁 unknown 项永不改变 overall 的 fail 判定(仅呈现)。
5. `waive_gate_item` 必须携带 reason 且逐项;无批量豁免入口。
