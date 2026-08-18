# Data Model: v0.4 Review Center 与质量门禁(Phase 1)

> 迁移版本:SQLite migrator v6 → **v7**(以下新表/新列)。命名与列风格
> 沿用既有 DDL(snake_case、revision 乐观锁、created_at/updated_at 秒级时间戳)。

## 新增实体

### review_comments(行级评论)

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | UUID |
| run_id / task_id | TEXT | 归属任务,FK 语义 |
| review_round | INTEGER | 创建时的审查轮次 |
| file_path | TEXT | 评论锚点文件 |
| line_start / line_end | INTEGER | 行锚点(基线侧行号) |
| context_snapshot | TEXT | 锚点行内容快照(≤2KiB,防行漂移后丢失) |
| body | TEXT | 评论正文(≤8KiB,写入前 redact) |
| severity | TEXT | `info` / `risk`(risk 计入高风险发现) |
| author | TEXT | `user` / `codex` / `claude_code` / `pi` |
| status | TEXT | `open` / `resolved` / `dismissed` / `line_changed` |
| created_at / updated_at | REAL | 秒级 |

**状态迁移**:`open → resolved`(返工后新 Diff 复审通过)/ `open → dismissed`
(显式关闭)/ `open → line_changed`(返工后锚点行变更,保留快照并重开);
终态不可逆。**校验**:锚点必须位于该任务 Diff 的文件集内;severity=risk 的
dismiss 需附理由(进入 findings 审计)。

### project_gate_configs(项目默认门禁)

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| repository_path | TEXT PK | 项目仓库绝对路径 |
| config_json | TEXT | 条件开关 + 参数(见下方结构) |
| updated_at | REAL | |

**config_json 结构**(领域校验见 policy):`checks: {tests, lint, typecheck,
build}`(命令 + 超时)、`max_risk_findings: 0`、`scope_allowed_paths: []`、
`require_dependencies_accepted: bool`、`require_target_baseline_safe: bool`、
`required_reviewers: []`、`manual_confirm_high_risk: bool`、`require_todo_clean:
bool`、`review_mode: standard | cross_model | dual_readonly | contest | role_based |
arbitration`。
**校验(保存时拒绝)**:矛盾组合——如 `require_todo_clean: true` 且同项目
Workflow 常驻 Todo 白名单未配置;`required_reviewers` 引用不存在的 Agent 类型;
命令条数 >8。

### team_runs 新列

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| gate_snapshot_json | TEXT | 启动时固化的生效门禁(项目默认 ⊕ 运行覆盖),随运行不可变 |

### gate_evaluations(门禁判定)

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | UUID |
| run_id / task_id | TEXT | 判定归属 |
| request_id | TEXT | 幂等键(cachedResponse 复用既有机制) |
| overall | TEXT | `pass` / `fail` / `waived`(全部失败项已豁免) |
| evaluated_at | REAL | |

### gate_evaluation_items(逐项明细)

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | |
| evaluation_id | TEXT | FK → gate_evaluations |
| check_key | TEXT | `tests` / `lint` / `typecheck` / `build` / `risk_findings` / `scope` / `dependencies` / `target_baseline` / `reviewers` / `high_risk_confirm` / `todo_clean` |
| status | TEXT | `pass` / `fail` / `waived` / `unknown`(命令超时/无法确认) |
| detail | TEXT | 结论摘要(含命令输出尾段,redact ≤2KiB) |
| fix_suggestion | TEXT | 失败时的可执行修复建议 |
| waived_by / waived_reason / waived_at | TEXT/REAL | 豁免留痕(主 Agent 或用户) |

**迁移语义**:overall=fail 时 accept 被拒;全部 fail 项转 waived → overall
重算为 waived 方可 PASS;unknown 不阻塞但醒目呈现(与 Doctor 原则一致)。

### arbitrations(仲裁结论)

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id / run_id / task_id | TEXT | |
| consensus | TEXT | 共识(Markdown) |
| disagreements_json | TEXT | 分歧数组:`{reviewer, verdict, evidence}` |
| to_verify_json | TEXT | 待验证项数组:`{claim, how_to_verify}` |
| auto_passed | INTEGER | 0(分歧时禁止自动通过,FR-013) |
| created_at | REAL | |

### delivery_summaries(交付摘要)

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id / run_id / task_id | TEXT | 任务级;run 终审摘要 task_id 为 NULL |
| verdict | TEXT | `PASS` / `REWORK` / `BLOCKED` |
| summary_md | TEXT | 结构化 Markdown(结论/证据链接/豁免清单/遗留项) |
| evidence_json | TEXT | 证据引用(report/log/diff/gate/review 的 id 集) |
| created_at | REAL | |

### pr_links(GitHub 回灌,默认关闭)

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id / run_id / task_id | TEXT | |
| pr_url / pr_number | TEXT/INTEGER | gh CLI 创建结果 |
| last_synced_at | REAL | 最近回灌时间(状态/检查/评论为即时拉取,不复制存储) |

## 派生(不落库)

- **审查会话视图**:待审查任务 = `status IN (awaiting_report, rework_required)`
  的任务跨 run 聚合(Review Center 列表);行评论按 file_path 分组即评论面板。
- **未解决发现清单**:`review_comments.status = open`(severity=risk 置顶)。

## 关系图(逻辑)

```text
team_runs 1─* child_tasks 1─* review_comments
team_runs 1─* gate_evaluations 1─* gate_evaluation_items
team_runs 1─* arbitrations / delivery_summaries / pr_links
project_gate_configs (repository_path) ─⊕运行覆盖→ team_runs.gate_snapshot_json
request_rework(findings) ←── 批量返工聚合自 review_comments(open)
```
