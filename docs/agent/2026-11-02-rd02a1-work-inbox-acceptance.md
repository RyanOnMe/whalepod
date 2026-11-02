# RD-02a-1 工作收件箱条目与显式关联验收

- 对应场景/门禁：ADR-0028 §4.2 的 Hub/PostgreSQL 半边；Q0 静态门、Q2 数据门
- 对应 Issue：#489（RD-02a-1，母 Issue #484）
- 上次验证：2026-11-02 · 分支 `feat/rd-02a-work-inbox`（本 PR）· PASS
- 本切片边界：只落收件箱条目与 `pending/returned/superseded/retracted/expired`；**不实现 delivered/unconfirmed/consumed、Run 清单、Node 下载、Runtime 读取、订阅快路径、模型 Router、自动派工**（归 #490/#485/#486）。

## 验的是哪条用户路径

Task 的当前责任人已有一份持续工作（RD-01）。成员在讨论区或项目上下文里留下一条真实补充后，责任人显式把它关联进这份工作的收件箱；随后可以判断它不相关而退回、因来源撤权而停止重投，或让其到期。同一来源更新后，旧 pending 自动被新版本替换；同一身份重复关联只产生一条。非责任人、非法来源、终态 Task 或已退休工作都不能悄悄塞进收件箱。

## 驱动（怎么触发）

全部走生产 HTTP 与真实 PostgreSQL（`apps/hub/tests/work-inbox.integration.spec.ts`）：

```bash
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-inbox.integration.spec.ts
```

覆盖的端点：

- `POST /api/v1/works/:workKey/inbox-items`
- `GET /api/v1/works/:workKey/inbox?status=&limit=`
- `POST /api/v1/works/:workKey/inbox-items/:itemId/return`
- `POST /api/v1/works/:workKey/inbox-items/:itemId/retract`
- `POST /api/v1/works/:workKey/inbox-items/:itemId/expire`

来源全部先走生产路径：Task 评论（`POST /tasks/:taskId/comments`）、约定确认（`agreement/draft` → `agreement/confirm`）产生的 Decision 条目、成员纠正（`POST /projects/:projectId/context/:entryId/correction`）、协调求值（`POST /projects/:projectId/coordination/evaluate`）产生的 Inference。关联本身复用 RD-01 的 `loadWorkSource`，与准入读同一份来源归属/活跃性/纠正/推断/越界判定。

数据夹具两处，原因与删除条件如下：

1. **已定向 instruction 消息**：生产路径创建该消息会同时建 Run/outbox，无法隔离「收件箱不建 Run」的判据；消息不是运行时投影，测试不写运行时状态。
2. **直接改 `task_message.body/edited_at` 制造同一来源新版本**：本切片生产面还没有编辑消息的 HTTP 路径；该直写只改业务消息本身，不写投影。消息编辑路由落地后删除。

## 观测（看什么）

- 协调表：`work_inbox_item`（来源身份、`source_digest`、`body_digest`、`authorization_generation`、`supersedes_id`、状态、退回原因/备注、`status_at`）。
- 读面：`GET /works/:workKey/inbox` 返回条目与水位 `{ lastItemAt, pendingCount }`；`lastItemAt` 不随状态筛选变化。
- 业务计数：`run`、`dispatch_outbox`、`team_event`、`context_entry`、`artifact`、`task_spec_revision` 在关联前后必须完全相同（Task 消息来源用例）。
- 审计：`work.inbox.associate`、`work.inbox.return`、`work.inbox.retract`、`work.inbox.expire`；只记动作与结果，不记正文。
- 拒绝归因：非法来源返回 `409 CONFLICT`，`error.details.reason/detail` 给出 `already_directed`、`source_inactive(corrected)`、`system_produced`、`source_out_of_scope` 等稳定原因；找不到来源/条目返回 `404 NOT_FOUND`。

## 判定（成功长什么样）

### 1. 授权与工作状态

- 只有 Task 当前 assignee 能关联、列收件箱、退回、撤权、过期；其他成员（含 Owner/Admin）一律 `403 FORBIDDEN`。
- 非 active 工作不能收新条目（`409 CONFLICT`，带 `workState`）；Task 终态优先归因 `409 TASK_TERMINAL`；Task 未接受返回 `409 ASSIGNMENT_NOT_ACCEPTED`。
- 工作退休后不能再关联，但遗留 pending 仍可由 assignee 收口（退回/撤权/过期）；测试覆盖退休后 `expire` 成功。
- 条目必须属于 URL 中的 work；拿另一份工作的 itemId 操作返回 `404 NOT_FOUND`。

### 2. 来源准入（复用 RD-01）

| 来源事实 | 结果 |
|---|---|
| 真实 `discussion` 消息 / 有效内部 context entry | 关联成功，保存私有正文快照 |
| `instruction`/`followup` 消息 | `409 CONFLICT`，`details.reason='already_directed'` |
| 消息不属于该 work 的 Task | `409 CONFLICT`（来源归属不符） |
| 消息作者已停用 | `409 CONFLICT`，`source_inactive` |
| context entry 已纠正 / 非 active | `409 CONFLICT`，`source_inactive` + `corrected/inactive` |
| 外部来源条目（权限代次未复核） | `409 CONFLICT`，`source_inactive` + `source_permission_unverified` |
| Inference | `409 CONFLICT`，`system_produced` |
| 条目业务归属不是本 Task（含无引用/异 Task） | `409 CONFLICT`，`source_out_of_scope` |
| 来源 id 不存在 | `404 NOT_FOUND` |

显式关联**不要求**当前存在 Mandate，也不受 `allowedSourceTypes` 限制：它是人把输入放进工作收件箱的动作，本切片不派发；#490 在交付前必须另行按 Mandate 与实时权限复核。该取舍登记在「边界」。

### 3. 身份、版本与幂等

- 同一 `(work, sourceType, sourceId, sourceVersion, sourceDigest)` 重复关联返回同一条目；两个并发关联（不同幂等键）也收敛为一行。
- 同一来源新版本（`sourceVersion/sourceDigest` 变化）创建新条目并把旧 pending 置 `superseded`（`status_reason='new_version'`），新条目 `supersedes_id` 指向旧条目；旧条目保留历史。
- 已 `returned` 的旧条目不因同一身份重放而复活；只有新版本会产生新的 pending。
- `Idempotency-Key` 作用域含 work/actor/source；重放关联命令时按 item id 回读当前状态，不把已退回/撤权的缓存视图当成仍 pending。

### 4. 生命周期

| 动作 | 允许起点 | 结果 | 重放 |
|---|---|---|---|
| `return` | `pending` | `returned` + `return_reason/return_note` | 同原因同备注幂等；不同原因 `409` |
| `retract` | `pending`、`returned` | `retracted` + `status_reason`，清空退回字段 | 重复 `retract` 幂等；其他状态 `409` |
| `expire` | `pending` | `expired` + `status_reason` | 重复 `expire` 幂等；其他状态 `409` |

- `returned` 不能 `expire`；`expired` 不能 `return/retract`；`retracted` 不能 `return/expire`；`superseded` 是终态。
- 列面支持 `status` 过滤与 `limit`（1–100，默认 50）；非法状态筛选 `400 VALIDATION_FAILED`。
- 水位：`pendingCount` 始终是全部 pending 数；`lastItemAt` 始终是最新条目时间，不随筛选变化。

### 5. 无副作用

- 关联/退回/撤权/过期只写 `work_inbox_item` 与命令回执；不建 Run、不写 outbox/team_event/context_entry/artifact/spec revision，不调模型。Task 消息来源用例对六类业务计数做了前后全等断言。
- 静态边界测试 `apps/hub/tests/work-boundaries.spec.ts` 继续扫描 `apps/hub/src/modules/work/*.ts`，inbox 模块不得引入 `@deepseek-ai/`、模型 SDK、Runtime/testkit、Run/outbox/TeamEvent/业务写入口或 `fetch(`。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| 403 | `context.ts` 的 assignee/启用成员校验；Task 是否已改派 |
| 409 `CONFLICT` 带 details.reason | `admission.ts` 的 `loadWorkSource` 分支；来源状态/归属/纠正/推理 |
| 409 无 details | 工作状态、Task 终态/未接受，或条目状态迁移 |
| 404 | workKey/itemId 解析、item 是否属于该 work |
| 重复条目 | `work_inbox_item_identity_unique` 与 `supersedes_id` |
| 退回字段约束 | `work_inbox_item_return_fields`；retract 是否清空 `return_*` |
| 水位不对 | `getLatestWorkInboxItem` 与 `countWorkInboxItems` |

## 取证

```bash
# 定向
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-inbox.integration.spec.ts

# 门禁
pnpm check
pnpm test:integration

# 合入前敏感扫描
scripts/secret-scan.sh .
```

本切片实测（2026-11-02）：

- Q0：`211` 个测试文件 / `2269` 条通过；work 边界静态测试 `1` 条通过。
- Q2：`86` 个测试文件 / `726` 条通过；定向 inbox `9` 条通过。
- 单点变异 `M1–M18` 全部 RED（见下）。

## 变异自证

每次只改一处生产代码，跑定向 inbox 用例，必须变红后恢复。

| # | 变异 | 被哪条判据抓住 |
|---|---|---|
| M1 | 去掉关联的 assignee 校验 | 非 assignee 403 |
| M2 | 去掉 active work 校验 | 退休工作拒绝关联 |
| M3 | 去掉 Task 终态校验 | 终态优先 `TASK_TERMINAL` |
| M4 | 去掉来源可接收校验 | instruction 409 `already_directed` |
| M5 | 去掉同一身份幂等回读 | 重复关联仍只有一行 |
| M6 | 去掉新版本 supersede | 旧 pending 变 `superseded` |
| M7 | 退回不写原因/备注 | 退回视图字段 |
| M8 | 退回不校验起点状态 | `retracted/expired` 上退回必须 409 |
| M9 | 撤权不校验起点状态 | `expired` 上撤权必须 409 |
| M10 | 过期不校验起点状态 | `returned` 上过期必须 409 |
| M11 | 幂等重放不回读最新状态 | 重放显示 `retracted` 而非缓存 pending |
| M12 | 列表忽略 status 过滤 | `?status=returned` 为空 |
| M13 | `pendingCount` 恒为 0 | 水位断言 |
| M14 | 新条目不写 `supersedes_id` | 版本链断言 |
| M15 | `body_digest` 复用 `source_digest` | 快照摘要必须独立 |
| M16 | 接受异 Task 消息 | 跨 Task 来源必须拒绝 |
| M17 | 接受另一工作的 itemId | 错 work 操作必须 404 |
| M18 | 撤权不清退回字段 | DB 约束/撤权响应字段 |

## 边界与未覆盖

- **显式关联不检查 Mandate**：本切片不派发，收件箱是人可先放入的私有容器；#490 交付前必须重新检查 active work、Mandate、来源类型、Agent/工具与实时权限。不得把“在收件箱里”当成已授权派发。
- **退休不批量迁移 pending**：工作退休后旧 pending 保留，需人显式收口；#490 不得向非 active work 交付 pending。后续可在退休命令里追加批量 `expired/retracted`，但需要单独定义语义。
- **来源权限代次是常量**：内部来源写 `member`/`internal`；真实外部来源的修订/撤权代次仍由 PC-02/ADR-0024 链复核，RD-03 派发前必须重验。
- **body 上限是防御性检查**：Task 消息正文上限 10k 字符、context entry 上限 64KiB 字节，生产路径目前产生不了超过收件箱 64KiB 的来源；该分支无 HTTP 可复现用例。
- **标题截断无 HTTP 可复现用例**：实现按码点截断到 200 字符，空标题回退到来源 kind；当前生产投影的标题远小于上限，因此该防御分支只有代码审查、没有递增用例。
- **无游标分页**：只有 `limit<=100`；条目很多时靠状态过滤和客户端水位增量，游标留给 #490/后续。
- **无交付/消费字段**：delivered/unconfirmed/consumed、交付尝试、Run 清单、Node/Runtime 读取与回执全部未做（#490）。
- **无订阅快路径/自动派工**：本切片没有事件订阅、模型 Router、Runtime 调用或 Run 创建；`autoDispatch=existing_task` 仍不会被消费（#485/#486）。
- **未做并发压测**：只验证两个并发关联收敛为一行；大量并发/跨工作争用未做。

## 复跑

```bash
# 干净环境（需 Docker）
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-inbox.integration.spec.ts
pnpm check
pnpm test:integration
```

迁移为 `packages/db/migrations/0025_work_inbox_items.sql`；本地库若在开发中间态应用过改名前的版本，按既有约定 reset 测试库后再跑 Q2。
