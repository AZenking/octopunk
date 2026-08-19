# Implementation Plan: v0.3 稳定性与多任务运行

**Branch**: `001-v03-stability-multi-teamrun` | **Date**: 2026-08-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-v03-stability-multi-teamrun/spec.md`

## Summary

四个故事:(1) 多项目多 TeamRun——解除 GUI 单运行假设、三级并发闸门、全局工作台;
(2) 崩溃恢复——启动扫描、进程核对、孤儿检测、节点重跑;(3) Doctor 环境诊断中心;
(4) 资源感知调度。**关键调研发现**:数据层已天然支持多 run——单活跃约束
(`repository.startTeam` 的 `activeTeamRunExists`)是**会话级**而非全局,调度内存结构
(`childWork`/`childRunIDs`/`launchReadyTasks`/`paceNextLaunch`)均已按 runID 或实例级
组织,集成串行化(`GitAdapter.integrationLocks`)已按仓库加锁。因此 US1 的正确路径是
**保留 Swift 移植语义、GUI 为每次启动传入独立 sessionID**,而不是修改仓储检查;
主要工作在渲染层多 run 支持、中央并发预算、工作台聚合与恢复/诊断两个新服务。

## Technical Context

**Language/Version**: TypeScript 5.x,Node 24,Electron + Vite + React 18

**Primary Dependencies**: better-sqlite3(迁移 v10 → **v11**)、
@modelcontextprotocol/sdk、shadcn/ui、vitest;诊断的磁盘/负载探测用 Node 内置
(`fs.statfs`、`os.loadavg`/`freemem`),经端口注入便于测试

**Storage**: SQLite 迁移 v11(team_runs 新列 + doctor 两表 + attempt pid 列);
三级并发与调度状态为运行时内存(预算值持久化到 settings.json 键)

**Testing**: vitest(ABI 流程同现状);多 run 并行与恢复用现有真实仓储/临时仓库
fixture 模式;`pnpm mcp:trace` 扩展多 run 场景

**Target Platform**: macOS 14+ 本地单用户

**Project Type**: desktop-app(Electron + React + MCP 服务面)

**Performance Goals**: 工作台聚合查询 ≤200ms(现 observeRunSummaries 增量流复用);
恢复扫描(含进程核对)≤5s;Doctor 全量体检 ≤15s(单项超时记「无法确认」)

**Constraints**: 不修改既有审查状态机语义;恢复/诊断动作全部落审计事件;
负载与配额探测遵守「尽力而为 + 明示不确定」,探测失败不阻塞调度

**Scale/Scope**: 并发活跃 run 2–10 级;单 run 任务数沿用现状;工作台为聚合视图无新事实源

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | 原则/约束 | 判定 | 说明 |
| --- | --- | --- | --- |
| 一 | Swift 对等 | PASS(关键决策见 research R1) | **不修改** `activeTeamRunExists` 的会话级语义;多 run 由「GUI 每次启动传独立 sessionID」达成,移植语义零偏离;集成串行化沿用既有 per-repo 锁 |
| 二 | 分层端口与适配器 | PASS | 恢复/诊断/调度预算为 application 服务;负载与进程探测经端口注入;渲染层仅经 preload 白名单 |
| 三 | SQLite 持久事实源 | PASS | 优先级/暂停/恢复状态/诊断报告先落库再呈现;预算是派生运行时,设置键除外 |
| 四 | 安全默认 | PASS | 恢复的进程核对只针对带 OctoPunk 会话标识的进程;孤儿清理显式确认;诊断包脱敏 |
| 五 | 编排与人可控 | PASS | 暂停/继续/重排队/重跑全部用户可操作且留痕;自动恢复不剥夺人工接管 |
| UI | shadcn 专属/禁原生控件/参考 v0 | PASS | 工作台/诊断/恢复视图全 shadcn 原语;布局参考 v0 |
| 工具 | Agent 代码读取优先 codegraph | PASS | 本 plan 调研经 codegraph(research.md 记录) |

*Post-Phase-1 re-check:research.md 末尾;无违规,Complexity Tracking 无条目。*

## Project Structure

### Documentation (this feature)

```text
specs/001-v03-stability-multi-teamrun/
├── plan.md / research.md / data-model.md / quickstart.md
├── contracts/interfaces.md
└── tasks.md             # /speckit-tasks 生成(本命令不创建)
```

### Source Code (repository root)

```text
electron/
├── domain/
│   ├── models.ts                 # RunPriority/RecoveryState/DoctorCheck 结论等纯模型
│   └── repositoryPort.ts         # run 优先级/暂停、诊断报告、恢复记录端口
├── application/
│   ├── concurrencyBudget.ts      # 三级并发闸门(全局/项目/单 Agent 类型)
│   ├── workbenchService.ts       # 六分区聚合(派生视图,复用 observeRunSummaries)
│   ├── recoveryService.ts        # 启动扫描、进程核对、孤儿检测、节点重跑编排
│   ├── doctorService.ts          # 体检项执行与报告聚合(检查器经端口注入)
│   └── resourceMonitor.ts        # 负载/磁盘采样(尽力而为)+ 排队原因标注
├── data/database.ts              # 迁移 v11
├── platform/
│   └── diagnosticsProbes.ts      # statfs/loadavg/进程探活的具体探测实现
├── mcp/server.ts                 # pause_team/resume_team/set_run_priority/
│                                 # run_doctor/get_recovery_status/rerun_task
├── ipc.ts / preload.ts           # workbench:*/doctor:*/recovery:*/scheduler:* 通道
└── appEnvironment.ts             # 组合根 + 启动时恢复扫描挂载

src/
├── features/
│   ├── workbench/WorkbenchView.tsx   # 全局工作台(六分区聚合,侧栏新顶级入口)
│   ├── settings/sections/(扩展现有) # 三级并发设置
│   └── doctor/DoctorView.tsx         # 诊断中心(可并入设置区或独立入口)
tests/
├── concurrency.test.ts / recovery.test.ts / doctor.test.ts
└── workbench.test.ts
tools/mcp-trace.mjs                # 多 run 并行与恢复场景驱动
```

**Structure Decision**: 沿用既有分层;新增四个 application 服务各自单一职责;
工作台为纯派生聚合(不建新事实源);UI 新增 `workbench/` 与 `doctor/` 两个 feature 目录。
