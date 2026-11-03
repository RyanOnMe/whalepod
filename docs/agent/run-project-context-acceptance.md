# Run 项目上下文快照与运行时消费验收（PC-05a / ADR-0027）

- Issue：#474（PC-05a）
- 合入：PR #478（squash a8f4b97，2026-11-02）
- 状态：正向最小链已交付；撤权状态机已由 PC-05b-1（#498，[验收](./2026-11-03-pc05b1-context-state-acceptance.md)）接手；watchdog、回执恢复、终态 session 清理与 `resumeContext` 仍归 PC-05b-2/-3
- 关联：[ADR-0027](../adr/0027-run-project-context-snapshot-and-consumption.md)（已采纳）、[事实账本验收](./project-context-ledger-acceptance.md)、[确定性协调验收](./project-coordination-acceptance.md)、[PC-05b-1 撤权状态验收](./2026-11-03-pc05b1-context-state-acceptance.md)

## 1 本切片交付

| 面 | 实现 | 判据 |
|---|---|---|
| 选择/冻结 | `apps/hub/src/modules/context/run-snapshot.ts`；migration `0023_run_project_context.sql` | 任务当前约定/成果/交接 Decision + 与本 Task 关联的 Run Observation；Inference/Correction 永不选入 |
| 快照头 | `selectionRuleVersion='pc05a.v1'`、`snapshotDigest`、`headerText/headerDigest`、nonce | 创建事务内生成并持久化；header ≤ 4000 字符，超出 `CONTEXT_UNAVAILABLE` |
| 容量 | 32 条 / 256KiB / 单条 64KiB | 超限进入 `unselected`（`entry_too_large`/`capacity_exceeded`）；逐条明细封顶 128 条，超出按原因聚合到 `unselectedOmitted`（header 记总数），不静默截断 |
| 派发前复核 | `verifyRunProjectContext` + `OutboxWorker.beforeDispatch` | 条目仍为当前有效版本、正文/头部 digest 未变、Node 仍声明能力；失败 `failed(CONTEXT_UNAVAILABLE)` 并把触发指令结算为 rejected（同码）；已成功写入 Node 的命令按 `dispatch_outbox.sent_at` 跳过复核（R7 ack 丢失重投不误杀） |
| 能力协商 | `node.hello.contextCapabilities` | 非空快照只向同时声明 `project-context.v1` 与 `context-state.v1` 的 Node 创建/派发（PC-05b-1 起）；空快照不受影响 |
| Node 交付 | `apps/node/src/context/project-context.ts` | `GET /node/runs/:runId/project-context/bundle`（Device Token + Run 归属）；逐条核对 digest/byteSize，不符 `CONTEXT_DIGEST_MISMATCH` 且不启动 Runtime |
| Runtime 注入 | `runtime.initialize.projectContext` + `read_project_context` | 清单/目录成对；正文不进 `executionContext`；工具按 entryId 白名单读取并复算 digest |
| 两级回执 | `runtime.context_receipt` → `run.context_receipt` | delivered/read 累计并集；Hub 校验归属、能力、headerDigest、nonce、集合与 `receiptSeq` |
| 消费事实 | `run_context_receipt` / `run_context_consumption` | 首条合格回执写 `deliveredAt`；读取写 `readAt` 与消费行；`entriesRead=0` 不算 consumed |
| 重放/新意图 | 创建事务 + command receipt | 同幂等键返回同一快照；只有新 Run 取当时新版本；旧 Run 快照/正文不变 |
| 本地副本 | `runtime-context/<runId>` | 下载失败清理半成品；Run 终态（`finalizeRun`/启动拒绝）删除该目录 |

### 1.1 选择规则的当前边界

`pc05a.v1` 的自动选入只覆盖本仓库已经存在的内部业务事实：

- Decision：`taskSpec:<taskId>`、本 Task 的 `artifact:<artifactId>`、本 Task 作为上游或下游的 `handoffReceipt:<up>:<down>`；
- Observation：`run:<runId>` 中归属本 Task 的 Run 终态事实；
- Correction 与 Inference 不进入候选。

Thread/WorkLink、`read_only` 显式选择、`model_inferred` 激活、外部来源正文均依赖 PC-03b/03c，尚未交付。因此本切片**没有**「成员勾选订阅线程」的入口；验收只声明上述内部引用面。业务 Observation 的 `snapshotAuthorizationGeneration` 为 `null`；ADR-0027 中「observation 必带代次」只适用于**来源** Observation，协议对 Decision 强制 null、对无 businessRef 的来源 Observation 强制非 null。

## 2 机器证据

### 2.1 门禁

| 门 | 命令 | 结果（2026-11-02，两轮评审修复后复跑） |
|---|---|---|
| Q0 | `pnpm check` | 210 个测试文件、2268 项通过（含 typecheck / boundaries / protocol generated / web） |
| Q2 | `pnpm test:integration` | 84 个文件、692 项通过（真实一次性 PostgreSQL） |
| Q3 | `pnpm test:dsh-contract` | 20 个文件、83 项通过（真 boot 栈 + replay） |
| Q6 | `pnpm test:resilience` | 6 个文件、34 项通过 |
| Q7 | `pnpm test:security` | 4 个文件、18 项通过；secret-scan 自检与实扫 OK；license 626 包 OK |

### 2.2 正向链证据

- [run-project-context.integration.spec.ts](../../apps/hub/tests/run-project-context.integration.spec.ts)
  - 前序 Run 发布成果并终态后，新 Run 快照固定 3 条：`taskSpec`、`artifact:<id>`、`run:<producer>`；协调评估产生的 Inference 不在快照。
  - 同幂等键重放返回同一 Run、同一快照（`run_project_context` 仍只有 1 行）。
  - `run.start.projectContext` 的 snapshotId/digest/headerDigest 与数据库一致；清单不含正文。
  - Device Token 下载 bundle 逐条正文与 digest 一致；其他有效设备 token 得到 404；成员读面返回冻结正文。
  - 新约定版本后旧快照逐字节不变；新 Run 得到新 snapshot，并绑定新版本。
  - 创建后确认纠正使派发前复核失败：Run `failed(CONTEXT_UNAVAILABLE)`，outbox 行 `failedAt` 非空，Node 未收到 `run.start`。
  - delivered 回执写 `deliveredAt`；read 回执写 `readAt`、`run_context_consumption` 与 `consumedAllAt`；完全重复的 `receiptSeq` 按幂等成功 ack 且不新增行；低水位但从未落库的 seq 补写读取事实（PC-05b-2）；终态后回执记 `receipt_late`。
  - 错误 headerDigest、`nonceMatched=false`、`entriesRead` 与 `readEvents` 不一致分别被拒。
  - 增量回执：交付后逐条读取（每条回执只带本批 readEvents），`consumedAt`/`consumedAllAt` 随进度推进；全字段写满后重复读第一条不新增消费行、不推迟首次 `readAt`（空 patch 不再触发 500）。
  - 部分交付但 `missing` 未覆盖快照全集 → `missing_set_mismatch` 拒绝且不落回执行。
  - 派发前复核失败：Run `failed(CONTEXT_UNAVAILABLE)`，触发指令同事务 `rejected`（错误码 `CONTEXT_UNAVAILABLE`）；同幂等键重发回放 `rejected`；模拟「Run 已终态但指令仍 pending」的崩溃窗口时，回放读路径按 Run 终态理由补结算，不再谎报 `started_run`。
  - 版本评审回合启动（`POST /artifact-revision-rounds/:id/start`）同样映射 `CONTEXT_UNAVAILABLE` 为 409，且不产生 Run；这是第三条建 Run 入口，不能被全局 500 吞掉。
  - R7 ack 丢失：首次 `run.start` 已写入 Node 后不投递 ack、期间纠正冻结条目，再派发仍发出同一命令，Run 保持 `queued`、`sent_at` 非空。
  - 空快照：旧 Node（未声明能力）普通 Run 201，快照 0 条，`run.start` 载荷无 `projectContext`。
  - 快照头溢出：1 条约定 + 30 条长标题 Observation 时下一次 Run 创建 409 `CONTEXT_UNAVAILABLE`，Run 与快照行数均不增加。
  - 容量与聚合：33 个候选（32 选入 + 1 条 `capacity_exceeded`）与 205 个候选（选 32、逐条明细 128、`unselectedOmitted={capacity_exceeded:45}`、header 记 173）均创建成功；读面同样返回明细与聚合。
- [project-context.spec.ts](../../apps/node/tests/project-context.spec.ts)：Node 下载副本按 entryId 命名、digest/byteSize 核对、失败清理半成品、Hub 错误码透传。
- [context-receipt-outbox.spec.ts](../../apps/node/tests/context-receipt-outbox.spec.ts)：PC-05b-2 起 receiptSeq 改由发件箱的 `enqueueNext` 在同一事务里分配；SQLite 跨进程重开继续单调、按 `(runId,snapshotId)` 隔离，并覆盖 PC-05a 旧计数文件迁移。
- [run-manager.spec.ts](../../apps/node/tests/run-manager.spec.ts)：manifest 与 entriesDir 成对进入 `runtime.initialize`；Runtime delivered/read 帧被累计为单调 `run.context_receipt`；PC-05b-2 起回执持久化/重放；PC-05b-3 起 `runtime-context/<runId>` 由终态清理队列在 Runtime 退出后删除（`cleanupProjectContext` 依赖已移除，见 [PC-05b-3 验收](./2026-11-03-pc05b3-terminal-cleanup-acceptance.md)）。
- [project-context-tool.spec.ts](../../packages/runtime-dsh/tests/project-context-tool.spec.ts)：工具只接受清单 id、读取失败不发回执、拒绝消息不含本机路径。
- [tool-boundary.contract.spec.ts](../../packages/runtime-dsh/tests/dsh-contract/tool-boundary.contract.spec.ts)：真 boot 栈中 `read_project_context` 的正文/结构化字段进入模型可见结果，并发出 delivered/read 回执；`{{fromRequest:PC05A_ECHO}}` 证明正文进入下一次模型请求，`{{fromRequest:\[project-context:}}` 证明 header 的 nonce 标记进入首条模型请求。
- [run-context.spec.ts](../../packages/protocol/tests/run-context.spec.ts)：清单代次规则、header 上限、initialize 成对字段、能力声明与回执形状。

## 3 负控与单点变异

每条新判据做一次单点变异；变异后立即恢复并通过 `git diff` 核对无残留。

| # | 判据 | 变异（单点） | 预期 | 实测 |
|---|---|---|---|---|
| M1 | Inference 永不选入 | 在候选集合中追加 Inference 并伪造 `businessVersion` | 快照不得含 Inference | 测试变红：命令 500，快照 schema 拒绝 `inference` 枚举 |
| M2 | Node 逐条 digest/byteSize | 删除 `sha256/byteSize` 比较 | 篡改副本必须拒绝 | `project-context.spec.ts` 变红（`CONTEXT_DIGEST_MISMATCH` 用例失败） |
| M3 | 旧 Node 不派发非空快照 | `assertProjectContextCapability` 直接返回 | 创建必须 409 | 集成用例变红（期望 409，实际创建成功） |
| M4 | `entriesRead` 与本批 `readEvents` 集合一致 | 删除一致性谓词 | 畸形回执不得落库 | 集成用例变红（希望 0 行，实际 1 行） |
| M5 | 同幂等键返回同一快照 | run.create 幂等键追加随机后缀 | 重放必须同一 Run/快照 | 集成用例变红（Run id 不同） |
| M6 | 派发前复核 | `verifyRunProjectContext` 恒返回 ok | 纠正后不得派发 | 集成用例变红（Run 仍 queued） |
| M7 | 真实读取回执（不是只存快照 ID） | `contextRead` 不再发 `runtime.context_receipt` | 必须有 read 回执 | Q3 契约用例变红（只有 delivered，期望 delivered+read） |
| M8 | 已下发命令不再复核（R7 ack 丢失） | `beforeDispatch` 去掉 `sentAt !== null` 早退 | 重投不得判失败 | 集成用例变红（第二次 `run.start` 为 0 帧） |
| M9 | 派发前失败结算触发指令 | 删除 `settleTriggerInstruction` 调用 | 指令应为 `rejected(CONTEXT_UNAVAILABLE)` | 集成用例变红（实际 `RUN_TERMINAL`） |
| M10 | 未纳入明细封顶 + 聚合 | 去掉 128 条截断、全量写入 `unselected` | 205 候选仍须创建成功且明细=128 | 集成用例变红（明细 173，聚合为空） |
| M11 | 回放读路径补结算 | 去掉 pending+终态分支 | 崩溃窗口不得报 `started_run` | 集成用例变红（outcome=started_run） |
| M12 | 部分交付必须覆盖全集 | 删除 `missing_set_mismatch` | 只报 1/3 且 `missing=[]` 必须拒绝 | 集成用例变红（回执行数 6≠5） |
| M13 | 增量回执空 patch | 去掉空 patch 守卫、无条件 `update` | 重复读不得 500 | 集成用例变红（`No values to set`） |
| M14 | 终态/拒绝清理 runtime-context | 删除 `cleanupProjectContext` 调用 | 两条路径都必须清理 | Node 用例变红（等待清理超时） |
| M15 | 已交付/未交付不得重叠 | 删除 `missing_overlaps_delivered` | 自报矛盾必须拒绝 | 集成用例变红（reject 未发生） |
| M16 | 版本评审回合建 Run 的错误映射 | 恢复为直接抛出（无 409 映射） | 旧 Node 必须 409 而非 500 | `personal-attention` 用例变红（实际 500） |
| M17 | readEvents 按集合比较 | 去掉去重、退回长度比较 | 同批重复读仍算一次 | 集成用例变红（回执行数少 1） |

复跑命令：

```bash
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/run-project-context.integration.spec.ts
pnpm exec vitest run --project unit apps/node/tests/project-context.spec.ts \
  apps/node/tests/run-manager.spec.ts
pnpm exec vitest run --project dsh-contract \
  packages/runtime-dsh/tests/dsh-contract/tool-boundary.contract.spec.ts -t "ADR-0027"
```

## 4 未交付 / `not_run`

- **已知残余（评审登记的边界，不当作已解决）**：
  - Node 侧 `run.start` 重发与首次下载并发时，失败的那次命令可能清理胜者的 `runtime-context`/回执状态（与既有 artifact 输入副本同类竞态），PC-05b-3 收口；
  - Hub 在 `gateway.send` 成功与 `markSent` 落库之间崩溃仍会留下 `sent_at=null` 的窄窗口，重投会重新复核并可能把 Run 判失败（B1 已把窗口从「每次重投」缩到「崩溃瞬间」）；
  - `sent_at` 只证明 socket 写入成功，不证明 Node 已收到；这是 R7 的既定取舍；
  - `cancel_requested` Run 的回执按 ADR 字面归为 `receipt_late`，其消费事实不落库；
  - bundle 读面非 `frozen` 条目的 409 映射由 PC-05b-1 接通：下载前按当前来源/纠正状态派生，非 frozen 一律 409。
- **撤权状态机**：`run.context_state`、`context.state_sync`、活跃 Run 未读副本逐条删除/隔离、Runtime 本地 ack、断连 fail-closed 已由 PC-05b-1（#498）交付，见[验收](./2026-11-03-pc05b1-context-state-acceptance.md)；来源条目的生产写入仍待 PC-03b/03c。
- **终态 session 处理**：`resumeContext: full/redacted/blocked`、终态清理队列、`runtime-context`/spill 删除与 blocked 血缘已由 PC-05b-3（#500）交付；session allowlist 重建、`redacted` 产生路径与 `coordination-home` 扫描仍未做（见 [PC-05b-3 验收](./2026-11-03-pc05b3-terminal-cleanup-acceptance.md)）。
- **首条回执 watchdog**：Run 进入 running 后 60 秒无回执自动 `failed(CONTEXT_UNAVAILABLE)` 未实现；当前只接受合格回执，不主动判定「Node 静默不读」。
- **回执重试**：`run.context_receipt` 只在连接 OPEN 时发送，断连窗口内不回放；PC-05b-2（#499）补持久 outbox 与 ack，watchdog 同切片。
- **显式选择**：Thread/Subscription/WorkLink、`read_only` 勾选、`model_inferred` 激活、`selectedByMemberId` 均无 UI/API 入口（PC-03b/03c）。
- **外部来源**：真实飞书/钉钉正文、来源 Observation、权限代次与撤回后的历史读面均 `not_run`。
- **真实平台与真人**：未连接真实模型、真实办公平台；不声称模型真的理解了正文（回执是受信 Node 的自报证据）。
- **ADR-0027 §6 全量清理**：不声称零命中、不声称 session 内无正文、不承诺模型记忆可收回。

## 5 证据边界

- 快照正文、Run 详情与回执字段不含绝对路径；Node 拒绝消息与 Runtime 工具错误均不含 `entriesDir`。
- 回执是本次 Run 受信 Node 的自报证据，用于防「只存快照 ID / 漏读 / 部分交付」，不防恶意 Node；Hub 只校验集合一致、headerDigest 可复算与序号单调。
- 成员读面只返回快照内条目；下载接口只对承载该 Run 的设备开放。
