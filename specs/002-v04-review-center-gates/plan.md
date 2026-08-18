# Implementation Plan: v0.4 Review Center 与质量门禁

**Branch**: `002-v04-review-center-gates` | **Date**: 2026-08-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-v04-review-center-gates/spec.md`

## Summary

在现有「报告审查(REWORK/PASS/BLOCKED)」状态机之上叠加四块能力:(1) 全局
Review Center——侧边栏顶级入口,聚合待审查任务,提供变更树、完整 Diff 与
基线/工作树/集成结果三方对比、行级评论与批量返工;(2) 项目默认 + 运行覆盖的
质量门禁,accept 前逐项判定通过/失败/豁免并留痕;(3) 跨模型审查模式与仲裁
(共识/分歧/待验证);(4) 默认关闭的 GitHub PR 回灌(经 gh CLI,凭证不落库)。
技术路径:Diff 数据由 GitPort 新增 diff 能力提供;行级评论复用 request_rework
既有 findings(file/line/evidence)通道扩展为可管理实体;门禁在 application
层新增服务、判定结果全量入 SQLite;GUI 与 MCP 共享同一状态机与工具面。

## Technical Context

**Language/Version**: TypeScript 5.x,Node 24,Electron + Vite + React 18

**Primary Dependencies**: better-sqlite3(唯一原生模块,Electron ABI)、
@modelcontextprotocol/sdk、shadcn/ui 渲染层、vitest

**Storage**: SQLite(`~/Library/Application Support/OctoPunk/octopunk.sqlite`,
迁移 v1–v6 → 本特性新增 v7);GitHub 凭证不落库(经 gh CLI 托管)

**Testing**: vitest(`tests/`,需 better-sqlite3 切换至 Node ABI);
`pnpm mcp:trace` 端到端驱动;`pnpm run typecheck` 主进程 + 渲染层

**Target Platform**: macOS 14+(本地单用户桌面应用)

**Project Type**: desktop-app(Electron 主进程 + React 渲染层 + MCP 服务面)

**Performance Goals**: 5000 行 Diff 首次呈现 ≤5s(SC-006);Diff 读取为
按需分页,不整仓加载;门禁判定单项超时显式标记 unknown,不阻塞其余项

**Constraints**: 渲染层仅经 preload 白名单 IPC;评论/门禁/仲裁/摘要全部先落库
再呈现;MCP 与 GUI 行为一致;离线可用(GitHub 回灌除外,降级不阻塞)

**Scale/Scope**: 单机、运行数与任务数十到百级;单任务 Diff 上限按 64KiB
分页读取(与现有 report 裁剪上限同量级)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | 原则/约束 | 判定 | 说明 |
| --- | --- | --- | --- |
| 一 | Swift 对等(移植保真) | PASS(附注) | v0.4 为全新能力,叠加于移植核心之上;不修改已移植的审查状态机语义,仅扩展(REWORK 仍复用原生会话、轮次规则不变) |
| 二 | 分层端口与适配器 | PASS | Diff 能力经 `GitPort` 扩展实现于 `electron/platform/gitAdapter.ts`;门禁/审查编排为 `electron/application` 新服务;渲染层只经 preload 白名单 |
| 三 | SQLite 持久事实源 | PASS | 行级评论、门禁配置与判定、豁免、仲裁、交付摘要、PR 关联全部先落库再呈现;审查会话为派生视图不另建表 |
| 四 | 安全默认 | PASS | GitHub 凭证不落库(gh CLI 托管,默认关闭);Diff 展示沿用脱敏规则并对敏感文件提示;门禁检查命令在任务 worktree 内受控执行 |
| 五 | 编排与人可控审查闭环 | PASS | 主 Agent 全权豁免(用户澄清决策)但逐项留痕、交付摘要醒目呈现豁免清单,用户可复审异议;仲裁分歧不静默合并 |
| UI | shadcn 专属/禁原生 HTML 控件/参考 v0 | PASS | Review Center 全部使用 shadcn/ui 原语(sidebar/tabs/scroll-area/badge/dialog 等);Diff 行内容渲染为文本展示(非交互控件),布局参考 v0 的栅格与间距写法;不引入第二套 UI 体系 |
| 工具 | Agent 代码读取优先 codegraph | PASS | 本 plan 的现状调研经 codegraph 完成(research.md 记录) |

*Post-Phase-1 re-check:见 research.md 末尾,无新增违规;无 Complexity Tracking 条目。*

## Project Structure

### Documentation (this feature)

```text
specs/002-v04-review-center-gates/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── interfaces.md    # MCP 工具 + IPC 通道契约
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
electron/
├── domain/
│   ├── models.ts                 # ReviewComment / GateCheckItem 等纯模型与状态判定
│   ├── repositoryPort.ts         # 新增评论/门禁/仲裁/摘要/PR 关联的仓储端口
│   └── policy.ts                 # 门禁条件组合校验(矛盾条件在保存时拒绝)
├── application/
│   ├── reviewCenterService.ts    # 审查中心用例:Diff 读取、评论、批量返工、交付摘要
│   ├── qualityGateService.ts     # 门禁配置/覆盖/执行/豁免/结果查询
│   ├── reviewModeService.ts      # 跨模型审查模式编排与仲裁聚合
│   └── ports.ts                  # GitPort 扩展(diff);GitHub 回灌端口
├── data/
│   ├── database.ts               # 迁移 v7(新表与新列)
│   ├── mappers.ts / repository.ts# 新实体读写实现
├── platform/
│   ├── gitAdapter.ts             # diff / 三方对比 / 冲突预览实现
│   └── ghCliAdapter.ts           # gh CLI 适配(PR 创建/状态/评论回灌,默认关闭)
├── mcp/server.ts                 # 新增/扩展工具(见 contracts/interfaces.md)
├── ipc.ts / preload.ts           # Review Center 与门禁 IPC 通道白名单
└── appEnvironment.ts             # 组合根装配新服务

src/
├── features/
│   └── reviewCenter/
│       ├── ReviewCenterView.tsx  # 全局审查中心(侧边栏顶级入口)
│       ├── DiffTree.tsx          # 文件变更树(shadcn tree 风格)
│       ├── DiffViewer.tsx        # Diff 渲染(分页,基线/工作树/集成三方切换)
│       ├── CommentPanel.tsx      # 行级评论与批量返工
│       ├── GatePanel.tsx         # 门禁结果(通过/失败/豁免明细)
│       └── ArbitrationPanel.tsx  # 共识/分歧/待验证展示
└── appState.tsx                  # 审查中心状态与通道调用

tests/
├── reviewCenter.test.ts          # 评论/返工闭环用例
├── qualityGate.test.ts           # 门禁判定/豁免/矛盾配置
└── repository.test.ts            # v7 迁移与新表读写(扩展既有套件)

tools/mcp-trace.mjs               # 新增审查/门禁步骤的 trace 驱动
```

**Structure Decision**: 沿用仓库既有 electron(domain/application/data/platform/mcp)+ src/features 分层(README Layout 表);新 UI 聚焦单一 `src/features/reviewCenter/` 目录,侧边栏入口经现有 navigation 结构扩展;不新增顶层项目或第二套状态。
