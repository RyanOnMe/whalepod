# P1-501：并发重复 run.start 不再误杀存活 Runtime 验收

- 对应场景/门禁：Q0（受影响 unit）+ 并发/失败路径负控
- 对应 Issue：#504（P1-501；来源 #500 评审）
- 上次验证：2026-11-08 · 分支 `fix/p1-501-duplicate-run-start` · PASS

本切片边界：只关闭「同一 `run.start` 尚未 ack 时被同一 `commandId` 并发重投，两条 handler 同时进入崩溃恢复分支」这一条竞态，并让重复投递回放首次真实结果。不改 Run 终态/取消链、不新增协议字段或 migration。

## 1 验的是哪条用户路径

Hub 在首个 `run.start` 的 ack 尚未上行时，按同一 `commandId` 重投（ack 丢失/重连重放）：

1. 第一条 handler `record()` 落 spool，进入 prepare（下载/初始化输入）；
2. 此时 `supervisor.isActive(runId)` 仍为 false、首次处理结果尚未落库；
3. 第二条 handler 拿到 `duplicate`，按既有「崩溃恢复」分支再次 prepare 并 spawn；
4. 第二个 Runtime 在 `active_runtime` 主键冲突后退出，其 `onExit → finalize(runId)` 按 runId 删掉第一个进程的行并上报退出；先失败的一条还会执行 `cleanupInputs`，可能删掉存活 Run 正在用的输入副本。

修复分两层：

- 同一 `runId` 的 `run.start` 串行执行：后来者等待前一条完整结束，再按首次真实结果早退，不再并发 prepare/spawn；
- 首次结果（`accepted` / `rejected` + 错误码）与 ack 同一时刻落 spool：后来者回放同一结果。首次以拒绝收场的 Run 重投仍回同一个 `accepted=false`，不得回成 `accepted=true` 再上报 `RUNTIME_LOST`（那会让 Hub 的 dispatching 与真实失败原因错位）。
- `rejected` 只表示首次处理以拒绝收场，不保证从未 spawn（spawn 后下发失败也归入拒绝）；回放的是首次 ack 的事实，与是否真正启动无关。

## 2 驱动与证据

- 真实装配：`RunManager` + 真实 `CommandStore`（SQLite spool）+ 真实 `RuntimeSupervisor`（SQLite `active_runtime`）+ fake driver（只在 spawn 边界替身，stdin/exit 由测试脚本化）。
- 并发驱动：同一 `runStartFrame`（同 `commandId`/`runId`）连续投两次；`prepareArtifactInputs` 用可控 gate 把第一条挂在 prepare，确认第二条到达时 `isActive`/处理结果都尚未翻转。
- 失败路径驱动：同一 gate 后在 `prepareArtifactInputs` 抛 `ARTIFACT_HASH_MISMATCH`，覆盖「首条被拒 + 等待者重投」。
- 隔离驱动：首个 Run 挂在 prepare 时启动另一个 `runId`，验证串行键不跨 Run 阻塞。
- 判据文件：`apps/node/tests/run-manager.spec.ts`（四条 `#501` 用例；同文件 95 项全部通过）。
- 观测：`command.ack` 帧（accepted/错误码）、`supervisor.db` 的 `active_runtime` 行身份与 pid、`supervisor.isActive`、spool 的 `isAcked/pending`、`run.snapshot` 帧（lost 快照）、`run.start outcome persist failed` 日志。

## 3 判定

- **成功路径只 spawn 一个**：`runtimes.length === 1`；`prepareArtifactInputs` 只调用一次；`active_runtime` 恰一行且 pid 等于第一个 Runtime；`supervisor.isActive(RUN_ID) === true`。
- **存活 Runtime 不被误判退出**：测试对多出来的 Runtime（仅缺陷路径会出现）显式 `emitExit`；退出后 `active_runtime` 行与 pid 仍是第一个 Runtime，句柄不被按 runId 摘掉。判别信号是行身份/pid 与 `isActive`；`run.snapshot` 断言只覆盖 R9 `reportLostSnapshot` 路径（`handleRuntimeExit` 本身不发快照）。
- **成功路径 ack 一致**：两条 handler 各回一条 `command.ack`，均为 `accepted=true`（后来者回放成功结果）；spool 已 acked 且无 pending。
- **失败路径 ack 一致**：首条与等待中的重投都回 `accepted=false` + 同一个 `ARTIFACT_HASH_MISMATCH`；不产生 lost 快照；`cleanupArtifactInputs` 只由首条自己调用一次（重投不再 prepare/清理）。
- **落库失败不悬挂**：首次结果写 spool 失败时 ack 照发、启动不被阻断，并发 error 级日志；代价见 §6。
- **跨 Run 独立**：首个 Run 挂在 prepare 时，另一个 `runId` 的 `run.start` 立即 spawn，不被全局串行阻塞。
- **负控（反证实测）**：
  - 停用串行化 → 成功路径用例红在 `prepareCalls === 2`（第二条确实并发进入 prepare）；
  - 停用「回放首次拒绝」→ 失败路径用例红在第二条 ack 变成 `accepted=true`；
  - 失败路径不落首次结果（退回裸 `markAcked`）→ 失败路径用例红在等待者 ack 变 `true` 并出现 lost 快照（`markAcked` 已置 `acked_at`，所以走 `isAcked` 兜底而不是重新 prepare）。

## 4 门禁

| 门 | 命令 | 结果（2026-11-08） |
|---|---|---|
| Q0 | `pnpm check` | 231 文件 / 2510 项通过 |
| Q2 | `pnpm test:integration` | 96 文件 / 990 项通过 |
| Q6 | `pnpm test:resilience` | 6 文件 / 34 项通过 |
| 目标用例 | `pnpm vitest run --project unit apps/node/tests/run-manager.spec.ts` | 95 passed |

## 5 单点变异

| # | 判据 | 变异 | 实测 |
|---|---|---|---|
| M1 | 同 runId 串行 | 删除 `runStartOps` 等待（`if (false && inFlight !== undefined)`） | 红（`prepareCalls` 2、`runtimes` 2） |
| M2 | 回放首次拒绝 | 删除 `previous?.outcome === 'rejected'` 分支 | 红（等待者 ack 变 true / 出现 lost 快照） |
| M3 | 拒绝结果落库 | 拒绝路径退回 `markAcked(commandId)`（不写 outcome） | 红（等待者 ack 变 true + 出现 lost 快照；不会重新 prepare） |

## 6 边界与未交付

- 首次处理成功且 Runtime 已不在时，仍按既有 R9 语义回放 `accepted=true` 并上报 `RUNTIME_LOST`，不自动重启；首次已明确拒绝的 command 重投只回放拒绝，不再走 lost。
- 不同 `commandId`、同一 `runId` 的第二次 `run.start` 仍按既有 `record` 语义处理（非本 Issue 的重复投递模型）；串行化只保证它们不并发 prepare/spawn。该路径的「recorded 后先查 active」加固另立 Issue。
- 同一 commandId 复用到不同 runId 的归属校验、长 prepare 期间等待者的合并/总时限，均为既有边界，本切片不改。
- 升级前的旧 spool 行只有 `acked_at`、没有 `outcome`：升级后重投仍按 `isAcked → RUNTIME_LOST` 兜底（与升级前一致）；lost 日志的 `firstOutcome=null` 可区分这类行。
- 首次结果落库失败（磁盘满/IO 错）时 ack 照发；若 ack 也丢失，同一 commandId 重投会按「未处理」重新 prepare/spawn（#181 N1 已接受的口径，代价比 followup 重，登记在此）。
- `run.status_request` 对「已拒绝且从未启动」的 Run 仍可能答 lost/null（既有读面按 `finalFacts`/active 推断，不查 command outcome）；正常路径下 Hub 收到拒绝 ack 后不会再探活，本切片不改。
- Runtime 崩溃后的工具不重放、Run 终态不复活等约束不变（ADR-0007/ADR-0027）。
