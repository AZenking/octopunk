# Quickstart: v0.4 Review Center 与质量门禁验证指南

> 目标:证明特性的端到端可用性(SC-001/002/003/004)。实现细节见 tasks.md
> (/speckit-tasks 生成),本文只定义可运行的验证场景。

## 前置条件

- `pnpm install` 完成(better-sqlite3 处于 Electron ABI,可 `pnpm start`)
- 本机已认证 `claude` CLI(mcp:trace 默认 1 个只读任务)
- 一个可写测试仓库(或让 trace 自建一次性仓库)

## 场景 1:审查闭环(GUI)

1. `pnpm start` 启动应用;经 GUI 委派 1 个 `workspace_write` 任务并等待报告。
2. 侧边栏打开 **Review Center**:待审查任务出现在列表;点击进入。
3. 验证:变更树与完整 Diff 呈现;切「基线/工作树/集成结果」三方对比;
   超出基线的文件有 diff 内容。
4. 在两个文件各留一条行级评论(其中一条 severity=risk),勾选两条执行
   **批量返工**;子 Agent 复用原会话完成返工。
5. 复审:原评论状态变为 resolved(锚点未漂移)或 line_changed(漂移但快照可见);
   risk 评论在门禁 risk_findings 项生效。
6. **通过审查**:自动生成交付摘要(结论/证据链接/豁免清单/遗留项)。

**预期**:全程未打开终端;评论零丢失;摘要证据链接可点开。

## 场景 2:质量门禁(MCP)

1. 配置项目默认门禁(设置页或 `set_gate_config`):`tests: "pnpm test"`、
   `require_todo_clean: true`、`require_target_baseline: true`。
2. `pnpm mcp:trace --repo <测试仓库> --agent codex --mode workspace_write`
   驱动一次完整运行至报告就绪。
3. 调用 `run_quality_gate` → 逐项明细(tests/lint… 按配置出现)。
4. 构造失败:在测试仓库放置必然失败的检查命令 → 该项 fail 且带修复建议;
   `accept_task` 被拒并返回明细。
5. `waive_gate_item`(带 reason)→ overall 变 waived → `accept_task` 成功,
   交付摘要呈现豁免清单。
6. 保存矛盾配置(如 require_todo_clean + Todo 白名单缺失)→ 保存被拒并提示。

**预期**:门禁永不返回裸布尔;失败意见可作为返工上下文回传原会话。

## 场景 3:跨模型仲裁(MCP)

1. `set_gate_config` 设 `review_mode: dual_readonly`。
2. trace 至报告就绪后,两个只读审查任务(Claude + Codex)被派发。
3. `get_arbitration` 返回共识/分歧/待验证三段;人为构造分歧(两审查者结论相反)
   → `auto_passed=false`,accept 需人工/主 Agent 决断。

## 场景 4:GitHub 回灌(可选,默认关闭)

1. 本机 `gh auth status` 已登录;设置中开启回灌。
2. 审查通过后 `create_pr` → PR 建立且任务详情出现链接;`pr:status` 回灌
   检查与评论。
3. 关闭回灌/卸载 gh → 功能报可读错误,本地审查与门禁不受影响。

## 自动化验证

```bash
# 1) 类型与单测(测试前需将 better-sqlite3 切至 Node ABI,见 README)
pnpm run typecheck
pnpm test            # reviewCenter / qualityGate / repository(v7 迁移)

# 2) 端到端协议驱动(自动仓库,自动清理)
pnpm mcp:trace --tasks 2
# 门禁场景驱动(trace 扩展后):
pnpm mcp:trace --gate "tests=pnpm test" --gate-fail-path tests/broken.test.ts
```

## 验收对照

| 场景 | 覆盖的 SC |
| --- | --- |
| 1 | SC-001(界面内全流程)、SC-004(评论闭环 ≥95%)、SC-006(大 Diff) |
| 2 | SC-002(证据链)、SC-003(门禁失败 100% 明细) |
| 3 | SC-005(共识/分歧/待验证) |
| 4 | FR-015/016(默认关闭、降级) |
