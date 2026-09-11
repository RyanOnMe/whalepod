# Run 取消/强杀/丢失与显式重跑 验收

- 对应场景/门禁：G7-01..06、R4/R5/R9、Q6（见 04-验收矩阵与测试策略.md）
- 对应 Issue：P1-16（#20）
- 上次验证：2025-xx-xx · <commit> · 结果 PASS（提交后回填 commit hash）

## 验的是哪条用户路径

- **取消**：责任人（或 Owner/Admin 紧急介入）对一个运行中的 Run 点击取消——
  Hub 落 `cancel_requested` 并派发 `run.cancel`，Node 转发给 Runtime；Runtime
  无响应时被 Supervisor 逐级收尾（15s → SIGTERM → 5s → SIGKILL），Run 以
  `cancelled(forced)` 终态闭环，进程组确认死亡。
- **失败归因**：Runtime 崩溃/消失后，Run 落 `failed(RUNTIME_LOST)` 或
  `lost(RUNTIME_LOST)`，界面明示失败码与「需验证外部状态」警示；系统绝不自动
  重启、绝不重放可能有副作用的工具。
- **显式重跑**：用户对终态 Run 显式发起重跑，新 Run 带 `rerunOfRunId` 指向旧
  Run（数据库 FK + Task Room 时间线血缘可见）；旧 Run 终态不复活。

## 驱动（怎么触发）

全部走真人同一条处理路径：HTTP 用 Fastify `inject`（与真实 HTTP 同一 app），
Node 侧用真实 `node` 子进程 + 真实 SIGTERM/SIGKILL 信号，Hub 侧用真实
`reconcileLeases` + FakeClock 推进租约时间。

```bash
# Q6 故障门（P1-16 建立；含一次性 PostgreSQL，R4/R5/R9 + Hub 侧故障语义）
pnpm test:resilience

# 单项复跑示例
pnpm test:integration -- apps/hub/tests/run-cancel-route.integration.spec.ts
pnpm test:integration -- apps/hub/tests/run-rerun.integration.spec.ts
pnpm vitest run --project resilience apps/node/tests/resilience
pnpm vitest run --project web apps/web/tests/run-actions.spec.tsx
```

测试文件 ↔ 场景对应：

| 场景 | 测试文件 | 断言要点 |
|---|---|---|
| G7-01（Hub 侧） | `apps/hub/tests/run-cancel-route.integration.spec.ts` | POST `/runs/:id/cancel` 200；queued 直接 cancelled；Outbox 有 `run.cancel(cause)`；重复取消幂等；终态 409 `INVALID_RUN_TRANSITION`；403/404 |
| G7-01（Node 侧，真人进程探针） | `apps/node/tests/resilience/cancel-escalation.spec.ts` | 真实子进程被 SIGTERM 终止（`process.kill(pid,0)` 判死）；脚本化链路确认 stdin cancel→窗口→升级信号序列 |
| G7-02 | 同上 | 注入 100ms/50ms 时钟：确认窗口内不动进程；过期 SIGTERM；再宽限 SIGKILL；强杀退出投影 `run.cancelled(forced=true)` 双受众；Runtime 主动确认则 `forced=false` 且零升级信号；SIGTERM 免疫进程被 SIGKILL 收尾 |
| G7-03 | `apps/node/tests/resilience/runtime-exit-no-restart.spec.ts` | 退出(1)→`run.failed(RUNTIME_LOST, code=1)`（owner 带 summary、project 只见错误码）；重复 `run.start` 不产生第二 Runtime；`code=0` 无终态帧同样判 lost；`completed` 后退出被忽略 |
| G7-04（API/FK） | `apps/hub/tests/run-rerun.integration.spec.ts` | 带 `rerunOfRunId` 201 且响应/Task Room 携带血缘；非终态 409；跨 Task/未知 404；畸形 400；同 Idempotency-Key 重放同一 Run；DB FK 拒绝悬挂引用 |
| G7-04/G7-05（UI） | `apps/web/tests/run-actions.spec.tsx` | 时间线「重跑自第 N 次运行」（#162 起；此前是「由 Run <前8位> 重跑」，短 id 不再当标签，完整来源 runId 退到 `title`）；终态 Run「重跑此 Run」→ 确认 POST 带 `rerunOfRunId`；活跃 Run「取消 Run」带 Idempotency-Key；member 不可见动作 |
| G7-05 | 同上 | `failed/lost` 出警示（含失败码），文案含「需验证外部状态」「不会自动重放」，且不出现「安全重放/已安全恢复」；`completed` 无警示 |
| G7-06 | `apps/hub/tests/run-cancel-route.integration.spec.ts`（断言 a）+ `apps/hub/tests/approval-decision.integration.spec.ts`（断言 b，P1-14 #59 已合入） | Alice（Owner 角色）可经 HTTP 取消 Bob 的 Run（`cause=admin`）；同一 Owner 角色对 Bob 的 Approval 决策被 HTTP 403 拒绝、行保持 pending（「不能替 Bob 批准」的 HTTP 面证据）；辅以 domain policy 单测（`decide_approval` 仅 owner）+ orchestrator `decided_by=owner` 强制 |
| R4 | `apps/hub/tests/resilience/run-lease-resilience.spec.ts` | 断网 10s（FakeClock）+ `reconcileLeases` → Run 保持原状态、`failureCode` 为空；重连 `runtime.ready` → running；全程无 `lost` 事件 |
| R5 | 同上 | >30s → `lost(RUNTIME_LOST)` + finishedAt + Team Event；之后心跳（含声称活跃）、snapshot(running)、迟到事件都不复活（事件持久留证，状态不动） |
| R9 | `apps/node/tests/resilience/node-restart-orphan.spec.ts`（Node 侧）+ `run-lease-resilience.spec.ts`（Hub 侧） | 真实孤儿进程三重匹配后被杀（liveness 判死）；离线期 lost 快照缓冲、重连 flush `run.snapshot(lost, RUNTIME_LOST)`；Hub 侧据此落 `lost(RUNTIME_LOST)`；Hub 重发 `run.start` 不复活、不重发 prompt |

## 观测（看什么）

- **component 分层**：Node 取消升级每阶段写结构化日志——
  `component: node.supervisor`，`msg` 含 `cancel requested` / `sigterm` /
  `sigkill` / `reaping`，带 `runId` 与注入窗口（测试断言了 phase 日志存在）。
- **wire 事实**：`run.cancelled.forced`（§6.4）、`run.failed.code=RUNTIME_LOST`
  + summary（owner 行脱敏正文 / project 行仅错误码）、`run.snapshot`
  （status/failureCode/failureSummary，§6.2）。
- **Hub 投影**：`run.status` / `failure_code` / `finished_at`（DB）与
  `run.changed` Team Event；UI 警示 `data-testid=run-failure-notice`、血缘
  `data-testid=run-lineage`。

## 判定（成功长什么样）

每条场景的「成功」都是测试里的可证伪断言（见上表），红线专项：

- 终态禁复活：R5/R9 用例在 lost 之后重放心跳/snapshot/事件，断言状态仍是
  `lost` 且迟到事件已持久留证（`run_event` 行数 +1）。
- 不自动重启：G7-03/R9 在退出/孤儿处理后重发 `run.start`，断言 Runtime 数
  不变、无第二 PID、不重发 prompt。
- 强杀真人路径：`awaitDead(pid)` 以 `process.kill(pid,0)` 判死，不自证。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| 取消后 Run 卡 `cancel_requested` | `node.supervisor` 升级日志（sigterm/sigkill 是否出现）→ `apps/node/src/run/run-manager.ts` `handleRunCancel` |
| 断网误判 lost | `apps/hub/tests/resilience/run-lease-resilience.spec.ts` R4 用例 → `reconciler.ts` 租约窗口（`DEVICE_LEASE_MS=30s`） |
| 断开 30s 未判 lost | 同上 R5 用例 → `devices.last_seen_at` 是否被刷新（心跳链路） |
| Runtime 消失但 Run 不终态 | `node.supervisor` lost 日志 → `exit-classifier.ts` 归因 → `run.snapshot` 上报（Hub ingest） |
| 重跑血缘丢失 | `run-rerun.integration.spec.ts`（Hub 侧）→ `apps/web/tests/run-actions.spec.tsx`（UI 侧） |

## 取证

```bash
# 门级证据：命令输出即证据（测试内嵌结构化断言，无人工判读）
pnpm test:resilience 2>&1 | tee artifacts/evidence/q6-resilience/$(git rev-parse --short HEAD).log
# 敏感扫描（本 PR 变更文件集）
scripts/secret-scan.sh apps/hub/src apps/hub/tests apps/node/src apps/node/tests \
  apps/web/src apps/web/tests packages/protocol
```

## 边界与未覆盖

- **G7-06 的 HTTP 批准断言**：已由 P1-14（PR #59，已合入 main）的
  `approval-decision.integration.spec.ts`「G5-02：非 owner（团队 Owner 角色）
  决策被拒 403，决定仍 pending」覆盖；合并 main 后与本 PR 的断言 a
  （run-cancel-route.integration.spec.ts）共同闭环 G7-06。
- **R9 双重启边界**：Node 重启后、重连前再次重启，内存缓冲的 lost 快照丢失；
  此时 Hub 依赖心跳投影（activeRunIds 不含该 Run）与租约过期兜底收敛 lost。
- **Windows Job Object**：升级链路按进程组信号实现（darwin/linux 验证）；
  Windows experimental 路径（02 Task 16 Step 3）不在本 Issue 验证范围。
- **取消确认后的 reap**：确认后不退出的 Runtime 由 SIGTERM/SIGKILL 兜底（已
  测）；真正的 bridge 是否总是确认后自退由 Q3 shutdown 契约覆盖。
- **Q4 `pnpm test:node`**：当时根脚本尚未建立，apps/node 测试挂在
  unit/integration/resilience 项目内全量执行，本 PR 以 `pnpm check` +
  `pnpm test:resilience` 覆盖。（现状：#100 已裁决**退役 Q4**——聚合脚本不再
  建立，本段保留为历史实录；Node 覆盖归属见 04 矩阵墓碑行。）

## 复跑

```bash
git clone <repo> && cd <repo> && pnpm install && pnpm -r build
pnpm check              # Q0（含 unit/web）
pnpm test:integration   # Q2（含 G7-01/04/06 HTTP 面）
pnpm test:resilience    # Q6（R4/R5/R9 + 故障注入）
scripts/secret-scan.sh apps/hub/src apps/hub/tests apps/node/src apps/node/tests apps/web/src apps/web/tests packages/protocol
```

## 追加：#180 执行中追问的受理语义（ADR-0009 切片②）

- 对应 Issue：#180（ADR-0009 决策 3 的协议先行切片）；评审整改见 PR #181（阻断 B1 + 应改 S1–S4）
- 验证日期：2026-09-11 · 分支 `feat/p1-180-node-followup` · 结果 PASS

### 驱动

`RunManager.handleFrame({ type: 'run.followup', payload: { commandId, runId, text } })`——
与 Hub 下行同一条入口；Runtime 侧用 Q1 既有内存 fake driver（`apps/node/tests/run-manager.spec.ts`），
断言写进 Runtime stdin 的帧。协议目录一致性由 `packages/protocol/tests/catalog-drift.spec.ts`
（frame ↔ fixture 一一对应）+ `roundtrip.spec.ts`（新 fixture 走解析往返）自动覆盖。

```bash
pnpm vitest run --project unit apps/node/tests/run-manager.spec.ts
pnpm test:unit                      # 含 protocol catalog-drift / roundtrip
pnpm check:protocol-generated       # 生成物与 schema 不得漂移
```

### 判定（12 条用例，全部可失败）

| 分支 | 断言 | 结果 |
|---|---|---|
| happy path（Run 已 running） | ack `accepted=true`；stdin 追加**恰好一帧** `run.followup{runId,text}`；无第二个 Runtime、无第二次 `initialize` | PASS |
| **B1 回归**：首次被拒 → ack 丢失 → 同 commandId 重投（此时已 ready） | ack **仍为 false** 且回放**同一个拒绝码**；stdin 无 `run.followup`（不得假受理） | PASS |
| 首次已受理 → ack 丢失 → 同 commandId 重投 | 回放 `accepted=true`；stdin 仍只有一帧（幂等未被破坏） | PASS |
| 已 spool 但从未处理完（崩溃在 record 与处理之间） | 重投时**真正处理一次**（spool 本意），ack `accepted=true` | PASS |
| Run 已终态（`run.completed` 之后） | ack `accepted=false` + `INVALID_RUN_TRANSITION`；不下发 | PASS |
| Run 存在但未 `runtime.ready` | ack `accepted=false` + `INVALID_RUN_TRANSITION`；不下发 | PASS |
| **Runtime 已不在管**（`supervisor.stopAll()` 摘 handle、抑制退出事件） | ack `accepted=false` + `RUNTIME_LOST`；不下发 | PASS |
| 本 Node 无该 Run 事实 | ack `accepted=false` + `NOT_FOUND`；不 spawn | PASS |
| 重复帧（Runtime 在管） | 只回放 ack；不二次注入 | PASS |
| 回放时留结构化日志 | `info` + `replayed: rejected` + `replayedCode`（关键事件不静默） | PASS |
| 首次结果**落库失败**（磁盘满模拟） | 仍照发 `accepted=true`、不悬挂；error 级日志留痕；只注入一次 | PASS |
| **老库补列迁移**（旧 schema 库 + 历史行） | 打开后补齐 `outcome`/`error_code`/`error_message`；历史行 `outcomeOf → undefined`（按未处理完重投一次）；新结果可写可读且与 ack 同步 | PASS |

**变异验证（证明用例不是恒真）**：把「重复投递回放首次结果」改回「一律回 `accepted=true`」，
**恰好 2 条**回归用例转红（B1 回归 + 崩溃后重投），其余 34 条仍绿；还原后 36/36 绿。

### 未覆盖与已知窗口（如实登记）

1. **`accepted=true` 不保证字节到达 Runtime**：Node 侧只保证「已写入在管进程的 stdin」，driver
   把 stdin 写失败统一归因为 stderr（#107 有意设计）。已知窗口：**进程已死、退出事件尚未投递**——
   那一瞬 handle 仍在管、派发返回成功，而追问被无声吞掉。要让受理更强，需让发送路径能报投递
   失败（driver 层改动），不在切片② 范围。
2. **Hub 半场（发送方）本片不存在**：`run.followup` 在产线还没有发送方（grep `apps/hub/src` 无
   生产代码）。指令落库、`instruction_state` 收敛属切片③，授权属切片④。本片验的是 **Node 半场的
   受理与拒绝语义**，不是端到端追问链路；「模型确实收到追问」同样待切片③ 接入后由 Q5/Q6 覆盖。
3. **spool 只进不出**：`spooled_command` 无删除与保留期，payload 全文入库——`run.followup` 把
   增长率从「每 Run 一行」变成「每条消息一行、每行最多 20 000 字」。已登记，清理策略与 §9 日志
   保留期一起定。另外：**除 `run.start` 外本 Node 不主动重放 command**（`pending()` 目前只有测试
   消费者），ack 丢失时的唯一恢复路径是 Hub 按同一 commandId 重投。
4. **首次结果落库失败 + ack 也丢失**（#181 评审 N1 的残留极窄窗口）：落库失败已降级为
   「仍照发 ack + error 留痕」（不会悬挂、正常情况下不会重投），但若那条 ack **同时**丢失，
   Hub 重投时 `outcomeOf` 仍为空 → 命中「无处理结果 → 重新处理」→ 同一句追问**二次注入**。
   彻底解需本地帧带 `commandId` 让 Runtime 去重（runtime-wire 变更，后续切片）。
5. **`command.ack` 的 `error.code` 今天不会被 Hub 解释**（`apps/hub/src/modules/run/orchestrator.ts`
   对非 `run.start` 的 ack 直接 return）：切片③ 必须把映射写进同事务，否则被拒的指令会静默消失。
   §6.3 已写出要求的映射表与「不要照抄 run.start 失败映射」的告警。

### 协议面

`run.followup` 已进 `03-领域模型与运行协议.md` §6.3（权威本文），本地 wire 同名帧在 §7.1；
两侧命名按本仓避让方向（runtime 侧加前缀）：`RuntimeRunFollowupSchema` ↔ `RunFollowupSchema`。
