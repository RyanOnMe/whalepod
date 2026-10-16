# Runtime 契约级负向判据验收（单 Run 隔离 / 指令回执 / 事件流范围）

- 对应场景/门禁：**Q3**（`pnpm test:dsh-contract`，CI check job）；总纲 §工程治理「DSH 熔断」的能力契约面
- 对应 Issue：#289（余项 cancel 竞态/followup 边界 → #353）
- 上次验证：2026-10-16 · `eb2b4c1` · **PASS**（红提交 `673ce00` 先红、实现 `3c3dc9b` 转绿）
- 全量门（同一工作树实测，计数口径 `pnpm test:unit`）：Q0（1662 passed + 7 expected fail）/Q1/Q2（68 文件 491 用例）/Q3（15 spec 49 用例）/Q5（`pnpm test:e2e` 全链 exit 0）/Q6（32 用例）/Q7/Q9（`pnpm test:compose-smoke` PASS total=70.5s）全绿
- 登记处：覆盖状态列在 [runtime-capability-contract.md](./runtime-capability-contract.md)

## 验的是哪条用户路径

一个 Run 的 Runtime 子进程在收到**不属于自己**的指令、或总线上出现**别的会话**的事件时，行为必须
可预期：拒绝而不是执行、丢弃而不是转发或结算；以及用户按下发送后指令必须留下回执——两者都不许
静默。对应用户可见后果：别人 Run 的指令串进我的 Run、我的 Run 被别的会话事件提前结算、指令发出
后界面毫无反应（无回执）。

## 驱动（怎么触发）

```bash
pnpm test:dsh-contract   # Q3：三个新探针 + 既有十二个契约 spec 一起跑
```

判据文件（可点开）：

| 判据 | 文件 |
|---|---|
| 单 Run 隔离：跨 Run 的 prompt/cancel/decide 显式拒 + 零副作用 + 正控（拒绝后桥仍可用） | `packages/runtime-dsh/tests/dsh-contract/single-run-isolation.contract.spec.ts` |
| 指令回执：initialize 前显式拒且零帧、重复 initialize 显式拒、受理的 prompt 回执先于结算 | `packages/runtime-dsh/tests/dsh-contract/instruction-receipt.contract.spec.ts` |
| 事件流范围：异会话事件不转发、不结算；本 Run 事件照常、恰好一次 run.completed | `packages/runtime-dsh/tests/dsh-contract/event-stream-scope.contract.spec.ts` |
| 生产闸本体 | `packages/runtime-dsh/src/bridge.ts` 的 `handleCommand`（runId 闸）、`session-owner.ts` 的 `deliverSessionEvent`（会话过滤） |

## 观测（看什么）

- 跨 Run 命令：`ProtocolError('VALIDATION_FAILED', 'command <type> belongs to a different run …')`
  ——探针里表现为 `runtime.send()` 的 rejection；生产上由 Node 侧 supervisor 的按 Run 路由挡在前面，
  这道闸是纵深防御（放行意味着跨 Run 串扰）。
- 越界事件：**没有** `session.event` 帧、**没有** `runtime.fatal`、`run.completed` 恰好一次且晚于
  `turn/start`；异会话事件在 `deliverSessionEvent` 的会话过滤处被丢弃（不入帧、不驱动 settle）。
- 回执：`turn/start` 出现在 prompt 被受理之后、`run.completed` 之前；initialize 之前的命令零帧。

## 判定（成功长什么样）

1. 三个探针全绿（7 条断言族），且**红绿可分**：
   - 单 Run 隔离与事件流范围在实现落盘前是**红的**（`git show <红提交>` 跑即见：跨 Run 指令被执行 /
     注入的越界事件无痕迹）；
   - 事件流范围另做**变异自证**：把 `session-owner.ts` 的会话过滤注释掉，探针必红
     （实测：`foreign/probe` 泄漏进帧流、run 提前结算、`assistant/message` 缺失）。
2. 正控都在：拒绝之后本桥照常起 turn/收敛；本 Run 的取消照常生效；本 Run 事件照常转发。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| Run 收到不属于它的指令并执行 | `bridge.handleCommand` 的 runId 闸是否被绕过（Node 侧应先按 Run 路由）；`node.run` 的 protocolViolation 日志 |
| Run 被别的会话事件提前结算/出现两个 run.completed | `session-owner.deliverSessionEvent` 的会话过滤；`run_event` 表里该 run 的 seq 是否连续 |
| 指令发了没反应（无回执） | Runtime 是否收到 `run.prompt`（Node stdin 转发）→ `session.event` 里有无 `turn/start`；无则看 `runtime.fatal` |
| 探针红了但看不出是哪条 | 三个 spec 各自只断言一件事；事件流范围的红通常带 `foreign/probe` 或 `run.completed` 计数信息 |

## 取证

本链路证据是**可复跑用例本身**（Q3，无外部服务）：三个 spec 文件 + 红/绿两段提交 + 变异自证记录
（本文件与提交信息）。变异自证的复跑方法：

```bash
# 1) 把 packages/runtime-dsh/src/session-owner.ts 里
#    if (String(candidate?.id) !== sessionId) return  这行改成 if (false) return
# 2) pnpm vitest run --project dsh-contract \
#      packages/runtime-dsh/tests/dsh-contract/event-stream-scope.contract.spec.ts   # 必红
# 3) git checkout -- packages/runtime-dsh/src/session-owner.ts
```

## 边界与未覆盖

- **越界事件的注入面**：探针经 `RuntimeBridgeOptions.probeAfterReady`（探针专用接缝）把合成事件
  **直送生产的订阅处理器**。试过更"真实"的两条路都不通：① DSH 的 session/event 按会话上下文限定
  受众（dsh-session 用自己的 ctx 当 `this` 做范围过滤），兄弟子树的插件发的事件到不了桥的订阅点
  （三种发射形态哨兵实测全不达）；② 从桥自己的 ctx 发能到达，但同树的其他 DSH 订阅者
  （`dsh-session-projection`）对畸形会话事件当场抛错——那是它们的正确行为，不该由探针引入。
  代价：本判据覆盖的是「事件被派发到本 Run 订阅面之后」的范围语义，不覆盖总线分发的上下文作用域
  本身（那一层由 DSH 拥有）。
- **跨 Run 命令闸是纵深防御**：生产路径上 Node 按 Run 路由，正常不会把别的 Run 命令送进本进程；
  探针判的是"万一送到"时的行为，不是路由本身的正确性（路由判据在 Node 单测/集成面）。
- **cancel 竞态与 followup 中断边界仍无判据**：单独立账 #353（catalog 契约表里已改指）。
- 事件流范围的正控依赖 replay fixture（`basic`）：真实模型的 turn 形态差异不在本判据覆盖面内。

## 复跑

```bash
pnpm test:dsh-contract
pnpm exec vitest run --project dsh-contract \
  packages/runtime-dsh/tests/dsh-contract/single-run-isolation.contract.spec.ts \
  packages/runtime-dsh/tests/dsh-contract/instruction-receipt.contract.spec.ts \
  packages/runtime-dsh/tests/dsh-contract/event-stream-scope.contract.spec.ts
```
