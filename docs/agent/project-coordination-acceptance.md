# 项目确定性协调验收（PC-04a）

- 对应门禁：Q0、Q2；真实模型、Node 派发、额度/租约/账本不在本切片。
- 对应 Issue：#473（PC-04a）· ADR-0026（2026-11-02 采纳）。
- 上次验证：2026-11-02 · 分支 `feat/pc-04a-deterministic-coordination`（基线 main `1a74284`）· Q0 2246 例（206 文件）、Q2 679 例（83 文件）。

## 验的是哪条用户路径

1. 平台内业务变化（约定确认、成果发布、交接确认/adopt、Run 终态、人工纠正）写入事实账本；
2. 同一事务把相关变化合并成**至多一条 queued 评估**，不唤醒第二次；
3. 成员显式触发或 Hub tick 做**确定性求值**：生成一条带引用的 Inference（项目状态摘要 + 开放问题）；
4. 成员打开协调读面，看到协调状态、最近评估、最新 Inference 与开放问题；
5. 无变化时不重复产出结论；纠正后输入摘要变化，下一次评估使用新输入。

本切片不接模型、不派发 Node、不记费用；`not_run`：真实模型质量、延迟、费用与 provider 账本。

## 驱动

```bash
# 协调集成（11 例：合并 queued、并发业务写入串行化、显式触发与同 key 幂等、
# 无变化 skipped、纠正后 digest 变化、tick 只跑一次、already_completed、stale_queue、
# 超长开放问题 payload 预算、入队后输入前进、引用/输出被纠正、读面鉴权）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/coordination.integration.spec.ts

# DB 不变量（4 例：同项目一条 queued、同输入一条 completed/attempt 唯一、
# 终态/完成字段组、一条评估一条 Inference）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  packages/db/tests/coordination.integration.spec.ts
```

自动触发由 PC-03a 的既有投影用例覆盖（约定/成果/交接/Run 终态/纠正）；本切片新增的协调副作用不改变那些用例的断言。

## 观测

- `hub.context`：
  - `coordination.evaluation_queued`（tick 接手或显式触发后写；业务事务内不写伪事件）
  - `coordination.evaluation_completed`（evaluationId/inferenceEntryId/projectId）
  - `coordination.evaluation_skipped`（reason：`no_relevant_change`/`already_completed`/`no_citable_input`/`stale_queue`/`coordinator_disabled`/`coordinator_paused`）
  - `coordination.evaluation_failed`（reason：`deterministic_error`）
  - `coordination.evaluation_deferred`（reason：`retryable_error`；queued 保留到下一拍）
- 读面：`GET /api/v1/projects/:projectId/coordination`；显式触发：`POST .../coordination/evaluate`（成员、Idempotency-Key）。
- 数据库：`project_coordinator_state`、`coordination_evaluation`；Inference 在 `context_entry` + `context_citation`。
- 日志不含正文：只含不透明 id、状态、原因、digest、计数。协调读面返回最新 Inference 的**生成摘要**（含开放问题文本，来自项目上下文）；输入条目正文不在协调视图里重复。
- `coordination_evaluation` 的 payload 受 `context_entry_payload_size`（16KiB）硬约束：开放问题按字节预算纳入，超出部分以 `openQuestionsOmitted` 计数并在正文说明（计数上限为抽取候选的前 20 个；超过 20 个的候选不进入计数）。

## 判定

1. 业务事实写入后同事务合并：同项目至多一条 `queued`（`coordinator_state` 行锁串行化并发业务写入）；第二次变化只更新同一行的 `inputDigest/attempt/manifestVersion/coalescedAt`。
2. `inputDigest` 覆盖当前有效 Observation/Decision/Correction 的身份与业务坐标、规则/处理器版本、显式省略的条目 id 与数量；**排除协调自己的 Inference**，避免结果反过来触发下一次评估。
3. 成员显式触发在同事务求值；同 Idempotency-Key 重放返回同一评估，不新增 Inference。
4. 当前输入已有 completed：显式触发记录 `skipped(no_relevant_change)`，不新增 Inference；tick 无 queued 时不唤醒（第二次 tick 计数全 0）。
5. 求值只写一条 `kind='inference'`、`actorKind='coordinator'`、带 `evaluationId/inputDigest` 与至少一条 business citation 的条目；payload 压缩到 16KiB 内（长开放问题截断并计数），不写 Decision/Correction，不改 Task/Run。
6. 纠正改变当前有效集 → 新 `inputDigest` → 新评估与新 Inference；被纠正的 Inference 或其引用的事实被纠正/取代时，旧结论退出协调读面。
7. tick 处理 queued：正常求值、`already_completed` skip、TTL 过期 `stale_queue` skip（合并 CAS，不用旧快照判过期）；可重试的 PG 错误保留 queued，其余单条失败标 `failed`，不阻塞其余。
8. 读面以 `state.lastSuccessfulEvaluationId` 解析最近成功的 Inference（避免锁竞争下 finishedAt 乱序）；`latestEvaluation` 仍按创建时间取最近一行。状态行的 `rulesVersion/processorVersion` 在 enqueue 时随当前版本同步。读面要求会话；未知项目 404、畸形 projectId 400；默认状态 `enabled=true` 仅表示**确定性协调**，不代表模型协调已启用。

## 归因

- 没有 queued：看业务事实是否真的提交（PC-03a 投影钩子），再看 `coordination_evaluation` 是否已有同 digest 的 completed。
- queued 不合并：检查是否出现第二条 `(projectId) WHERE status='queued'`（DB 会拒绝）。
- 重复提醒：看 `inputDigest` 是否包含 Inference 自身或缺少规则/处理器版本。
- 没有 Inference：看评估 `skipped` 的 `failureCode`（`no_citable_input` 表示当前有效集没有可引用业务坐标）。
- 读面旧结论：看 Inference 是否被纠正（`correctedAt`）或评估是否未 completed。

## 取证

- 机器证据是两份 integration spec 的退出码与断言；Q0/Q2 可复跑。
- 本切片不产生 Node/模型证据；日志不含正文；协调读面只返回生成的 Inference 摘要。
- 提交前 `scripts/secret-scan.sh`。

## 负控变异自证

| 改坏的守卫 | 变红的用例 |
|---|---|
| 协调输入包含自身 Inference | `is idempotent per idempotency key and reports no_relevant_change on a second explicit run`（无变化却再次 completed） |
| 求值不写 citation | `coalesces business changes into one queued evaluation and produces a cited Inference`（citations 为空） |
| 去掉同输入 completed 检查 | 同上「无变化」用例（第二次产出新结论） |
| 求值改写成 Decision | 同用例 + DB CHECK（Decision 需要 member/createdBy） |
| 不去重 tick / 每次 tick 都新建评估 | `tick evaluates queued work once and does not wake on unchanged input`（第二次 tick 计数非 0） |
| 去掉开放问题 payload 预算 | `keeps Inference payload within the DB budget for long open questions`（16KiB CHECK 失败） |
| 入队后输入前进时不改写 digest/attempt | `merges an input that advanced after enqueue and keeps digest linkage`（Inference 与评估 digest 不一致） |
| 读面不校验引用是否仍当前 | `hides an Inference when its output or cited facts are corrected`（旧结论仍显示） |

## 边界与未覆盖

- **模型/Node/额度/租约/账本**：ADR-0026 §3–§6 的模型路径后续切片；本切片不派发、不计费、不产生 provider 调用。
- **启用/暂停命令**：本切片没有状态变更 API；`project_coordinator_state` 以 `enabled=true` 懒创建，暂停原因字段已就位。该 `enabled` 只代表确定性协调；模型协调启用仍必须按 ADR-0026 §1 显式配置（Node/操作者/费用/凭据/额度），后续切片不得复用本标志直接启用模型。
- **失败注入**：`failed(deterministic_error)` 代码路径存在；可重试的 PG 错误保留 queued，非重试错误才标 failed。没有稳定可复现的业务级求值失败注入；真实失败恢复与重试属模型路径。
- **测试夹具**：`already_completed`/`stale_queue`/输入前进/长开放问题用直插或直改 `coordination_evaluation` 制造前置（生产路径无法稳定复现）；删除条件：出现可控制时钟/输入的生产入口后改走真人路径。
- **省略清单**：输入超出抓取页（32 条）的部分只有 `omittedCount`，页内被字节预算跳过的条目 id 进入 `omittedEntryIds`；完整全量省略清单等来源正文/更大项目切片。
- **读面鉴权**：协调读面按团队会话可读；没有项目级 ACL（ADR-0025 §11 边界）。
- **来源/线程输入**：外部来源修订、Thread/WorkLink 由 03b/03c/PC-06；当前输入只有 PC-03a 的 Observation/Decision/Correction。
- **每次业务写入的成本**：投影在 coordinator state 行锁内读取最多 32 条当前条目正文计算 digest；这是项目级串行化点，Q8 未覆盖，PC-04b 需评估。
- **开放问题抽取**：只识别约定正文的 `待确认：` 行（确定性规则）；模型语义抽取未做，读面不声称覆盖所有未决问题。
- **真实模型质量/费用/延迟**：`not_run`。
