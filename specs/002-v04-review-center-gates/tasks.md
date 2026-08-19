---
description: "Task list for v0.4 Review Center 与质量门禁"
---

# Tasks: v0.4 Review Center 与质量门禁

**Input**: Design documents from `/specs/002-v04-review-center-gates/`

**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/interfaces.md ✓, quickstart.md ✓

**Tests**: 宪法质量门禁要求 domain/repository/application 行为有测试覆盖;本特性按 story 各含测试任务。

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1=Diff 审查工作台, US2=质量门禁, US3=跨模型仲裁, US4=GitHub 回灌)

## Path Conventions

按 plan.md 结构:`electron/`(domain/application/data/platform/mcp)+ `src/features/reviewCenter/` + `tests/`。

---

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 在 `shared/dtos.ts` 增加 Review Center 共享 DTO(ReviewPendingTaskDTO、DiffTreeEntryDTO、DiffPageDTO、ReviewCommentDTO、GateConfigDTO、GateEvaluationDTO 等,字段对齐 `specs/002-v04-review-center-gates/data-model.md`),并创建 `src/features/reviewCenter/` 目录骨架

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ 全部用户故事依赖本阶段完成**

- [x] T002 SQLite 迁移 v9 → v10(实现时代价发现迁移器已至 v9,规范文档的 v7 编号已被既有功能占用):`electron/data/database.ts` 新建表 `review_comments`、`project_gate_configs`、`gate_evaluations`、`gate_evaluation_items`、`arbitrations`、`delivery_summaries`、`pr_links`,并为 `team_runs` 增加 `gate_snapshot_json` 列(DDL 风格与既有迁移一致,结构见 data-model.md)
- [x] T003 [P] 领域纯模型:`electron/domain/models.ts` 增加 ReviewComment(状态迁移 open→resolved/dismissed/line_changed,终态不可逆)、GateCheckStatus、Arbitration、DeliverySummary 及构造函数(无 I/O,保持宪法原则二)
- [x] T004 [P] 门禁配置校验:`electron/domain/policy.ts` 增加 validateGateConfig(矛盾组合拒绝、命令条数 ≤8、required_reviewers 引用合法 Agent 类型、review_mode 枚举校验)
- [x] T005 仓储端口与实现:`electron/domain/repositoryPort.ts` 增加评论/门禁配置/判定/仲裁/摘要/PR 关联的读写端口;`electron/data/repository.ts` + `electron/data/mappers.ts` 实现(沿用 cachedResponse 幂等与 write 通知观察者机制)(depends: T002, T003)
- [x] T006 仓储测试:扩展 `tests/repository.test.ts` —— v7 迁移可用性、评论状态迁移约束、门禁配置主键唯一、gate_evaluations 幂等重放(deps: T005)

**Checkpoint**: 数据层就绪,四个用户故事可并行开工。

---

## Phase 3: User Story 1 - Diff 审查工作台(Review Center)(Priority: P1)🎯 MVP

**Goal**: 全局审查中心:变更树 + 完整 Diff + 三方对比 + 行级评论批量返工 + 证据联动 + 风险提示 + 冲突预览 + 交付摘要。

**Independent Test**: quickstart.md 场景 1 —— GUI 内完成「查看 Diff → 行级评论 → 批量返工 → 复审 → 通过 → 交付摘要」,全程不开终端,评论零丢失。

### Implementation for User Story 1

- [x] T007 [P] [US1] GitPort Diff 能力:`electron/application/ports.ts` 扩展 `diffTree` / `diffPatch`(按文件分页、单页输出 ≤64KiB、写前 redact)与 `conflictPreview`(merge --no-commit 试算后 abort);`electron/platform/gitAdapter.ts` 用既有 git 子进程通道实现(三方 = run 基线 / 任务分支 HEAD / 集成 worktree HEAD,rev-parse 取值)
- [x] T008 [P] [US1] Diff 适配测试:临时仓库 fixture 验证 diffTree/diffPatch 分页边界(空 Diff、>64KiB 截断、integration worktree 缺失报可读错误)(deps: T007)
- [x] T009 [US1] 审查中心服务:`electron/application/reviewCenterService.ts` —— 待审查任务跨 run 聚合、Diff 读取(side 切换)、行级评论 CRUD(context_snapshot 写入)、批量返工(勾选评论聚合为 findings 走既有 `request_rework` 通道,复用原生会话与轮次规则)、返工后评论回填(resolved / line_changed 判定)、交付摘要生成(结论+证据链接+豁免清单+遗留项)(deps: T005, T007)
- [x] T010 [P] [US1] MCP 工具:`electron/mcp/server.ts` 新增 `get_task_diff` / `add_review_comments` / `request_rework_batch`,扩展 `get_task_review_context`(追加 unresolved findings 与最近门禁判定)(deps: T009)
- [x] T011 [P] [US1] IPC 通道:`electron/ipc.ts` + `electron/preload.ts` 注册 `review:pending-list` / `review:get-diff` / `review:add-comments` / `review:rework-batch` / `review:get-summary` 白名单,事件流新增 `review_comment_added` / `summary_generated` kind(deps: T009)
- [x] T012 [P] [US1] 审查中心 UI(一):`src/features/reviewCenter/ReviewCenterView.tsx`(待审查列表)+ `DiffTree.tsx`(变更树,risk/敏感标记)+ `DiffViewer.tsx`(基线/工作树/集成 Tabs、分页加载、行锚点、超大 Diff 折叠;全部 shadcn/ui 原语,布局参考 v0 栅格间距,禁原生 HTML 控件)(deps: T001, T011)
- [x] T013 [US1] 审查中心 UI(二):`CommentPanel.tsx`(行级评论、severity、勾选批量返工、line_changed 快照展示)+ 侧边栏顶级入口接入现有 navigation(deps: T012)
- [x] T014 [US1] 服务测试:`tests/reviewCenter.test.ts` —— 评论闭环(添加→返工→resolved/line_changed)、批量返工 findings 聚合、摘要证据链接完整性(deps: T009)
- [ ] T015 [US1] 接线验证:UI 已直连通道(无需 appState 中转),侧边栏入口已挂载;剩余 quickstart 场景 1 的 GUI 手动走查(返工后列表为手动刷新,自动刷新订阅待 Polish)

**Checkpoint**: US1 独立可用(MVP 交付点)。

---

## Phase 4: User Story 2 - 自动质量门禁(Priority: P2)

**Goal**: 项目默认 + 运行覆盖的门禁配置;accept 前逐项判定通过/失败/豁免;失败原因与修复建议回传原会话。

**Independent Test**: quickstart.md 场景 2 —— 配置 4 项门禁,构造失败与豁免,验证明细输出与 accept 拦截/放行。

- [x] T016 [P] [US2] 门禁服务:`electron/application/qualityGateService.ts` —— 配置读写(项目默认 + TeamRun 启动覆盖快照写入 `team_runs.gate_snapshot_json`)、三类判定(状态类查 SQLite / Git 类走 GitPort / 命令类经 processAdapter 在任务 worktree 受控执行,超时标 unknown)、overall 计算(pass/fail/waived)、逐项 fix_suggestion(deps: T005)
- [x] T017 [US2] 豁免与 accept 集成:`waive` 逐项 + 理由 + 留痕,全失败项豁免后 overall 重算 waived;`accept_task` 前强制判定(fail 且有未豁免项即拒绝并返回明细)——修改 `electron/application/agentTeamService.ts` 与 `electron/mcp/server.ts` 的 accept 路径(deps: T016)
- [x] T018 [P] [US2] MCP + IPC:`set_gate_config` / `get_gate_config` / `run_quality_gate` / `waive_gate_item` 工具与 `gate:*` 通道白名单(幂等 request_id)(deps: T016)
- [x] T019 [P] [US2] UI:`GatePanel.tsx`(逐项明细、unknown 醒目、豁免操作)+ 设置页门禁配置表单(矛盾配置保存时按 policy 校验拒绝提示)+ 启动 TeamRun 时的覆盖入口(deps: T018)
- [x] T020 [US2] 测试:`tests/qualityGate.test.ts` —— 三类判定、命令超时 unknown、豁免重算、矛盾配置拒绝、evaluate 幂等重放、失败意见回传原会话格式(deps: T017)
- [x] T021 [US2] trace 扩展:`tools/mcp-trace.mjs` 增加 `--gate` / `--gate-fail-path` 驱动场景 2 端到端

**Checkpoint**: US1 + US2 均独立可用;门禁永不返回裸布尔。

---

## Phase 5: User Story 3 - 跨模型审查与仲裁(Priority: P3)

**Goal**: 对向互查 / 双只读独立调查 / 竞赛 / 分角色 / 多 Reviewer 仲裁;冲突输出共识/分歧/待验证,分歧不自动通过。

**Independent Test**: quickstart.md 场景 3 —— dual_readonly 模式 + 人为分歧,验证三段结构与 auto_passed=false。

- [x] T022 [US3] 审查模式服务:`electron/application/reviewModeService.ts` —— 按 gate 配置 review_mode 将审查任务建模为只读子任务经既有 delegate 通道派发(对向/双只读/竞赛/分角色);结论聚合为 arbitrations(共识/分歧/待验证,分歧时 auto_passed=false)(deps: T005, T016)
- [x] T023 [P] [US3] 通道与 UI:`get_arbitration` MCP 工具 + `review:arbitration` IPC;`ArbitrationPanel.tsx` 三段结构展示(共识/分歧并排证据/待验证清单)(deps: T022)
- [x] T024 [US3] 测试:双只读派发、结论冲突聚合、分歧阻止自动通过(deps: T022)

**Checkpoint**: US1–US3 全部独立可用。

---

## Phase 6: User Story 4 - GitHub 回灌(可选,Priority: P4)

**Goal**: gh CLI 承载 PR 创建与状态/评论回灌;默认关闭;凭证不落库;失败降级。

**Independent Test**: quickstart.md 场景 4 —— 开启回灌后 create_pr + 状态回灌;关闭/卸载 gh 时可读降级。

- [x] T025 [P] [US4] gh 适配器:`electron/platform/ghCliAdapter.ts` —— createPr / prStatus / reviewComments(经本机 `gh` CLI,不存 Token;CLI 缺失/未登录返回可读错误)(depends: 无,可与 US1–US3 并行)
- [x] T026 [US4] 接入:`pr_links` 读写接入 reviewCenterService;`create_pr` / `pr:status` / `pr:create` MCP+IPC;设置页开关(默认 off)(deps: T025, T005)
- [x] T027 [US4] UI 与降级:任务详情 PR 链接与回灌状态展示;gh 不可用时本地审查不受影响的手动验证

---

## Phase 7: Polish & Cross-Cutting Concerns

- [x] T028 [P] 文档:`README.md` Layout 表与 `docs/USAGE.md` 增补 Review Center / 质量门禁 / 审查模式 / 回灌章节
- [x] T029 全量验证:`pnpm run typecheck` + `pnpm test` 全绿;quickstart.md 四场景走查;宪法合规自查清单(UI 无原生 HTML 控件、凭证不落库、GUI/MCP 同构、新数据全落库、Swift 移植语义未重定义)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 → Phase 2**:T001 先行;T002–T006 中 T003/T004 可与 T002 并行
- **Phase 2 BLOCKS 所有用户故事**(数据层与端口是公共依赖)
- **US1 → US2**:US2 的 accept 集成依赖 US1 的 findings/评论通道已就绪(T017 deps T009 语义)
- **US2 → US3**:审查模式配置挂在门禁 config.review_mode(T022 deps T016)
- **US4**:仅依赖 Phase 2,可与 US1–US3 全程并行
- **Phase 7**:所有保留 story 完成后

### Parallel Opportunities

- T003 ‖ T004(不同文件);T010 ‖ T011 ‖ T012(不同文件,同依赖 T009)
- T018 ‖ T019;T023 与 T024 内部无冲突;T025 可从 Phase 2 后任意时点并行
- 不同 story 由不同人并行(US4 完全独立)

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 + Phase 2 → 数据层就绪
2. Phase 3(US1)→ **STOP and VALIDATE**:quickstart 场景 1 全流程通过即可演示交付(MVP)

### Incremental Delivery

US1(MVP)→ US2(门禁)→ US3(仲裁)→ US4(可选回灌)→ Polish;每个 Checkpoint 独立验证,不破坏前一故事。

---

## Notes

- [P] = 不同文件且无未完成依赖;同 story 内 service → MCP/IPC → UI 顺序不可倒置
- 所有变更类调用携带 request_id 并幂等;所有展示前 redact;Diff 单页 ≤64KiB
- UI 任务执行时遵守宪法 UI 约束:shadcn/ui 专属、禁原生 HTML 交互控件、布局参考 Vercel v0
- 每个任务或逻辑组完成后提交;Checkpoint 处跑 typecheck + 对应测试
