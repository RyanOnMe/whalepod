# RD-02a-2a Run 工作输入清单与交付状态验收

- 对应场景/门禁：ADR-0028 §3 的 Run 清单/交付半边；Q0 静态门、Q2 数据门
- 对应 Issue：#492（RD-02a-2a，母 Issue #484）
- 上次验证：2026-11-02 · 分支 `feat/rd-02a2-work-input-manifest`（本 PR）· PASS
- 本切片边界：只做 Hub/PostgreSQL 的不可变 `workInputManifest`、交付尝试、`delivered/unconfirmed` 与 60s 回到 `pending`；**不实现 Node 下载、Runtime `read_work_input`、`consumed/duplicate` 消费回执**（归 #493）。

## 验的是哪条用户路径

Task 当前责任人在既有工作上把几条 pending 收件箱条目显式带进一次新 Run。创建事务必须复核这些条目属于同一 active work/Task、来源仍可读且版本未变，然后把它们冻结为不可变清单；Run 读面只显示清单摘要，正文仍留在收件箱私有快照。Run 创建成功后条目进入 `delivered` 并留下交付尝试；Run 终态仍未消费时先转 `unconfirmed`，60 秒对账窗口结束仍无回执才回到 `pending`（保留尝试历史）。来源撤权时已交付条目转 `retracted`，交付尝试转 `withdrawn`。

## 驱动（怎么触发）

全部走生产 HTTP 与真实 PostgreSQL（`apps/hub/tests/work-input-manifest.integration.spec.ts`）：

```bash
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-input-manifest.integration.spec.ts
```

覆盖的入口：

- `POST /api/v1/tasks/:taskId/works`（RD-01/RD-02a-1）
- `POST /api/v1/works/:workKey/inbox-items`（RD-02a-1）
- `POST /api/v1/tasks/:taskId/runs`，body 新增 `workInputItemIds`
- `POST /api/v1/works/:workKey/inbox-items/:itemId/retract`（来源撤权）
- `GET /api/v1/works/:workKey/inbox`（交付状态与计数）
- Run 终态事件走既有 `run.event`（FakeDeviceGateway + 真实 Orchestrator）；60s 对账直接调用 `reconcileWorkInputs(database, now)`。

## 观测（看什么）

- Run 行：`work_key`、`work_input_manifest`、`work_input_manifest_digest`；同一事务写入，创建后不可改。
- `work_inbox_item`：`delivery_run_id`、`delivered_at`、`unconfirmed_at`、`consumed_at` 与状态 `delivered/unconfirmed/consumed`。
- `work_inbox_delivery`：每次尝试的 `attempt/sent_at/acked_at/failed_at/settled_at/status/manifest_digest/failure_reason`。
- `work_input_consumption`：消费对账表已建，写入归 #493。
- 读面：收件箱条目带交付 Run 与时间；水位新增 `deliveredCount/unconfirmedCount/consumedCount`，不替换 `pendingCount/lastItemAt`。
- Run 读面：`workKey`、`workInputItemCount`（条目数）、`workInputManifestDigest`；条目标识/标题/来源不随读面广播，正文也不在清单里。

## 判定（成功长什么样）

### 1. 冻结与不可变

- `workInputItemIds` 必须非空、无重复、≤32；空数组/重复/超限 `400 VALIDATION_FAILED`。
- 只有 Task 当前责任人能带工作输入；被授权成员即使能驱动 Run，带 `workInputItemIds` 也是 `403 FORBIDDEN`。同 Idempotency-Key 回放和并发回读同样按**当前**责任人复核，不能借缓存回执绕过。
- 所有条目必须同 work、同 Task、同项目；work 必须 `active`、owner 与 Task 当前 assignee 一致；条目必须 `pending`。
- 创建事务内逐条重跑 `loadWorkSource`：来源被纠正/停用/推断/越界/撤权，或 `sourceVersion/sourceDigest/authorizationGeneration` 与关联时不一致，`409 CONFLICT`，不冻结、不建 Run。
- 条目快照正文必须与 `bodyDigest` 一致；来源正文也必须与关联时摘要一致，否则拒绝。
- 清单条目按 `inboxItemId` 字节序稳定排序；`manifestDigest = sha256(canonicalJson(manifest))`，可从数据库清单重算一致；同 Idempotency-Key 重放返回同一 Run 与同一清单。
- Run 创建后编辑来源不改变 Run 的清单/摘要；正文不进入清单或 Run 行。
- 同一批条目并发创建两个 Run 时由 Task 行锁串行化：一个成功，另一个因条目已非 `pending` 返回 `409`，只落一条交付尝试。

### 2. 交付

- Run 创建事务内为每个条目写一条 `work_inbox_delivery(attempt=1,status='sent',sent_at=now,manifest_digest)`，并把 item 置 `delivered`、写 `delivery_run_id/delivered_at`；任一失败整体回滚。
- 同一条目再次作为新 Run 输入时因不再是 `pending` 被拒绝（`409 CONFLICT`）。
- 每次 Run 的交付尝试独立保留：条目 60s 回到 `pending` 后再交付给下一 Run，会新增一行 delivery（`attempt=1` 针对该 Run），旧行仍是 `returned`，不被覆盖。
- Run 创建仍走既有 outbox `run.start`；本切片**不**把工作清单放进 `run.start`，Node 对该字段无感知（#493）。

### 3. Run 终态与 60s 对账

- Run 进入任意终态（completed/failed/cancelled/lost）时，同事务把该 Run 下 `delivered` 条目转 `unconfirmed`（`status_reason='run_ended_awaiting_receipt'`），delivery 转 `unconfirmed`。
- 对账窗口从 `unconfirmed_at` 起算 60s；`reconcileWorkInputs(now)` 在窗口内不动作，到期把无消费条目标 `pending`（`status_reason='run_ended_unconsumed'`），清空交付指针，delivery 转 `returned(failure_reason='run_ended_unconsumed')`。
- 每条到期输入在**独立事务**内收口（`Work → item` 锁序），单条失败不回滚已成功条目，也不会让整轮 tick 卡死；同一时间点重跑幂等，已收口条目返回 0。
- 若同来源已有更新条目，旧版本不回 `pending`，而是 `superseded(new_version)`；delivery 转 `returned(superseded_by_new_version)`，避免撞来源 pending 唯一索引或让 #493 重投旧版本。两个版本同时 `unconfirmed` 时也只允许一个回到 `pending`，不依赖时间戳/id 的先后选择。
- 对账只改收件箱/交付记录，不改 Run 终态；Run 不复活。
- 服务端 10s tick 调用同一对账函数；测试以 59s/61s 两个时间点证明窗口边界。

### 4. 来源撤权

- 已交付条目被来源级 retract 时置 `retracted`，清空交付指针；delivery 转 `withdrawn(source_retracted)`。
- Run 已冻结的清单不因 retract 改变；#493 必须在 Node 读取前复核撤权并拒绝/标记 duplicate。

### 5. 读取面

- `GET /works/:workKey/inbox` 返回条目交付 Run/时间与 `pending/delivered/unconfirmed/consumed` 计数；计数与条目在同一个 `REPEATABLE READ` 只读事务内。
- `GET /runs/:runId` 与幂等回放只给 `workKey`、`workInputItemCount`、`workInputManifestDigest`；条目标识、来源 id 与标题不出现在响应里。被授权成员也不能通过回放读取清单摘要。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| Run 创建 409 | `work/run-inputs.ts` 的 work/Task/owner/status/source/摘要校验 |
| 清单缺失 | HTTP 路由是否透传 `workInputItemIds`、orchestrator 是否调用 `snapshotWorkInputs` |
| 条目未变 delivered | `recordWorkInputDeliveries` 是否在 Run 创建事务内、delivery 行是否写入 |
| 终态仍 delivered | `applyRunStatus` 的终态 hook、`markWorkInputsUnconfirmed` |
| 60s 后仍 unconfirmed | `reconcileWorkInputs`/server tick、`unconfirmedAt`、`listDueUnconfirmedWorkInputIds` |
| 回到 pending 撞唯一索引 | 是否存在更新版本；应走 `superseded(new_version)`；检查是否逐条持 Work 锁收口 |
| 被授权成员带入/回放工作输入 | `createInTransaction` 的 `right !== 'assignee'` 与 `assertWorkInputAssignee` 回放复核 |
| Run 读面出现条目 id/标题 | `toRunView` 是否只映射 `workInputItemCount`/digest，未把内部 manifest 原样外送 |
| 撤权后仍 delivered | retract sweep 状态集合与 delivery withdraw 更新 |

## 取证

```bash
# 定向
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-input-manifest.integration.spec.ts

# 门禁
pnpm check
pnpm test:integration

# 合入前敏感扫描
scripts/secret-scan.sh .
```

本切片实测（2026-11-02）：

- Q0：`212` 个测试文件 / `2272` 条通过。
- Q2：`87` 个测试文件 / `748` 条通过；定向 manifest `16` 条通过。
- 单点变异 `M1–M23` 全部 RED（M20 的 SQL 过滤与结算复核是两层冗余保护，分别单点变异各由 `listDue` 与直接结算用例判红）。

## 变异自证

每次只改一处生产代码，跑定向 manifest 用例，必须变红后恢复。

| # | 变异 | 被哪条判据抓住 |
|---|---|---|
| M1 | Run 创建不记录 delivery/item 仍 pending | 清单冻结后条目 delivered + delivery 行 |
| M2 | 跳过 active work 校验 | 退休工作输入 409 |
| M3 | 跳过顶层 work/Task/项目/owner 归属校验 | 跨 Task 输入 409 |
| M4 | 跳过逐条 work/Task 归属校验 | 第二份条目 task 损坏 409 |
| M5 | 跳过来源版本/摘要/代次重验 | 仅 `editedAt` 变化的 stale 输入 409 |
| M6 | 跳过正文摘要校验 | 篡改 item body/bodyDigest 409 |
| M7 | 跳过重复 item id 校验 | 重复输入 400 |
| M8 | Run 终态不标 unconfirmed | 终态后条目仍 delivered |
| M9 | 对账忽略“同来源已有更新版本” | 旧版本回 pending 撞唯一索引/测试红 |
| M10 | retract 不扫 delivered/unconfirmed | 已交付条目未转 retracted |
| M11 | retract 不撤回 delivery | delivery 仍 sent |
| M12 | 水位缺 deliveredCount | 读面 schema/计数断言 |
| M13 | 路由不透传 workInputItemIds | 清单缺失 |
| M14 | Run 不写清单列 | Run 读面无清单 |
| M15 | 跳过 owner 一致性校验 | 故障注入 work owner 409 |
| M16 | 删除创建事务内的 assignee-only 校验 | 被授权成员带输入建 Run 返回 201 |
| M17 | 删除普通幂等回放的 assignee 复核 | 被授权成员用旧 key 回放拿到 201 |
| M18 | RunView 原样返回内部 manifest | 读面出现 `workInputManifest`/条目 id |
| M19 | 对账忽略“同来源已有 pending” | 旧版本回 pending 撞 23505 |
| M20a | 去掉到期列表的 cutoff 过滤 | `listDueUnconfirmedWorkInputIds` 在 59s 返回未到期条目 |
| M20b | 去掉结算内的 `unconfirmedAt` 复核 | 绕过列表直接结算时提前返回 1 |
| M21 | 结算改成 item→Work 锁序 | 边界静态用例（Work 必须先于 item） |
| M22 | 对账改成整轮一个事务 | 边界静态用例（每条到期输入独立事务） |
| M23 | 删除活跃冲突回读的 assignee 复核 | 边界静态用例（两条回放路径都要复核） |

## 边界与未覆盖

- **无 Node/Runtime**：没有 bundle 下载、`read_work_input`、消费回执、`consumed/duplicate/duplicate_consumption`；终态一律 unconfirmed→pending，除非 #493 写入消费。
- **清单未进 `run.start`**：Node 当前完全不知道 `workInputManifest`；#493 增加 wire 字段与旧 Node 能力门。
- **delivered 只代表进入 Run 的队列**：不是 Node 已收到/已落盘；`acked_at/failed_at` 留给 #493。
- **file 正文仍在收件箱私有快照**：Run 清单只有摘要；读权限仍只有当前 assignee。
- **人类 HTTP 入口**：`workInputItemIds` 只在 `POST /tasks/:taskId/runs` 透传；指令/自动/评审建 Run 入口未携带（#493/RD-03 按需接）。
- **不要求 Mandate**：人类 Run 可显式使用工作输入；RD-03 自主派发必须按 Mandate 与实时权限复核，不能把本切片当授权。
- **不批量迁移退休工作**：work 退休后新 Run 不能取输入；已交付条目的对账仍按本切片走。
- **60s 是粗粒度 tick**：服务端每 10s 扫一次，实际回到 pending 可能晚于 60s 数秒；验收以函数时间点证明边界，不承诺秒级精度。
- **delivery attempt 固定为 1**：本切片每次 Run 只交付一次，`attempt` 是该 `(item, run)` 的首次尝试；ack/重试/迟到的消费回执归 #493。
- **consumed 后撤权**：本切片没有消费回执，故不存在 `consumed` 行；#493 接管后按 ADR-0028 记录 `duplicate_consumption`，不再让来源级 retract 改写已消费历史。
- **直写夹具四处**：篡改 item body、篡改 bodyDigest、改 item.taskId、改 work.humanOwnerUserId，均只用于触发 fail-closed 分支，测试内写明 removeWhen；不写运行时投影。
- **未做并发压测**：Task 行锁串行化 Run 创建；未测大量并发选择/撤权争用。

## 复跑

```bash
# 干净环境（需 Docker）
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-input-manifest.integration.spec.ts
pnpm check
pnpm test:integration
```

迁移为 `0026_run_work_inputs.sql`（只提交 enum 值，避免同事务使用新 enum）与 `0027_run_work_input_tables.sql`（Run 列、item 交付字段、delivery/consumption 表）。
