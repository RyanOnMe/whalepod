# PC-05b-2：首条回执 watchdog 与回执发件箱验收（ADR-0027 §4/§6）

- 对应场景/门禁：Q0 / Q1 / Q2 / Q3 / Q6 / Q7；ADR-0027 §4 回执与 watchdog、§6 断连重放
- 对应 Issue：#499（父 #497；RD-03 #486 的真实执行前置）
- 上次验证：2026-11-03 · `feat/pc-05b-2-receipt-recovery` · PASS
- 关联：[ADR-0027](../adr/0027-run-project-context-snapshot-and-consumption.md)、[PC-05a 验收](./run-project-context-acceptance.md)、[PC-05b-1 验收](./2026-11-03-pc05b1-context-state-acceptance.md)

## 1 本切片交付

| 面 | 实现 | 判据 |
|---|---|---|
| 首条回执 watchdog | `apps/hub/src/modules/context/receipt-watchdog.ts`、`apps/hub/src/config.ts`、`apps/hub/src/server.ts` | 只选 `running` / `waiting_approval`、`run_project_context.entry_count>0`、`started_at <= now - watchdogMs` 的 Run；默认 60 秒，`WHALEPOD_CONTEXT_RECEIPT_WATCHDOG_MS` 可配，resolver 上限 120 秒；server 10 秒 tick 与审批过期清扫串行执行 |
| 误杀防护 | 同文件逐 Run 事务 | `select … for update` 后重查 Run 状态，并查 `run_context_receipt` 最高 seq；候选查询后到达的回执不会被误杀。空快照 Run 永不进入候选 |
| 超时收敛 | 同文件 | `failed(CONTEXT_UNAVAILABLE)` + 触发指令（若仍 pending）结算为 rejected + `applyRunStatus` + 悬置审批 `cancelled(run_terminal_fold)` + `team_event(run.changed)` + `dispatch_outbox(run.cancel, cause=admin)`，让 Node 停止 Runtime；结构化日志 `context.receipt_watchdog` / `context.receipt_watchdog_error` |
| Hub 回执 ack | `packages/protocol/src/node-wire.ts`、`apps/hub/src/modules/run/orchestrator.ts` | Node 下行 `run.context_receipt_ack`：`runId/snapshotId/receiptSeq/highestSeq/result(accepted/duplicate/late/rejected)/reason?`；四种结果都回 ack；ack 发送失败只记 `context.receipt_ack_send_failed`，不回滚已提交的回执事实 |
| 重复/乱序序号 | `packages/db/src/repositories/run-context.ts`、`apps/hub/src/modules/context/receipts.ts` | 同 `(runId,snapshotId,receiptSeq)` 已有行 → `duplicate`（不新增行、不重写消费）；低于高水位但从未落库的序号仍接受（补写本批读取事实，高水位不回退；与工作输入回执同策略）；只有确实重复才按幂等成功回报 |
| 终态迟到 | 同上 | 终态 Run 的回执返回 `late`，不落库、不复活 Run，仍回 ack 让 Node 清发件箱 |
| Node 回执发件箱 | `apps/node/src/context/receipt-outbox.ts`、`apps/node/src/cli.ts` | SQLite `context_receipt_outbox`（主键 `run_id+snapshot_id+receipt_seq`，存完整帧与入队时间）；`enqueueNext` 在同一事务里分配 seq + 入队，崩溃不会留下「seq 已消费但无待发项」；`pending` 按 Run/快照/seq 升序；`ack` 只删精确 seq；`seedFromLegacy` 接管 PC-05a `context-receipts.sqlite` 的高水位；内存实现语义一致；CLI 落在 state dir 的 `context-receipt-outbox.sqlite` |
| 先入队再发送 | `apps/node/src/run/run-manager.ts` | 回执先经 `enqueueNext`（原子分配 seq + 入队）持久化，再写本地 delivered/read 标记；持久化异常只记 `persist_failed`，不冒泡拖死 Node；发送成功不删除，只有 Hub ack 才删；`sentContextReceipts` 避免同一连接重复发送同一 seq |
| 重连重放 | 同文件 | `onReconnect` 清空本次连接的已发集合后 drain 出站箱；离线期间累积的回执按 seq 重放 |
| ack 清理 | 同文件 | `run.context_receipt_ack` → 只 `ack(receiptSeq)`，并清该精确 key 的已发标记；重复 ack 幂等；不按 `highestSeq` 区间删除（Hub 允许 seq 空洞，区间删除会丢掉从未落库的更低回执） |
| 协议形状 | `packages/protocol/fixtures/node-downstream/run.context_receipt_ack.json`、`packages/protocol/tests/run-context.spec.ts` | ack 只允许四个 result；`reason` 1–200 字符；非法 result 被 schema 拒绝 |

## 2 驱动与证据

全部走生产装配：Hub 创建/派发/回执/状态事务与真实 PostgreSQL；Node 走真实 SQLite 发件箱与 RunManager 帧处理；watchdog 走 server 同一函数而不是测试专用入口。

主要判据文件：

- `apps/hub/tests/run-project-context.integration.spec.ts`
  - 60 秒无首条回执 → `failed(CONTEXT_UNAVAILABLE)`、一条 admin `run.cancel`、`context.receipt_watchdog` 事件；`settleTriggerInstruction` 只对仍为 pending 的触发指令生效（正常 Run 已 accepted，属崩溃窗口防御）；
  - 回执在截止前到达 → 不收敛、Run 保持 running；
  - 仅 59 秒 → 不收敛；
  - 自定义 30 秒窗口在 31 秒触发（默认 60 秒不会触发），证明 `deps.watchdogMs` 生效；
  - 空快照 Run 超过 60 秒 → 不收敛（watchdog 不得误杀）；
  - `waiting_approval` 且首条回执从未到达 → 同样收敛（审批闸门不豁免交付证据），挂起审批随 Run 终结为 cancelled；
  - 首条回执 ack `accepted/highestSeq=1`；重复 seq ack `duplicate/highestSeq=2` 且不新增行；
  - 低水位但从未落库的 seq 被接受（ack `accepted/highestSeq=2`），读取事实与 `run_context_consumption` 补齐；
  - 终态后迟到回执 ack `late/highestSeq=0`、不落库；
  - 非法 digest/nonce/read 集合逐条 ack `rejected` 并带 reason；
  - ack 发送抛错时回执仍落库并记 `context.receipt_ack_send_failed`。
- `apps/hub/tests/context-receipt-watchdog-options.spec.ts`：默认 60 秒、可配置、120 秒上限、非法值回落。
- `apps/node/tests/run-manager.spec.ts`：离线回执进 outbox 不发送；重连后按 seq 重放；Hub ack 后清空；ack `highestSeq=2` 只删 `receiptSeq=1`；late/rejected（`highestSeq=0`）只删精确 seq；重复 ack 幂等；SQLite 发件箱跨 manager 重启后仍能重放（生产装配）。
- `apps/node/tests/context-receipt-outbox.spec.ts`：SQLite 跨重开保留、乱序入队按 seq 重放、`enqueueNext` 原子分配并持久计数、`ack` 只删精确 seq、PC-05a 旧计数文件迁移、多 Run/多快照全局排序与按 Run 过滤、内存实现对齐。
- `packages/protocol/tests/run-context.spec.ts`：ack 形状与非法 result 负控。

## 3 门禁

| 门 | 命令 | 结果（2026-11-03） |
|---|---|---|
| Q0 | `pnpm check` | 221 个测试文件、2372 项通过（含 typecheck / boundaries / protocol generated / web；lint 0 error、119 条存量 warning） |
| Q1 | `pnpm test:unit`（含在 Q0） | 同上 |
| Q2 | `pnpm test:integration` | 88 个文件、816 项通过（真实一次性 PostgreSQL） |
| Q3 | `pnpm test:dsh-contract` | 21 个文件、86 项通过（真 boot 栈 + replay） |
| Q6 | `pnpm test:resilience` | 6 个文件、34 项通过 |
| Q7 | `pnpm test:security` | 4 个文件、18 项通过；secret-scan 自检与实扫 OK；license 626 包 OK |

## 4 负控与单点变异

每次只改一处，跑对应判据确认变红，再恢复并用 `git diff` 核对无残留。

| # | 判据 | 变异（单点） | 预期 | 实测 |
|---|---|---|---|---|
| M1 | 未到 60 秒不收敛 | 候选查询去掉 `started_at <= cutoff` | 59 秒用例必须红 | 红（`before the watchdog window elapses`：count 1≠0） |
| M2 | 空快照不启 watchdog | 候选查询去掉 `entry_count > 0` | 空快照用例必须红 | 红（`empty-snapshot Run`：count 1≠0） |
| M3 | 候选后到达的回执不误杀 | 删事务内 `lastSeq > 0` 早退 | 回执先到用例必须红 | 红（`receipt arrived before the watchdog deadline`：count 1≠0） |
| M4 | 超时收敛并停 Runtime | 去掉 `run.cancel` 入队 | cancels 断言必须红 | 红（`fails a context Run after 60s`：cancels 0≠1） |
| M5 | 重复 seq 幂等 | `getRunContextReceiptBySeq` 命中仍返回 rejected | duplicate 用例必须红 | 红（`accepts delivered/read receipts`：无 `receipt_duplicate`） |
| M6 | ack 携带最高水位 | accepted/duplicate 的 `highestSeq` 固定 0 | ack 断言必须红 | 红（同用例：highestSeq 0≠1） |
| M7 | ack 丢失不回滚回执 | catch 分支改为 rethrow | ack 发送失败用例必须红 | 红（`ack cannot be delivered`：promise rejected） |
| M8 | 先入队再发送 | Node 回执改为直接 send、跳过 enqueue | 离线持久用例必须红 | 红（`persists receipts offline`：pending 0≠1） |
| M9 | 重连重放 | `onReconnect` 去掉 clear+drain | 重放用例必须红 | 红（同用例：replayed 0≠1） |
| M10 | 只有 ack 才删 | ack 处理改为不调用 `ack` | pending 清零断言必须红 | 红（同用例：pending 1≠0） |
| M11 | 未 ack 不重发 | 去掉 `sentContextReceipts` 去重 | 累积回执用例必须红（重复帧） | 红（`forwards cumulative receipts`：3≠2） |
| M12 | 发件箱按 seq 重放 | SQLite 查询去掉 `order by … receipt_seq` | outbox 顺序断言必须红 | 红（outbox：`[2,1,3]≠[1,2,3]`） |
| M13 | ack 不得误删更低未 ack 项 | Node ack 处理改用 `payload.highestSeq` 删除 | run-manager 离线用例必须红（seq 2 被误删） | 红（`persists receipts offline`：pending `[1]≠[2]`） |
| M14 | ack result 枚举 | schema 去掉 `z.enum` 限制 | 协议负控必须红 | 红（`accepts the Node receipt…`：未抛错） |
| M15 | watchdog 120 秒上限 | `resolveContextReceiptWatchdogMs` 去掉 `Math.min` | 配置上限用例必须红 | 红（options：600000≠120000） |
| M16 | `waiting_approval` 不豁免交付证据 | 事务内状态判断只留 `running` | 审批中缺回执用例必须红 | 红（`waiting-approval context Run`：count 0≠1） |
| M17 | 失败后不得挂 pending Approval | 去掉 `cancelPendingApprovalsInTransaction` 调用 | 审批状态必须 red | 红（同用例：`pending≠cancelled`） |
| M18 | 低水位未落库 seq 不得丢读取事实 | 恢复为 `rejected(receipt_seq_not_monotonic)` | 乱序用例必须红 | 红（`lower seq that was never recorded`：receipts `[2]≠[1,2]`） |
| M19 | seq 分配必须持久 | `enqueueNext` 固定返回 1 | 跨重开计数用例必须红 | 红（counter：`[1,1]≠[1,2]`；legacy：1≠8） |
| M20 | 自定义 watchdog 窗口生效 | `failMissingContextReceipts` 忽略 `deps.watchdogMs` | 30 秒用例必须红 | 红（`configured watchdog window`：count 0≠1） |
| M21 | 入队失败必须回滚 seq | `enqueueNext` 去掉事务包裹 | 回滚用例必须红 | 红（`rolls back the seq allocation`：seq 残留 1） |
| M22 | 持久化失败不拖死 Node | 去掉 `enqueueNext` 的 try/catch（异常冒泡） | persist_failed 用例必须红 | 红（`persist_failed` 用例：`Error: disk full` 未被吞掉） |

复跑命令：

```bash
pnpm check
pnpm test:integration
pnpm test:dsh-contract
pnpm test:resilience
pnpm test:security
```

## 5 边界与未交付

- **watchdog 检测窗口**：server 10 秒 tick + 默认 60 秒阈值，实际收敛落在 60–70 秒；`WHALEPOD_CONTEXT_RECEIPT_WATCHDOG_MS` 可配，resolver 上限 120 秒；server 已接线该配置。
- **watchdog 只覆盖首条回执**：后续增量回执依赖 Node 发件箱与重连重放；没有「第 N 条回执长期缺失」的独立 watchdog。
- **ack 是尽力而为**：Node 断线时 ack 丢，回执事实已落库；Node 重放同一 seq 得到 `duplicate` ack 后清理。Hub 不持久化待发 ack，也不保证 ack 送达顺序。
- **回执是受信 Node 自报证据**：不防恶意 Node；`entriesRead` 只证明调用过读工具，不证明模型真的理解内容。
- **迟到回执**：终态后到达只 ack 不落库，不复活 Run；Hub 不回放终态回执。
- **审批锁序**：server 单进程内将审批过期清扫与 watchdog 串行执行，避免新增自动路径形成 `Run→Approval` / `Approval→Run` 并发；多副本部署时该单飞不跨进程，PostgreSQL 会检测并回滚一方（既有自愈边界）。真人审批与既有终态折叠的竞争同属该边界，本切片未改。
- **持久化失败边界**：`enqueueNext` 失败（磁盘/权限）会回滚 seq 分配并记 `persist_failed`，进程继续运行；该批读取事实可能无法送达 Hub，但不会产生“seq 已消费却无待发项”的空洞，也不会拖死 stdout 监听器。本地 delivered/read 标记在回执入队之后写，写失败只影响撤权清理的保守方向；若进程恰在两步之间崩溃，重启后本地 read 标记可能滞后（Hub 已有回执），撤权清理可能多删已读副本，但回执本身不丢。
- **终态残留**：Run 终态后未 ack 的上下文回执只会在下次重连时重放，由 `late` ack 清理；若 Node 长期离线，发件箱行会保留到重连。不做主动过期清理（PC-05b-3 终态清理范围）。
- **混合舰队**：PC-05b-1 的能力升级顺序与旧 Node 限制继续有效；升级前已存在的活跃上下文 Run 在旧 Node 上不受 watchdog/撤权保护。
- **PC-05b-3（#500）未交付**：spill 根固定、终态 session 清理/blocked、`resumeContext`、24 小时清理队列。
- **`apps/web`**：未改动。

## 6 证据边界

- ack、watchdog 与 outbox 日志只含不透明 id、seq、计数、状态与原因码；不含正文、digest 原文、绝对路径或凭据。
- Node 发件箱内容完整帧含 headerDigest（摘要非正文），落在 state dir；生产进程退出后由 SQLite 保留。
- 回执与 ack 的时序证据来自测试驱动的真实事务与真实 SQLite，不用截图或日志正则判定。
