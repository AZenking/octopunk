<!--
同步影响报告
- 版本变更:1.1.0 → 1.2.0
- 修改原则:核心原则未变;"开发流程"新增一条工具约束(AI Agent 读取/理解
  代码时必须优先使用 codegraph 索引工具定位符号与调用链,索引不可用时才
  退回常规文件读取/文本搜索)。
- 新增章节:无(仅新增约束条目,章节结构不变)。
- 删除章节:无。
- 后续 TODO:无。
- 说明:新增实质性约束指引,按语义化版本规则升 MINOR;最后修订日期 2026-08-18。
依据来源:README.md、roadMap.md、仓库目录结构、tests/、tools/mcp-trace.mjs、用户指令。
-->

# OctoPunk 项目宪法

OctoPunk 是面向 Codex 主导的 Agent 团队的本地、安全、可恢复、可审计的执行控制平面,
是原生 SwiftUI macOS 应用 OctoPunk 的一对一 TypeScript/Electron 移植。本宪法约束本
仓库的所有变更;与其他习惯做法冲突时,以本宪法为准。

## 核心原则

### 一、Swift 对等(移植保真)

从 Swift 源码(`../OctoPunk`)移植的行为必须保持语义一致:相同的 SQL schema 与迁移
(v1–v6)、相同的 TeamRun/任务状态机与流转、相同的脱敏/审计/策略规则、相同的 MCP
工具面与通知协议。有意偏离的变更必须在变更说明中明确写出偏离点及理由。路线图功能
(见 `roadMap.md`)必须叠加在移植核心之上,严禁静默重定义已移植的语义。

### 二、分层端口与适配器架构

- `electron/domain` 只包含纯模型、策略、事件与仓储端口,严禁导入 Electron API、
  Node 内置模块或执行任何 I/O。
- `electron/application` 仅通过端口编排用例;`electron/data` 与 `electron/platform`
  实现这些端口(SQLite、CLI 适配器、Git、进程、钥匙串、通知)。
- `electron/appEnvironment.ts` 是唯一的组合根;服务必须接收依赖注入,严禁自行构造
  适配器。
- 渲染进程只能通过 preload 桥接(`contextIsolation` IPC 白名单)访问主进程,严禁
  获得直接的 Node 或文件系统访问能力。
- 新界面(GUI、MCP、未来 CLI/API)必须驱动同一套应用服务与领域状态机——不允许
  存在平行状态。

### 三、SQLite 是持久事实源(不可协商)

调度状态、任务 DAG、attempt、报告、事件与审计记录必须先落库 SQLite 再被依赖;
内存状态只是可丢弃的缓存。变更类请求必须幂等(`client_key` / `request_id`),
批量校验必须原子(全部成功或全部不执行)。每次执行必须记录为 attempt,每份报告
必须保留供审查。崩溃或重启之后必须留下可恢复、可解释的状态。

### 四、安全默认(不可协商)

- OctoPunk 严禁存储模型 API Key;子 Agent 仅通过其原生 CLI 登录态认证。
- 子进程必须在独立进程组中脱离运行,并处于 `sandbox-exec` 与环境变量白名单约束
  之下。
- 上下文、日志、报告、诊断信息与 MCP trace 在持久化、展示或导出之前必须完成
  密钥与敏感内容的脱敏。
- HTTP 兼容端点必须仅绑定回环地址并要求 Bearer 认证;运行中的子 Agent 只能获得
  任务绑定的受限 MCP 服务器,且仅暴露两个只读工具。
- 集成到目标分支时,若记录的分支已移动或工作区不干净,必须拒绝集成。破坏性清理
  (discard)需要显式的用户/Agent 动作;严禁静默自动合并、静默自动批准与无限
  静默重试。

### 五、主 Agent 编排、人类始终可控的审查闭环

主 Agent(Codex)通过 MCP 编排,委派显式 `agent_kind` / `execution_mode` 的任务
并担任最终审查者,但 OctoPunk 的价值在审查闭环而非自治。`PASS` 必须有留存证据
支撑(报告、Diff 基线、日志);`REWORK` 复用同一原生会话并附带审查发现;
`BLOCKED`/已取消的工作保留以备恢复。用户必须始终能够检查、暂停、返工或终止任何
运行——自动化不得剥夺人类的接管权。新增 Agent Provider、触发器与集成必须通过
适配器协议扩展,严禁修改核心状态机。可靠性(可恢复、可解释、可审计)优先于
功能数量。

## 技术与产品约束

- **技术栈**:macOS 14+、Node 24、Electron + Vite + React + TypeScript、pnpm 11+。
  原生模块仅 `better-sqlite3`,通过根 `postinstall`(`electron-rebuild`)重建到
  Electron ABI。
- **渲染层 UI(界面约束)**:
  - 界面组件必须使用 shadcn/ui;存在 shadcn/ui 原语时严禁手写控件。
  - 严禁使用原生 HTML 元素编写界面控件:按钮、输入框、下拉、复选、开关、弹窗、
    表格、进度等一切交互与表单元素,必须使用对应的 shadcn/ui 组件,不得直接使用
    `<button>`、`<input>`、`<select>`、`<dialog>` 等原生标签实现。
  - 原生结构性标签(`<div>`/`<span>`/`<section>` 等)仅限布局组织使用,严禁借此
    重新实现 shadcn/ui 已提供的任何组件。
  - 布局与样式的编写可以学习 Vercel v0(v0.dev)的布局模式与样式写法(Tailwind
    工具类、栅格、间距体系、响应式断点、组件化布局);参考 v0 风格的产出最终仍
    必须落在 shadcn/ui 组件与项目 design tokens 之上,不得引入第二套 UI 体系。
- **包管理器**:pnpm;依赖构建脚本持续受 `pnpm-workspace.yaml` 约束(允许
  `electron`、`esbuild`、`@electron/rebuild`;刻意禁用 `better-sqlite3` 自带
  prebuild)。
- **数据位置**必须与 Swift 应用一致:SQLite 数据库、worktree、集成 worktree、
  设置与旧会话导入均位于 `~/Library/Application Support/OctoPunk/`。MCP HTTP
  Bearer Token 保存在 Electron `safeStorage`;`OCTOPUNK_DATABASE_URL` 仅用于
  诊断/CI 覆盖数据库位置。
- **MCP 传输**:本地 STDIO 为默认;HTTP 端点(`127.0.0.1:51931/mcp`)为显式
  启动的兼容面。
- **产品边界(MVP)**:同一时间仅一个活跃 TeamRun;子 Agent 并发 1–10 可配置
  (默认 3);持久化排队;已完成运行永久保留。方向与优先级遵循 `roadMap.md`;
  其中"暂不优先的方向"不得在可靠性、审查与恢复工作之前消耗核心研发资源。

## 开发流程

- **Agent 代码读取**:AI Agent(Codex、Claude Code、ZCode 等)在本仓库读取与
  理解代码时,必须优先使用 codegraph 索引工具(符号定位、调用链追踪、相关源码
  聚合,如 `codegraph_explore`),仅在索引缺失、失效或需要精确逐行核对时,才
  退回常规文件读取与文本搜索;`.codegraph/` 索引数据为本机状态,不入库。
- **规格驱动变更流**:非平凡功能与行为变更必须走 `.specify/` 中的 Spec Kit 工作
  流(specify → plan → tasks → implement),保持规格、实现与本宪法同步。
- **质量门禁**:变更判定完成之前必须通过 `pnpm run typecheck`(主进程 + 渲染层)
  与 `pnpm test`。测试移植自 `OctoPunkTests`;领域、仓储与子执行行为必须保持与
  Swift 测试同等的覆盖。
- **ABI 纪律**:运行测试要求 `better-sqlite3` 处于纯 Node ABI(prebuild-install);
  运行应用要求 Electron ABI(`electron-rebuild`)。严禁在错误 ABI 上提交或交付。
- **提交风格**:Conventional Commits(`fix:`、`feat:`、`docs:`、`build:`、
  `test:`……),主题行中文或英文与近期历史保持一致,必要时加 scope。
- **验证工具**:`pnpm mcp:trace` 通过 MCP stdio 驱动真实应用,必须保持可用于
  端到端生命周期验证(默认一次性仓库/数据库;仅在显式要求时使用真实数据库)。
- **打包**:通过 `tools/package-app.sh` 离线打包(esbuild 打包、本地 Electron
  运行时、ad-hoc 签名)——不依赖 electron-builder。

## 治理

- 本宪法是本仓库代码与流程决策的最高权威;与之冲突的文档或习惯做法让位于本宪法。
- **修订**:提出变更 → 更新本文档 → 按语义化版本提升 **CONSTITUTION_VERSION**
  (MAJOR:原则删除或重定义;MINOR:新增原则或实质扩充指引;PATCH:澄清性调整),
  更新"最后修订"日期,并在顶部追加同步影响报告注释,说明改了什么、为什么。
- **合规审查**:每个 PR / Agent 执行的任务必须验证宪法合规性——尤其是两条
  不可协商原则(持久事实源;安全默认)。超出架构分层的复杂度必须在变更说明中
  给出理由。
- **指引**:`roadMap.md` 是产品方向指引文档;运行时开发指引位于 Spec Kit memory
  (`.specify/memory/`)。本宪法中的原则必须是声明式且可检验的——不接受无理由
  的模糊"应该"表述。
- **审查节奏**:在每个路线图里程碑(v0.3 → v1.0)复核本宪法,确认原则仍与
  产品边界匹配。

**版本**: 1.2.0 | **批准**: 2026-08-18 | **最后修订**: 2026-08-18
