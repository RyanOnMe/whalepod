# RD-04b 预授权立项验收

- Issue：[#534](https://github.com/RyanOnMe/whalepod/issues/534)；PR：[#539](https://github.com/RyanOnMe/whalepod/pull/539)；契约：[ADR-0030](../adr/0030-project-work-discovery-and-creation.md) 的 RD-04b。
- 最近验证：2026-11-11，生产 HTTP / Node WS / 真实 PostgreSQL 装配；12 条新用例、RD-04a 原链路与相关 201 条回归全部通过，Q0 静态门 exit 0。
- 验的证据固定在 PR #539 的最终提交；`c527435` 为初版实现，`8ebb04d` 为第一轮评审修复，最后一轮修复见 PR head。
- 状态：自动立项（`tier=create`）已按预授权接线，但默认关闭（旧配置与未设置 `tier` 的配置一律按 `discover` 处理）。

## 范围

RD-04a 只产出私有候选。本切片把「有证据的独立缺口」接到「按本人预授权，只建一次任务」：

- 责任人本人确认一次 `discovery_permit` 快照：具名责任人、活动/槽位、模板版本与摘要、期限、核实人、可立项数。
- 责任人核对当前完整任务/成果目录，记录代次与逐项覆盖；只有当前代次、全部 `not_covered` 且无占用才是 `eligible_empty`。
- 自动立项要求独立核实人：同项目、预先登记、非来源作者；正式发布的当前佐证，或经专门入口确认确切来源版本的核实回执。
- 一事务物化：已承接 Task（责任人预授权回执时间作为 `accepted_at` 来源）、`origin=preauthorized_template` 的 `status=derived` 首份约定、active Work、槽位占用与固定来源绑定。
- 人工创建与自动立项共用 Project 行锁和 `discovery_slot_occupation.slot_id` 唯一约束。人工创建必须认领槽位或提交「与无关」建议；未分类旧客户端会 409，直到显式关闭自动档。
- 本切片不建子 Mandate、派工意图、Run 或 Executor 预留；发现物化的 Work 上创建 Mandate 直接 409。
- 派生约定不是正式确认：`getLatestConfirmedSpec` / Run resolver 只认 `confirmed`；普通 Run 会因 `AGREEMENT_REQUIRED` 被拒，直到责任人另走正式确认入口。

## 驱动和判定

```bash
pnpm -r --if-present build
pnpm test:integration apps/hub/tests/discovery-creation.integration.spec.ts
pnpm test:integration apps/hub/tests/discovery.integration.spec.ts
pnpm check
```

驱动全部走生产入口：项目/任务/约定/评论/发现配置/许可/参与/核实/槽位核对/候选应用均为 HTTP；发现评估与模型结果走 Node WS；只有模型 HTTP 响应被回放。数据库只读用于独立核对。

12 条用例与判据：

1. **正向立项**：一条普通筹备评论 + 核实回执 → 一个 accepted Task、派生约定、active Work；无 Mandate / dispatch_intent / Run；正式约定视图 `confirmed=null`；创建 Mandate 409；普通 Run `AGREEMENT_REQUIRED`；候选视图显示 application 与 `creation.reason=applied`；作者本人核实 403；人工重复认领 409 并返回既有 taskId；应用后 60s 的清理 tick 不因 application FK 失败；来源撤回后候选正文不再返回而 Task 保留；改派后新责任人 accept work 也被 409 拒绝。
2. **发布佐证**：核实人通过真实 Run 上传并发布成果；模型引用该 evidence；应用记录的 `verification.kind=published_evidence`，无 receipt。
3. **并发**：同一候选两次并发 apply，恰好一次 `applied`、一次 `already_applied`；application / occupation / task 各一行；非责任人 apply 404（不向其确认候选是否存在）。
4. **两人报告**：同一槽位两条独立来源各自完成评估与核实回执；并发应用后恰好一个 `applied`、一个 `slot_occupied`，只有一个 application / occupation / 新 Task。
5. **人工/机器并发**：人工认领与自动 apply 同时提交，只产生一个槽位占用与一个 Task；谁先提交谁占用，另一侧 409/`slot_occupied`。
6. **人工先于机器**：未核对的自动应用只落 `slot_unverified`；随后人工认领槽位；再次 apply 落 `slot_occupied`；未分类人工创建 409 `DISCOVERY_CLASSIFICATION_REQUIRED`；重复认领 409 并返回既有 taskId。
7. **撤权/更正**：许可撤回删除未应用候选、apply 404；原作者版本化更正删除旧候选、apply 404；空白更正 400；两种情况下 application 与 Task 均不新增。
8. **目录失效/covered**：核对后修改入口 Task 标题（范围变更）→ 自动应用 `slot_unverified`；槽位视图 `current=false`、`eligibleEmpty=false`，非责任人读取 403；把场地任务标为 `covered` → 核对结果 `coveredCount=1`、`eligibleEmpty=false`，自动应用 `slot_covered`，人工认领同槽位 409 `DISCOVERY_SLOT_COVERED`；两种情况均不新增 application。
9. **晚到核实**：先完成评估、尚无回执 → 候选落 `independent_support_missing` 且 `creation_terminal=false`；核实人随后提交回执，下一次 tick 自动立项，仍不产生 Run。
10. **陈旧评估重排**：评估后目录/清单变化并重新核对槽位 → apply 落 `stale_evaluation`；准入行 `processed_at=null`、`evaluation_id=null`、`requeued_at` 非空；下一次 tick 派发**新的** evaluation；再次 apply 旧候选仍拒绝，且新 evaluation 的 `evaluation_id/processed_at/requeued_at` 原样保留（CAS 不被旧候选清掉）。
11. **更正后隐私**：已立项候选在来源更正后从责任人列表消失，但 application 与 Task 保留（审计历史），候选行未被删除。
12. **许可档位**：`POST /permit` 省略 `tier` 落 `discover`；`tier=create` 缺当前模板摘要 409；`tier=execute` 超过项目上限 409。

RD-04a 的 15 条影子发现用例继续通过，确认默认关闭、既有 Router/Run 路径、候选私有读面和撤权清理未被破坏。

## 观测

- 候选：`GET /projects/:projectId/discovery/candidates`，看 `creation.reason/terminal/checkedAt` 与 `application`。
- 槽位：`GET /projects/:projectId/discovery/slots/:slotId`，看 `catalog.digest`、`verification.current/eligibleEmpty/coveredCount`、`occupation`。
- 来源回执：`GET /projects/:projectId/discovery/sources/:sourceId`（责任人/已登记核实人），看 `sourceVersion/sourceDigest/corrected`。
- 独立核对只读查询：`discovery_application`、`discovery_slot_occupation`、`discovery_permit`、`discovery_admission.requeued_at`、`coordination_evaluation.failure_code`。
- 结构日志 `component=hub.discovery`，关键 action：`discovery.application_failed`、`discovery.candidate_cleanup_failed`、`discovery.candidate_expiry_delete_failed`。

## 归因

- 未立项先看候选 `creation.reason`：`slot_unverified/slot_covered` 在槽位门；`independent_support_missing` 在事实门（可等回执重试）；`stale_evaluation` 在评估清单与当前目录不一致；`permit_inactive/config_changed` 在授权快照。
- 槽位核对不 `current`：先看是目录 `digest` 变化（任务/成果/Work 变更）还是 `generation` 被任何目录写入推进；两者都要责任人重新核对。
- 派发异常看 `coordination_evaluation` 与 admission `processed_at/evaluation_id/requeued_at`；`hub.discovery` 日志只带 id，不带评论正文。
- 立项后仍被拒绝执行：确认 `task_spec_revision.status='derived'` 与 `AGREEMENT_REQUIRED`，这是本切片的「仅立项」边界，不是故障。

## 取证

```bash
pnpm test:integration apps/hub/tests/discovery-creation.integration.spec.ts \
  --reporter=verbose 2>&1 | tee /tmp/rd04b-creation.log
bash scripts/secret-scan.sh
```

测试只回放模型 HTTP 响应；评论、核实、许可、认领、apply 均走 HTTP，数据库只读用于独立判定。

## 证据

- 新用例：`apps/hub/tests/discovery-creation.integration.spec.ts`（12 tests）。
- 纯函数用例：`apps/hub/tests/discovery-helpers.spec.ts`（5 tests：模板存储边界、NUL/孤立代理、占位符单次替换）；`packages/protocol/tests/router.spec.ts`（maxCreations int4 边界）。
- 回归：`apps/hub/tests/discovery.integration.spec.ts`（15 tests）；任务/指派/约定/评论/Work Mandate/Work Dispatch/Run 创建/交接/Artifact 相关 11 个文件共 201 tests。
- 静态门：`pnpm check` exit 0（format、lint、typecheck、boundaries、protocol-generated、plugin fixture、2617 unit/web tests）。
- 迁移：`0049_rd04b_spec_enum.sql`（先提交 enum 值）、`0050_rd04b_preauthorized_creation.sql`（许可/槽位/核对/回执/应用/占用/来源绑定 + 旧配置回填）、`0051_rd04b_requeue_admission.sql`（`requeued_at` 独立成迁移且 `if not exists`，c527435 级、8ebb04d 级与新库都能升级）。
- 回执驱动：`GET /projects/:projectId/discovery/sources/:sourceId` 向责任人与已登记核实人返回确切版本/摘要；测试不再从数据库拼回执请求。

## 边界

- 自动立项仍默认关闭；开启需要协调模型操作者配置 `tier=create`（含非空目标/验收模板与核实人），再由具名责任人确认模板摘要。任何配置换版都会撤销旧许可。
- 本切片是 **API-only 试点**：现有 Web 建任务/交接面板不发送 `discovery` 分类；启用 `tier=create` 后这些旧客户端会收到 409 `DISCOVERY_CLASSIFICATION_REQUIRED`。槽位选择 UI 与交接分类入口另开 Issue，不在本 PR 改 `apps/web`。
- 交接新建路径（`deliverHandoff` → `createTask`）会转发 `discovery` 分类，但没有单独的集成用例；`discovery` 只用于 `newTask`，与 `downstreamTaskId` 同时出现时被忽略。
- 许可额度按槽位累计，重新确认许可不重置。由于 `discovery_slot_occupation.slot_id` 唯一且占用不删除，**单槽位实际上限恒为 1**；`maxCreations > 1` 目前不产生第二个自动立项，保留字段是为未来多槽位配额。
- 槽位行锁序固定为「Project → 项目全部槽位按 id 排序 → 单个槽位」；目录 generation 推进也先按 id 锁全量槽位，避免多槽位项目里生成扫描与单槽位预锁互相等待（40P01）。配置/许可变更同样先锁 Project，与人工创建、自动立项串行。
- generation 只在人工/范围写入（建任务、改派、改范围、完成/取消、建/退休 Work、成果发布、约定确认、受理/提交验收、owner 承接）推进。Router/Run 驱动的 Work 状态变化不推进 generation，但仍会改变目录摘要，自动立项会按 `slot_unverified` fail closed，需要责任人重新核对。
- Real-model 语义质量沿用 RD-04a 已冻结的 `discovery.v2` 开发集/保留集与人工复核；本切片不新增模型判断，也没有放宽引用校验。
- RD-04c 未开始：专用跨 Task 来源读取、调用级费用守卫、私有草稿投影、Executor 实际消费与跨重启清理仍待实现；正式阅稿、受控模型/计费验收继续关闭，飞书仍等测试租户授权。
- 人工/机器并发在单一 Project 行锁上串行；跨项目不共享槽位。多进程 Hub 依赖 PostgreSQL 行锁与唯一约束，不依赖进程内状态。
- Hub 物化与真人回执的区分落在 `discovery_application`（candidate/evaluation/permit/slot/来源绑定）与 `task_spec_revision.origin=preauthorized_template`；Task 的 `created_by`/`accepted_at` 表示具名责任人与许可确认时间，不伪造系统用户或第二个受理回执。
- 候选列表对已应用候选读取冻结的评估清单，避免新增 Task 后重建清单把历史候选过滤掉；未应用候选仍按当前权限重验。已应用候选只在来源撤回/更正时隐藏；其引用的成果事后取消发布或成员被停用不会重新校验（Task 已存在，列表只面向责任人）。
- 已应用候选仍受 24h 候选 TTL 约束：过期后责任人列表不再返回该条历史，application/Task/来源绑定保留在库内；面向责任人的立项历史读面留给 RD-04c。
