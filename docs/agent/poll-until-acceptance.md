# 固定 sleep 改 poll-until 验收（#256）

- 对应门禁：Q0（静态）+ Q2（集成；用例本身不改产品行为）
- 对应决策：#256「两个集成用例靠固定 sleep 等待异步落库，CI 负载升高即抖红」
- 上次验证：2026-10-09 · `fix/p1-256-poll-until` · 结果 PASS

## 验的是哪条链路

**不是产品链路，是测试判据的可靠性**：把「等待异步状态落库」的固定 sleep 改成
「轮询到条件成立或超时」。原缺陷形态（#256 原文）：`setTimeout(300)` 后断言
workspace `available` 恢复——镜像落库慢于 300ms 即红；`node-websocket` 那例更糟，
`after!.lastSeenAt!` 在心跳处理慢于 120ms 时是 TypeError 崩溃而非断言失败。

## 判定（改了什么）

**转换 17 处**（等待异步落库 → poll-until）：

| 文件 | 处数 | 观察条件 |
|---|---|---|
| `apps/hub/tests/device-inventory.integration.spec.ts` | 5 | workspaces 行数/成员/available 翻转/lastSeenAt 非空 |
| `apps/hub/tests/node-websocket.integration.spec.ts` | 2 | dsh 版本列落库；lastSeenAt **严格变大**（刷新语义；同毫秒的 >= 证明不了心跳生效） |
| `apps/hub/tests/run-projection.integration.spec.ts` | 3 | run_event 行数=2；device dsh 版本列（hello 落库，两处） |
| `packages/db/tests/idempotency.integration.spec.ts` | 1 | `bExecuted`（transactCommand 先 SELECT 后 execute ⇒ 它=true 即证明 B 的 SELECT 已完成；把并发时序从「碰巧」变「必然」） |
| `apps/node/tests/recovery.spec.ts` | 1 | `alive(pid) === false`（孤儿进程真的消失） |
| `apps/node/tests/runtime-supervisor.spec.ts` | 1 | `lost` 记录出现（超时回收真的触发） |
| `apps/node/tests/run-manager.spec.ts` | 3 | collector 被调（采集链跑过）；inputs.cleaned 含 runId；负向例先等 collector 再排空一个宏任务 |
| `apps/node/tests/integration/run-projection-chain.integration.spec.ts` | 1 | alice/bob 各收到 run.completed（**同 socket 帧有序** ⇒ 用它给「语料零出现」断言定界，替代 500ms 猜窗口） |

新增 `waitForValue(probe, describe, {timeoutMs=3000})` helper（hub / db / node 各一份本地拷贝——
跨包 import 测试 helper 在干净 checkout 下解析不了，沿用既有「同源不跨包」约定）：
条件是**可观察返回值**，超时给明确失败消息（如「has-runs 工作区未在超时内降级为 unavailable」），
不再是 TypeError 或无声红。

## 同类扫描与归类（全仓 16 文件）

扫描口径：`apps|packages|scripts` 测试面里 `silence(N)` / `new Promise(setTimeout)` 形态，共 **62 处基线**。

- **本次转换 17 处**（上表；判据=等待异步落库且存在可观察条件）。
- 剩余 45 处逐类核过，**有意保留**：
  - **有界轮询间隔**（~25）：`while` + deadline 循环里的 sleep 是轮询实现本身（`take()`、
    `waitForClose`、`awaitDead` 等既有 helper 内部）；本次新增的 3 处 helper 轮询间隔同属此类。
  - **负向静默窗**（~8）：判据本身是「某事件在窗口内**不**发生」（`NEGATIVE_WINDOW_MS`、
    `expectSilence`、「未被误杀」、`node-restart-orphan-cli` 的 5s 存活确认）——没有正向可观察条件，窗口
    就是判据；已逐处加注释说明。
  - **真实时序/OS 回收窗**（~10）：`process.kill` 后等 OS 回收（worker 收不到 SIGCHLD）、
    流销毁、WS 压力/排空、订阅登记（服务端状态无客户端可观测量）、连接拆除。
  - **宏/微任务冲刷**（~6）：`setTimeout(0)` 排空微任务链（session.spec 有专门注释）。
  - **Promise.race 超时**（2）：`race([exit, silence(5000)])`——有界等待，不是裸 sleep。

回归保护：两条被点名的用例（device-inventory 的镜像收敛、node-websocket 的心跳刷新）
现在按条件收敛；「红」只在条件真的不成立时发生，且消息指明期望状态。

## 复跑

```bash
pnpm exec tsx scripts/with-test-postgres.mts pnpm exec vitest run --project integration \
  apps/hub/tests/device-inventory.integration.spec.ts \
  apps/hub/tests/node-websocket.integration.spec.ts \
  apps/hub/tests/run-projection.integration.spec.ts \
  packages/db/tests/idempotency.integration.spec.ts
pnpm exec tsx scripts/with-test-postgres.mts pnpm exec vitest run --project integration \
  apps/node/tests/integration/run-projection-chain.integration.spec.ts
pnpm vitest run --project unit apps/node/tests/recovery.spec.ts \
  apps/node/tests/runtime-supervisor.spec.ts apps/node/tests/run-manager.spec.ts
```

上次结果（2026-10-09）：集成 20/20（4 文件）+ run-projection-chain 5/5；
node 单测 62/62（4 文件）。全程无固定 sleep 参与「等待落库」。

## 未覆盖与已知项

- 真实「慢 DB」注入未做：本轮证据是条件收敛 + 全绿，不是「把 DB 拖慢到 3s 看是否还稳」的
  故障注入。若要更强证据，可在 CI 上加 `pg_sleep` 注入档（另立 Issue）。
- `realtime.integration.spec.ts` 的订阅登记守卫（2 处 50ms）与压力/排空窗（2 处）保留：
  服务端订阅注册无客户端可观测量，正控（alice 收到）已在用例内，负控（bob 收不到）依赖窗口。
