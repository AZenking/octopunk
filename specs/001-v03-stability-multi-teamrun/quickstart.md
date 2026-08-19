# Quickstart: v0.3 稳定性与多任务运行验证指南

> 证明 spec 四个故事的端到端可用性(SC-001 至 SC-006)。实现细节归 tasks.md。

## 前置条件

- `pnpm install` + `pnpm run build`(dist-electron 为新产物)
- 两个可写测试仓库 A、B(或让 trace 自建)
- 本机已认证 `claude` CLI

## 场景 1:多项目并行 + 工作台(US1 / SC-001、SC-005)

1. `pnpm start` 启动 GUI;分别在仓库 A、B 各启动一个 TeamRun 并委派任务。
2. 验证:两 run 同时推进;侧栏「工作台」六分区聚合正确(运行中/排队/
   等输入/失败/等审查/可集成);工作台可跳转对应 run。
3. 并发治理:设置 → 常规把全局并发调到 1 → 新任务全部排队且原因标
   `global_budget`;恢复 3 后自动放行;生效值 = 四级最严并在 UI 明示。
4. 同仓库:对仓库 A 再起第二个 run,两个 run 先后终局集成 → 后到者因基线
   移动被拒并提示重新核验(串行化,无双写)。

## 场景 2:崩溃恢复(US2 / SC-002)

1. run 内 3 个任务运行中,`kill -9` 主进程(Electron)与其中 1 个子进程。
2. 重启 App:恢复视图自动呈现——存活子进程标注「进程仍在」;被杀任务标
   failed(系统错误)并给恢复入口;全部未完成任务状态可解释。
3. 孤儿:构造残留 worktree/临时分支(discard 前强杀),恢复视图列出来源与
   占用;「清理」需逐项确认,清理后审计事件留痕。
4. 节点重跑:对失败任务执行「重跑(含下游)」→ 仅该任务与未启动的后代重置
   为 queued,已完成无关任务不动;attempt 计数递增。

## 场景 3:Doctor 体检(US3 / SC-003)

1. 设置 → 诊断(或工作台入口)对仓库 A 运行体检:九项全部出结果
   (含 GUI PATH 与终端差异核对)。
2. 注入故障:改 PATH 使 GUI 找不到 claude / 仓库制造脏工作区 / 磁盘配额模拟
   → 对应项 fail,含影响范围与建议;修复后单项重检即转 pass。
3. 复制诊断包 → 粘贴检查:无密钥/Token/未脱敏内容。
4. start_team 拦截:仓库路径不存在时启动前被拒并指向诊断项。

## 场景 4:资源感知(US4 / SC-06 场景)

1. 设置资源阈值为极易触发(如 minFreeDisk 高于当前余量)→ 新任务排队,
   原因 `resource_pressure`,运行中任务不受影响。
2. 阈值恢复 → 5 分钟内自动放行(契约不变量 4 的资源版)。
3. 交互槽:并发占满时委派一个 interactive 任务 → 预留槽使其先于排队批任务启动。

## 自动化验证

```bash
pnpm run typecheck
pnpm test                       # concurrency / recovery / doctor / workbench / repository(v11)

# 多 run 并行 + 串行化端到端(trace 扩展后):
pnpm mcp:trace --runs 2                  # 两仓库(或同仓库)并行 run,交叉断言零串扰
pnpm mcp:trace --same-repo-serial        # 同仓库双 run 先后 complete,后者被拒
pnpm mcp:trace --doctor                  # 体检驱动 + 单项重检
```

## 验收对照

| 场景 | 覆盖 |
| --- | --- |
| 1 | SC-001(≥2 仓库 0 串扰)、SC-005(集成串行 100%)、FR-001~005 |
| 2 | SC-002(100% 可解释 + 恢复入口)、FR-006~010 |
| 3 | SC-003(发现率 ≥80%)、FR-011~014 |
| 4 | SC-006(高压不伤运行 + 自动恢复)、FR-015~018 |
