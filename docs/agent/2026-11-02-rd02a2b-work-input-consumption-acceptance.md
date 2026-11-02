# RD-02a-2b 工作输入正文交付与消费回执验收

- 对应场景/门禁：ADR-0028 §3 的 Node 下载、Runtime 读取与消费回执半边；Q0 静态门、Q2 数据门、Q3 DSH 契约门、Q6 故障门
- 对应 Issue：#493（RD-02a-2b，母 Issue #484）
- 上次验证：2026-11-02 · 分支 `feat/rd-02a2b-work-input-consumption`（本 PR）· PASS
- 本切片边界：把 #492 冻结的清单送到 Node/Runtime，并把「已交付/已读取」回执落成 Hub 的 `consumed/duplicate/duplicate_consumption` 事实；**不实现**订阅快路径（RD-02b）、自主派发/自动执行（RD-03）与模型必须读取的强制策略。

## 验的是哪条用户路径

Task 当前责任人在创建 Run 时显式带上 pending 收件箱条目。Hub 在 Run 创建事务里冻结不可变清单（#492），`run.start` 只携带清单头与逐条元数据，不带正文。Node 凭 Device Token 和 Run 归属调用受控下载端点取得正文，逐条核对 `bodyDigest/byteSize` 后写入 `<stateDir>/runtime-work-inputs/<runId>/<inboxItemId>`，再在 `runtime.initialize` 里把清单与本地目录成对交给 Runtime。Runtime 只注册 `read_work_input`：模型按 `inboxItemId` 从白名单读取，读取时再次核对摘要；`runtime.ready` 发一次 `delivered` 回执，每次成功读取发一条 `read` 回执。Node 把回执累计成带持久 `receiptSeq` 的 `run.work_input_receipt` 上行（断线保留、重连补发）；Hub 在 Run 终态后的 60 秒窗口内把条目置 `consumed`，窗口外只记 `duplicate`/`duplicate_consumption` 对账，**不复活 Run**。

## 驱动（怎么触发）

全部走生产 HTTP、真实 PostgreSQL、真 Node 装配与 Q3 真 boot/replay 栈：

```bash
# Hub：Run 创建 → 清单 → bundle → 回执状态机（29 条）
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-input-manifest.integration.spec.ts

# Node：downloader / 持久回执 / RunManager 接线（63 条）
pnpm exec vitest run --project unit \
  apps/node/tests/work-input.spec.ts \
  apps/node/tests/work-input-receipt.spec.ts \
  apps/node/tests/run-manager.spec.ts

# Runtime 工具单测 + Q3 真栈（4 + 3 条）
pnpm exec vitest run --project unit packages/runtime-dsh/tests/work-input-tool.spec.ts
pnpm test:dsh-contract -- packages/runtime-dsh/tests/dsh-contract/work-input.contract.spec.ts
```

覆盖的入口：

- `POST /api/v1/tasks/:taskId/runs`（body `workInputItemIds`，沿用 #492）
- `GET /api/v1/node/runs/:runId/work-input/bundle`（Device Token + Run 归属）
- `run.start` 新字段 `workInput.{manifestDigest, manifest}`（只读清单）
- `runtime.initialize.workInputs.{workKey, manifestDigest, entries, entriesDir}`
- Runtime 工具 `read_work_input({ inboxItemId })`
- 上行 `run.work_input_receipt`（`delivered`/`read` 累计回执）
- Run 终态事件走既有 `run.event`；60 秒对账走 `reconcileWorkInputs(database, now)`
- Node 断线/重连走既有会话 `send` 返回值与 `onReconnect`

## 观测（看什么）

- `run.work_input_receipt`：`receipt_seq`、累计 `entries_delivered/entries_read`、本批 `read_events`、`missing`、`digest_verified`、`received_at`；唯一键 `(run_id, manifest_digest, receipt_seq)`。
- `work_input_consumption`：`kind=consumed|duplicate|duplicate_consumption`、`receipt_id`、`read_at`；唯一键 `(run_id, inbox_item_id)`。
- `work_inbox_item`：`status=consumed/duplicate/duplicate_consumption`、`delivery_run_id`、`consumed_at`。
- `work_inbox_delivery`：`acked_at`、`status=consumed|duplicate|duplicate_consumption`、`failure_reason=receipt_after_window|consumed_by_another_run|...`。
- 结构化日志：`component=hub.work_input`（`work.input_receipt`，只含计数/序号/id）与 `component=node.work_input`（准备、转发、丢弃原因）。
- Runtime 本地 wire：`runtime.work_input_receipt`（`delivered` 在 ready 后、`read` 在成功读取后）。
- 本地副本：`runtime-work-inputs/<runId>/<inboxItemId>`，终态/启动拒绝后被清理。

## 判定（成功长什么样）

### 1. 能力协商与清单下发

- `node.hello.contextCapabilities` 新增 `work-input.v1`；Node 生产装配默认声明 `project-context.v1` 与 `work-input.v1`。
- 带非空 `workInputItemIds` 的 Run 创建时，目标 Node 未声明 `work-input.v1` → `409 CONTEXT_UNAVAILABLE`，不建 Run。
- `run.start.payload.workInput` 只含 `manifestDigest` 与清单（身份/版本/摘要/标题），不含 `body`；同一 Run 幂等回放返回同一清单与摘要。
- Node 收到清单但未装配下载器 → `command.ack accepted=false, code=CONTEXT_UNAVAILABLE`，不 spawn Runtime，并清理已准备的副本。

### 2. Node 受控下载

- `GET /node/runs/:runId/work-input/bundle` 只接受 Run 所属 Device Token；其他设备得到 `404`（不可枚举）。
- 响应条目按 `inboxItemId` 对应清单：版本/来源摘要/正文摘要/字节数/授权代次/标题/来源 id 任一不符 → 整包 `409 CONTEXT_UNAVAILABLE`，不写半成品。
- 正文 base64 解码后重新计算 SHA-256 与 `byteSize`，两者都必须匹配清单。
- 清单条目缺失、重复或出现清单外条目 → 拒绝并清理目录。
- 已消费/已撤回/不再属于该 Run 的条目不再可下载（bundle `409`）。
- Hub 失败码原样透传；网络失败映射 `DEVICE_OFFLINE`，未知 5xx 映射 `INTERNAL_ERROR`。
- 下载成功后副本目录按 `inboxItemId` 命名；`runtime.initialize.workInputs` 与清单成对出现，缺一不发。

### 3. Runtime 读取

- 只有 `runtime.initialize.workInputs` 存在时才注册 `read_work_input`；没有清单时该工具不存在（模型得到 unknown-tool）。
- 工具只按清单白名单读取，`../../escape.md`、`/etc/passwd` 等路径形 id 在触碰文件系统前拒绝，错误消息不出现本机绝对路径。
- 每次读取重新核对 `byteLength/bodyDigest`；不符返回错误且**不发** `read` 回执。
- 成功结果同时投影结构化字段（`inboxItemId/sourceType/sourceId/sourceVersion/title/digest/byteSize/truncated`）与正文；Q3 replay 用 `{{fromRequest:RD02A2_ECHO}}` 证明正文进入下一次模型请求。
- ready 后发 `delivered` 回执（条目集合来自 initialize 清单），每次成功读取发 `read` 回执；两者 `workKey/manifestDigest` 与 Run 一致。

### 4. Node 回执持久化与补发

- `receiptSeq` 按 `(runId, manifestDigest)` 持久单调，跨 Node 进程重开同一 SQLite 文件继续递增；不同 Run/清单各自从 1 开始。
- `delivered/read` 累计集合持久化，重启后能重建累计回执；同一 Run 的重复读取不新增消费事实。
- 回执先入本地 outbox 再发送；`send` 返回 false（断线）时保留，`onReconnect` 补发成功后才删除。
- Node 对不在清单内的 `delivered/entriesDelivered` 条目做过滤；对未知 `inboxItemId` 的 read 回执直接丢弃并留 warn 日志；清单身份不符的回执同样丢弃。
- Run 终态或 `run.start` 拒绝后清理本地副本与内存清单；已入 outbox 的未发回执不受此清理影响。

### 5. Hub 消费状态机

- 回执必须属于该 Run 的 Device、`workKey` 与 `manifestDigest` 匹配、`(runId,inboxItemId)` 在清单内；否则 `CONFLICT`，不落回执行。
- 回执先落 `run_work_input_receipt`（append-only）；同 `(run, manifest, seq)` 重放幂等，不新增消费行、不重复推进状态。
- `digestVerified=false` 的 read 不消费；`digestVerified=true` 但任一 `readEvent.digestVerified=false` 整帧拒绝（事务回滚）。
- Run 仍 `delivered`，或终态后 `unconfirmed` 且距 `unconfirmedAt` ≤60 秒（以 **Hub `now`** 判定）→ 置 item `consumed`，写 `work_input_consumption(kind=consumed)`，delivery `status=consumed, acked_at=now`。
- 同 Run 再次读取同一条目 → `duplicate`（不新增第二行消费；delivery 保持 consumed）。
- 条目已被后续 Run 消费，旧 Run 回执迟到 → `duplicate_consumption`，旧 delivery 同步标记；不改变新 Run 的已消费事实。
- 终态超过 60 秒才到 → `duplicate`（`failure_reason=receipt_after_window`），不消费；后续对账仍可把条目收回 `pending`。
- 任何回执路径都不改变 Run 状态；`run_work_input_receipt` 在 Run 终态后继续接受。
- 读回执在插入回执前先取 Work 行锁（`Run → Work → receipt/item`），避免两条并发读回执各持 Work KEY SHARE 再升级 FOR UPDATE 的死锁；纯 delivered 回执不改条目，不取 Work 锁。

### 6. 与 #492 对账的衔接

- 窗口内读取成功后，Run 终态→`unconfirmed` 的 60 秒对账返回 0（条目已 `consumed`），不会把已消费条目退回 pending。
- 窗口外迟到读取只留对账事实；原对账仍按 #492 规则把条目回 `pending`（或按来源版本 `superseded`）。
- 撤权/Run 终态/清理路径不删除已消费历史；`work_input_consumption` 唯一键保证一个 Run 对一条目只有一条消费/重复事实。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| Run 创建 409 CONTEXT_UNAVAILABLE | Node hello 是否声明 `work-input.v1`；`assertWorkInputCapability` |
| run.start 无 workInput | orchestrator 是否把 `workInputs.manifest/digest` 放进 payload；Q0 生成 schema 是否同步 |
| Node 不 spawn、ack 拒绝 | `prepareWorkInputs` 是否装配；download 错误码是否原样透传 |
| bundle 404 | 请求设备是否 Run 所属；Run 是否真的冻结了清单 |
| bundle 409 | 条目状态（consumed/retracted）、存储正文摘要/字节数、清单身份 |
| initialize 缺 workInputs | Node 下载是否成功、`workInputs` map 是否写入、pair 字段是否被丢 |
| 模型看不到工具 | initialize 是否带 entries/entriesDir；`session-owner` 是否注册 |
| read 报 digest 错 | 本地副本被改写/截断；Node 下载是否绕过摘要校验 |
| 回执没上行 | Runtime 是否发 `runtime.work_input_receipt`；Node `handleWorkInputReceipt` 的 workKey/digest 过滤；outbox/重连 |
| 条目没 consumed | 回执 seq/身份、`digestVerified`、item 状态与 60 秒窗口、Hub `now` |
| 迟到回执被判 duplicate | 预期行为：窗口外只对账；不是 consumed |
| 跨 Run 重复消费 | 检查新 Run 是否先消费；旧回执应落 `duplicate_consumption` |
| 重连后回执 seq 冲突 | Node SQLite `next_seq` 是否持久；Hub 是否已有同 seq 回执行 |
| 终态后本地副本残留 | `cleanupInputs` / `cleanupWorkInputs` 是否被调用 |

## 取证

```bash
# 定向（本切片）
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-input-manifest.integration.spec.ts
pnpm exec vitest run --project unit \
  apps/node/tests/work-input.spec.ts \
  apps/node/tests/work-input-receipt.spec.ts \
  apps/node/tests/run-manager.spec.ts
pnpm exec vitest run --project unit packages/runtime-dsh/tests/work-input-tool.spec.ts
pnpm test:dsh-contract -- packages/runtime-dsh/tests/dsh-contract/work-input.contract.spec.ts

# 门禁
pnpm check
pnpm test:integration
pnpm test:dsh-contract
pnpm test:resilience
pnpm test:security

# 合入前敏感扫描（默认扫 artifacts/evidence；改动面另扫）
scripts/secret-scan.sh
scripts/secret-scan.sh apps/hub/src apps/node/src packages/db/src packages/db/migrations packages/protocol/src packages/runtime-dsh/src
```

本切片实测（2026-11-02）：

- 定向：Hub `29` 条、Node `63` 条、Runtime 工具 `4` 条、Q3 新契约 `3` 条、边界静态 `4` 条，全部通过。
- Q0：`215` 个测试文件 / `2301` 条通过。
- Q2：`87` 个测试文件 / `761` 条通过（含本切片 29 条）。
- Q3：`21` 个测试文件 / `86` 条通过（含新 replay 正控与拒绝面）。
- Q6：`6` 个测试文件 / `34` 条通过。
- Q7：`4` 个测试文件 / `18` 条通过，secret-scan 自检/实扫与依赖许可 gate 通过。
- 单点变异 `M1–M27` 全部 RED，逐条见下表。

## 变异自证

每次只改一处生产代码，跑对应定向用例，必须变红后恢复。临时脚本不提交。

| # | 变异 | 被哪条判据抓住 |
|---|---|---|
| M1 | bundle 不校验 Run 所属设备 | 跨设备 GET bundle 期望 404 |
| M2 | bundle 放行非 delivered/unconfirmed 条目 | 已消费后再次 GET bundle 期望 409 |
| M3 | bundle 去掉存储正文摘要复核 | 等长篡改正文后 GET bundle 期望 409 |
| M4 | 派发前工作输入复核整体短路 | 撤权后 Run 仍被派发（期望 failed CONTEXT_UNAVAILABLE） |
| M5 | 创建 Run 跳过 `work-input.v1` 能力门 | 未声明能力的设备创建带输入 Run 期望 409 |
| M6 | 回执不校验清单外条目 | 未知 `entriesDelivered` 的回执被接受 |
| M7 | 去掉回执级 `digestVerified` 短路 | 未验证回执被逐条校验拒绝（期望成功记录） |
| M8 | 去掉逐条 `digestVerified` 校验 | 信封 true/单条 false 的回执被消费 |
| M9 | 60 秒窗口判断恒真 | 迟到回执被 consumed；对账/DB 约束同时判红 |
| M10 | 同 Run 重复读取不短路 | 重复读取后 delivery 被改写为 duplicate |
| M11 | 跨 Run 迟到回执一律记 duplicate | 旧 Run 回执未记 `duplicate_consumption` |
| M12 | 窗口外 unconfirmed 不记 late | 迟到回执未写 `receipt_after_window` |
| M13 | 回执不校验 workKey/manifestDigest | 伪造清单身份的回执被接受 |
| M14 | delivered 回执不写 `acked_at` | delivered-only 回执后 delivery `acked_at` 为空 |
| M15 | 读回执先插回执再取 Work 锁（或只无锁读） | 边界静态用例（Work 锁必须先于回执插入/item） |
| M16 | Node 无下载器时不 fail-closed | run.start ack 错误码从 CONTEXT_UNAVAILABLE 变成 INTERNAL_ERROR |
| M17 | Node 不丢弃清单外 read 回执 | 未知条目 read 产生上行帧 |
| M18 | Node 不丢弃清单身份不符的回执 | 错 manifestDigest 回执被上行 |
| M19 | Node 发送失败仍删 outbox | 离线回执未保留，重连补发判据红 |
| M20 | 终态不清理工作输入副本 | `cleanupWorkInputs` 断言超时 |
| M21 | Node 不过滤清单外 delivered id | 上行回执 `entriesDelivered` 出现未知 id |
| M22 | `read_work_input` 白名单失效 | 路径形 id 报“不可用”而非 unknown item |
| M23 | `read_work_input` 跳过摘要复核 | 篡改副本被成功读取 |
| M24 | `read_work_input` 不发 read 回执 | 成功读取后回执集合为空 |
| M25 | bridge ready 后不发 delivered 回执 | Q3 回执序列期望 `[delivered, read]` |
| M26 | bridge 不发 read 回执 | Q3 读取后回执序列缺 read |
| M27 | 工具 render 不投影正文 | Q3 `{{fromRequest:RD02A2_ECHO}}` 匹配失败/正文缺失 |

## 边界与未覆盖

- **没有订阅快路径**：本切片只验证人类触发、显式带 `workInputItemIds` 的 Run；订阅直达与 Router 不调用是 RD-02b。
- **没有自主派发/自动执行**：RD-03 才接 Mandate 与自动 Run；本切片的消费回执不能当作自主执行授权。
- **模型可以不读**：工具可用不等于模型必读；未读取的 Run 终态仍走 #492 的 unconfirmed→pending，不把“Run 成功”当“输入已消费”。
- **60 秒窗口用 Hub 时钟**：Node 的 `read.at` 只作为 `read_at` 事实，不参与窗口判断；多实例时钟偏差不影响消费判定。
- **seq 允许空洞**：Node 在计数器递增与 enqueue 之间崩溃会留下永久空洞；Hub 接受更高 seq（否则该 Run 后续回执永远卡死），只把已存在行视为幂等、比最大 seq 小的未见行视为 CONFLICT。
- **delivered-only 回执幂等**：重复 delivered 回执会照常写回执行（seq 不同）并 ack，不产生消费行。
- **不做 HTTP 重试/退避**：bundle 下载失败即 `run.start` 拒绝；没有下载器级重试；副本下载是启动前置条件，不是执行中补拉。
- **单条目上限 64KB**：与清单 schema 一致；Runtime 工具一次读全文，`truncated` 恒 false；大文件/附件不在本切片。
- **无模型可见性/提示词注入策略**：`read_work_input` 只做数据面；提示模型优先读取哪些条目由 RD-03/后续提示层决定。
- **无 Node 重启后的 Run 续跑**：Node 重启仍走既有 lost 收敛，不自动重放；未发回执按 outbox 补发，但 Run 不会复活。
- **直写夹具三处**：跨设备 device 行、设备能力降级、item body 等长篡改，均只用于触发 fail-closed 分支，测试内写明 removeWhen；不写运行时投影。
- **迁移 0028 只加回执/消费约束**：`run_work_input_receipt` 新表、`work_input_consumption.receipt_id` 外键与 `(run_id, inbox_item_id)` 唯一索引；不回填历史行（旧 Run 无回执）。
- **未做高并发压测**：两条并发读回执的锁序由静态判据守住；未跑多 Run/多 Node 压测。

## 复跑

```bash
# 干净环境（需 Docker）
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-input-manifest.integration.spec.ts
pnpm test:integration
pnpm test:dsh-contract
pnpm test:resilience
pnpm check
```

迁移为 `0028_run_work_input_receipts.sql`。Node 新增 `apps/node/src/work/work-input.ts`、`apps/node/src/work/receipt-store.ts`；Runtime 新增 `packages/runtime-dsh/src/work-input-tool.ts`；协议新增 `packages/protocol/src/work-input-wire.ts` 与两份 fixture。
