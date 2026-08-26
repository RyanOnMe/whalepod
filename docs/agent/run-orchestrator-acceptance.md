# Run Orchestrator 与事务 Outbox 派发 验收

- 对应场景/门禁：G4-01..03、R7/R8（04-验收矩阵与测试策略.md）、Q0/Q2
- 对应 Issue：P1-10
- 上次验证：2026-08-25 · feat/p1-10-run-orchestrator · 结果 PASS（干净 checkout 复验）

## 验的是哪条用户路径

Assignee 在已接受的任务上创建 Run：单事务落 Run/TeamEvent/Outbox run.start；worker 把帧派发给 Device（FakeGateway 模拟，真实 WS 是 P1-09/13）；Node 的 ack 上行把 queued→dispatching，runtime.ready 事件推进 running，run.completed 收尾 completed；取消（queued 同事务作废待投 / 活跃态入队 run.cancel）；Hub 崩溃/ack 丢失后恢复继续收敛（R7/R8）。

## 驱动（怎么触发）

不经过 HTTP（routes 由组合根 P1-13 接线）：测试直驱 `RunOrchestrator` + `OutboxWorker` + `packages/testkit` 的 `FakeDeviceGateway`/`FakeClock`（六原语 #1 的 Fake Adapter 形态，与真实路径同构：同一协议 schema、同一 Outbox 表、Node 上行帧走 `ingestNodeEvent` fail-closed 解析）。数据库是 Docker 一次性 PostgreSQL 18：

```bash
pnpm test:integration            # Q2：packages/db + apps/hub 全部 integration spec
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests
```

## 观测（看什么）

- DB 行与状态：`run`（status/dshSessionId/finishedAt）、`dispatch_outbox`（acked_at/failed_at/退避）、`run_event`（(runId,seq) 去重）、`team_event`（run.changed/run.event）、`task`（open→in_progress）。
- FakeGateway 计数：`runtimeStartCount`（run.start 每新 commandId 恰一次）、`cancelledRunIds`、`sent` 帧（重发可见）。
- 帧合法性：下行帧过 `NodeDownstreamSchema`、上行帧过 `parseNodeFrame`（fail-closed）。

## 判定（成功长什么样）

- G4-01：queued→dispatching→running→completed 全链走查；Runtime 恰好启动一次。
- G4-02：同幂等键重放返回首次结果（command_receipt）；并发同键恰一次生效，败者回读回执返回胜者结果。
- G4-03：活跃唯一（并发 5 起仅 1 成）；终态禁复活（迟到 run.event 留证不迁移）。
- R7：ack 丢失后同 commandId 重投，Node 侧（spool）不重复执行 run.start。
- R8：提交后 worker 重启（新建实例）继续派发；queued 缺 run.start 由 reconciler 换新 commandId 重投；租约过期→lost(RUNTIME_LOST)；数据损坏行 fail-closed 置 failed。
- 取消：queued 取消后 run.start 永不被派发（作废行）；dispatching/running 取消入队 run.cancel，重复取消幂等。

## 归因（失败先看哪层）

- Run 状态不对 → `apps/hub/src/modules/run/orchestrator.ts`（transitionRun 放行白名单）。
- 派发不到 Node / 重投行为不对 → `apps/hub/src/modules/run/outbox-worker.ts` + `packages/db/src/outbox.ts`（claim/ack/fail 语义）。
- 恢复异常 → `apps/hub/src/modules/run/reconciler.ts`（租约 30s、activity 投影）。
- 帧解析失败 → `parseNodeFrame`（协议层）与 FakeGateway 的帧构造。

## 取证

```bash
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests
# 改动文件过敏感扫描：
bash scripts/secret-scan.sh apps/hub packages/db packages/testkit
```

## 边界与未覆盖

- **驱动边界**：本链不经过 HTTP 路由（routes 已写好但未挂组合根；路径与 requestId 约定已与 #38 对齐，P1-13 接线时直接 `app.register` 于 `/api/v1` 前缀下即可）。真实 WebSocket gateway、设备 token 认证是 P1-09；NOTIFY 唤醒是文档明示的优化，未做。
- `dshDistributionVersionFor` 悬空已由 #37 关闭：device 列于 migration 0002 补齐，`queries.getDeviceDshDistributionVersion` 提供真实查询并有测试；hello 回填（真实数据源）仍是 P1-09，路由注册仍是 P1-13。
- acked_at 语义以 03 §2.6 为准（Node command.ack 才写），与 02 Task 10 Step 4 草图不同。
- `findOutboxCommandsForRun` 走 `payload->>'runId'` 无索引扫描，第一阶段规模可接受。

## 复跑

```bash
corepack enable && pnpm install && pnpm -r --if-present build
pnpm test:integration && pnpm check
# 必须在不位于 .worktrees/ 布局的干净 checkout 里跑，验证测试不依赖目录巧合。
```