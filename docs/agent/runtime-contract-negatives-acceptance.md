# Runtime 契约级负向判据验收（单 Run 隔离 / 指令回执 / 事件流范围）

- 对应场景/门禁：**Q3**（`pnpm test:dsh-contract`，CI check job）；总纲 §工程治理「DSH 熔断」的能力契约面
- 对应 Issue：#289（余项 cancel 竞态/followup 中断边界 → #353）
- 上次验证：2026-10-16 · `35970a7` · **PASS**（实现红绿三段 `673ce00 → 3c3dc9b → eb2b4c1`；评审两轮修复 `5c27cb3` / `8839139` / `d40e70a`，格式 `35970a7`）
- 全量门（同一工作树实测）：Q0（`pnpm check`，含 test:unit + web，1662 passed + 7 expected fail）/Q2（68 文件 491 用例）/Q3（15 spec 52 用例）/Q5（`pnpm test:e2e` 1 passed 30.5s exit 0）/Q6（6 文件 32 用例）/Q7（18 用例 + secret-scan 自检/实扫 + 许可门）/Q9（`pnpm test:compose-smoke` PASS total=62.1s）全绿
- 登记处：覆盖状态列在 [runtime-capability-contract.md](./runtime-capability-contract.md)

## 验的是哪条用户路径

一个 Run 的 Runtime 子进程在收到**不属于自己**的指令、或总线上出现**别的会话/别的 agent** 的事件时，
行为必须可预期：拒绝而不是执行、丢弃而不是转发或结算；以及用户按下发送后指令必须留下回执——两者
都不许静默。对应用户可见后果：别人 Run 的指令串进我的 Run、我的 Run 被别的会话事件提前结算、
指令发出后界面毫无反应（无回执）。

## 驱动（怎么触发）

```bash
pnpm test:dsh-contract   # Q3：三个新探针 + 既有十二个契约 spec 一起跑
```

判据文件（可点开）：

| 判据 | 文件 |
|---|---|
| 单 Run 隔离：跨 Run 的 prompt/followup/cancel/decide/shutdown 显式拒 + 零副作用（正控收敛后清总账）+ 正控 | `packages/runtime-dsh/tests/dsh-contract/single-run-isolation.contract.spec.ts` |
| 指令回执：initialize 前显式拒且零帧、重复 initialize 显式拒且零副作用、受理的 prompt 回执先于结算 | `packages/runtime-dsh/tests/dsh-contract/instruction-receipt.contract.spec.ts` |
| 事件流范围：异会话事件不转发、不结算；异 agent 状态不成帧；本 Run 事件/状态照常、恰好一次 run.completed | `packages/runtime-dsh/tests/dsh-contract/event-stream-scope.contract.spec.ts` |
| 生产闸本体 | `packages/runtime-dsh/src/bridge.ts` 的 `handleCommand`（runId 闸，`runtime.shutdown` 同过闸）、`session-owner.ts` 的 `deliverSessionEvent` / `deliverAgentStatus`（两条范围过滤） |

## 观测（看什么）

- 跨 Run 命令：`ProtocolError('VALIDATION_FAILED', 'command <type> belongs to a different run …')`
  ——探针里表现为 `runtime.send()` 的 rejection；生产上由 Node 侧 supervisor 的按 Run 路由挡在前面，
  这道闸是纵深防御（放行意味着跨 Run 串扰）。拒绝只落 stderr（bin 记 `invalid command frame dropped`），
  不回送 wire 级否定回执——发送方指令会悬置，故纵深防御场景仍需 Node 侧的超时兜底。
- 越界事件：**没有** `session.event` 帧、**没有** `runtime.fatal`、`run.completed` 恰好一次且晚于
  `turn/start`；异会话事件在 `deliverSessionEvent` 的会话过滤处被丢弃（不入帧、不驱动 settle）；
  异 agent 状态在 `deliverAgentStatus` 的 agent 过滤处被丢弃（ready 时刻注入即见零帧）。
- 回执：`turn/start` 出现在 prompt 被受理之后、`run.completed` 之前；initialize 之前的命令零帧。
- shutdown：跨 Run 的 `runtime.shutdown` 同样被拒且本进程未被收敛（后续本 Run 指令照常）；
  本 Run 的 shutdown 收敛后命令一律 `… after runtime shutdown` 显式拒。

## 判定（成功长什么样）

1. 三个探针全绿（隔离 5 用例 + 回执 3 用例 + 范围 1 用例），且**红绿可分**：
   - 红提交 `673ce00`（实现落盘前）实测：单 Run 隔离 3 用例全红（红点正是
     `rejects.toThrow(/different run/)`）、事件流范围红在「注入根本没发生」的接缝未接线断言；
     指令回执 3 用例是**既有行为的钉版**（当时即绿，判据价值在防退化）。
     该红提交自己过不了 tests typecheck（载荷字面量与 wire 联合不符，`eb2b4c1` 修正）。
   - 事件流范围另做**变异自证**（实测，两条过滤各自单点削弱即红）：
     ① `deliverSessionEvent` 的会话过滤改成恒不返回 → `foreign/probe` 泄漏进帧流；
     ② `deliverAgentStatus` 的 agent 过滤改成恒不返回 → ready 时刻就多出 agent.status 帧。
   - 单 Run 隔离的**「先执行后拒绝」变异自证**（实测）：把 `handleCommand` 的 runId 闸
     改成 try/finally——先照常执行命令、最后才抛拒绝（最容易被误判为"有闸"的假绿形态）。
     五个用例全红，且红点全在**屏障**上而不只是 rejection 断言：prompt（拒绝时已有会话
     事件）、followup（3× turn/start）、cancel（turn/end 的中止原因是 `parent` 而非 `user`）、
     approval（`artifact.candidate` 为 0——审批被跨 Run 的拒绝消费）、shutdown（随后的
     正控撞 `after runtime shutdown`）。
2. 正控都在：拒绝之后本桥照常起 turn/收敛；本 Run 的 followup/cancel/shutdown 照常；
   本 Run 的事件与 running→idle 状态照常转发（另有一条**同会话哨兵事件**必须被转发——
   证明注入面是活的、过滤是有选择性的，负向不会因"接缝退化成丢弃一切的桩"而空转）。
3. 零副作用有**屏障**（不是只查拒绝时刻的帧流——那里异步帧还没产出）：prompt/followup
   用例在正控收敛后清总账（turn/结算计数、越界文本）；cancel 判在 turn/end 的中止原因
   （`user` vs 泄漏的 `parent`）而不是 `run.cancelled` 计数；approval 跨 Run 用**真实
   pending callId** 决定并判 `artifact.candidate` 恰好一条（审批若被消费，工具永不发布）。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| Run 收到不属于它的指令并执行 | `bridge.handleCommand` 的 runId 闸是否被绕过（Node 侧应先按 Run 路由）；`node.run` 的 protocolViolation 日志 |
| Run 被别的会话事件提前结算/出现两个 run.completed | `session-owner.deliverSessionEvent` 的会话过滤；`run_event` 表里该 run 的 seq 是否连续 |
| 界面上出现本 Run 不该有的 running/idle | `session-owner.deliverAgentStatus` 的 agent 过滤；多 agent 场景下该 Run 的 agent 注册面 |
| 指令发了没反应（无回执） | Runtime 是否收到 `run.prompt`（Node stdin 转发）→ `session.event` 里有无 `turn/start`；无则看 `runtime.fatal` |
| 探针红了但看不出是哪条 | 三个 spec 各自只断言一件事；范围的红通常带 `foreign/probe`、`unhandled reason kind: max-tokens` 或帧计数信息 |

## 取证

本链路证据是**可复跑用例本身**（Q3，无外部服务）：三个 spec 文件 + 红/绿两段提交 + 变异自证记录
（本文件与提交信息）。变异自证的复跑方法（两条各跑一次，`git checkout --` 复原）：

```bash
# ① 会话过滤：把 packages/runtime-dsh/src/session-owner.ts 里
#    if (String(eventSession.id) !== String(this.session.id)) return  改成 if (false) return
# ② agent 过滤：把同文件
#    if (payload.agent !== this.agent) return                        改成 if (false) return
pnpm exec vitest run --project dsh-contract \
  packages/runtime-dsh/tests/dsh-contract/event-stream-scope.contract.spec.ts   # 两种情况都必红
git checkout -- packages/runtime-dsh/src/session-owner.ts
```

## 边界与未覆盖

- **越界事件的注入面**：探针经 `RuntimeBridgeOptions.probeAfterReady`（探针专用接缝）把合成输入
  **直送生产的订阅处理器**（`RuntimeProbeFace`：`deliverSessionEvent` / `deliverAgentStatus`）。
  试过更"真实"的两条路都不通：① DSH 的 session/event 按会话上下文限定受众（dsh-session 用自己的
  ctx 当 `this` 做范围过滤），兄弟子树的插件发的事件到不了桥的订阅点（三种发射形态哨兵实测全不达）；
  ② 从桥自己的 ctx 发能到达，但同树的其他 DSH 订阅者（`dsh-session-projection`）对畸形会话事件当场
  抛错——那是它们的正确行为，不该由探针引入。代价：本判据覆盖的是「事件被派发到本 Run 订阅面之后」
  的范围语义，**不覆盖总线分发的上下文作用域本身**（那一层由 DSH 拥有）。
- **探针面的能力上限**：拿到 `RuntimeProbeFace` 的探针能伪造本 Run 的帧流（包括越界形态——判据要判的
  就是它）；不能触碰别的 Run、不能写会话日志、不能起 turn。生产路径恒不设置 `probeAfterReady`
  （唯一装配点 `apps/runtime/src/bin.ts`），该面在线上不存在；回调不得抛（抛错会打断启动）。
- **跨 Run 命令闸是纵深防御**：生产路径上 Node 按 Run 路由，正常不会把别的 Run 命令送进本进程；
  探针判的是"万一送到"时的行为，不是路由本身的正确性（路由判据在 Node 单测/集成面）。
  跨 Run 命令被拒后发送方指令**悬置**（无 wire 级否定回执），依赖 Node 侧超时/终态兜底。
- **cancel 竞态与 followup 在中断边界的行为仍无判据**：单独立账 #353（catalog 契约表里已改指）。
  本批的 followup 负向覆盖的是**跨 Run 串扰**，不是 followup 在 interrupt 边界的产品语义。
- 事件流范围的正控依赖 replay fixture（`basic`）：真实模型的 turn 形态差异不在本判据覆盖面内；
  异 agent 状态的负向同理（注入的是合成 agent 身份，覆盖过滤线本身，不覆盖 DSH 的分发作用域）。

## 复跑

```bash
pnpm test:dsh-contract   # Q3：15 spec / 52 用例（含 apps/runtime 两文件 5 条），约 2.5s
pnpm exec vitest run --project dsh-contract \
  packages/runtime-dsh/tests/dsh-contract/single-run-isolation.contract.spec.ts \
  packages/runtime-dsh/tests/dsh-contract/instruction-receipt.contract.spec.ts \
  packages/runtime-dsh/tests/dsh-contract/event-stream-scope.contract.spec.ts
```
