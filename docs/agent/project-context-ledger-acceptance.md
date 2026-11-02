# 项目事实账本验收（PC-03a）

- 对应门禁：Q0/Q1、Q2；来源正文与模型推断不在本切片。
- 对应 Issue：#472（PC-03a）· ADR-0025（2026-11-02 采纳）。
- 上次验证：2026-11-02 · 分支 `feat/pc-03a-context-ledger`（基线 main `67044a9`）· Q0 2246 例（206 文件）、Q2 664 例（81 文件）、Q6 34 例（6 文件）、Q7 18 例 + secret-scan 自检/实扫 + license 全绿。

## 验的是哪条用户路径

平台内业务事件直接形成项目理解，不等待外部来源：

1. 责任人确认任务约定 → 当前有效 Decision 出现在项目上下文；
2. 成果发布 → 成果发布 Decision；
3. 交接接收人确认交接 → 交接接收 Decision；
4. Run 进入终态 → 确定性 Observation；
5. 成员发现某条只是建议 → 追加 Correction，目标条目退出当前有效集，后续读面以纠正为准；
6. 任一成员打开项目上下文，看到当前有效的 Observation/Decision/Correction、类型、业务引用与时间。

本切片不接飞书，不使用模型；Inference 由 PC-04a 写。

## 驱动

```bash
# 事实账本（10 例：约定 Decision/版本 supersede、观测只记真实提交、多字节正文裁剪、
# 纠正幂等与过滤、Run 终态 Observation（真实事件路径）、任务取消联动、同毫秒不丢行、
# 游标分页、缺引用 fail-closed、会话与项目作用域）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/context-ledger.integration.spec.ts

# DB 不变量（8 例：Observation 引用、Decision 成员/业务版本、Inference 评估身份、
# Correction 目标/唯一/业务坐标、业务坐标成对、Observation 幂等 helper 拒绝空坐标、
# Decision 当前有效唯一、citation 形状）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  packages/db/tests/context.integration.spec.ts
```

投影钩子另由既有生产用例断言：任务约定确认（`task-agreement.integration.spec.ts`）、成果发布（`artifact.integration.spec.ts`）、交接确认与 adopt 覆盖（`handoff-receipt.integration.spec.ts`）。

## 观测

- `GET /api/v1/projects/:projectId/context?limit=&cursor=`：当前有效集，含 `kind/status/title/body/businessRef/businessVersion/targetEntryId/actorKind/citations` 与 `nextCursor`（按 entry 身份键集分页，`null` 才代表已到末尾；默认 50、上限 200）。
- `hub.context`：`context.entry_recorded`（业务事务**提交后**写，只含 entryId/projectId/kind/status/businessRef/businessVersion/occurredAt）、`context.entry_corrected`（只含 projectId/entryId/targetEntryId/actorKind/correctionKind，不含正文）、缺引用条目被挡时 `context.entry_withheld`（warn + entryIds）。
- 数据库：`context_entry`、`context_citation`；Decision 的当前有效行由部分唯一索引钉住。

## 判定

1. 约定确认在同一业务事务内写 Decision：`actorKind='member'`、`createdBy` 为确认人、`businessRef=<taskSpec:taskId>`、`businessVersion=<revisionId>:<revisionNumber>`，并有 business citation；提交后产生一条 `context.entry_recorded`。
2. 同一 Task 的下一版约定确认后，旧 Decision 标 `superseded`，读面只返回新版；旧行保留。
3. 成果发布与交接接收确认同样投影为成员 Decision；交接 adopt 以**谱系 businessRef**（`handoffReceipt:<upstreamTaskId>:<downstreamTaskId>`）推进版本，`businessVersion=<receiptId>:<confirmedAt>`（避免同毫秒碰撞），旧的已确认 Decision 标 `superseded`，同一交接对不会同时有两条 active。
4. Run 进入终态投影为 `actorKind='system'` 的 Observation，`businessVersion=status`；真实 `run.completed` 事件（`ingestNodeEvent`）、任务取消联动与 reconciler 租约过期都走 `applyRunStatus` 收口，重复 seq 重放不新增行，提交后都产生 `context.entry_recorded`。
5. Correction 只追加：目标行正文/引用/status 不变，仅写 `correctedAt`；读面按 `status='active' AND correctedAt IS NULL` 过滤；同一目标重复纠正返回既有 Correction；纠正不能被再次纠正（409）。
6. actorKind 非 member 的 Decision、无业务引用/成员 actor 的 Observation、无 evaluationId/inputDigest 的 Inference、无目标或携带业务坐标的 Correction 均被 DB CHECK 拒绝；Observation/Decision/Inference 没有可用 citation 的条目**不进读面**（fail-closed），并写 `context.entry_withheld` warn。
7. 读面要求会话；畸形 projectId 400、不存在 404、非 UUID 游标 400；`limit` 只影响分页，不静默截断（`nextCursor` 显式给出），游标边界按 DB 微秒精度比较——同一毫秒创建的多条 entry 仍可逐页取完。

## 归因

- 条目缺失：先看对应业务行是否真的提交（约定确认/成果发布/交接确认/Run 终态），再看 `context_entry.business_ref` 与投影调用点。
- 版本不更新：看 `businessRef/businessVersion` 是否按业务对象/版本分离；旧 active 是否被标 `superseded`；交接看谱系 ref 而不是单条 receipt id。
- 纠正后仍显示：检查读面是否只按 `status` 过滤而漏了 `correctedAt IS NULL`。
- 条目被挡：看 `hub.context` 的 `context.entry_withheld` warn 与 `context_citation` 是否随 entry 同事务落库。
- 观测缺失：`context.entry_recorded` 只在事务提交后写；同 key 重放/并发败者不写，符合「日志不指向已回滚行」。
- 类型混淆：Decision 必须是 member + business citation；Inference 只能由 PC-04a 的协调提交写。

## 取证

- 机器证据是两份 integration spec 的退出码与断言结果；CI `integration` job 同时跑 Q2/Q6/Q7。
- 本切片不产生前端或外部平台证据包；日志/断言不含正文之外的敏感字段。
- 提交前 `scripts/secret-scan.sh`。

## 负控变异自证

| 改坏的守卫 | 变红的用例 |
|---|---|
| 读面去掉 `correctedAt IS NULL` | `appends one correction, hides the corrected entry, and is idempotent`（被纠正条目重新出现） |
| 读面不挡无 citation 条目 | `withholds entries without usable citations instead of showing an unreferenced fact`（坏条目泄漏进读面） |
| Decision 投影不写 citation | `projects a confirmed agreement as a Decision and supersedes the prior version`（citations 为空） |
| Decision 投影改用非成员 actor | 同用例（约定确认事务被 DB CHECK 拒绝） |
| 交接 adopt 仍用单条 receipt businessRef（不 supersede） | `adopt：无新版本 409；新版本产生新 confirmed receipt；旧 receipt 保留；重复采用幂等`（两条 active Decision） |
| 终态投影不写 Observation / 不走收口 | `records a run terminal state as an idempotent Observation through the real event path`（读面缺 Observation） |
| 去掉 `context.entry_recorded` 提交后日志 | `emits entry_recorded only for the transaction that created the Decision` 与 Run 终态用例（观测事件缺失） |
| 纠正日志不再判 `created`（重放也发） | `appends one correction, hides the corrected entry, and is idempotent`（同一目标出现第二条 `entry_corrected`） |
| 读面忽略游标 | `pages by entry identity and exposes an explicit cursor instead of truncating`（第二页重复第一页） |
| 游标退回 JS 毫秒比较 | `does not lose entries that share the same millisecond (microsecond keyset)`（同毫秒行丢失） |
| 游标不做 UUID 校验 | `pages by entry identity...` 的 `cursor=not-a-cursor` 分支（500 而非 400） |
| reconciler 漏传 `log`（组合根） | `pnpm check` 的 typecheck（`ReconcileDeps.log` 必填）；reconciler 路径的事件由 R5 用例 `marks the run lost... and emits entry_recorded` 断言 |
| 任务取消不传 collector | `emits entry_recorded when cancelling a Task with a queued Run`（观测缺失） |

## 边界与未覆盖

- **来源修订与正文**：`source_revision`、`source_event`、外部消息编辑/撤回/缺口按 03b/03c；本切片只有业务引用。
- **Thread/WorkLink/订阅分发**：PC-06；本切片没有线程级 M:N。
- **Inference/协调**：PC-04a；当前读面不会出现 Inference。
- **Correction 撤销**：ADR-0025 明确不可撤销；本切片不提供清除 `correctedAt` 的入口。同一目标只允许一条 Correction（DB 部分唯一索引），产品上视为终局纠正；多轮纠正/替代纠正属于后续切片。
- **Entry 级 citation 的 DB 强约束**：目前由「投影函数同事务写 citation + 读面 fail-closed + 测试」三件保证，尚未加延迟约束触发器；坏账本行只能由故障注入制造。`business_ref`/`business_version` 的成对或同为空的 CHECK 已由 DB 强制，Correction 不得携带业务坐标。
- **业务审批决定**：当前仓库没有独立业务审批表；工具调用审批不进入项目上下文。
- **来源/Inference 的 `context.entry_recorded`**：等 PC-03b/04a 的写入路径接入同一观测口径。
- **游标边界语义**：语法合法但不存在（或属于其他项目）的 UUID 游标返回 200 + 空页（子查询无行）；不泄漏、不崩溃，但调用方无法区分「已到末尾」与「游标失效」，暂按空页处理。
- **交接谱系的乱序确认**：同一对上下游 Task 存在多个 pending receipt 时，当前按「最后提交的理解为 active」；拒绝比已 adopt 版本更旧的 receipt 属于后续产品规则，不在 PC-03a。
