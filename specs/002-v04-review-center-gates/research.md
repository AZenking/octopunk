# Research: v0.4 Review Center 与质量门禁(Phase 0)

> 现状调研经 codegraph 完成(宪法 v1.2.0 Agent 代码读取约束);关键源:
> `electron/data/repository.ts`(审查状态机)、`electron/mcp/server.ts`(工具面)、
> `electron/platform/gitAdapter.ts`(集成与序列化锁)、
> `electron/application/taskIntegrationService.ts`(集成用例)。

## R1: Diff 数据来源与三方对比

- **Decision**: `GitPort` 新增 `diffTree` / `diffPatch`(基于 `git diff
  --stat` 与 `git diff -U3 <base>...<head>`,按文件分页,单页 ≤64KiB 输出裁剪)。
  三方对比 = 任务基线 commit ↔ 任务分支 HEAD ↔ 集成 worktree HEAD
  (`octopunk/<runID>/integration`),三者均可由现有 `rev-parse` 获得。
- **Rationale**: 复用既有 git 子进程通道与集成 worktree,零新增存储;
  分页 + 裁剪满足 SC-006(5000 行 ≤5s)与超大 Diff 边界用例。
- **Alternatives**: 引入 nodegit 原生库( rejected:新增原生模块违反 better-sqlite3
  唯一原生模块约束);在前端解析整个 worktree( rejected:整仓加载不可分页)。

## R2: 行级评论与批量返工

- **Decision**: 新实体 `review_comments` 落库(含上下文快照行,防返工后行漂移);
  批量返工 = 勾选的评论聚合为 findings(`file`/`line`/`evidence`/`expected_fix`)
  走**既有** `request_rework` 通道——MCP 工具 schema 已支持 findings,复用同一
  状态机与原生会话恢复,轮次规则不变(宪法原则一)。
- **Rationale**: `request_rework` 的 findings schema(server.ts:273-288)与
  repository 的 `insertReview`/reviewRound 已具备 80% 语义;评论只是把 findings
  从一次性入参升级为可管理、可追踪解决的持久实体。
- **Alternatives**: 独立评论-返工管线绕过 review 状态机( rejected:平行状态,
  违反宪法原则二/五)。

## R3: 质量门禁执行架构

- **Decision**: `application/qualityGateService.ts` 编排;条件分三类——
  (a) 状态类(无未处理高风险发现/依赖已接受/Todo 清零/Reviewer 已通过/范围未
  越界)由 SQLite 直接判定;(b) Git 类(目标分支安全基线)由 GitPort 判定;
  (c) 命令类(测试/lint/类型检查/构建)在任务 worktree 内以受控子进程执行
  (复用 processAdapter 的进程组与环境白名单,非交互、超时标记 unknown)。
  判定在 `accept_task` 前强制执行,结果 100% 落库(`gate_evaluations` +
  逐项明细)。
- **Rationale**: 状态/Git/命令三类判定来源不同,统一为逐项结果实体即可满足
  FR-008(拒绝布尔值);命令类必须沙箱化以符合宪法原则四。
- **Alternatives**: 门禁检查派发给子 Agent 执行(rejected:消耗模型配额、时延
  不可控、结果不可归因;v0.5 后再评估)。

## R4: 门禁配置存储(澄清决策落地)

- **Decision**: `project_gate_configs` 表以 `repository_path` 为主键存项目默认;
  `team_runs` 新增 `gate_snapshot_json` 列,启动时固化生效配置(含运行覆盖),
  随运行留档、可追溯(FR-007)。矛盾条件组合在保存时由 `domain/policy.ts`
  校验拒绝(边界用例)。
- **Rationale**: 项目默认需要跨会话共享 → SQLite;运行覆盖需要不可变快照 →
  随运行落列;settings.json 仅存 UI 偏好不存治理配置(与现有键语义一致)。
- **Alternatives**: 全部存 settings.json(rejected:多项目歧义);仅运行级
  (rejected:与澄清决策「项目默认」不符)。

## R5: 集成串行化复用

- **Decision**: 冲突预览 = 集成 worktree 内 `merge --no-commit --no-ff` 试算后
  abort;目标分支应用沿用 `applyIntegration` 的既有 per-repo 序列化锁
  (gitAdapter.ts:32 `integrationLocks`)与基线/脏检查。v0.4 不新增锁机制。
- **Rationale**: 序列化与安全检查已存在且与 v0.3 多 TeamRun 兼容;重复造锁
  引入第二事实源。

## R6: Diff 渲染组件

- **Decision**: 自研轻量 Diff 行渲染(基于 git 输出的 hunk 解析,纯文本行展示
  + shadcn 容器 Tabs/ScrollArea/Badge),不引入 react-diff-viewer 等库。
- **Rationale**: 宪法 UI 约束「不引入第二套 UI 体系」;shadcn 无 Diff 原语,
  但 Diff 行本身是文本展示而非交互控件(不违反禁原生 HTML 控件条款);自研
  才能做 64KiB 分页、行锚点评论与超大 Diff 折叠。布局参考 Vercel v0 的栅格/
  间距/等宽字体写法。
- **Alternatives**: react-diff-viewer-continued(rejected:第二 UI 体系、
  无法承载行级评论锚点与分页)。

## R7: GitHub 回灌凭证与通道

- **Decision**: `platform/ghCliAdapter.ts` 经本机 `gh` CLI 完成 PR 创建/状态/
  评论读取;OctoPunk 不存储任何 GitHub Token(gh 自管凭证);功能默认关闭,
  设置中显式开启;CLI 缺失/未登录时报可读错误并降级(边界用例)。
- **Rationale**: 宪法原则四「不存模型 API Key」精神延伸到一切凭证;gh CLI 是
  macOS 开发者标配,免 Token 管理与刷新。
- **Alternatives**: octokit + PAT(rejected:Token 必须落库,违反安全默认)。

## R8: 跨模型审查与仲裁

- **Decision**: `reviewModeService` 将审查任务建模为**只读子任务**经既有
  delegate 通道派发(Claude↔Codex 对向、双只读独立调查、多方案竞赛、分角色
  审查);仲裁结果(共识/分歧/待验证)为独立实体落库;分歧默认不自动通过
  (FR-013),交人工/主 Agent 决断。
- **Rationale**: 审查者 Agent 与执行者 Agent 走同一受控执行面(沙箱/脱敏/
  日志),无需新执行通道;「Agent 可驱动」原则要求 GUI/MCP 同构。

## R9: MCP 工具面扩展

- **Decision**: 新增工具 `get_task_diff`、`add_review_comments`、
  `request_rework_batch`(聚合评论)、`get_gate_status`、`set_gate_config`、
  `run_quality_gate`、`waive_gate_item`、`get_arbitration`、`create_pr`;
  `accept_task` 语义扩展为「门禁通过或全部失败项已豁免才可 PASS」。
  GUI IPC 通道一一对应(契约见 contracts/interfaces.md)。
- **Rationale**: 宪法原则二「新界面共享同一应用服务」;工具命名沿用既有
  snake_case 与 request_id 幂等约定。

## R10: 交付摘要

- **Decision**: `delivery_summaries` 落库:结论(PASS/REWORK/BLOCKED)、证据
  链接(报告/日志/Diff/门禁明细/审查轮次)、豁免清单、遗留 findings;
  审查结束自动生成,Markdown 持久化。
- **Rationale**: FR-006/SC-002(证据链追溯)要求摘要本身是事实源的一部分。

## 遗留 NEEDS CLARIFICATION

无——Technical Context 全部已知;4 项规格澄清已由用户在 /speckit-clarify 决断。

## Post-Phase-1 Constitution Re-check

- 原则一:review 状态机仅扩展未重定义 ✓(R2);原则二:全部经端口/服务分层 ✓;
  原则三:六类新数据全落库 ✓;原则四:凭证不落库、命令沙箱执行、脱敏沿用 ✓;
  原则五:豁免留痕可复审、分歧不静默合并 ✓;UI 约束:shadcn 专属 + 自研 Diff
  文本行展示(非控件)✓;codegraph 约束:调研路径已记录 ✓。无违规,
  Complexity Tracking 无条目。
