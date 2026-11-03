# RD-02b 订阅快路径验收

- 对应场景/门禁：ADR-0028 §4 的入口程序准入与「有效订阅直达工作收件箱」；Q0 静态门、Q2 数据门
- 对应 Issue：#485（RD-02b，母 Issue #484）
- 上次验证：2026-11-02 · 分支 `feat/rd-02b-subscription-fast-path`（本 PR）· PASS
- 本切片边界：只覆盖**显式、可撤销的内部订阅**——工作所属 Task 的讨论消息，以及工作所属 Task 可解析的既有内部业务引用（`taskSpec:` / `run:` / `artifact:`）；**不实现** Thread/WorkLink（PC-03b）、外部来源订阅（PC-01/02b）、模型 Router 决定（RD-03）、自动派工或新工作自动立项（RD-04）。
- 最近复审修复（2026-11-02）：退回绑定条目自身工作（退休/旧工作不再静默丢 Router 调用或记到后继工作）；业务引用按 `(businessRef, sourceKind)` 合并并保留人工纠正；责任人停用后不再快路径投递；wait 自动副本随生命周期收口；区分来源级 tombstone 与订阅副本撤回；drop 与 `run:`/`artifact:` 成功路径补机器证据；撤销日志不再记录调用方自由文本。

## 验的是哪条用户路径

Task 当前责任人在已有工作上显式订阅自己的 Task（或 `taskSpec`/`run`/`artifact` 业务引用）。之后其他成员在同一个 Task 里正常讨论、追加业务事实或人工纠正，**不再 @Agent、不转发、不重写提示词**：

- 入口程序准入先核对可验证事实：工作仍 active、Task 未终态、责任人未变且仍为启用成员、Mandate 仍 active 且版本未推进、订阅仍 active、来源类型被 Mandate 允许、来源授权代次与订阅一致。
- 全部通过 → 来源正文直接进入该工作的 `work_inbox_item(pending, subscription_id=...)`，**不调用 Router**；证据是 `work_entry_admission.outcome=deliver, router_invoked=false` 且 `work_entry_router_call` 零行。
- 没有有效订阅且来源类型被当前 Mandate 允许（含被撤销、代次变化、Mandate 推进后未重新订阅）→ 只输出 `route_router`，写一条独立的 `work_entry_router_call`，不写 RD-01 的 `router_decision`；因此自动入口不会占用「同一来源只裁决一次」的唯一键。来源类型被 Mandate 排除 → `drop/source_not_allowed`，不调用 Router（`return` 是显式退回，固定走慢路径，见 §4）。
- 订阅被显式撤销、Mandate 新版本/暂停/撤销、Task 改派、Task 终态、工作退休、责任人停用 → 旧订阅转 `revoked/stale`，并撤回该订阅交付的未读副本（`pending/returned/delivered/unconfirmed` → `retracted`，delivery → `withdrawn`）；已 `consumed` 的条目保持原状。
- 成员显式退回 → 保留水位并调用 Router 端口（`work_entry_admission.trigger=return, outcome=route_router`），不静默丢弃；退回绑定**条目自身的工作**，即使该工作已退休或同 Task 已有后继工作。

## 驱动（怎么触发）

主要驱动走生产 Fastify 路由（`app.inject`，与真人同一路由/鉴权/事务路径）+ 真实 PostgreSQL；并发收敛、退回负向、drop 来源失效与 Run 终态探针直接调用**生产函数/事务**（`admitTaskMessageEntry`、`applyRunStatus`），不绕开业务校验，也不用测试专用旁路。

```bash
# 订阅 + 入口准入（29 条）
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-subscriptions.integration.spec.ts

# 静态边界（9 条，其中本切片新增 3 条）
pnpm exec vitest run --project unit apps/hub/tests/work-boundaries.spec.ts
```

覆盖的入口与生产装配：

- `POST /api/v1/works/:workKey/subscriptions`（targetType=`task|business_ref`）
- `GET /api/v1/works/:workKey/subscriptions`
- `POST /api/v1/works/:workKey/subscriptions/:subscriptionId/revoke`
- `GET /api/v1/works/:workKey/entry-admissions`
- `POST /api/v1/tasks/:taskId/comments` → `addComment` 同事务入口准入
- `POST /api/v1/projects/:projectId/context/:entryId/correction` → `correctContextEntry`
- 既有业务事实投影 `projectDecision/projectObservation`（约定确认、成果发布、Run 终态；`handoffReceipt:` 引用暂不支持，见边界）。Run 终态用例的 running Run 行是测试夹具，终态迁移与投影调用生产 `applyRunStatus`；artifact 用例走真实上传→订阅→发布 HTTP。
- `POST /api/v1/works/:workKey/inbox-items/:itemId/return` → Router 慢路径
- 既有 Mandate 创建/暂停/恢复/撤销、Task 改派/完成/取消、工作退休、成员停用路径统一收口订阅

## 观测（看什么）

- `work_subscription`：`target_type/target_ref/status/authorization_generation/mandate_id+version/ended_*`；active 身份唯一索引 `(work_id,target_type,target_ref)`。
- `work_entry_admission`：`trigger/outcome/reason/source_*`、`subscription_id`、`inbox_item_id`、`router_invoked`、`router_call_id`、`deadline_at`；`dedupe_key` 保证同一事件同一工作只裁决一次。
- `work_entry_router_call`：独立的 Router 调用记录（`reason/input_digest/source_*`，无正文）；`dedupe_key` 唯一。
- `work_inbox_item.subscription_id`：区分订阅快路径交付与成员显式关联；撤销/失效只清理该订阅交付的副本。
- `work_inbox_item.business_ref/source_kind`：业务引用订阅的合并身份（同一 identity/kind 才互相 supersede）；`auto_admitted=true` 标记 wait 自动保留副本，生命周期清理只收口这类副本；`retraction_scope` 区分 `source`（来源级 tombstone）与 `subscription`/`lifecycle`（副本撤回，不阻止重新订阅）。
- 结构化日志：`component=hub.work_subscription`（create/revoke，只有 id/状态/重复标记；**不记**调用方 `reason` 文本）。入口准入没有独立 stdout logger；按 `work_entry_admission` / `work_entry_router_call` 的 DB 行归因（不记正文，只有不透明 id/摘要）。
- 业务计数：`router_decision` 在自动入口中保持零行；`dispatch_intent` 保持零行（RD-03 未启用）。

## 判定（成功长什么样）

### 1. 快路径

- 订阅后用另一个成员账号在 Task 评论区留言（不 @Agent）→ `work_entry_admission` 一条 `deliver/subscription_match`，`router_invoked=false`、`router_call_id=null`；`work_inbox_item` 一条 `pending`，`subscription_id` 指向该订阅。
- 同一事件下 `work_entry_router_call` 为零、RD-01 `router_decision` 为零、`dispatch_intent` 为零。
- 重复提交同一评论（同一 Idempotency-Key）只产生一条消息、一条准入、一条收件箱条目；重复订阅同一 target 返回同一订阅 id，不新增 active 行。
- 业务引用订阅：先订阅 `taskSpec:<taskId>` 再确认约定 v1 → Decision 直接进收件箱；再确认 v2 → 旧 pending 转 `superseded(new_version)`，新 pending 的 `supersedesId` 指向旧项，不会留下两份可领取依据。旧版本即使由成员显式关联（`subscription_id=null`）进入，v2 也按 `(businessRef, sourceKind)` 找到并 supersede。
- 人工纠正独立：纠正只替换被纠正条目的 pending（`supersedesId` 指向目标），不替换同 businessRef 的新版本；后续 v3 再推进时纠正仍保持 pending，第二条纠正也只替换自己的目标。
- `run:`/`artifact:` 成功路径有机器证据：Run 终态 Observation、成果发布 Decision 分别在订阅后直接 `deliver`，`work_entry_router_call` 为零。订阅前已发生的投影不回溯补投。

### 2. 慢路径

- 工作有 active Mandate、来源类型被允许、但没有匹配的 active 订阅 → 不写收件箱；`work_entry_admission` 一条 `route_router/no_valid_subscription`，`router_invoked=true` 且 `router_call_id` 非空；`work_entry_router_call` 恰好一条。
- 来源类型不在 Mandate `allowedSourceTypes` → `drop/source_not_allowed`，`router_invoked=false`、零 Router 调用、零收件箱。
- 自动入口不写 `router_decision`，也不写 `dispatch_intent`；Router 端口只记录「被调用」，不伪造模型决定。
- Router 调用记录有唯一 `dedupe_key`：同一入口事件并发重放只保留一条调用记录与一条准入（测试用同一消息并发调用生产准入函数验证）。

### 3. 撤权/失效/旧代次

- 显式撤销：订阅 `status=revoked`、`ended_by_user_id` 为操作者；该订阅交付的 `pending/returned/delivered/unconfirmed` 副本转 `retracted`，delivery 转 `withdrawn(subscription_ended)`；`consumed` 保持原状。撤销后新补充走 `route_router`，撤销后重新订阅新补充恢复快路径。
- Mandate 新版本：旧订阅自动 `stale/mandate_superseded`，未读副本撤回；新补充因无 active 订阅走 `route_router`。
- Mandate 暂停：订阅 `stale/mandate_pause`，未读副本撤回；新补充输出 `wait/mandate_inactive`，**不**调用 Router（无有效授权可路由），Task 讨论补充保留为 pending 并记录 `deadline_at`。
- Mandate 过期（故障注入）：订阅 `stale/mandate_expired`，未读副本撤回；新补充 `wait/mandate_expired`，保留 pending + deadline，不调用 Router。到期清理是惰性的（下一个入口事件触达时收口），没有独立 tick。
- 来源授权代次变化（故障注入）：订阅 `stale/source_generation_changed`，未读副本撤回，新补充 `route_router/source_generation_changed`。
- Mandate 版本指针不一致（故障注入）：订阅 `stale/mandate_version_changed`，未读副本撤回，新补充 `route_router/mandate_version_changed`。
- Task 改派：工作转 `waiting(owner_confirmation)`，订阅 `stale/owner_changed`，旧副本撤回；新责任人收到的新补充输出 `wait/owner_changed`，保留 pending + deadline，不调用 Router。
- 责任人停用：入口准入在订阅校验前输出 `wait/assignee_inactive`，active 订阅转 `stale/assignee_inactive`，订阅副本与既有 wait 自动副本撤回；本次事件不再创建新的 wait 副本。
- Task 终态 / 工作退休 / full_access 切换：订阅 `stale/task_terminal|work_retired|full_access_task`，订阅副本与 wait 自动副本一并撤回；full_access 下新补充 `wait/full_access_task`。
- Task 改派：旧责任人失去读面，wait 自动副本随 `owner_changed` 撤回。
- Mandate 新建/暂停/恢复/撤销：只收口订阅，**不**撤回已保留的 wait 自动副本；该副本仍可被后续 Run 选择。
- 来源级 tombstone 只由显式 `retract` 产生；订阅撤销/失效写入的 retracted 不阻止后续重新订阅。
- 任一路径都不删除已 `consumed` 历史；只撤回未读副本。已投递到 Node 的本地副本无法实时收回（见边界）。

### 4. 退回与权限

- 退回 pending 条目：item `returned` + `returnReason`，水位保留；`work_entry_admission(trigger=return)` 一条 `route_router/returned_<reason>`，Router 调用记录非空。
- 退回绑定条目自身的工作：工作退休后仍可在原工作账本上退回并记录 Router 调用；同 Task 已建立后继工作时，准入与 Router 调用仍记在旧工作，不会串到新工作。
- 订阅创建/列表/撤回与准入读面仅 Task 当前责任人可调用；其他启用成员一律 403。
- 订阅 target 必须属于该工作 Task：Task 订阅只能指向工作自己的 Task；业务引用必须能解析到同一 Task；`run:` 不存在或多段 businessRef → 400；跨 Task → 409。
- 无 active Mandate、Mandate 不允许对应来源类型、`full_access` Task、工作 waiting/retired、Task 终态/未接受：拒绝创建订阅；已有订阅在准入时输出 `wait`/`drop`，不直达收件箱。`wait` 的 Task 讨论补充保留为 `auto_admitted=true`、`subscription_id=null` 的 pending；`drop` 不保留。`drop` 已用「作者停用」与「Mandate 排除来源类型」两条机器判据证明；`source_retracted`、`body_too_large`、`duplicate` 等分支目前是防御性分支。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| 订阅创建 403 | 是否 Task 当前 assignee；`requireAssignee` 与启用成员检查 |
| 订阅创建 409 no active mandate | Mandate 是否 active、未过期；`effectiveMandate` |
| 订阅创建 409 target outside | targetRef 是否指向工作自己的 Task / 可解析到同一 Task 的业务引用 |
| 有订阅但补充没进收件箱 | 订阅是否 active；Mandate id/version 是否与订阅 pin 一致；来源授权代次是否一致；Task/工作状态与责任人是否仍启用 |
| 快路径却出现 Router 调用 | `work_entry_router_call` 是否新增；检查 `admitWorkEntry` 是否在 `validity.valid` 分支提前返回 |
| 无订阅却没调用 Router | `work_entry_admission.outcome` 是否 `wait/drop`（状态/来源不满足是预期），或 `work_entry_router_call` 是否写入 |
| 订阅失效后旧副本仍在 | `statusReason`、item 的 `subscription_id`/`auto_admitted`/`status`；`retractInboxItemsForSubscription` 与 `retractAutoAdmittedInboxItemsForWork` 是否覆盖 delivered/unconfirmed |
| 已消费条目被撤回 | 检查撤回 SQL 是否误包含 `consumed`（应保持原状） |
| 重新订阅后同来源仍被 tombstone 拦截 | item 的 `retraction_scope`：订阅撤回应为 `subscription`，只有显式撤权才是 `source` |
| 退回没有 Router 记录 | `returnWorkInboxItem` 是否调用 `admitReturnedInboxItem`；`event.workId` 是否来自 item；`trigger=return` 的 dedupe key 是否包含 item id |
| 退回记到了后继工作 | `admitWorkEntry` 是否在 return 分支用 `event.workId`，而不是重新 `getCurrentWorkByTask` |
| 业务引用新版本把纠正吞掉 | item 的 `business_ref/source_kind`；supersede 候选是否按 `(businessRef, sourceKind)` 且 correction 不在候选内 |
| 责任人停用后仍投递 | `waitReason` 是否检查 `getEnabledMember`；订阅是否 `stale/assignee_inactive` |
| 自动入口污染 RD-01 影子决定 | `entry.ts` 是否误用 `insertRouterDecision`；自动入口应只写 `work_entry_router_call` |
| 同一事件出现两条准入/Router 调用 | `dedupe_key` 是否稳定包含 workKey/trigger/source 身份/item id；并发回读是否生效 |

## 取证

```bash
# 定向
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-subscriptions.integration.spec.ts
pnpm exec vitest run --project unit apps/hub/tests/work-boundaries.spec.ts

# 门禁
pnpm check
pnpm test:integration
pnpm test:security

# 合入前敏感扫描（改动面）
scripts/secret-scan.sh
scripts/secret-scan.sh apps/hub/src/modules/work apps/hub/src/modules/task/commands.ts apps/hub/src/modules/context packages/db/migrations/0029_work_subscriptions.sql packages/db/src/repositories/work-subscription.ts packages/protocol/src/work-subscription.ts
```

本切片实测（2026-11-02）：

- 定向：订阅/入口准入 `29` 条、`work-input-manifest` 新增 `4` 条（撤销 delivered/unconfirmed、保留 consumed、终态锁序并发探针）、边界 `9` 条（本切片新增 `3` 条），全部通过。
- Q0：`215` 个测试文件 / `2309` 条通过。
- Q2：`88` 个测试文件 / `804` 条通过（含本切片新增判据）。
- Q7：`4` 个测试文件 / `18` 条通过；secret-scan 自检/实扫与依赖许可 gate 通过。
- 单点变异 `M1–M28` 全部 RED，逐条见下表。

## 变异自证

每次只改一处生产代码，跑订阅定向用例，必须变红后恢复。临时脚本不提交。

| # | 变异 | 被哪条判据抓住 |
|---|---|---|
| M1 | 失效/过期订阅仍然直达收件箱 | 来源代次变化用例期望 `route_router`，实际交付 |
| M2 | Router 调用记录用伪造 id 冒充 | admission 的 `router_call_id` FK 拒绝，无订阅用例失败 |
| M3 | 快路径额外调用 Router | 已知补充用例断言 `work_entry_router_call` 为零 |
| M4 | 撤销订阅不撤回未读副本 | 撤销用例期望 pending 转 `retracted` |
| M5 | 新 Mandate 不使旧订阅失效 | Mandate 推进用例期望 `stale/mandate_superseded` |
| M6 | 不比较来源授权代次 | 来源代次变化用例期望 `stale/source_generation_changed` |
| M7 | 不比较 Mandate 版本 pin | 版本指针故障注入用例期望 `stale/mandate_version_changed` |
| M8 | Mandate 暂停时仍走 Router | 暂停用例期望 `wait/mandate_inactive` 且 Router 零调用 |
| M9 | Task 改派不清理订阅 | 改派用例期望 `stale/owner_changed` 与旧副本撤回 |
| M10 | 创建订阅跳过 assignee 校验 | 非责任人创建期望 403 |
| M11 | Task 订阅接受其他 Task | 跨 Task target 期望 409 |
| M12 | 无 active Mandate 仍允许订阅 | 无 Mandate 工作期望 409 |
| M13 | 退回被当作普通来源处理 | 退回用例期望 `trigger=return` 的 `route_router` |
| M14 | 订阅失效时不撤回未读副本 | 来源代次变化用例期望 pending 转 `retracted` |
| M15 | 业务引用可跨 Task 订阅 | 跨 Task `taskSpec:` 期望 409 |
| M16 | 移除 Mandate 来源类型闸 | 只允许 `context_entry` 的 Mandate 订阅 Task 消息期望 409 |
| M17 | Run 终态先锁 item 再锁 Work | 并发锁序探针实测 40P01 deadlock（撤销清理 Work→item vs 终态 item→Work） |
| M18 | wait 不保留 Task 补充 | 暂停/改派用例期望 pending 副本 + `deadline_at` |
| M19 | 业务引用新版本不 supersede 旧 pending | 业务引用版本推进用例期望旧项 `superseded(new_version)` 且新项 `supersedesId` 指向旧项 |
| M20 | 退回仍按 `getCurrentWorkByTask` 重新推导工作 | 退休/后继工作用例期望 return 准入与 Router 调用都记在旧工作 |
| M21 | 业务引用 supersede 按订阅 id 一把抓（或把 correction 纳入候选） | 跨通道版本与纠正用例期望纠正保持 pending、v3 不吞纠正 |
| M22 | 显式关联 entry 不写 `business_ref/source_kind` | 混合通道用例期望 v2 能找到并 supersede 显式关联的 v1 |
| M23 | 入口不检查责任人是否仍启用 | 停用责任人用例期望 `wait/assignee_inactive` 且订阅 stale |
| M24 | 生命周期清理不处理 `auto_admitted` wait 副本 | 退休/终态/full_access 用例期望自动副本 `retracted` |
| M25 | 来源 tombstone 查询不区分 `retraction_scope` | 订阅撤回后同 sourceId 新版本显式关联期望 201，实际 409 |
| M26 | 入口账本保留 `task_id` FK（迁移不 drop） | Task→Work 并发探针阻塞/失败（实测 25 条失败、约 257s），确认判据能抓反向锁边；手工探针可复现 40P01 |
| M27 | 慢路径不检查 Mandate `allowedSourceTypes` | 窄 Mandate 用例期望 `drop/source_not_allowed`，实际 `route_router` |
| M28 | Mandate 变更也撤回 wait 自动副本 | 暂停/恢复用例期望 wait 副本仍 pending，实际被 retracted |

## 明确边界与残余风险

- **Thread/WorkLink 未交付**：本切片只支持工作自己的 Task 与 `taskSpec:/run:/artifact:` 内部引用；`handoffReceipt:` 与外部来源、群/线程、跨项目订阅要等 PC-03b/PC-01/02b。
- **Router 只有端口**：`work_entry_router_call` 证明「慢路径被调用」，不证明模型已判断或已派工；`dispatch`/`wait`/`ask`/`ignore` 的语义决定归 RD-03/RD-04。自动入口不写 RD-01 的 `router_decision`，避免占用其「同一来源只裁决一次」唯一键。
- **wait 只做到「保留 + 期限」**：Task 讨论补充在 `wait` 时保留为 `pending` 并写 `deadline_at`；到期自动重评/补投不在本切片（归 RD-03/RD-04）。系统投影/纠正的 `wait` 不自动入箱，避免 Run 终态 Observation 在没有 Mandate 时堆积副本。
- **无 active 工作的 Task 不进入自动准入**：新工作识别属于 RD-04；本切片只在已有工作上分流。
- **已投递给 Run 或已消费的副本无法从 Node 撤回**：撤销订阅只撤回 Hub 的未读副本；活跃 Node 本地副本与已读内容的实时撤权帧归 PC-05b。已消费按 ADR-0024/0027 保留对账事实。撤销时若清空 delivery 指针，已在撤销前发生的迟到读回执只能记 `duplicate`，消费证据会弱化——这是 PC-05b 回执恢复/撤权联动的已知残余。
- **Mandate 新版本（含恢复）使既有订阅失效**：这是保守选择，避免撤销/暂停后自动恢复旧授权；用户需重新确认订阅。
- **业务引用订阅只覆盖已投影的 Decision/Observation/Correction**：不会自动订阅未来才出现的同类对象；订阅前已发生的事件不回溯补投。同一 `(businessRef, sourceKind)` 的新版本会 supersede 旧 pending；纠正只替换自己的目标，不参与版本合并。
- **入口准入没有独立 stdout logger**：按 `work_entry_admission` / `work_entry_router_call` 的 DB 行归因；不记正文。`work_entry_admission` 会把每个入口事件的 `source_id/version/digest` 留在协调表，只有 assignee 可读；保留期/清理策略尚未单独实现。
- **来源级 retracted tombstone**：自动入口与显式关联只把 `retraction_scope='source'` 的 retracted 当作停投依据；订阅撤销/生命周期清理写 `subscription/lifecycle`，不会永久拦截重新订阅。当前内部来源没有「同 sourceId 新版本」入口，来源级分支仍是防御性的。
- **Mandate 到期是惰性收口**：没有独立 tick sweep；到期后若一直无新入口事件，订阅在库里仍显示 active，直到下一次事件或生命周期动作触发校验。
- **full_access 只看 Task 显式列**：`task.approval_policy` 的继承解析不在本切片；Agent Revision 继承来的 full_access 仍按 RD-01 既有口径处理，后续切片需统一有效档位。
- **等待副本只在失去读面时自动撤回**：`auto_admitted=true` 的 wait 副本随退休/终态/full_access/改派/责任人停用收口；Mandate 变更不撤回。RD-02a 人工显式关联的 pending 仍保留给 assignee 手工处置（原有语义）。
- **入口账本不建 task FK**：`work_inbox_item.task_id`、`work_entry_router_call.task_id`、`work_entry_admission.task_id` 是 `work.task_id` 的不可变冗余，不建 FK；否则入口准入在 Work 锁内 INSERT 会对 Task 取 KEY SHARE，与既有 Task→Work 锁序形成反向边并 40P01。归属仍由 `work_id → work.task_id` 保证；集成判据用 Task→Work 与入口插入并发探针自证。
- **入口账本未单列 Mandate 版本**：`work_entry_admission`/`work_entry_router_call` 只把 Mandate 版本纳入 `input_digest`；deliver 可通过 `subscription_id` 回查 pin，wait/drop/route_router 不能直接读出当时版本。
- **退回不再复核来源权限**：退回是 assignee 显式动作，固定走慢路径并保留 Router 调用记录；来源作者停用或来源类型后来被排除时，是否可退回仍由 `requireAssignee` 与 Router 后续语义处理，本切片不在 return 分支重复做来源闸。
