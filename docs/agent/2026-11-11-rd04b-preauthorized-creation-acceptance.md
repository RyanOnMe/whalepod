# RD-04b 预授权立项验收

- Issue：[#534](https://github.com/RyanOnMe/whalepod/issues/534)；契约：[ADR-0030](../adr/0030-project-work-discovery-and-creation.md) 的 RD-04b。
- 最近验证：2026-11-11，生产 HTTP / Node WS / 真实 PostgreSQL 装配；8 条新用例与 RD-04a 原链路全部通过，Q0 静态门通过。
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

7 条用例与判据：

1. **正向立项**：一条普通筹备评论 + 核实回执 → 一个 accepted Task、派生约定、active Work；无 Mandate / dispatch_intent / Run；正式约定视图 `confirmed=null`；创建 Mandate 409；普通 Run `AGREEMENT_REQUIRED`；候选视图显示 application；人工重复认领 409 并返回既有 taskId。
2. **发布佐证**：核实人通过真实 Run 上传并发布成果；模型引用该 evidence；应用记录的 `verification.kind=published_evidence`，无 receipt。
3. **并发**：同一候选两次并发 apply，恰好一次 `applied`、一次 `already_applied`；application / occupation / task 各一行。
4. **人工先于机器**：未核对的自动应用只落 `slot_unverified`；随后人工认领槽位；再次 apply 落 `slot_occupied`；未分类人工创建 409 `DISCOVERY_CLASSIFICATION_REQUIRED`；重复认领 409 并返回既有 taskId。
5. **撤权/更正**：许可撤回删除未应用候选、apply 404；原作者版本化更正删除旧候选、apply 404；两种情况下 application 与 Task 均不新增。
6. **目录失效/covered**：核对后修改入口 Task 标题（范围变更）→ 自动应用 `slot_unverified`；把场地任务标为 `covered` → 自动应用 `slot_covered`；两种情况均无 application。
7. **评估边界**：发现评估完成后只有立项事务新增一个 Task；评估本身不写 Task/Work。
8. **两人报告**：同一槽位两条独立来源各自完成评估与核实回执；并发应用后恰好一个 `applied`、一个 `slot_occupied`，只有一个 application / occupation / 新 Task。

RD-04a 的 15 条影子发现用例继续通过，确认默认关闭、既有 Router/Run 路径、候选私有读面和撤权清理未被破坏。

## 证据

- 新用例：`apps/hub/tests/discovery-creation.integration.spec.ts`（8 tests）。
- 回归：`apps/hub/tests/discovery.integration.spec.ts`（15 tests）；任务/指派/约定/评论/Work Mandate/Work Dispatch/Run 创建/交接/Artifact 相关 10 个文件共 189 tests。
- 静态门：`pnpm check`（format、lint、typecheck、boundaries、protocol-generated、plugin fixture、2611 unit/web tests）。
- 迁移：`0049_rd04b_spec_enum.sql`（先提交 enum 值）与 `0050_rd04b_preauthorized_creation.sql`（许可/槽位/核对/回执/应用/占用/来源绑定 + 旧配置回填）。

## 边界

- 自动立项仍默认关闭；开启需要协调模型操作者配置 `tier=create`（含非空目标/验收模板与核实人），再由具名责任人确认模板摘要。任何配置换版都会撤销旧许可。
- Real-model 语义质量沿用 RD-04a 已冻结的 `discovery.v2` 开发集/保留集与人工复核；本切片不新增模型判断，也没有放宽引用校验。
- RD-04c 未开始：专用跨 Task 来源读取、调用级费用守卫、私有草稿投影、Executor 实际消费与跨重启清理仍待实现；正式阅稿、受控模型/计费验收继续关闭，飞书仍等测试租户授权。
- 人工/机器并发在单一 Project 行锁上串行；跨项目不共享槽位。多进程 Hub 依赖 PostgreSQL 行锁与唯一约束，不依赖进程内状态。
- 候选列表对已应用候选读取冻结的评估清单，避免新增 Task 后重建清单把历史候选过滤掉；未应用候选仍按当前权限重验。
