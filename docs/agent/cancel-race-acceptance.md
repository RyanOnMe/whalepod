# cancel 竞态与 followup 中断边界验收（#353）

- 对应场景/门禁：Q3（DSH 契约门，`pnpm test:dsh-contract`）——能力「中断模式（cancel）」的
  竞态面与 followup 中断边界
- 对应 Issue：#353（#289 的第四项余项；立账原因见
  [runtime-capability-contract](./runtime-capability-contract.md) 的覆盖状态列与第五节）
- 上次验证：2026-10-16 · `fix/p1-353-cancel-race-boundary` · 结果 PASS

## 验的是哪条用户路径

用户在 Task Room 里对正在执行的 Run 按**取消**：他要的是「停下来，状态如实」。三种真实交错：

1. **模型还在流式输出时按取消**——Run 必须以 `run.cancelled` 收场、之后不得再冒出
   `run.completed`（协议上两个终态帧互斥），会话收敛回 idle；
2. **取消与这一轮收尾同时发生**（模型恰好答完、结算还在飞）——用户按下取消的同一瞬间
   Run 已完成：此时**只能有一个终态**。当前契约：已完成的那一轮成立（`run.completed`），
   取消**不再补一条** `run.cancelled`（也绝不允许两条都出），且这次取消不得毒化会话
   （用户随后追问仍要能正常起下一轮）；
3. **取消时已经追了一条新指令**（followup 已入队）——中断必须把它一起中止：不得在取消后
   偷偷执行它（用户会看到「我明明取消了，它又跑了一轮」），也不得因此把 Run 打成 fatal。

## 驱动（怎么触发）

```bash
pnpm test:dsh-contract
# 单跑本文件（约 1.5s）：
pnpm exec vitest run --project dsh-contract \
  packages/runtime-dsh/tests/dsh-contract/cancel-race.contract.spec.ts
```

驱动走与 Node 完全相同的命令入口（`initializeCommand` / `commandFrame('run.cancel'|'run.followup')`
→ `dispatchRuntimeCommand`），Runtime 是 DSH replay overlay 的真装配（fixtures `cancel` 的
`hang` 条目 = 流到一半永远挂起；`basic` = 正常答完）。

## 观测（看什么）

- **终态帧**：`run.cancelled` / `run.completed` / `runtime.fatal`（桥对 `turn/end` 的映射）；
- **会话事件**：`turn/start`、`turn/end`（`reason` 必须是 `aborted`/`completed`）、
  `agent/inbox/spliced`（**入队语义**在这里可见：`target: next-turn` = 下一个 turn 的追问，
  `next-step` = 插进当前步的 steer）；
- **状态帧**：`agent.status` 的 `running`/`idle`（收敛信号）。

## 判定（成功长什么样）

三条判据（`packages/runtime-dsh/tests/dsh-contract/cancel-race.contract.spec.ts`）：

| # | 场景 | 断言要点 |
|---|---|---|
| ① | 流式中取消 | 同步点等 **hang 前缀内容帧**（`assistant/chunk` 带 `partial`，比 `agent.status: running` 强——那时流可能还没到挂起点）→ cancel → 等 `run.cancelled` 与 `agent.status: idle`（**收敛屏障**）→ 静默窗后清总账：恰 1 `turn/start`、恰 1 `turn/end`（reason aborted）、恰 1 `run.cancelled`、0 `run.completed`、0 `runtime.fatal` |
| ② | 取消与收尾撞车 | 等 `turn/end`（completed）帧出现（= 收尾已提交、settle 链必在飞）后**立即**送 cancel → `run.completed` 成立、0 `run.cancelled`、0 fatal、恰 1 turn；**正控**：随后 followup 照常起第二 turn 并收敛（取消不毒化会话） |
| ③ | 中断边界的 followup | 流式中先入队 followup、再 cancel → 恰 1 aborted turn、恰 1 `run.cancelled`、0 `run.completed`、0 fatal；并以 `agent/inbox/spliced` 钉住「followup 是 `next-turn` 入队，不是 `next-step` 插话」 |

**变异自证**（每条都实测过「改坏即红、还原即绿」）：

| 变异 | 红在哪 |
|---|---|
| `bridge.ts` 的 `turnSettled` 加「cancel 胜出」：收尾窗口内的 completed 改判 cancelled | 三条全红（②正是为它立的） |
| `bridge.ts` 的 aborted → 改判 completed（终态映射写反） | ①③ 红（0 cancelled / 多 completed） |
| `session-owner.ts` 的 `followup` 改用 vendor 的 `steer`（插话进当前步） | ③ 红（spliced 的 target 变 `next-step`） |
| 去掉任何一条「无第二串 turn」屏障（例如把 followup 从入队改成 cancel 后重放） | ③ 红（第二串 turn/end 或 fatal 现形） |

②的窗口由**构造**保证而非 sleep：`until(turn/end)` 返回后测试续体是微任务，而
`SessionOwner` 的 settle 链要 `await whenIdle()` + `flush()` 才发帧——cancel 必落在窗口内。
稳定性：本文件连跑 10 次全绿（1470ms/次量级）。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| 出了两条终态帧（completed + cancelled） | `packages/runtime-dsh/src/bridge.ts` 的 `turnSettled` 映射（每次 `turn/end` 恰好一帧；跨两个 turn 才会有两帧） |
| 取消后没有任何终态帧 | `SessionOwner.cancel` 是否真调用 `agent.cancel`；`deliverSessionEvent` 的 `queueSettle`/`settle` 链是否被 idle 屏障卡住 |
| 取消后多出第二串 turn | followup 的入队语义（`session-owner.ts` 的 `followup` 用的是 `agent.followup` 而不是 `steer`）+ vendor 的 inbox 语义（`inbox.clear()` / abort 后驱动抛出） |
| `runtime.fatal` 冒出来且 summary 含 `script exhausted` | 第二串 turn 真的开跑了（replay fixture 只有一个脚本条目）——与上一条同源 |

## 边界与未覆盖

- **「窗口正中」的撞车做不出确定性判定**（已立账 **#363**）：replay harness 只能表达「每帧内容」
  ——没有 per-frame delay，全局 `paceMs` 被 vendor 明说「tests must not depend on it」，`hang` 的
  `readyFile` 未被 harness 接出。所以「cancel 恰好落在 finish chunk 与 turn/end 之间」这一格
  两侧都可控的时序构造不出来。①钉窗口左侧、②钉右侧（进程内微任务序确定性保证），**正中间那
  一格如实记为未覆盖**，靠 #363 的 harness 接缝补。
- **进程边界（真子进程）上的同一交错未覆盖**：`apps/runtime/tests/dsh-contract/stdio.contract.spec.ts`
  没有 `DSH_SNAPSHOT_OVERRIDE` 之类的通道，无法按用例切 fixture；本条判据全在进程内 harness。
- **机制层（inbox 是否被 clear）不钉**：判据钉的是结果（不执行、不 fatal、收敛到 idle）。实测
  把 `SessionOwner.cancel` 改成 `keepInbox` 语义（vendor 的替代旋钮）在 abort 路径下**结果不变**
  （abort 后驱动直接抛出）——所以该旋钮对判据不敏感是事实记账，不是遗漏。
- **`error`（模型抛错）边界下的 followup 未判**：需要一个 `throw` fixture（现有 8 个 fixture 无
  一含 throw），且该形态在生产链路上不可达——Node 收到首个终态帧（fatal）即 finalize 并
  `runtime.shutdown`，在途追问由 Hub 落 `rejected(run_terminal)`（ADR-0009 决策 5），Hub/Node 侧
  的 `INVALID_RUN_TRANSITION` 判据已有（`apps/node/tests/run-manager.spec.ts`）。故本轮不新增
  fixture；若将来要钉，先定「error 后 followup 必须拒绝还是允许续 turn」的产品口径。
- **Hub/Node 层的迟到 cancel 未判**：Run 终态后再来的 `run.cancel` 走的是
  `INVALID_RUN_TRANSITION`（Node）/ 404（Hub）既有面，不是运行时竞态。

## 复跑

```bash
pnpm test:dsh-contract
```

（Q3 全量约 16 个 spec；本文件 3 例。）
