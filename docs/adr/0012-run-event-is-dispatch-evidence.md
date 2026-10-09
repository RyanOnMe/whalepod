---
status: accepted
---

# 0012 事件即受理证据：`queued` 收到归属合法的 Run 事件时隐式确认派发

## 背景

派发确认（`queued --dispatch_acked--> dispatching`）由 Node 的 `command.ack` 驱动。但 ack 只是
**一帧上行**：它可以被丢弃（传输/崩溃窗口），而 Node 侧一旦受理命令就会真正把 Runtime 起起来，
并把 `runtime.ready` 等事件上行。此时 Hub 若仍在 `queued`，事件撞 `RUN_NEXT` 表外边，按
ADR-0007 的语义冲突收敛把 Run 记成 `failed(INVALID_RUN_TRANSITION)`——**账本与事实分叉**：
Hub 认为 Run 失败，Node 上 Runtime 仍在跑。

实测（2026-10-09，A0-8 发布取证）：Q5 的 R7 场景（注入「丢掉一次 run.start 的 ack」）在第 3 轮
连跑复现——`cannot apply runtime_ready to a run in queued`。竞态窗取决于「outbox 重发先到」与
「runtime 就绪先到」谁赢：重发先到则 Node 对重复命令回 ack、正常；就绪先到则误判失败。多轮连跑
会把这条暴露成不稳定红。

## 决策

**事件即受理证据**：`command.ack` 是背书（bookkeeping），不是许可（permission）。Hub 处理
归属合法的 `run.event` 时，若目标 Run 仍是 `queued`，先把「受理」这一步按事件所证补上
（应用 `dispatch_acked` → `dispatching` + `run.changed` 广播），再走该事件的正常迁移。

1. **归属仍是最外层门槛**：事件必须来自 `run.deviceId` 对应的设备（既有 `FORBIDDEN` 分支不动）；
   通过归属校验的事件才可能触发隐式确认——不引入新的信任面（设备主人本来就能跑 Runtime）。
2. **不伪造 ack**：outbox 行的 `acked_at` 只由真实 `command.ack` 写；隐式确认**不改**该列。
   重发仍会发生，Node 对重复命令回 ack 后正常闭环（`handleCommandAck` 的 `status !== 'queued'`
   早返回是既有的幂等面）。
3. **终态优先**：`isTerminal` 早返回在隐式确认之前——已取消/已终态的 Run 收迟到事件仍只留证。
4. **applied 语义**：只对 `queued` 补这一步；`dispatching/running/...` 的事件路径一字不改。

## 后果

- 正向：丢 ack 不再把 Run 判死，账本向事实收敛；R7（「只启动一个 Runtime」）由不稳定变为确定；
  「Hub 记 failed 而 Node 在跑」这一分叉形态从根上消失。
- 代价与边界：Hub 在 `queued` 期间可能比 ack 早一步进入 `dispatching`（`run.changed` 会多广播
  一次 dispatching）。观测面：这是**同一事实的更早知晓**，不是新状态；对 UI 无破坏（状态徽标
  只前进一次）。
- 与 ADR-0007 的关系：0007 处理「表外边 → 收敛 + 留证 + 连接保留」；本 ADR 是它的**前置消解**：
  把一类伪冲突（本可由事实消解的 ack 丢失）从"冲突"里摘出去，剩下的才是真冲突。
- 正典回填：03 §3.2 状态图注记；04 的 R7 场景判据不变（本 ADR 让它稳定可判）。
- 弃选：①Node 侧「未 ack 前不上行事件」——把本地事实绑架在 Hub 的记账上，ack 永久丢失时会
  永久扣留事件，且让重发成为唯一恢复路径；②领域表直接加 `queued --runtime_ready--> running`
  ——跳过 `dispatching` 会把两步合成一步，丢「已受理」这个可观测的中间事实。
