# PC-05b-3：终态清理队列、spill 根与 resumeContext 验收（ADR-0027 §6）

- 对应场景/门禁：Q0 / Q1 / Q2 / Q3 / Q6 / Q7；ADR-0027 §6「终态通用清理」「spill 根受管」「blocked 与 resume」
- 对应 Issue：#500（父 #497；RD-03 #486 的真实执行前置）
- 上次验证：2026-11-03 · `feat/pc-05b-3-terminal-cleanup` · PASS
- 关联：[ADR-0027](../adr/0027-run-project-context-snapshot-and-consumption.md)、[PC-05a 验收](./run-project-context-acceptance.md)、[PC-05b-1](./2026-11-03-pc05b1-context-state-acceptance.md)、[PC-05b-2](./2026-11-03-pc05b2-receipt-recovery-acceptance.md)

## 1 本切片交付

| 面 | 实现 | 判据 |
|---|---|---|
| spill 根受管 | `packages/runtime-dsh/config/whalepod.patch.yml` | id-target 给 `spill-local` 写 `root: dshHomePath('spill')`；>50KB 工具输出落到 `<dshHomePath>/spill/<session-hash>/`，本次运行写入的正文不在 OS tmpdir 默认 `dsh-spill-*` 根 |
| Run home 事实 | `apps/node/src/run/terminal-cleanup.ts`、`apps/node/src/run/run-manager.ts` | `run.start` **任何下载/初始化前**落 `run_runtime_facts(run_id, home_path, entry_count, owns_home, session_ready, dsh_session_id)`；resume Run 的 home 是来源 Run 的 home 且 `owns_home=false`；`runtime.ready` 后补 `session_ready=true` 与持久 `dsh_session_id`（重启后的 lost 快照也要带上，Hub 才能传播血缘） |
| 事实兜底 | 同文件 | 本进程未写过 facts（旧 Node 升级接管、启动拒绝）时从 command spool 的 `run.start` 重建 home/`entryCount`/`ownsHome`；缺失不再默认 `entryCount=0` |
| 持久清理队列 | 同文件、`apps/node/src/cli.ts` | SQLite `run_terminal_cleanup`：`pending/deferred/cleanup_pending/done`、`due_at/attempts/last_error`；终态帧只登记，**Runtime 子进程退出确认后**才执行；启动先 `startTerminalCleanup(false)` 清自有 home 的未完成任务（忽略 `due_at`），resume 共享 home 等首次连接补发 lost 快照后再清；运行期每小时重试；队列读/写失败只记结构化日志，不阻断终态收敛 |
| 删除时序 | `apps/node/src/run/run-manager.ts` | tick 先看本 Run 的 `supervisor.isActive`（shutdown 宽限中仍活跃 → `deferred`），再看同 home 其它活跃使用者；`isHomeInUse` 自身排除不能代替“本 Run 已退出” |
| 清理范围 | 同文件 | 所有 Run：删 `runtime-context/<runId>`；`resume` 且未 ready（spawn 前失败）到此为止；其余删 `<home>/spill`；非空上下文（blocked）：删 home 下全部子项（session + 非 session），保留 home 目录本身；空快照/无上下文（full）：保留 session 与非 session，只额外删 `quarantine` |
| 共享 home 守卫 | `apps/node/src/supervisor/runtime-supervisor.ts` | `active_runtime.dsh_home_path`（旧库启动时补列）；`isHomeInUse(homePath, exceptRunId)` 查同 home 是否还有其它活跃 Runtime；命中则 `deferred` 并延后重试 |
| 失败与重试 | `apps/node/src/run/run-manager.ts` | 删除失败、home 占用探测抛错、队列写失败都只记 `cleanup_pending`/`schedule_failed` 并保留可重试状态；单条失败不拖垮整轮，exit handler/小时定时器不因存储异常跳过归因 |
| Hub 终态标记 | `packages/db/src/repositories/run.ts`、`packages/db/migrations/0033_run_resume_context.sql` | `run.resume_context` 枚举 `full/redacted/blocked`，默认 `full`；`setRunStatus` 进终态时查 `run_project_context.entry_count`，>0 → 同事务写 `blocked`，空快照/无上下文保持 `full` |
| 血缘传播 | 同文件 | 已 ready（`dsh_session_id` 非空）或 Hub 判 lost（Node 可能已离线 ready）的非空上下文 Run 进 blocked 时，沿 `resume_from_run_id` 找到根来源并把它与全部 resume 后代一并标 blocked：共享 home 的 session 被删后，来源不能仍宣称 `full` |
| resume 拒绝 | `apps/hub/src/modules/run/orchestrator.ts` | 来源 Run `resumeContext='blocked'` → 409 `CONFLICT`（明确 blocked），不创建新 Run；blocked 判定优先于“没有会话” |
| 读面 | `apps/hub/src/modules/run/queries.ts` | `RunView.resumeContext` 暴露 `full/redacted/blocked`；`GET /runs/:id` 可机器判定 |
| 派发拒绝路径 | `apps/node/src/run/run-manager.ts` | `run.start` spawn 后下发失败：Runtime 仍活跃时只登记清理任务；spawn 前失败且 home 属来源 Run 时只删本 Run 的 `runtime-context`，不碰来源 session/spill；失败副本登记持久任务重试 |

## 2 驱动与证据

Hub 终态收敛用真实 Node 上行 `run.completed` 帧（`ingestNodeEvent`）或真实 HTTP 取消；resume 走真实 `POST /tasks/:id/runs` / 统一指令入口；Node 清理用真实 `RunManager`、真实 SQLite 队列与真实文件系统；spill 用真 boot 栈（`dsh-base → whalepod bundle → replay`）。

测试前置条件有三组直插业务表（既有 helper 形态，`tests/` 夹具不在 `scripts/check-boundaries.ts` 的 harness 扫描面内）：① `run-resume` 的空快照来源与 `run-input-snapshot` 的“无上下文来源”用 `insertRunRow` 种一条历史形态 Run；② `run-resume` 的空快照行直接插入 `run_project_context`；③ `run-resume` 的租约过期用例用 `insertRunRow` + `run_project_context` 种一个 `dispatching/running`、`dshSessionId=null` 的非空上下文子 Run，再驱动真实 `reconcileLeases` 判 lost。它们分别覆盖既有 ADR-0009 兼容形态与“Hub 尚无 session id”的租约时序，不替代生产路径：终态/取消、resume 创建、RunView 读取都走 HTTP 或真实帧。其余 Node/Hub 用例均驱动生产函数。Q5 的 `scripts/e2e-node.mts` 与生产 `apps/node/src/cli.ts` 采用同一启动清理时序（启动只清自有 home，共享 home 等首次连接）。

主要判据文件：

- `packages/runtime-dsh/tests/dsh-contract/spill.contract.spec.ts`
  - fixture `spill/session.jsonl` 调 bash 输出 60,000 字节；
  - 断言 `<spec.dshHomePath>/spill` 存在、含正文 marker、至少一个文件 >50KB；
  - 负控：扫描**全部** `tmpdir()/dsh-spill-*` 默认根，只认本次运行（mtime 晚于开始时刻）且含 marker 的新文件；历史残留/并行用例不会造成假绿或误报。
- `packages/runtime-dsh/tests/dsh-contract/resume.contract.spec.ts`
  - full 终态清理删掉 `spill`/`quarantine` 后，`ctx.agents.resume` 仍装载同一 session 并命中第一轮上下文（Q3 replay 真 boot）。
- `apps/node/tests/run-manager.spec.ts`（PC-05b-3 新用例）
  - 终态帧后 `pending` 且 spill/session 仍在；本 Run 的 Runtime 仍活跃时 tick → `deferred` 且不删；Runtime 退出后才删 `runtime-context`/spill/quarantine，full 保留 session 与 `settings.yaml`；
  - blocked：`entryCount=1` 的任务在退出后清空 home 全部子项、保留 home 根；
  - 共享 home：`isRuntimeHomeInUse` 为 true → `deferred` 且不删；false 后下一轮 `done`；
  - 删除失败（不可写目录）→ `cleanup_pending`/`attempts=1`，修复权限后重试成功；
  - 占用探测抛错、队列写失败 → 不拖垮定时器/终态收敛；`schedule_failed` 可见；
  - 启动清扫忽略 `due_at`；`startTerminalCleanup(false)` 只清自有 home，共享 home 留到首次连接后的全量清扫；启动对账把“有 facts 无任务”的 Run 补登记（prepare 后崩溃窗口）；**首次连接对账不会清理仍在 prepare、尚未 spawn 的 run.start**（延迟 prepare 的并发回归）；**启动对账跳过 command spool 中未 ack 的 run.start**，Hub 按同一 commandId 重投后仍能完成终态清理（防止启动清扫把任务写成 done、重投终态被 `on conflict do nothing` 吞掉）；已有 done 行在新 run.start 处理前被删除，重跑生命周期可重新登记；tick 遇到在途 run.start 只 deferred、不删已有副本；队列写失败后同一进程下一轮 tick 补登记；拒绝路径的删除与队列写入同时失败时，内存保留 facts 并在下一轮补登记；真实 SQLite 队列跨 manager 重启保持 `done`，新 manager 用同一库清扫遗留任务；
  - spawn 后下发失败：run.start accepted=false，但活跃 session 不被删；Runtime 退出后才 blocked 清理；
  - 重启后的 lost 快照带持久化 `dshSessionId`（Hub 才能沿血缘标 blocked）；
  - resume Run spawn 前失败：只删自己的 runtime-context，来源 home 的 session/spill 原样；
  - facts 缺失时从 run.start spool 重建 `entryCount`，拒绝路径按 blocked 清自己的 home；
  - resume Run ready 后终态：`ownsHome=false` + `sessionReady=true` 时按 blocked 清扫共享 home（Hub 血缘另行标 blocked）；
  - 非 owner 且未 ready 的持久任务：只删 runtime-context，绝不删共享 home。
- `apps/node/tests/terminal-cleanup.spec.ts`
  - Run home 事实跨 SQLite 重开可取；`markSessionReady` 持久化 session id 并同步已存在的任务；重复终态帧不重置任务/dueAt/attempts；
  - 重复 `putFacts`（崩溃后重处理未 ack 的 run.start）不把已 ready 的 `session_ready`/`dsh_session_id` 降级；SQLite 与内存实现同语义；
  - `factsNotScheduled` 只返回有 facts 且没有任务行的 Run（SQLite LEFT JOIN 判据，done 任务也算已登记）；
  - `reopen` 只删除 done 行，pending/deferred 任务保持原状（SQLite 与内存同语义）；
  - `due` 只发到期项、`notDone` 供启动清扫；
  - deferred/cleanup_pending/done 跨重启保持，`markFailure` 累计 attempts，done 不被失败迁移拉回。
- `apps/node/tests/runtime-supervisor.spec.ts`
  - `isHomeInUse`：同 home 的其它活跃 Run 算占用，排除自身；`stopAll` 后放行。
- `apps/hub/tests/run-project-context.integration.spec.ts`
  - 确认约定 → 创建带上下文 Run → `runtime.ready` 落 session → `run.completed` 终态 → DB `resume_context=blocked`、`GET /runs/:id` 暴露 blocked；
  - 同 Task 发起 resume → 409 `CONFLICT` 且消息含 blocked，Run 行数不变（不凭空建 Run）；设备离线时统一指令入口也先报 blocked。
- `apps/hub/tests/run-resume.integration.spec.ts`
  - 空快照（`entry_count=0`）来源 Run 取消进终态 → `resume_context=full`，RunView 暴露 full，resume 201 且血缘正确；
  - 来源 full → resume 子 Run 拿到非空上下文 → 子 Run 终态 blocked 时，来源 Run 一并 blocked；再次 resume 来源 409（生产 `run.completed` 帧 + 真实 HTTP）。
- `apps/hub/tests/run-resume.integration.spec.ts`
  - 设备租约过期先判 lost（`dispatching/running`、`dshSessionId=null`）→ 非空上下文子 Run 仍沿血缘把根来源标 blocked（真实 `reconcileLeases`）。
- `packages/db/tests/resume-context.integration.spec.ts`
  - 非空上下文 resume Run 终态 blocked → 根来源与同 home 的兄弟 Run 一并 blocked；
  - 无会话（spawn 前失败）的 blocked Run 不传播，来源仍 full；
  - 空快照 Run 终态保持 full，不做血缘传播。
- `apps/hub/tests/run-input-snapshot.integration.spec.ts`
  - 既有输入继承用例：非空上下文来源终态后 resume 409 blocked；用无上下文的固化成来源验证 resume 输入继承、大写 Task 路由与统一指令入口仍工作。

## 3 门禁

| 门 | 命令 | 结果（2026-11-03） |
|---|---|---|
| Q0 | `pnpm check` | 222 个测试文件、2405 项通过（含 typecheck / boundaries / protocol generated / web；lint 0 error） |
| Q1 | `pnpm test:unit`（含在 Q0） | 同上 |
| Q2 | `pnpm test:integration` | 89 个文件、824 项通过（真实一次性 PostgreSQL） |
| Q3 | `pnpm test:dsh-contract` | 22 个文件、88 项通过（真 boot 栈 + replay） |
| Q5（目标脚本） | `pnpm exec tsx scripts/run-create-to-recovery.mts` | 7/7 通过，evidence `PASS`（48 checks）；用于验证 `scripts/e2e-node.mts` 与生产 CLI 同启动时序，未跑全量 `pnpm test:e2e` |
| Q6 | `pnpm test:resilience` | 6 个文件、34 项通过 |
| Q7 | `pnpm test:security` | 4 个文件、18 项通过；secret-scan 自检与实扫 OK；license 626 包 OK |

## 4 负控与单点变异

每次只改一处，跑对应判据确认变红，再恢复并用 `git diff` 核对无残留。变异在 vitest 项目下执行（不做单点 typecheck），所以“删掉必填字段映射”等的红来自运行时断言。

| # | 判据 | 变异（单点） | 预期 | 实测 |
|---|---|---|---|---|
| M1 | spill 根在受管 home | 删掉 `spill-local.root` 配置 | Q3 spill 用例必须红 | 红（正文未落受管 home） |
| M2 | 终态写 blocked | 删掉 `resumeContext:'blocked'` 更新 | Hub blocked 用例必须红 | 红（resume 未 409） |
| M3 | 空快照保持 full | `entryCount > 0` 改 `>= 0` | 空快照 resume 用例必须红 | 红（空快照被标 blocked） |
| M4 | blocked 拒绝 resume | 删 orchestrator blocked 守卫 | Hub blocked 用例必须红 | 红（resume 创建新 Run） |
| M5 | RunView 暴露 | 删 `resumeContext` 映射 | Hub 读面断言必须红 | 红（`undefined ≠ blocked`） |
| M6 | 终态不先删 | `scheduleTerminalCleanup` 内先调 `cleanupRunCopies` | full 用例必须红 | 红（终端帧后 spill 已不存在） |
| M7 | full 保留 session | `entryCount>0` 改 `true` | full 用例必须红 | 红（session 被删） |
| M8 | blocked 删 session | `entryCount>0` 改 `false` | blocked 用例必须红 | 红（home 子项残留） |
| M9 | 共享 home 延迟 | 去掉 `isRuntimeHomeInUse` 判断 | 共享 home 用例必须红 | 红（立即 done、spill 被删） |
| M10 | 重复终态不重置 | `on conflict do nothing` 改更新 `due_at` | SQLite 队列用例必须红 | 红（dueAt 被新帧覆盖） |
| M11 | due 只发到期项 | `due_at <= ?` 改 `>=` | due 用例必须红 | 红（future 任务提前返回） |
| M12 | 失败累计 attempts | `attempts = attempts + 1` 去掉 `+1` | 队列用例必须红 | 红（attempts 0≠1） |
| M13 | 启动清扫忽略 due_at | `startTerminalCleanup` 传 `false` | 启动清扫用例必须红 | 红（未来到期任务未清） |
| M14 | 非空上下文事实 | `putFacts.entryCount` 固定 0 | blocked 用例必须红 | 红（任务 entryCount 0≠1） |
| M15 | 退出后触发清理 | 删 `handleRuntimeExit` 的 tick | full 用例必须红 | 红（3s 超时未 done） |
| M16 | 共享 home 排除自身 | `run_id <> ?` 改恒真 | supervisor 用例必须红 | 红（自身 home 被判占用） |
| M17 | 拒绝路径不删活跃 session | 删 `isActive` 早退 | spawn 后失败用例必须红 | 红（session 在 Runtime 活跃时被删） |
| M18 | 失败重试不推后 | 失败 dueAt 改 1 小时后 | 重试用例必须红 | 红（下一轮 tick 0≠1） |
| M19 | 探测异常不拖垮定时器 | catch 分支改为 rethrow | 探测异常用例必须红 | 红（未收敛 cleanup_pending） |
| M20 | 拒绝路径失败也入队 | 删 schedule+markFailure | 拒绝清理失败用例必须红 | 红（超时未 cleanup_pending） |
| M21 | 本 Run 活跃时延迟 | 删 tick 的 `isActive(task.runId)` 分支 | “Runtime 仍活跃”用例必须红 | 红（active 时删除 session/spill） |
| M22 | 非 owner 未 ready 不碰 home | 删 `!ownsHome && !sessionReady` 早退 | spawn 前失败/持久任务用例必须红 | 红（来源 session 被删） |
| M23 | facts 兜底 entryCount | `fallbackCleanupFacts.entryCount` 固定 0 | spool 兜底用例必须红 | 红（blocked 路径未删 home） |
| M24 | 队列写失败不阻断终态 | schedule catch 改为 rethrow | schedule_failed 用例必须红 | 红（emitStdout 抛出） |
| M25 | ready 写 sessionReady | 删 `markSessionReady` 调用 | resume ready 用例必须红 | 红（facts sessionReady=false） |
| M26 | 无会话不传播血缘 | 去掉 `row.dshSessionId !== null` 条件 | 无会话来源用例必须红 | 红（来源被误标 blocked） |
| M27 | blocked 传播血缘 | 删 `blockResumeLineage` 调用 | DB/HTTP 血缘用例必须红 | 红（来源仍 full） |
| M28 | 统一指令先报 blocked | 删 instruction.ts 的 blocked 守卫 | 设备离线下的指令 resume 用例必须红 | 红（返回 DEVICE_OFFLINE 而非 CONFLICT/blocked） |
| M29 | lost 快照带持久 session id | `buildSnapshot` 退回 `ready?.dshSessionId ?? null` | 重启 lost 快照用例必须红 | 红（dshSessionId=null） |
| M30 | ready 同步已有任务 | 删 `run_terminal_cleanup` 的 session_ready 更新 | SQLite 任务同步用例必须红 | 红（任务 sessionReady=false） |
| M31 | 启动先只清自有 home | 去掉 `includeSharedHome` 过滤 | 启动清扫用例必须红 | 红（共享 home 被提前删） |
| M32 | 启动对无任务 facts 对账 | 删 `reconcileCleanupFacts` 调用 | 崩溃窗口用例必须红 | 红（runtime-context 未清） |
| M33 | 队列写失败同进程重试 | 删 `retryUnscheduledCleanupTasks` 调用 | schedule 失败重试用例必须红 | 红（任务未补登记） |
| M34 | lost 无 session 也传播血缘 | 去掉 `status === 'lost'` 条件 | DB lost 用例必须红 | 红（来源仍 full） |
| M35 | 在途 run.start 不被对账清理 | 删 `startingRuns.set(runId, …)` 登记行 | 延迟 prepare 并发用例必须红 | 红（runtime-context 被删、facts 被登记） |
| M36 | 重复 facts 不降级 ready | upsert 改回 `excluded.session_ready/dsh_session_id` | SQLite/内存 facts 用例必须红 | 红（sessionReady=false） |
| M37 | 拒绝路径双失败内存保留 | 删 `unscheduledCleanupFacts.set` | 双失败重试用例必须红 | 红（下一轮 tick 0≠1） |
| M38 | SQLite factsNotScheduled 判据 | `t.run_id is null` 改 `is not null` | SQLite 对账用例必须红 | 红（返回已登记 Run） |
| M39 | 未 ack 的 run.start 不启动清理 | 删 `pendingRunStartReason` 的跳过分支 | 未 ack 对账用例必须红 | 红（启动对账返回 1，重投前副本已删） |
| M40 | 重跑重开 done 任务 | 删 `terminalCleanupStore.reopen(runId)` | done 行重开用例必须红 | 红（done 行仍在） |
| M41 | tick 跳过在途 run.start | 删 tick 的 `startingRuns.has` 分支 | tick 在途用例必须红 | 红（任务被 done、runtime-context 被删） |

复跑命令：

```bash
pnpm check
pnpm test:integration
pnpm test:dsh-contract
pnpm test:resilience
pnpm test:security
```

## 5 边界与未交付

- **resume probe 未固定**：本切片按 ADR fail-safe，所有非空 `run_project_context` Run 终态一律 `blocked`；`redacted` 只存在于枚举/迁移，本切片没有任何写入路径。resume probe 固定与 allowlist 重建是后续工作。
- **blocked 的代价**：非空上下文 Run 的 session 被整棵删除；同一 home 的 resume 血缘（来源 + 兄弟）一并 blocked。`full` Run（无上下文或空快照）保留 session 与非 session 文件。
- **`run.resumed` 不存在**：仓库当前没有该事件实现（成功 resume 也不产生），所以“blocked 不产生 `run.resumed`”无法作为独立判据；本切片没有新增该事件。
- **共享 home 的旧 Node 升级形态**：新 Node 从 spool 重建非 resume Run 的 facts；旧版本启动的 resume Run 若已 ready，无法从 spool 得知 session 是否写过共享 home。此时采用保守路径：Hub 依 `dsh_session_id` 已存在把血缘标 blocked（禁止再 resume），Node 不擅自删来源 home，留在磁盘等人工/后续 probe 收口；这是 fail-safe 的残留边界，不是零命中承诺。
- **Hub 与 Node 时序**：Hub 在终态收敛时立即写 blocked（fail-safe），不等 Node 实际清理完成；Node 队列负责最终删除。Node 长期离线时读面已显示 blocked，但本地副本可能仍在（活跃期通用工具读边界见 PC-05b-1/2）。
- **lost 的过度阻断**：lost 且非空上下文时，即使 Node 从未 ready（`session_ready=false`，Node 会保留共享 home），Hub 也按 fail-safe 传播血缘。方向保守，但一次派发期断线会让来源永久不可 resume；后续可用 Node 清理 ack 或 ready 事实细化，本切片不区分“从未 ready 的 lost”。
- **血缘 UPDATE 的锁序**：`setRunStatus` 先更新目标 Run，再由 `blockResumeLineage` 锁根与全部后代。当前同 Task 只允许一个活跃 Run，同一血缘不会有并发终态事务，故无死锁；若未来放宽为并行子 Run，需按 id 排序 `SELECT … FOR UPDATE` 或对 40P01 重试。
- **Node 停机路径**：`supervisor.stopAll()` 引发的退出不发布退出回调（既有行为）；已登记任务依赖下次启动的 `startTerminalCleanup()` 清扫，不保证本次进程内完成。
- **spawn 后下发失败 + 随后 ready**：run.start 的 catch 会移除 projector，之后 Runtime 的 `runtime.ready` 按“未知 Run”丢弃；任务保持 `sessionReady=false`，Node 只删本 Run 的 runtime-context、保留共享 home。Hub 收到 ack false 后把子 Run 标 blocked（无 session id，不传播来源）；来源仍可续，避免在 Hub 不知情时删来源 session。代价是子 Run 的非空上下文可能留在共享 session，属于“拒绝 Run + 共享 home”的已知取舍。
- **重启清扫与 lost 快照的时序**：启动只清自有 home（`startTerminalCleanup(false)`）；共享 home 延后到首次连接，`onReconnect()` 先补发带持久 `dshSessionId` 的 lost 快照，再执行全量清扫。Hub 若已因租约过期先写 lost，`setRunStatus` 对 `lost + 非空上下文` 即使尚无 session id 也按 fail-safe 传播血缘，避免来源永久停在 full；WebSocket 写入与 Hub 处理之间仍有一个很窄的“来源仍显示 full”窗口（设备刚重启、lastSeen 仍新鲜时 HTTP resume 可能被受理），但已不再先删后告知。彻底消除需要 Hub 侧等待快照 ack 再放行 resume。
- **链式 resume 的 home 语义**：Node 的 home 取**直接父 Run**（`runtimeHomeFor(resumeOfRunId)`），而 DSH session 实际在根来源 home；grandchild 续跑可能装载不到。Hub 的血缘阻断按 `resume_from_run_id` 整棵树标 blocked，因此在链式 resume 本来失败时是过度保守；若链式 resume 被判成功，则可能 block 一个 session 仍存在的后代。修复方向是链式 resume 统一用根 home，或血缘阻断只覆盖同一 home。本切片未改既有 ADR-0009 home 推导。
- **启动孤儿信号等待**：`recoverOrphans` 对 matched 孤儿发 SIGTERM/SIGKILL 后不等待内核回收就删 `active_runtime` 行并上报 lost；随后 tick 的 `isActive` 已为 false。严格意义的“观察到 exit”依赖进程已被信号终止的既有假设（`process.ts` 只发信号不等待）。这是 supervisor 的既有边界，本切片未改；后续可加 `waitForExit`/存活探测再触发清理。
- **崩溃窗口**：facts 在下载/初始化前落盘；启动 `reconcileCleanupFacts` 会把“有 facts 无任务”的 Run 补登记，覆盖 prepare 后崩溃与 schedule 写失败。本进程内未完成的 `run.start` 用 `startingRuns` 标记，对账与 tick 都跳过，避免首次连接把“facts 已写、尚未 spawn”的在途 Run 当孤儿删掉。跨进程崩溃时，若 command spool 里的 run.start 仍未 ack，启动对账也会跳过（Hub outbox 会按同一 commandId 重投）；重投进入处理链前删除上一生命周期的 done 行，保证新的终态能重新登记。只有进程在 `putFacts` 自身写失败/崩溃于它之前才可能残留，而那时尚未下载正文；该极小窗口未做目录扫描。
- **未 ack 命令的残留**：启动对账跳过未 ack 的 run.start 后，若 Hub 永久不重投，该 facts 不会被清理。可达路径不只是 Hub 状态丢失：dispatching 阶段用户取消 queued Run 时，Hub 会直接 fail 掉未 ack 的 run.start outbox 行且不发 run.cancel（`apps/hub/src/modules/run/cancel.ts`），Node 侧命令永远 unacked；若 Node 恰在 prepare 中崩溃，重启后会被永久跳过。这是“宁可保留、不可先删”的取舍（残留只是未执行 Run 的 runtime-context，无 session）；后续应给“未 ack 且超过 24h”加年龄兜底或由 Hub 显式下发清理指令。spool 读失败也按待重投处理，日志记 `reconcile_skipped`。
- **并发重复 run.start（既有边界）**：Hub 极短时间内用同一 commandId 重投两次时，两条 handler 仍可能各自完整 prepare，先失败的一条在 catch 中清理副本，影响另一条；`supervisor.start` 也没有按 runId 的串行化。`startingRuns` 计数只保证清理保护不被提前摘掉，未关闭该既有竞态；需要按 runId 串行化命令处理，已登记为 #504（P1-501）。
- **共享 home 守卫**：只看 `active_runtime` 的活跃进程；同一 home 上已终态但尚未清理的其它 Run 不构成占用（各自任务按序执行）。
- **full 的非 session 文件**：probe 未固定时保留除 `quarantine` 外的非 session 文件；ADR 的最终 resume 白名单清理与 `redacted` 重建未做。
- **混合舰队能力位**：Hub 的 blocked 只基于 Hub DB 与 `project-context.v1`/`context-state.v1` 能力，没有独立的 “terminal-cleanup.v1” 派发门。只到 PC-05b-1/2 的旧 Node 仍可能接单：Hub 会显示 blocked，但旧 Node 不删 session/spill（spill 仍可能落 OS tmpdir）。升级窗口内这是已知不一致，后续应加能力位或由 Node 清理 ack 驱动读面。
- **队列保留期**：`run_terminal_cleanup` 的 done 行只在同一个 runId 的新生命周期（新 run.start 进入处理链）时由 `reopen` 删除；其余情况不删除（与 command spool 同为只进不出）。长期运行会在 state dir 累积行与 `home_path` 绝对路径，保留期与 §9 日志策略一起定。
- **同步删除**：tick 用同步 `rmSync` 递归删除 session/spill；大 spill/慢盘会阻塞 Node 事件循环（同进程其它 Runtime 的 stdout/心跳受影响）。本切片优先正确性，异步删除留给性能切片。
- **mechanical resume 覆盖范围**：Q3 新增真 boot 用例证明 full 清理删掉 spill/quarantine 后仍能 `ctx.agents.resume` 同一 session；`runtime-context` 在 Node state dir、不属于 DSH home，其删除不参与 DSH 装载。
- **`runtime-home` 根**：blocked 删除 home 下全部子项但保留 home 目录本身；不承诺目录不存在。
- **spill 阈值**：沿用 rc.8 基座 `maxInlineBytes: 50000`；本切片只固定根，不改阈值/预览策略。spill 文件名随机且带 session hash，只能扫目录，不能按名枚举。
- **`apps/web`**：未改动；`resumeContext` 已在 Hub RunView 暴露，Web 类型与 RunDetailPanel 尚未消费（后续切片）。
- **24 小时口径**：任务在终态收敛时立即到期，Runtime 退出后执行；失败每小时重试，启动时全量清扫。ADR 的「终态后 24 小时内」是上界，本实现取更早执行，不额外延迟 24 小时。
- **`coordination-home/<evaluationId>` 零命中**：属 ADR-0026 协调评估范围，本切片未实现/未验收；本切片只处理 `runtime-home`/`runtime-context`。
- **真实环境**：Q5 全量浏览器/真机未在本切片重跑；只跑了 `run-create-to-recovery` 目标脚本以覆盖 `e2e-node` 装配改动，无真实租户/外部来源。
- **PC-05b-2 交接**：watchdog、回执发件箱与上下文状态机保持不变，本切片只接终态清理、resume 能力与血缘 blocked。

## 6 证据边界

- 清理日志只含 `runId`、`mode`、`attempts`、`errorName`、`reason`（`node.context` / `action=node.context.terminal_cleanup` / `event=deferred|done|cleanup_pending|cleanup_pending_write_failed|schedule_failed|facts_read_failed|facts_write_failed|queue_read_failed|reconcile_skipped`），不含正文、绝对路径、session id 或凭据。
- 队列 SQLite（`terminal-cleanup.sqlite`）含 `home_path` 等本机路径，落在 Node state dir，不进团队投影、不进日志、不进证据包。
- spill 契约证据只读临时 `dshHomePath` 下的文件与字节数；测试结束删除临时 home/workspace。证据包若需展示，只放脱敏 marker/字节数，不放完整全文或绝对路径。
- 删除判定用真实文件系统存在性、SQLite 状态迁移与 HTTP/DB 状态，不用截图或日志正则；固定 `dshSessionId` 在 Hub 集成测试中作为来源前置（与既有 run-resume 夹具同口径）。
