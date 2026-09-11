# 指令路径（追问受理 → 命令入队 → ack 结算）验收（#186 · ADR-0009 切片③b）

- 对应门禁：Q2 数据门（`apps/hub/tests/followup.integration.spec.ts`）+ Q0
- 对应 Issue：#186（决策 3/5 的 Hub 半场；切片② 已铺好下行帧与 Node 侧受理）
- 上次验证：2026-09-11 · `feat/p1-186-hub-instruction-path` · 结果 PASS（10 用例全绿）

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

| 用例 | 断言 | 结果 |
|---|---|---|
| running 受理全程 | 消息 `pending` → 命令入队（载荷**恰好** `{commandId, runId, text}`，`message_id` 指回消息）→ 派发帧过 schema → ack 后消息 `accepted`、outbox 落 `acked_at` | PASS |
| ack 未回前 | 消息仍 `pending`（受理 ≠ 送达，决策 3 的语义强度） | PASS |
| waiting_approval | 受理但排队（入队一条命令，不拒） | PASS |
| 终态 Run | **不受理**：消息 `rejected` + `INVALID_RUN_TRANSITION` + 理由含状态名，且**零命令入队** | PASS |
| Node 拒绝 ack | 消息 `rejected`，理由来自 Node 的错误码（`RUNTIME_LOST` 原文），不冒充受理成功 | PASS |
| 重复 ack 重放 | 只结算一次，状态不被二次改写 | PASS |
| 同 Idempotency-Key | 不产生第二条消息、不二次入队 | PASS |
| 非责任人 | `FORBIDDEN`，且线程与 outbox 都**零行**（本片不放宽授权） | PASS |
| 未知 Run | `NOT_FOUND` | PASS |
| 空文本 / 缺幂等键 | `VALIDATION_FAILED`，不落库 | PASS |
| 受理状态变化 | 写进 `team_event`（UI 靠它刷新线程） | PASS |

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

- **路由层未单测**：HTTP 级 setup 需配对设备 + WS；本次语义在命令层全覆盖，路由只做 actor /
  幂等键 / body 校验与错误映射。端到端覆盖归切片⑥ 的 Q5。
- **「指令在无活跃 Run 时自动起 Run」不在本片**：需要 `runs.trigger_message_id` 与自动触发
  降级规则（切片③c/⑦）。今天这类请求会被判「非活跃状态」而落 `rejected`——**不会**静默排队。
- **`accepted=true` 仍不保证模型读到**：只到「Node 写进在管进程的 stdin」（切片② 的登记），
  「模型确实收到追问」待切片⑥ 的 Q5/Q6 覆盖。
- **本机高负载**：默认 5s 用例超时在本机负载 15+ 时会被拖爆（`main` 上同样复现），本地须用
  `--testTimeout=30000`；CI 用默认值。
- **`comment.created` 事件名未改**：与 `task_message` 实体名不一致，改名归切片③c（与 UI 一起）。
- **`origin='auto_assignment'` 的自动指令路径未实现**：本片只有人发指令。
