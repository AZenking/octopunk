# Research: v0.3 稳定性与多任务运行(Phase 0)

> 现状调研经 codegraph 完成;关键源:`repository.ts` startTeam/observeRunSummaries、
> `agentTeamService.ts` 调度内存结构、`gitAdapter.ts` integrationLocks、
> `teamQueryService.ts` 观察者、`ipc.ts` attachObservers。

## R1: 单活跃约束的真相与多 run 解除策略(宪法原则一关键决策)

- **发现**:`activeTeamRunExists`(repository.ts:90-98)按 **session_id** 检查——
  每个 MCP 会话一个活跃 run,**没有全局唯一约束**;GUI 当前单 run 是因为
  appState 用固定 GUI 会话启动。调度内存(`childWork`/`childRunIDs` 为
  taskID→runID 映射、`launchReadyTasks(runID)`、`paceNextLaunch` 实例级)天然
  支持多 run。
- **Decision**:不改仓储检查(Swift 移植语义零偏离);GUI 的 `team:start` 为每次
  启动生成独立 sessionID(`gui-<uuid>`),MCP 会话语义保持不变。多 run 即刻成立。
- **Alternatives**:删除/加参数绕过检查(rejected:修改移植语义,需宪法偏离记录,
  且 MCP「每会话一 run」本身是有用语义)。

## R2: 三级并发闸门(ConcurrencyBudget)

- **Decision**:新建 `concurrencyBudget.ts` 中央闸门,`agentTeamService.launch`
  前申请配额:全局并发 / 单项目(repository_path)/ 单 Agent 类型,取最严格者;
  配额来源:settings 新键(全局默认 6、项目默认 3、单 kind 默认 3,均可配)+
  run 自身 maxConcurrentTasks(四级联检,最严生效并在 UI 明示)。拒绝时任务保持
  queued 并标注原因(FR-016 排队原因),闸门释放事件驱动重排。
- **Rationale**:闸门必须集中,否则四个 launch 路径(首启/重试/恢复/审查)口径不一。
- **Alternatives**:每 run 各自为政(rejected:全局/项目约束无法表达)。

## R3: 全局工作台(六分区聚合)

- **Decision**:`workbenchService` 消费既有 `observeRunSummaries`(全局增量流)+
  每活跃 run 的轻量 `runSummary`,按 spec 六分区(运行中/排队/等输入/失败/
  等审查/可集成)聚合为派生 DTO;**不建新表**,分区判定复用任务状态机
  (等输入=blocked、可集成=accepted 未 complete 等)。UI 侧栏新顶级入口。
- **Alternatives**:独立物化表(rejected:第二事实源,违反宪法原则三)。

## R4: 崩溃恢复与进程核对

- **Decision**:
  - **PID 持久化**:迁移 v11 给 `task_attempts` 加 `pid` 列;子进程启动时记录,
    适配器退出时清除。
  - **启动扫描**:appEnvironment 构造后异步执行——查非终态 run 的 running 任务,
    对有 PID 者经探活端口(经 `ps`/`kill -0` 判活,只认带 `OCTOPUNK_SESSION_*`
    环境标识的进程——用 `ps -E` 或 `/proc` 不存在于 macOS,改用 `ps -o pid,command`
    匹配 octopunk 标识参数)核对;活着 → 任务标注「进程仍在,等待人工关联或观察」
    (不自动接管输出流,孤儿进程输出已无管道,接管不可行——如实呈现);死了 →
    标记 failed(failure_kind=system)+ 恢复选项。
  - **孤儿 worktree/分支/锁**:扫描托管目录(沿用 worktreeMaintenance 的扫描思路)
    与数据库登记比对,来源不明者列出并显式确认后清理;残留锁检测集成 worktree。
  - **节点重跑**:`rerunTask(runID, taskID, downstream: boolean)`——复用既有
    resumeTask 语义 + 下游重置(把 DAG 依赖该任务的未启动后代重置为 queued),
    全程 attempt 留痕。
- **Rationale**:detached 子进程重启后输出管道不可恢复,诚实降级优于假装接管;
  spec FR-006 要求「明确失败原因与恢复入口」而非魔法续跑。
- **Alternatives**:自动 kill 后全量重跑(rejected:违背人可控,浪费已完成工作)。

## R5: Doctor 环境诊断中心

- **Decision**:`doctorService` + 检查器注册表,每项独立超时(默认 5s,超时
  →「无法确认」)并并行执行;检查项(对齐 spec FR-011 九类):
  ①CLI 路径/版本(复用 checkAgent/ToolLocator)②GUI 继承 PATH(对比 `which` 结果)
  ③登录会话(checkAgent detail 已含)④MCP stdio 自检(self-executable 存在 +
  `--mcp-stdio --help` 级探测或轻量 spawn)⑤Git 仓库状态(inspect)⑥worktree
  可创建性(临时建删)+ 磁盘余量(statfs,阈值可配默认 2GiB)⑦沙箱能力
  (sandbox-exec 探测)⑧Provider 配额(尽力而为:读不到就「无法确认」,不臆造)
  ⑨数据库健康(schema 版本、PRAGMA quick_check 精简)。
  报告落库(`doctor_reports`/`doctor_check_items`),脱敏诊断包 = 报告 JSON 导出;
  单项重检 = 按检查器 key 重跑并更新行。
- **Alternatives**:启动前强制全量体检(rejected:体检是主动动作,拦截只做
  「注定失败」级,如仓库不存在/未登录)。

## R6: 资源感知调度与排队原因

- **Decision**:`resourceMonitor` 定时采样(5s)loadavg/内存/磁盘,超阈值
  (可配,默认 load> cores×2 或磁盘 <1GiB)置「高压」标志 → 预算闸门暂缓发放
  新配额(运行中不受影响),恢复后自动放行;排队原因 = 预算闸门拒绝时记录的
  级别(全局满/项目满/单类型满/资源高压/错峰等待),预计顺序 = 闸门队列的
  优先级排序投影。交互槽:预留 1 个全局配额给 interactive 标记任务(委派时可选)。
- **Rationale**:探测尽力而为(宪法假设条款):所有探测失败 → 状态「未知」,
  不阻塞、不放行依据臆造数据。

## R7: 同仓库多 run 与集成串行化

- **Decision**:零新增机制——`applyIntegrationLocked` 的 per-repo 锁 +
  基线/脏检查已覆盖 FR-002;补测试证明两个同仓库 run 先后 complete_team 时
  后到者被拒(基线移动)即可;集成前冲突预览复用 v0.4 的 conflictPreview。

## R8: run 优先级与暂停/继续

- **Decision**:迁移 v11 给 `team_runs` 加 `priority INTEGER DEFAULT 0`(高优先
  先得配额;调度排序 = priority DESC, created_at ASC)与 `paused_at REAL`
  (暂停 = 闸门停发该 run 配额 + 队列冻结展示,运行中任务不受影响;继续即恢复);
  MCP `pause_team`/`resume_team`/`set_run_priority` + GUI 工作台操作,全部审计事件。

## 遗留 NEEDS CLARIFICATION

无——spec 已澄清全部范围;实现细节取舍见上。

## Post-Phase-1 Constitution Re-check

原则一:仓储/状态机零修改(R1/R7),仅新增列与表 ✓;原则二:四个新服务 +
探针端口 ✓;原则三:优先级/暂停/诊断/恢复全落库,工作台纯派生 ✓;原则四:
进程核对只认带标识进程、清理显式确认、诊断包脱敏 ✓;原则五:一切恢复动作
人工可及、留痕 ✓;UI 约束:全 shadcn ✓;codegraph 约束:调研记录 ✓。无违规。
