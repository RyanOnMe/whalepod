# cancel 竞态与 followup 中断边界验收（#353）

- 对应场景/门禁：Q3（DSH 契约门，`pnpm test:dsh-contract`）——能力「中断模式（cancel）」的
  竞态面、followup 中断边界，以及审批悬置时的取消
- 对应 Issue：#353（#289 的第四项余项）；同批新开 **#365**（撞车时的 Hub 侧结局）、
  **#366**（resume 续跑中取消）、**#363**（harness 时序接缝）
- 上次验证：2026-10-16 · `fix/p1-353-cancel-race-boundary` · 结果 PASS

## 验的是哪条用户路径

用户对正在执行的 Run 按**取消**，要的是「停下来，状态如实」。四种真实时刻：

1. **模型还在流式输出时按取消**——Run 以 `run.cancelled` 收场、之后不得再冒出
   `run.completed`（协议上两个终态帧互斥），会话收敛回 idle；
2. **取消与这一轮收尾同时发生**（模型恰好答完、结算还在飞）——只能有一个终态。**Runtime
   层**的契约：已完成的那一轮成立（`run.completed`），取消不补一条 `run.cancelled`、也不
   得打成 fatal，且这次取消不得毒化会话（为续跑保留可继续的会话）。**注意产品层的结局不
   同**：取消请求先落 `cancel_requested` 时，这条已完成事件会让 Run 收敛为
   `failed(INVALID_RUN_TRANSITION)`（见下节「边界」与 #365）；
3. **取消时已经追了一条新指令**（followup 已入队）——中断必须把它一起中止：不得在取消后
   偷偷执行它，也不得因此 fatal；且这条「移除」要落进会话日志（否则续跑会把它复活）；
4. **工具在等审批时取消**（`approval.requested` 悬置中）——这是用户最可能按取消的时刻：
   该工具不得执行，终态唯一，取消后才到的 `approval.decide` 必须被静默丢弃并留归因。

## 驱动（怎么触发）

```bash
pnpm test:dsh-contract
# 单跑本文件（约 1.5s）：
pnpm exec vitest run --project dsh-contract \
  packages/runtime-dsh/tests/dsh-contract/cancel-race.contract.spec.ts
```

驱动走与 Node 完全相同的命令入口（`initializeCommand` / `commandFrame('run.cancel'|'run.followup'|'approval.decide')`
→ `dispatchRuntimeCommand`），Runtime 是 DSH replay overlay 的真装配（fixtures：`cancel` 的
`hang` 条目 = 流到一半永远挂起；`basic` = 正常答完；`tool-approval` = 工具调用先过审批）。

## 观测（看什么）

- **终态帧**：`run.cancelled` / `run.completed` / `runtime.fatal`（桥对 `turn/end` 的映射）；
- **会话事件**：`turn/start`、`turn/end`（`reason` 必须是 `aborted`/`completed`）、
  `agent/inbox/spliced`（入队与**移除**都在这里：`target: next-turn` = 排队成 follow-up
  turn；`next-step` = 插进当前步的 steer；移除记录带 `outcome: canceled` + `removedCount`）；
- **状态帧**：`agent.status` 的 `running`/`idle`（收敛信号）；
- **桥日志**（`runtime.logs`，stderr 通道）：迟到的 `approval.decide` 的归因行。

## 判定（成功长什么样）

四条判据（`packages/runtime-dsh/tests/dsh-contract/cancel-race.contract.spec.ts`）：

| # | 场景 | 断言要点 |
|---|---|---|
| ① | 流式中取消 | 同步点等 **hang 前缀内容帧**（`assistant/chunk` 带 `partial`）→ cancel → 等 `run.cancelled` + `agent.status: idle`（收敛屏障）→ 采样窗后清总账：恰 1 `turn/start`、恰 1 `turn/end(aborted)`、恰 1 `run.cancelled`、0 `run.completed`、0 `runtime.fatal`。**相对既有判据（`agent-control.contract.spec.ts`，它已有 idle 屏障）的净增量**：内容帧同步点 + 数量不变量与 fatal 检查（重复终态帧会被抓住） |
| ② | 取消与收尾撞车 | 等 `turn/end(completed)` 帧后立即送 cancel；**送出前当场自检窗口存在**（尚无 `run.completed`、最后一条状态是 `running`——链路将来多一个 await 把 cancel 滑到终态之后时，这里会红而不是静默退化）→ completed 成立、0 `run.cancelled`、0 fatal、恰 1 turn；**正控**：随后 followup 照常起第二 turn（取消不给后续工作上闩 ⟹ 续跑可继续；同 runId 的第二条 run.completed 在产品里无害——Node 收首个终态帧即 finalize，之后 stdout 行被丢弃） |
| ③ | 中断边界的 followup | 流式中先入队 followup、再 cancel → 恰 1 aborted turn、恰 1 `run.cancelled`、0 completed、0 fatal；并以 spliced 记录钉两件持久事实：**入队**是 `next-turn`（不是 `next-step` 插话）、**移除**在入队之后且带 `outcome: canceled`（续跑不复活已取消指令的防线） |
| ④ | 审批悬置时取消 | `approval.requested` 后 cancel → 恰 1 aborted turn、恰 1 `run.cancelled`、0 completed、0 fatal、**0 `artifact.candidate`**（放行不得执行工具）；随后**迟到**的 `approval.decide` 被静默丢弃（零执行 + 桥日志有 `approval decide ignored` 归因） |

**变异自证**（每条都实测「改坏即红、还原即绿」）：

| 变异 | 红在哪 |
|---|---|
| `bridge.ts` 的 `turnSettled` 加「cancel 胜出」（收尾窗口内的 completed 改判 cancelled） | **只有 ②**（`run.completed` 不来）；①③ 走 aborted 路径不受影响 |
| `bridge.ts` 的 aborted → 改判 completed（终态映射写反） | ①③ 红（0 cancelled / 多 completed） |
| `session-owner.ts` 的 `followup` 改用 vendor 的 `steer`（插话进当前步） | ③ 红（spliced 的 target 变 `next-step`） |
| `session-owner.ts` 的 `cancel` 传 `keepInbox`（vendor 的替代语义：保留排队项） | ③ 红（**移除记录缺席**——本进程帧面结果不变，但会话日志少那条 `outcome: canceled`，续跑会复活该指令） |
| 去掉「无第二串 turn」的屏障（取消后重放排队项，模拟「取消后仍执行」） | ③ 红（第二串 turn/end → 脚本耗尽 → fatal 现形） |
| `approval-port.ts` 去掉 `signal.abort → settle('cancelled')` 的收回（取消不处理挂起审批） | ④ 红（**归因那条**先红：迟到的 decide 被受理 ⟹ 无 `approval decide ignored`；`artifact.candidate` 仍为 0——vendor 的工具执行器在已 abort 的 stage 上不派发工具，所以「工具不得执行」这半边由 vendor 兜底、不敏感） |

稳定性：本文件连跑 10 次全绿（约 1.4–2.0s/次）。②的窗口由**构造**保证而非 sleep：
`until(turn/end)` 返回后测试续体是微任务，而 `SessionOwner` 的 settle 链要 `await whenIdle()`
+ `flush()` 才发帧（评审 A 用仪表化实测过：cancel 送出时 `run.completed` 尚未出现、最后一条
状态是 `running`）；且窗口存在性已作为断言写进用例。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| 出了两条终态帧（completed + cancelled） | `packages/runtime-dsh/src/bridge.ts` 的 `turnSettled` 映射（每次 `turn/end` 恰好一帧；跨两个 turn 才会有两帧） |
| 取消后没有任何终态帧 | `SessionOwner.cancel` 是否真调用 `agent.cancel`；`deliverSessionEvent` 的 `queueSettle`/`settle` 链是否被 idle 屏障卡住 |
| 取消后多出第二串 turn | followup 的入队语义（`session-owner.ts` 的 `followup` 用 `agent.followup` 而不是 `steer`）+ vendor 的 inbox 语义 |
| `runtime.fatal` 且 summary 含 `script exhausted` | 第二串 turn 真的开跑了（replay fixture 只有一个脚本条目）——与上一条同源 |
| 审批悬置取消后仍出现 `artifact.candidate` | `approval-port.ts` 的 abort 收回（`req.signal` 的 `cancelled` settle）是否还在；工具是否把「已取消」当成放行 |
| 取消后迟到的 `approval.decide` 被受理（日志里没有 `approval decide ignored` 归因） | 同上——**实测更常先看到的是这一条**：vendor 的工具执行器在 stage signal 已 abort 时不会真派发工具，所以「工具没执行」可能由 vendor 兜住，而「决定被受理/无归因」直接指向 abort 收回缺失 |

## 边界与未覆盖

- **②只是 Runtime 层契约，产品层结局是另一回事（#365）**：完整链路上，取消请求先落
  `cancel_requested` 时，这条「已完成」事件会让 Hub 按 03 §3.2 收敛为
  `failed(INVALID_RUN_TRANSITION)`（outbox 250ms 轮询 vs 完成事件即时推送 ⟹ 该窗口里
  取消点击必然先提交）——**用户看到「模型答完了，Run 显示失败」**。该行为已有 Hub 判据
  （`apps/hub/tests/run-transition-violation.integration.spec.ts`）。「加域表边（取消来晚
  ⟹ 完成胜出）」是 ADR/域表级决定，单独立账 #365，本 PR 不改产品语义。
- **「收尾窗口正中」的撞车做不出确定性判定**（#363）：replay harness 只能表达「每帧内容」
  ——没有 per-frame delay，全局 `paceMs` 被 vendor 明说「tests must not depend on it」，
  `hang` 的 `readyFile` 只能复现「流中挂起」这一侧。所以①钉窗口左侧、②钉右侧（进程内微任务
  序确定性），正中间那一格如实记账。#363 的验收判据需按「能外部释放后正常完成的 gate 条目」
  重写（原「生成 hang+readyFile」的写法关不掉缺口：vendor 只允许 `readyFile` 出现在 `hang`
  上，而 hang 的等待只 reject、永不 resolve）。
- **进程边界（真子进程）上的同一交错未覆盖**：`apps/runtime/tests/dsh-contract/stdio.contract.spec.ts`
  虽然按用例 spawn 并自带 fixture 环境（加一个 override 变量是一行），但它的 `until()` 只按
  **帧类型**匹配、没有谓词同步点，跨进程又放大时序噪声——不是通道缺失，是同步面不够。本条
  判据全在进程内 harness。
- **机制层（inbox 是否被 clear）不钉，只钉结果 + 会话日志**：判据钉「不执行、不 fatal、
  收敛到 idle、且日志留下 `outcome: canceled` 的移除记录」。为什么不够：vendor 在 abort 后
  直接抛出，所以 `inbox.clear()` 与「驱动终止」在**本进程帧面**上等价（实测 `keepInbox`
  也不改变帧面结果）；真正区分两者的是**持久日志**（`Inbox` 在 persisted load 时重放全部
  splice）——那正是③的新断言覆盖的面，勿再把它读成「旋钮无所谓」。
- **`error`（模型抛错）边界下的 followup 未判**：需要新增 `throw` fixture（现有 8 个 fixture
  无一含 throw）。它的结果与③同源（abort/error 后驱动抛出 ⟹ inbox 不被消费），收益不抵
  fixture 成本；且在**产品链路**上只有窄窗：Node 的 followup 守卫是 check-then-act，首个终态
  帧到达 finalize 之前并发进来的追问会通过守卫（随后 Runtime 被 shutdown）；Hub 侧只清扫
  仍 `pending` 的指令（已 `accepted` 的在途追问是**有意**不扫的，见
  `docs/agent/instruction-path-acceptance.md`）。要钉先定「error 后 followup 必须拒绝还是
  允许续 turn」的产品口径。
- **两条判定不值当、只记账的形态**：多次连续取消（Hub 侧幂等 `cancel.ts` + Node 重复 ack
  回放 `run-manager.ts` 已覆盖）；取消确认后才到的 followup（Hub 在 `cancel_requested` 当场
  拒，`apps/hub/tests/followup.integration.spec.ts` 已判）。**另立账一项**：resume 续跑中
  取消（#366）——③的移除记录判据是它的前置，但「取消 → 真的 resume 一次」的端到端判据未做。
- **判别力的口径**：①②的「无第二串 turn」在各自场景内不是主承力面（没有产生第二串的机制），
  它的价值在③（followup 已入队时才有判别力）；采样窗（200ms）按当前实现没有已知帧源能在
  settle 之后发帧，属兜底采样——这两点按评审意见如实写明，避免高估。

## 复跑

```bash
pnpm test:dsh-contract
```

（Q3 全量 17 个文件 / 67 例；本文件 4 例。）
