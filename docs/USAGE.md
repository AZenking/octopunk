# OctoPunk 使用文档

OctoPunk 是一个面向 **Codex 主导的 Agent 团队**的 Git 任务控制平面：它负责调度、SQLite 状态、幂等与审计，外部子 Agent（Claude Code / Codex）在受控的隔离环境里执行任务，Codex 通过 MCP 担任编排者与审查者。

> 开发者文档（架构、源码映射、测试、MCP trace 工具）见 [README.md](../README.md)。

## 目录

- [环境要求](#环境要求)
- [安装与启动](#安装与启动)
- [核心概念](#核心概念)
- [界面导览](#界面导览)
- [典型工作流](#典型工作流)
- [设置说明](#设置说明)
- [让 Codex 通过 MCP 接入](#让-codex-通过-mcp-接入)
- [数据都存在哪](#数据都存在哪)
- [常见问题](#常见问题)

---

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| macOS 14+ | 目前仅支持 macOS（worktree、sandbox-exec、登录项等均为平台能力） |
| Node.js 24+ / pnpm 11+ | 仅开发/自行构建需要 |
| `claude` CLI 和/或 Codex CLI | 需已完成本地登录；OctoPunk **从不存储模型 API Key** |
| 一个本地 Git 仓库 | TeamRun 以仓库 HEAD 为基线 |

## 安装与启动

**方式一：开发模式（热更新）**

```bash
pnpm install
pnpm run dev        # vite dev server + Electron，改代码即时生效
```

**方式二：构建后运行**

```bash
pnpm run build      # 主进程 tsc → dist-electron，渲染层 vite → dist
pnpm start          # 运行构建产物
```

**方式三：打包成独立 .app**（无需 electron-builder，离线可用）

```bash
./tools/package-app.sh
# 产物：release/OctoPunk.app（ad-hoc 签名，本机可直接双击运行）
```

## 核心概念

| 概念 | 含义 |
| --- | --- |
| **TeamRun** | 一次团队运行。锚定仓库当前 HEAD 与分支，同一 UI 会话同时只有一个活跃运行 |
| **子任务（Child Task）** | 委派给外部 Agent 的任务，显式指定 Agent 类型与执行模式 |
| **执行模式** | `read_only`（只读，共享基线 worktree）/ `workspace_write`（独占分支与 worktree） |
| **审查** | 通过 / 返工 / 阻塞 三种裁决；返工会带着 findings 恢复同一个原生会话继续改 |
| **并发限制** | 单个 TeamRun 同时运行的子 Agent 数，1–10 可调（默认 3），见 [设置 → 常规](#常规) |
| **审计** | 每次执行都是一条 attempt 记录，所有报告保留；删除运行只是隐藏，审计不删 |

## 界面导览

### 新建 TeamRun

首页表单：填写 **Git 仓库路径**（可"选择…"浏览）、**团队任务**描述、**审查轮次**（1–20），点击「启动 TeamRun」。运行会锚定仓库当前 HEAD；未提交变更会被提示并忽略。

表单下方即可**委派单个外部 Agent**：任务标题、Agent 类型（Claude Code / Codex）、执行模式（只读 / 工作区写入）、提示词。若所选 Agent 不可用，会显示检测详情。

### 运行列表（侧栏）

- 实时刷新：任务进度、取消、新运行无需手动刷新
- 已完成运行永久保留；终态但未完成的运行可**删除**（软删除，审计保留）或**归档**（移入归档区，可随时恢复）

### 运行详情

- **事件流**：每个任务的生命周期事件（启动、输出预览、完成、失败……）
- **执行日志**：子 Agent 的完整执行过程，可逐任务查看
- **审查操作**：对报告给出 通过 / 返工 / 阻塞 裁决，填写审查摘要
- **任务操作**：取消、丢弃（显式清理 worktree）

### 批量委派

多任务一次下发，每行一个任务：

```
client-key | 标题 | 提示词 | 父任务 | 依赖1,依赖2
标题 | 提示词
```

- 前两列简写形式即可；`client-key` 省略时自动生成
- 依赖支持 UUID 或 client-key，形成 DAG；被依赖任务通过后依赖任务才启动
- 需填写**父级上下文摘要**（脱敏后的整体背景），会随批量任务下发
- 超出并发限制的任务自动排队

### 审查中心（Review Center）

侧栏底部「审查中心」入口，聚合**所有运行**中等待审查的任务，作为审查主战场：

- **Diff 审查**：文件变更树 + 完整 Diff,可切「基线 / 工作树 / 集成结果」三方对比;超大/二进制/敏感文件有醒目提示,大 Diff 分页加载
- **行级评论**:在任意行添加评论(可标 risk),勾选多条一键**批量返工**——评论自动带入返工上下文,子 Agent 复用原会话续改;返工后锚点行未变的评论自动 resolved,行已变的标记 line_changed 并保留快照
- **质量门禁**:见设置说明;任务详情可一键运行检查,逐项通过/失败/豁免/无法确认,失败项可豁免(逐项、附理由、留痕)
- **跨模型审查**:按配置模式派发只读审查任务(Claude↔Codex 互查、双只读独立调查、分角色、竞赛、仲裁),结论以「共识 / 分歧 / 待验证」三段呈现,**存在分歧不会自动通过**
- **交付摘要**:审查通过自动生成(结论 + 证据链接 + 豁免清单 + 遗留项)
- **GitHub PR**(默认关闭):见「连接与 MCP」;启用后可为通过审查的任务创建 PR 并回灌 CI 状态与评论

## 典型工作流

```
1. 新建 TeamRun（锚定 HEAD）
2. 委派任务（单个或批量；只读任务共享基线，写任务各得私有分支）
3. 子 Agent 执行 → 事件流实时可见 → 报告落库
4. 审查（推荐用审查中心）：Diff + 行级评论；质量门禁逐项检查,失败可豁免（留痕）,门禁未过不能通过；返工则同会话续改；阻塞则保留现场
5. 终局通过后，集成结果应用回目标分支（分支已移动或有未提交变更时拒绝）
6. 完成：侧栏永久保留；不需要的可归档或隐藏
```

## 设置说明

侧栏底部进入设置，共六个分区：

### 常规

| 项目 | 说明 |
| --- | --- |
| 开机自启 | 登录 macOS 时自动启动 OctoPunk |
| **并发限制** | 每个 TeamRun 同时运行的子 Agent 数，**1–10**（默认 3）。提高并发会同时启动更多子进程，实际吞吐仍受机器性能与模型套餐并发额度约束。**仅对之后新建的 TeamRun 生效** |
| OctoPunk Skill | 把 OctoPunk 编排技能（start_team / delegate_tasks / join_tasks 等）安装到各 Agent 的 skills 目录。Claude Code 需按说明执行一次 `claude mcp add`；Codex 可用「连接与 MCP → 连接 Codex」自动写入。不影响 OctoPunk 自己派发的子 Agent；覆盖安装自动备份原文件 |
| Worktree 清理 | 扫描托管 worktree 目录，列出可清理的终态/孤儿残留及占用空间，确认后一键清理。活跃运行的可恢复 worktree 不会被触碰 |

### 外观

应用主题（浅色/深色/跟随系统）与代码块高亮主题（明暗各一套，渲染报告代码块时使用）。

### 外部 Agent

各 Agent 的可执行文件路径、可用性检测；可停用某个 Agent（从委派 UI 隐藏）。还可为每类 Agent 配置**默认子 Agent 模型**（如 pi 的 `provider/id` 格式，任务级指定优先）。

### 质量门禁

为某个仓库路径配置 PASS 前置条件（项目默认；启动 TeamRun 时可临时覆盖，覆盖随运行留档）：

- **命令检查**：tests / lint / typecheck / build 四类,自定命令与超时,在任务 worktree 内受控执行,超时记「无法确认」
- **状态条件**：无未解决高风险发现、修改范围白名单、依赖任务已接受、目标分支安全基线、必要 Reviewer 已通过、高风险变更人工确认、Todo 清零
- 审查模式:常规 / 跨模型互查 / 双只读调查 / 竞赛 / 分角色 / 仲裁
- 矛盾组合(如「依赖须接受」× 竞赛模式)保存时即拒绝;门禁永不返回裸布尔,失败附可执行修复建议

### 连接与 MCP

- **STDIO 传输**（默认）：「连接 Codex」会向 `~/.codex/config.toml` 写入 `octopunk` MCP 条目
- **HTTP 兼容**：可选启用 `http://127.0.0.1:51931/mcp`（仅回环 + Bearer 鉴权），令牌存于 Keychain
- **GitHub 回灌**（默认关闭）：经本机 `gh` CLI 创建 PR 并回灌 CI 状态与 Review 评论;凭证由 gh 托管,OctoPunk 不存储任何 Token;未安装/未登录时给出可读提示,不影响本地审查

### 自定义

**自定义指令**：全局注入到每个子 Agent 提示词前的宿主级指导（AGENTS.md 风格），对所有委派任务生效。

## 让 Codex 通过 MCP 接入

设置 → 连接与 MCP → 「连接 Codex」，之后 Codex 即可使用以下工具编排（也是 Skill 安装后子 Agent 侧的工作流）：

`start_team` · `delegate_task` / `delegate_tasks` · `join_tasks` · `accept_task` / `request_rework` / `block_task` · `cancel_task` / `cancel_team` · `discard_task` / `discard_team` · `archive_team` / `unarchive_team`

运行中的子 Agent 额外获得一个任务绑定的受限只读 MCP，仅暴露 `get_team_context` 与 `get_task_report` 两个工具。

调试编排链路可用：

```bash
pnpm mcp:trace                 # 一次性仓库 + DB，跑完整生命周期并打印每步
pnpm mcp:trace --repo /path --db real --tasks 4
```

## 数据都存在哪

| 数据 | 位置 |
| --- | --- |
| 数据库 | `~/Library/Application Support/OctoPunk/octopunk.sqlite`（WAL） |
| 任务 worktree | `~/Library/Application Support/OctoPunk/worktrees/<runID>/…` |
| 集成 worktree | `~/Library/Application Support/OctoPunk/integration/<runID>` |
| 设置 | `~/Library/Application Support/OctoPunk/settings.json` |
| MCP HTTP 令牌 | macOS Keychain（Electron safeStorage） |

> 与原生 SwiftUI 版共用同一数据库与目录结构，两边可交替使用。

## 常见问题

**Q：启动提示 better-sqlite3 ABI 不匹配？**
开发依赖 `pnpm install` 后已按 Electron ABI 编译；若为跑测试切到 Node ABI，记得 `pnpm exec electron-rebuild -f -w better-sqlite3` 切回。

**Q：打包的 .app 双击白屏？**
确保使用 `./tools/package-app.sh` 重新打包（脚本已处理相对资源路径与 preload 打包）。若仍异常，窗口内按 `F12` / `Cmd+Option+I` 打开 DevTools 查看。

**Q：委派时提示 Agent 不可用？**
到 设置 → 外部 Agent 填写可执行文件路径并点「检测」。检测只运行 `--version`，不会请求任何密钥。

**Q：并发调高了为什么没更快？**
并发限制只控制同时启动的子 Agent 数；实际速度还受模型服务端并发额度（如 Coding Plan 套餐档位）与机器负载限制。

**Q：想换个数据库做实验？**
`OCTOPUNK_DATABASE_URL=<path>` 可覆盖数据库位置，不动正式数据。

---

本项目基于 [MIT License](../LICENSE) 开源。
