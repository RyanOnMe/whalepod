# P1-501：并发重复 run.start 不再误杀存活 Runtime 验收

- 对应场景/门禁：Q0（受影响 unit）+ 并发负控
- 对应 Issue：#504（P1-501；来源 #500 评审）
- 上次验证：2026-11-08 · 分支 `fix/p1-501-duplicate-run-start` · PASS

本切片边界：只关闭「同一 `run.start` 尚未 ack 时被同一 `commandId` 并发重投，两条 handler 同时进入崩溃恢复分支」这一条竞态。不改 ack 丢失后的重放语义、不改 Run 终态/取消链、不新增协议字段或 migration。

## 1 验的是哪条用户路径

Hub 在首个 `run.start` 的 ack 尚未上行时，按同一 `commandId` 重投（ack 丢失/重连重放）：

1. 第一条 handler `record()` 落 spool，进入 prepare（下载/初始化输入）；
2. 此时 `supervisor.isActive(runId)` 仍为 false、`commandStore.isAcked(commandId)` 也为 false；
3. 第二条 handler 拿到 `duplicate`，按既有「崩溃恢复」分支再次 prepare 并 spawn；
4. 第二个 Runtime 在 `active_runtime` 主键冲突后退出，其 `onExit → finalize(runId)` 按 runId 删掉第一个进程的行并上报退出；先失败的一条还会执行 `cleanupInputs`，可能删掉存活 Run 正在用的输入副本。

修复后同一 `runId` 的 `run.start` 串行执行：后来者等待前一条完整结束，再按最新 `isActive`/`isAcked` 走既有早退路径（回放 ack / lost 上报），不再并发 prepare/spawn。

## 2 驱动与证据

- 真实装配：`RunManager` + 真实 `CommandStore`（SQLite spool）+ 真实 `RuntimeSupervisor`（SQLite `active_runtime`）+ fake driver（只在 spawn 边界替身，stdin/exit 由测试脚本化）。
- 并发驱动：同一 `runStartFrame`（同 `commandId`/`runId`）连续投两次；`prepareArtifactInputs` 用可控 gate 把第一条挂在 prepare，确认第二条到达时 `isActive`/`isAcked` 都尚未翻转。
- 判据文件：`apps/node/tests/run-manager.spec.ts`（`#501` 用例；同文件 92 项全部通过）。
- 观测：`command.ack` 帧、`RunManager` 内存事实、`supervisor.db` 的 `active_runtime` 行数、`run.snapshot` 帧（lost 快照）。

## 3 判定

- **只 spawn 一个**：`runtimes.length === 1`；`prepareArtifactInputs` 只调用一次。
- **存活 Runtime 不被误判退出**：`supervisor.isActive(runId) === true`；`active_runtime` 恰一行；无 `run.snapshot`（lost）上行。
- **ack 一致**：两条 handler 各回一条 `command.ack`，均为 `accepted=true`（后来者回放成功结果）。
- **不误清在途输入**：失败路径的 `cleanupArtifactInputs` 未被第二条 handler 调用（`cleaned === []`）。
- **负控（反证实测）**：临时停用串行化后同一用例红在 `prepareCalls === 2`（第二条确实并发进入 prepare），证明判据打在竞态本身而不是无关断言。

## 4 门禁

| 门 | 命令 | 结果（2026-11-08） |
|---|---|---|
| Q0 | `pnpm check` | 231 文件 / 2507 项通过 |
| 目标用例 | `pnpm vitest run --project unit apps/node/tests/run-manager.spec.ts` | 92 passed |

## 5 单点变异

| # | 判据 | 变异 | 实测 |
|---|---|---|---|
| M1 | 同 runId 串行 | 删除 `runStartOps` 等待（`if (false && inFlight !== undefined)`） | 红（`prepareCalls` 2、`runtimes` 2、第二条 ack false） |

## 6 边界与未交付

- 不改「ack 已丢失且命令已处理完」的既有重放语义：成功回放 `accepted=true`，失败/已终态仍按既有 `RUNTIME_LOST` 上报，不自动重启。
- 不同 `commandId`、同一 `runId` 的第二次 `run.start` 仍按既有 `record` 语义处理（非本 Issue 的重复投递模型）；串行化只保证它们不并发 prepare/spawn。
- Runtime 崩溃后的工具不重放、Run 终态不复活等约束不变（ADR-0007/ADR-0027）。
