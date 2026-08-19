---
description: "Task list for v0.3 稳定性与多任务运行"
---

# Tasks: v0.3 稳定性与多任务运行

**Input**: Design documents from `/specs/001-v03-stability-multi-teamrun/`

**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/interfaces.md ✓, quickstart.md ✓

**Tests**: 宪法质量门禁要求覆盖;每个故事含测试任务。

**Organization**: Tasks are grouped by user story (US1=多项目多 TeamRun, US2=崩溃恢复, US3=Doctor, US4=资源感知)。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- 设计文档为准:data-model.md(迁移 v11 与设置键)、contracts/interfaces.md(工具/通道/不变量)、research.md(R1–R8)

---

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 在 `shared/dtos.ts` 增加 v0.3 共享 DTO(WorkbenchSectionDTO/WorkbenchEntryDTO/QueueReasonDTO、DoctorReportDTO/DoctorCheckItemDTO(check_key 九值联合)、RecoveryItemDTO/RecoveryStatusDTO、RunControlDTO(priority/pausedAt),字段对齐 specs/001 各文档),并创建 `src/features/workbench/` 与 `src/features/doctor/` 目录骨架

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ 全部用户故事依赖本阶段**

- [x] T002 SQLite 迁移 v10 → v11:`electron/data/database.ts` —— `team_runs` 加 `priority INTEGER NOT NULL DEFAULT 0`、`paused_at REAL`;`task_attempts` 加 `pid INTEGER`;新表 `doctor_reports`/`doctor_check_items`(结构见 data-model.md,DDL 风格照既有 stage)
- [x] T003 [P] 领域层:`electron/domain/models.ts` 加 RUN_PRIORITIES(-5..5)与排序规则、DOCTOR_CHECK_KEYS(九值)/DOCTOR_STATUSES(pass/fail/unknown)/DOCTOR_OVERALLS、RecoveryAction 纯模型;`electron/domain/repositoryPort.ts` 扩展端口:setRunPriority/pauseRun/resumeRun、recordDoctorReport/getLatestDoctorReport/rerunDoctorCheckItem、updateAttemptPid
- [x] T004 [P] 设置与钳制:`electron/settingsStore.ts` 加六个键(data-model 表);`shared/ipc.ts` 加对应 clamp 函数(照 clampTaskRetryLimit 模式)与 SchedulerSettingsPayload
- [x] T005 仓储实现:`electron/data/repository.ts` + `electron/data/mappers.ts` —— 优先级/暂停更新(乐观锁+审计事件 run.paused/resumed/priorityChanged)、doctor 两表读写、attempt pid 更新、runSummaries 附 priority/pausedAt;`electron/domain/events.ts` 扩 kind(deps: T002, T003)
- [x] T006 仓储测试:扩展 `tests/repository.test.ts` —— v11 迁移、优先级/暂停留痕、doctor 报告与单项重检、pid 写清(deps: T005)

**Checkpoint**: 数据层就绪,四个故事可并行。

---

## Phase 3: User Story 1 - 多项目多 TeamRun(Priority: P1)🎯 MVP

**Goal**: 多仓库并行运行、四级并发闸门、run 暂停/优先级、全局工作台六分区。

**Independent Test**: quickstart 场景 1 —— 仓库 A/B 并行 TeamRun 零串扰;全局并发调 1 时新任务排队且原因可见;同仓库双 run 集成串行(后到者拒)。

- [x] T007 [US1] GUI 多 run 解锁:`electron/ipc.ts` team:start 处理器为每次启动生成独立 sessionID(`gui-<uuid>`,research R1——不改仓储检查);验证 GUI 可同时存在多个活跃 run
- [x] T008 [US1] 并发预算:`electron/application/concurrencyBudget.ts` —— 四级闸门(全局/项目/单 Agent 类型/run.maxConcurrentTasks 取最严)、申请/释放、拒绝原因(global_budget/project_budget/kind_budget/run_paused)、释放事件驱动重排;接入 `agentTeamService` 全部 launch 路径(首启/重试/审查/恢复),替代仅按 run 计数的 activeChildCount 判定(deps: T004, T005)
- [x] T009 [US1] run 控制:pause(停发该 run 配额,运行中不受影响)/resume/setPriority 排序接入闸门队列;审计事件贯通(deps: T005, T008)
- [x] T010 [P] [US1] MCP 工具:`electron/mcp/server.ts` 加 pause_team/resume_team/set_run_priority/get_workbench;get_team_status 输出附 priority/pausedAt/排队任务 queueReason(deps: T008, T009)
- [x] T011 [P] [US1] IPC 通道:`electron/ipc.ts`+`electron/preload.ts` 注册 workbench:summary、run:pause/resume/set-priority、scheduler:settings;事件流推送 run.paused 等新 kind
- [x] T012 [P] [US1] 工作台 UI:`src/features/workbench/WorkbenchView.tsx` 六分区聚合视图 + 侧栏顶级入口 + 分区项跳转对应 run(全 shadcn,布局参考 v0)
- [x] T013 [US1] 设置 UI:常规区三级并发与生效值展示(四级联检 min 值明示)(deps: T004, T011)
- [x] T014 [US1] tests/concurrency.test.ts:四级取最严、多仓库并行零串扰(任务/worktree/事件交叉断言)、同仓库双 run 集成串行后到者拒、暂停不伤运行中(deps: T008, T009)
- [ ] T015 [US1] quickstart 场景 1 走查(自动化等价断言已由 T014 覆盖;GUI 走查与 mcp-trace --runs 留用户/T029)

---

## Phase 4: User Story 2 - 崩溃恢复与故障闭环(Priority: P2)

**Goal**: 重启扫描与进程核对、孤儿检测清理、节点重跑(含下游),全部留痕。

**Independent Test**: quickstart 场景 2 —— kill 主进程与子进程后重启,状态 100% 可解释;孤儿显式清理;rerun 只重置受影响路径。

- [x] T016 [US2] PID 持久化:`LocalProcessAdapter`/适配器链路把子进程 PID 写入 attempt(updateAttemptPid),正常退出清除;若 runStreaming 未暴露 PID 则最小扩展 ProcessPort(research R4)
- [x] T017 [P] [US2] 平台探测:`electron/platform/diagnosticsProbes.ts` —— 进程探活(ps 按 PID,只认带 octopunk 标识的命令行)、孤儿 worktree/临时分支扫描(对照 DB 登记)、磁盘 statfs 与负载采样(US3/US4 复用);全部经端口类型导出供服务注入
- [x] T018 [US2] 恢复服务:`electron/application/recoveryService.ts` —— 启动扫描(非终态 run 的 running 任务→探活分类:进程仍在/已死)、恢复视图聚合、孤儿清单与显式确认清理、rerunTask(include_downstream 下游重置,复用 resumeTask 语义)、全部 recovery.action 审计(deps: T005, T017)
- [x] T019 [US2] 接线:`electron/appEnvironment.ts` 启动后异步扫描(不打断启动);MCP get_recovery_status/rerun_task + IPC recovery:status/rerun/cleanup-orphans(清理需显式 confirm)(deps: T018)
- [x] T020 [P] [US2] 恢复视图 UI:工作台「执行失败/等待输入」分区入口或运行详情内恢复区 —— 进程仍在标注、失败原因(五类)、重跑(含下游 Switch)、孤儿清理确认 Dialog(deps: T019)
- [x] T021 [US2] tests/recovery.test.ts:扫描分类、孤儿确认清理留痕、rerun 下游重置且无关任务不动、清理需 confirm(deps: T018)

---

## Phase 5: User Story 3 - 环境诊断中心 Doctor(Priority: P3)

**Goal**: 九项体检、单项超时 unknown、报告落库、脱敏诊断包、单项重检、注定失败拦截。

**Independent Test**: quickstart 场景 3 —— 注入 PATH/脏工作区故障被检出,修复后单项重检转 pass,诊断包无敏感内容。

- [x] T022 [US3] 体检服务:`electron/application/doctorService.ts` —— 九项检查器注册表(cli_path/gui_path/login/mcp_stdio/git_repo/worktree_disk/sandbox/provider_quota/db_health),单项超时(5s)→unknown,overall fail/degraded/pass;报告落库、单项重检、脱敏诊断包导出;检查器依赖经端口注入(checkAgent、git.inspect、probes、db 健康)(deps: T005, T017)
- [x] T023 [P] [US3] 通道:MCP run_doctor/get_doctor_report + IPC doctor:run/latest/rerun-item(deps: T022)
- [x] T024 [P] [US3] DoctorView UI:九项三态列表(影响/建议/耗时)、单项重检按钮、诊断包复制;start_team 注定失败拦截(仓库不存在/CLI 不可用→指向诊断项)(deps: T023)
- [x] T025 [US3] tests/doctor.test.ts:三态与 overall 规则、超时 unknown、单项重检只重跑该项、诊断包 redact、拦截判定(deps: T022)

---

## Phase 6: User Story 4 - 资源感知调度(Priority: P4)

**Goal**: 负载/磁盘高压暂缓新任务(不伤运行中)、自动恢复、交互槽、排队原因贯通。

**Independent Test**: quickstart 场景 4 —— 阈值触发高压后新任务排队(resource_pressure),运行中任务完成;阈值恢复后自动放行;交互槽先启。

- [x] T026 [US4] 资源监控:`electron/application/resourceMonitor.ts` —— 5s 采样(探针注入)、高压判定(尽力而为,探测失败=未知不阻塞)、事件联动 concurrencyBudget 暂缓/恢复;交互槽预留(全局配额保留 1 给 interactive 任务,委派时可标记)(deps: T008, T017)
- [x] T027 [US4] 贯通与设置:排队原因展示(工作台/运行详情显示 resource_pressure/交互槽状态)+ 设置区资源阈值/开关 UI(deps: T011, T026)
- [x] T028 [US4] tests(扩展 concurrency.test.ts):高压暂缓不伤运行中、恢复自动放行(时钟快进)、交互槽优先(deps: T026)

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T029 [P] trace 扩展:`tools/mcp-trace.mjs` 加 --runs <n>(多 run 并行零串扰)/--same-repo-serial(集成串行)/--doctor(体检驱动)
- [ ] T030 [P] 文档:README(workbench/doctor/恢复 工具面)+ docs/USAGE.md(工作台/诊断中心/恢复/三级并发设置章节)
- [ ] T031 全量验证:`pnpm run typecheck` + 全套件 + quickstart 四场景;宪法自查(UI shadcn、进程核对只认带标识进程、恢复留痕、工作台纯派生无新事实源、仓储/状态机零修改)

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 → Phase 2(T003/T004 可与 T002 并行);**Phase 2 BLOCKS 全部故事**
- US1(T008 闸门)是 US4 的前置;US2 的 T017 探针被 US3/US4 复用(先做)
- US2/US3 相互独立;US4 依赖 US1+US2(T008/T017)
- Phase 7 最后

### Parallel Opportunities

- T003 ‖ T004;T010 ‖ T011 ‖ T012;T017 可与 US1 全程并行(仅新文件)
- 不同故事不同人并行:US1 与 US3 文件不相交可同时推进(US2 的 T016 亦独立)

## Implementation Strategy

### MVP First (User Story 1 Only)

Phase 1+2 → US1(T007–T015)→ STOP and VALIDATE:quickstart 场景 1 通过即可交付(多 run 是 roadmap 推荐顺序第 1 项)。

### Incremental Delivery

US1(MVP)→ US2(恢复)→ US3(Doctor)→ US4(资源)→ Polish;每 Checkpoint 独立验证。

---

## Notes

- [P] = 不同文件且无未完成依赖;同故事内 服务 → 通道 → UI 顺序
- 宪法红线:不修改 `activeTeamRunExists` 与审查状态机;恢复/诊断动作全部审计留痕;工作台不建新事实源
- 探测一律尽力而为:失败=unknown/未知,不阻塞调度、不臆造
- 每任务完成即标记 [x];Checkpoint 跑 typecheck + 对应测试;commit 按故事分组
