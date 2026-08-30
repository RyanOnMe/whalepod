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
| G7-04/G7-05（UI） | `apps/web/tests/run-actions.spec.tsx` | 时间线「由 Run xx 重跑」；终态 Run「重跑此 Run」→ 确认 POST 带 `rerunOfRunId`；活跃 Run「取消 Run」带 Idempotency-Key；member 不可见动作 |
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
- **Q4 `pnpm test:node`**：根脚本尚未建立（AGENTS 门表仍标「待 P1-12」），
  apps/node 测试现挂在 unit/integration/resilience 项目内全量执行，本 PR 以
  `pnpm check` + `pnpm test:resilience` 覆盖。

## 复跑

```bash
git clone <repo> && cd <repo> && pnpm install && pnpm -r build
pnpm check              # Q0（含 unit/web）
pnpm test:integration   # Q2（含 G7-01/04/06 HTTP 面）
pnpm test:resilience    # Q6（R4/R5/R9 + 故障注入）
scripts/secret-scan.sh apps/hub/src apps/hub/tests apps/node/src apps/node/tests apps/web/src apps/web/tests packages/protocol
```
