# 指令路径（追问受理 → 命令入队 → ack 结算）验收（#186 · ADR-0009 切片③b）

- 对应门禁：Q2 数据门（`apps/hub/tests/followup.integration.spec.ts` 15 条 + `apps/hub/tests/followup-route.integration.spec.ts` 6 条 HTTP 契约 + `packages/db/tests/outbox.integration.spec.ts` 的时钟用例）+ Q0
- 对应 Issue：#186（决策 3/5 的 Hub 半场；切片② 已铺好下行帧与 Node 侧受理）
- 上次验证：2026-09-11 · `feat/p1-186-hub-instruction-path` · 结果 PASS（命令层 15 + 路由层 6 + outbox 时钟 1）

## 验的是哪条用户路径

责任人在线程里对**正在跑的 Run** 说一句话：Hub 受理 → 落一条带状态的线程消息 + 把
`run.followup` 命令写进 outbox → Node 受理并回报 → 消息状态收敛（受理成功 / 被拒 + 理由）。

## 驱动（怎么触发）

真 PostgreSQL + 真迁移链（含 0004），走 Hub 命令层 `sendRunFollowup` 与真 worker 派发、
真协议校验（帧过 `NodeDownstreamSchema`）、真 ack 上行经 `orchestrator.ingestNodeEvent`。

```bash
npx tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/followup.integration.spec.ts --testTimeout=30000
```

> `--testTimeout=30000` 仅用于本机高负载（本机负载常 15+，默认 5s 会被拖爆，见「已知项」）。

## 观测（看什么）

`task_message` 的 `instruction_state` / `instruction_error_code` / `instruction_error_message`；
`dispatch_outbox` 的 `type` / `payload` / `message_id` / `acked_at`；`team_event`；
以及派发出去的帧本身（过协议 schema 后的形态）。

## 判定（10 条用例）

### 命令层（`followup.integration.spec.ts`，15 条）

| 用例 | 断言 | 结果 |
|---|---|---|
| running 受理全程 | 消息 `pending` → 命令入队（载荷**恰好** `{commandId, runId, text}`，`message_id` 指回消息）→ 派发帧过 schema → ack 后消息 `accepted`、outbox 落 `acked_at` | PASS |
| ack 未回前 | 消息仍 `pending`（受理 ≠ 送达，决策 3 的语义强度） | PASS |
| **受理集合逐状态钉死**（5 条） | `queued` / `dispatching` / `running` / `waiting_approval` → `pending` + 1 条命令；`cancel_requested` → `rejected(RUN_CANCELLING)` + **0 条命令** | PASS |
| 终态 Run | **不受理**：消息 `rejected(RUN_TERMINAL)` + 理由含状态名，且**零命令入队** | PASS |
| **终态清扫** | Run 进终态时该 Run 上仍 `pending` 的追问被同事务清扫成 `rejected(RUN_TERMINAL)`（Node 可能永远不回 ack） | PASS |
| Node 拒绝 ack | 消息 `rejected`，理由来自 Node 的错误码（`RUNTIME_LOST` 原文），不冒充受理成功 | PASS |
| 重复 ack 重放 | 只结算一次，状态不被二次改写 | PASS |
| 同 Idempotency-Key | 不产生第二条消息、不二次入队 | PASS |
| 非责任人 | `FORBIDDEN`，且线程与 outbox 都**零行**（本片不放宽授权） | PASS |
| 未知 Run / 空文本 / 缺幂等键 | `NOT_FOUND` / `VALIDATION_FAILED`，不落库 | PASS |
| 受理状态变化 | 写进 `team_event`（UI 靠它刷新线程） | PASS |

### 路由层（`followup-route.integration.spec.ts`，6 条 HTTP 契约）

| 用例 | 断言 | 结果 |
|---|---|---|
| 缺 Idempotency-Key | 400 `VALIDATION_FAILED` | PASS |
| 空文本 / 超长文本（>20 000） | 400 `VALIDATION_FAILED`——**不是 500**（评审阻断 1 的回归判据：`.parse()` 抛的 ZodError 会被本路由的 catch 误映射成 `INTERNAL_ERROR`） | PASS |
| 未知 Run | 404 `NOT_FOUND` | PASS |
| running 受理 | 201 + `pending` 消息 | PASS |
| 被 Hub 拒 | **仍 201** + `rejected(RUN_TERMINAL)` 消息 | PASS |

### 数据层（`packages/db/tests/`）

| 用例 | 断言 | 结果 |
|---|---|---|
| `settleInstruction` 收敛守卫 | 只从 `pending` 收敛，二次结算返回 undefined 且不改写（变异判据：删守卫即红） | PASS |
| `task_message` 约束 | 讨论不驱动 / 指令必带 Agent 与状态 / 追问挂既有 Run / **受理成功必有 Run** / 理由只在 rejected / 线程排序 | PASS |
| **outbox 时钟** | 未给 `notBefore` 时 `next_attempt_at` = Outbox 的（假）时钟且同刻可 claim（可失败判据，见下） | PASS |

## 归因（失败先看哪层）

- **命令一条都没派发** → 先看帧是否过 `NodeDownstreamSchema`：worker 对校验失败的行直接
  `fail`（permanent），行会静默躺在表里。**载荷字段必须与 wire 帧逐字一致**（`run.followup`
  少了 `commandId` 就是这个坑，本片实测踩到过）。
- **命令永远不可 claim** → `next_attempt_at` 用了 DB 默认 `now()` 而 worker 用注入时钟：
  `enqueue` 现在缺省写 `this.nowFn()`（未给 `notBefore` = 立即可投）。
- **消息停在 pending** → 看 ack 是否真上行（fake gateway 的 `drainUpstream` 要喂给
  `ingestNodeEvent`），以及 `dispatch_outbox.message_id` 是否为空（空则不结算，直接 return）。
- **状态被改成别的** → `settleInstruction` 只从 `pending` 收敛，终态不二次改写。

## 未覆盖与已知项

- **路由层已补**（`followup-route.integration.spec.ts`，评审要求）：device/workspace 直接按外键
  关系铺行，不真配对（配对链另有 spec）；真配对的端到端仍归切片⑥ 的 Q5。
- **`queued`/`dispatching` 的「排队」只在 Hub 侧成立**：「Node 收到后会不会先跑完首轮再读追问」
  属 Node/Runtime 行为，本片只验 Hub 落了 pending 且命令按同一条 outbox 保序；端到端待 Q5/Q6。
- **「指令在无活跃 Run 时自动起 Run」不在本片**：需要 `runs.trigger_message_id` 与自动触发
  降级规则（切片③c/⑦）。今天这类请求会被判「非活跃状态」而落 `rejected`——**不会**静默排队。
- **`accepted=true` 仍不保证模型读到**：只到「Node 写进在管进程的 stdin」（切片② 的登记），
  「模型确实收到追问」待切片⑥ 的 Q5/Q6 覆盖。
- **本机高负载**：默认 5s 用例超时在本机负载 15+ 时会被拖爆（`main` 上同样复现），本地须用
  `--testTimeout=30000`；CI 用默认值。
- **`instruction_error_code` 里有两套词表**（wire ErrorCode 透传 + Hub 理由标签 `RUN_TERMINAL` /
  `RUN_CANCELLING`）：已在 `03` §2.2 写明；若将来要机器分派，需要一张显式词表而不是靠字符串猜。
- **`comment.created` 事件名未改**：与 `task_message` 实体名不一致，改名归切片③c（与 UI 一起）。
- **`origin='auto_assignment'` 的自动指令路径未实现**：本片只有人发指令。

## 变异验证（证明用例有牙）

| 变异 | 期望 | 结果 |
|---|---|---|
| 受理集合收窄成只剩 `running` | `waiting_approval` 等用例变红 | ✅ 变红 |
| 受理集合放宽到 `+cancel_requested` | 必须变红 | ✅ 变红（**整改前**该变异 10 条全绿——`cancel_requested` 无覆盖，评审抓出） |
| 删掉 `settleInstruction` 的 `pending` 守卫 | 必须变红 | ✅ 变红（**整改前**集成层测不到：重复 ack 被 `ackInTransaction` 先挡住，故补了直接调用的数据层用例） |
| 命令载荷删掉 `commandId` | 必须变红 | ✅ 变红（worker 的 `NodeDownstreamSchema` 校验失败 → 行被标 permanent fail） |
| `enqueue` 改回不写 `nextAttemptAt` | outbox 时钟用例变红 | ✅ 变红（**整改前**该修复无用例） |
| 路由改回 `.parse()` | 空文本/超长文本用例变红（500 而非 400） | ✅ 变红 |
