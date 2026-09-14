# 指令排队与补发验收（P1-192 / 切片③c-1）

- 对应门禁：Q0（静态）+ Q2（真实 PostgreSQL 集成）
- 对应 Issue：#189（缺陷）、#192（本片）
- 上次验证：2026-09-11 · `fix/p1-192-hub-instruction-queue` · 结果 PASS

## 验的是哪条链路

Run 还没到 `running` 时，人在线程里接着说一句话，Hub 怎么处理：

**驱动**：走真人路径——`sendRunFollowup`（与 `POST /runs/:id/followup` 同一条服务函数）+ 喂
`run.event` 上行帧（`runtime.ready` / `approval.requested` / `approval.decided`）推进状态机。
不开测试专用近道，不直接改 Run 状态来模拟迁移（除前置摆位）。

**为什么必须有这条链**：#189 实测——③b 把「排队」实现成了「消息标 `pending` 但命令立刻入队」，
而 Node 在 Run 未到 `runtime.ready` 时会以 `INVALID_RUN_TRANSITION` 拒绝
（真守卫在 `apps/node/src/run/run-manager.ts:481-484`；`:392` 只是解释该守则的注释）→ 消息经 ack 结算被写成 `rejected`，
与 ADR-0009 决策 5「接着说永远成立」相反。

## 判定（9 条机器判据，`apps/hub/tests/instruction-queue.integration.spec.ts`）

| 判据 | 断言 | 结果 |
|---|---|---|
| 排队窗口不下发 | `queued` / `dispatching` / `waiting_approval` 三状态受理后消息 `pending`、outbox 里 **0 条** `run.followup` | PASS |
| 进 running 按序补发 | 两条排队追问 → `runtime.ready` 后恰好 2 条命令，顺序 = `(created_at, id)` = 线程顺序 | PASS |
| 载荷即 wire 帧 | 每条命令载荷**恰好** `{commandId, runId, text}`，`messageId` 落在 outbox 行 | PASS |
| 入队≠受理 | 补发后消息仍 `pending`，由 ack 决定命运 | PASS |
| **真人路径** | 审批窗口排队 → **HTTP 决策**（`decideApproval`）通过 → 补齐下发，旧命令 id 不变 | PASS |
| **reconciler 探活路径** | `run.snapshot` 把 `dispatching → running` 时同样放行排队指令 | PASS |
| **审批过期清扫路径** | `expireApprovals` 让 `waiting_approval → running` 时同样放行 | PASS |
| 终态不吊死 | 排队期间 Run 进终态 → 清扫成 `rejected(RUN_TERMINAL)`，且始终没下发过 | PASS |
| 顺序契约 | 按 `(created_at, id)` 补发——含**同 created_at** 时按 id 升序（次级键） | PASS |

Node 侧的 not-ready 守卫**不在本文件验**：它由 `FakeDeviceGateway.refuseCommand` 的 4 条单测覆盖
（`packages/testkit/tests/fake-device-gateway.spec.ts`）——该缝对所有帧生效，接进本文件会把正常
链路的 `run.start` 也拒掉（首版曾放了一个从未接线的 `refuseUnlessRunning`，已删）。

## 变异验证（每条都确认变异已落盘、构建退出码为 0、结束时树还原）

| 变异 | 红 | 归因 |
|---|---|---|
| A 把「未 running 也下发」改回去（=③b 错行为） | **7**（本文件；另有 ③b 验收 3 条同时红，合计 10） | 三条排队窗口 + 顺序 + 幂等 + 终态 + 真人/探活路径（「过期清扫」在 A 下恰好仍绿） |
| B 删掉审批闭环回 running 的补发点 | **1** | 恰是「审批往返」那条（本片首版就漏了这个入口） |
| C 去掉补发里的 `message_id` 幂等判据 | **1** | 恰是「不重复下发」那条 |
| D `decide.ts` 绕过收口（真人路径漏接） | **1** | 恰是「真人路径」那条 |
| E `handleRunSnapshot` 绕过收口 | **1** | 恰是「reconciler 探活路径」那条 |
| F 顺序改 `orderBy(id)` / 删掉 orderBy / 改倒序 | **1 / 1 / 2** | 顺序判据（钉 `(created_at, id)`；首版 id 与 created_at 同向，F 全绿——判据自己错了，已修） |

## 归因（失败先看哪层）

- **命令数不为 0（排队窗口）** → `apps/hub/src/modules/run/followup.ts` 的
  `FOLLOWUP_DISPATCHABLE_STATUSES` / `FOLLOWUP_QUEUEING_STATUSES`；
- **进 running 后没补发** → 检查是不是有人绕过了唯一收口 `apps/hub/src/modules/run/run-status.ts`
  的 `applyRunStatus`（它是**唯一**允许把 Run 写成 `running` 的入口）。Hub 里能写 `running` 的
  路径共 **5 条**：`orchestrator.ts` 的 `runtime.ready`、`approval.decided` 回显、
  `handleRunSnapshot`（reconciler 探活），`decide.ts` 的 HTTP 审批决策（**真人主路径**），
  `approval-expiry.ts` 的过期清扫。首版只接了前两条，而其中「回显」那条生产上基本是死路——
  这才是 B1 的真身；
- **重复下发** → 补发器的 `dispatch_outbox.message_id` 判据；
- **消息被写成 rejected（INVALID_RUN_TRANSITION）** → 说明有路径把未 running 的追向下发了
  （正是本片要根除的形态），或 Node 侧真的还没 ready（真机排查看 `deviceActivity` 与 run 状态）。

## 未覆盖与已知项

- **Node 侧的真实拒绝**只在 fake 里复刻（`refuseCommand`），没有跨进程真 Node 的端到端判据；
  真 Node 的那条守卫由切片②的 Node 测试覆盖（`apps/node/tests`）。
- **补发不保证被模型读到**：`accepted=true` 只说明 Node 收下了这条命令（③b 已登记的残留）。
- **`queued` / `dispatching` 的首轮 `run.start` 仍会先派发**（那是正常链路：Node 收到 start
  才可能 ready）；本片管的是追问。
- **③c-2 未做**：「无活跃 Run 时按指令起 Run」（`runs.trigger_message_id` + 设备/工作区解析）。

## 复跑

```bash
pnpm check
npx tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/instruction-queue.integration.spec.ts apps/hub/tests/followup.integration.spec.ts \
  --testTimeout=30000
```
