# RD-03a：dispatch_intent 人工确认与受控派工端口验收（ADR-0028 §6）

- 对应场景/门禁：Q0 / Q2
- 对应 Issue：#505（母 #486）
- 上次验证：2026-11-04 · 分支 `feat/p1-486-rd03-existing-task-dispatch` · PASS

本切片边界：只交付 `proposed → approved → dispatched` 的人工确认链与第一个机器 Run；`autoDispatch='existing_task'` 自动直达、固定工具面/步级预批准、Run 边界自动续接、ask/pause/revoke 完整流程、跨成员委托与 Web 工作读面均未做。

## 1 验的是哪条用户路径

Task 责任人：

1. 在既有 Task 上创建持续工作与 active Mandate；
2. 把一条 Task 消息显式关联进工作收件箱；
3. 触发影子准入，得到 `proposed` 派工意图；
4. 在工作读面确认意图（`approved`）；
5. 选择一个非 `full_access` 的 Agent/Revision 与自己的在线 Device/Workspace，提交派工；
6. Hub 端口在同一事务内复核 Task/Work/Mandate/候选/来源并创建机器 Run；Run 记录 `origin='mandate'`、Mandate、意图与 on-behalf 用户；
7. Run 活跃期间工作转 `waiting(auto)`，Run 终态后同事务回 `active`（本切片不建下一 Run）。

任何非当前 assignee、旧/暂停/过期 Mandate、`full_access`、越界 action class/Agent、来源漂移、重复/已终结意图都不得创建 Run。

## 2 驱动与证据

- Work/Mandate/收件箱/准入/Run/终态全部走生产 HTTP 或真实 Node 帧：
  - `POST /tasks/:taskId/works`、`POST /works/:workKey/mandates`
  - `POST /tasks/:taskId/comments`、`POST /works/:workKey/inbox-items`、`POST /works/:workKey/admission-checks`
  - `POST /works/:workKey/dispatch-intents/:intentId/{approve,reject,dispatch}`
  - `POST /mandates/:id/{pause,resume}`、`POST /works/:workKey/retire`
  - `GET /runs/:runId`
  - Run 终态：`ingestNodeEvent(runEventFrame(...runtime.ready/run.completed...))`。
- 判据文件：`apps/hub/tests/work-dispatch.integration.spec.ts`（16 用例）。
- 静态边界：`apps/hub/tests/work-boundaries.spec.ts` 新增 dispatch 端口锁序、禁止直写 Run/TeamEvent/状态、普通 `create()` 拒绝机器来源、migration 约束检查。
- 测试前置依赖：Agent/Profile、Device/Workspace 由行插入构成（生产注册路径是既有 WS 配对）；每一处都在测试内标注 `removeWhen`。Work/意图/Run/outbox/team_event 不直插。
- 观测：Hub `component=hub.dispatch` 的 `work.dispatch.approve/reject/dispatch`（workKey、intentId、status、runId，无来源正文）；DB `dispatch_intent.status/approval_basis/approved_at/dispatched_at/run_id/agent_id/device_id/action_class`、`run.origin/mandate_id/dispatch_intent_id/on_behalf_of_user_id/work_key`、`work.state/resume_mode/resume_condition`。

## 3 判定

- **正控**：assignee approve → dispatched；机器 Run 的 provenance 完整，`workInputManifest` 冻结且 `workInputItemCount=1`；Run 活跃时 work=`waiting(auto)`，真实 terminal 帧后回 `active`；同一派工幂等键重放只产生一个 Run/一条 `run.start`；同 approve 幂等键重放在意图被新 Mandate 取消后回读当前 `cancelled`，不返回缓存 `approved`。
- **负控**：
  - 非 assignee approve/dispatch → 403，Run 0；
  - 拒绝意图 → `rejected` + `resolutionReason`，之后 dispatch 409；
  - Mandate 新版本/暂停/撤销 → `approved` 意图 cancelled，dispatch 409；
  - 意图过期 → approve 409 且不建 Run；已 approved 后过期 → dispatch 409；
  - `full_access` Agent → 403；action class / Agent 超出 Mandate → 403；
  - Work waiting/retired → dispatch 409，已有活跃 Run 时不产生第二个 Run；
  - 来源在准入后漂移 → 派工端口重新读取来源并 409，Run 0；
  - 普通 `create()` 携带 `origin='mandate'` → 403；`createWithinTransaction` 缺 dispatchIntent → 拒绝；
  - 无收件箱条目的机器 Run 仍绑定 `workKey`，manifest 为空。
- **数据判据**：`run_dispatch_intent_unique` 与 `dispatch_intent_run_unique` 保证一意图一 Run；`run_origin_fields` 保证机器 Run 四个溯源列非空且人类 Run 全空；`dispatch_intent_target_fields` 保证 dispatched 行固定候选/现场/action class。

## 4 门禁

| 门 | 命令 | 结果（2026-11-04） |
|---|---|---|
| Q0 | `pnpm check` | 222 文件 / 2405 项通过（dispatch 静态边界 3 条新增） |
| Q2 | `pnpm test:integration` | 90 文件 / 833 项通过（新增 `work-dispatch` 16 项） |

## 5 单点变异

每次只改一处，跑 `apps/hub/tests/work-dispatch.integration.spec.ts` 必须红；恢复后 `git diff` 核对无残留。

| # | 判据 | 变异 | 预期 | 实测 |
|---|---|---|---|---|
| M1 | approve 仅 assignee | 删 approve 的 `requireAssignee` | 非 assignee 用例红 | 红（403 变 200） |
| M2 | approve 过期拒绝 | 删 approve 的 `assertIntentLive` | 过期 approve 用例红 | 红（message 不再是 expired） |
| M3 | 只派发 approved | 删 dispatch 状态检查 | reject 后 dispatch 用例红 | 红（message 不再是 approve it first） |
| M4 | Work 必须 active | 删 dispatch 的 `assertActiveWork` | 第二意图 waiting 用例红 | 红（被活跃 Run 守卫取代，message 不含 waiting） |
| M5 | work.mandateId 指针 | 删指针一致性检查 | 旧 approved 意图用例红 | 红（旧 Mandate 被用于派工） |
| M6 | Mandate 仍 active | 删 `mandate.status !== 'active'` | 暂停 Mandate 用例红 | 红（paused 仍派工） |
| M9 | action class 在 Mandate 内 | 删 action class 检查 | 越界 action 用例红 | 红（创建 Run） |
| M10 | Agent 在 allowlist 内 | 删 allowedAgentIds 检查 | 越界 Agent 用例红 | 红（创建 Run） |
| M11 | 机器 Run provenance 完整 | 删 `createInTransaction` 的完整性检查 | 缺 dispatchIntent 用例红 | 红（DB 约束失败） |
| M12 | 普通 create 不得伪造机器来源 | 删 `create()` 的 origin 守卫 | human create 用例红 | 红（创建 Run） |
| M13 | 无条目机器 Run 仍带 workKey | 删 `explicitWorkKey` 兜底 | 无条目正控红 | 红（`run_origin_fields` 失败） |
| M14 | 新 Mandate 取消 approved | 取消范围改回仅 proposed | 版本推进用例红 | 红（意图仍 approved） |
| M15 | 终态恢复 work active | 删 run-status 的 waiting→active | 正控终态断言红 | 红（仍 waiting） |
| M16 | 意图落 workKey | 删 admission 的 `workKey` | 有意图用例红 | 红（15/15 建意图失败） |
| M17 | 派工幂等键生效 | key 改随机 | 同 key 重放用例红 | 红（第二次 409） |
| M18 | 派工前意图未过期 | 删 dispatch 的 `assertIntentLive` | 过期 dispatch 用例红 | 红（message 不再是 expired） |
| M19 | 幂等重放读当前状态 | 重放直接返回 `outcome.value` | 取消后重放用例红 | 红（仍返回 approved） |

**分层防御说明**：M2/M3/M18 的 SQL CAS（`where status/expires_at`）与 service 预检是两层；单删 service 层后仍会被 CAS 拒绝，测试通过新增的稳定 message 判据把 service 层隔离出来。`full_access` 同时由派工端口与 `createInTransaction` 检查，单删任一层仍被另一层拒绝，故不做“必红”变异，保留为双层负控。

## 6 边界与未交付

- `autoDispatch='existing_task'` 未消费：仍必须人工 approve 后 dispatch；自动直达归 RD-03b。
- 未选择候选/排序：03a 由成员显式提交 Agent/Device/Workspace；端口只做硬筛，不写候选排序/排除理由（candidates 仍为空）。RD-03b 补齐。
- 预算/次数账本未做：`maxRunsPerWork/maxCostMicros/maxTokens/maxAttempts` 仍只存储，不预占/结算；派工前不因额度拒绝。归 RD-03b。
- 固定草稿工具面、步级预批准、私有草稿、`mandateInvalidated` 逐次工具复核未做；归 RD-03c。机器 Run 目前仍按 `approval_required` 走既有逐次审批，没有工具面强制。
- Run 边界自动续接、`ask`/`decisionId`、`authorize_scope`、`owner_confirmation` 承接、wait 到期重评未做；归 RD-03d。本切片只把 work 从 waiting 恢复 active，不建立下一意图。
- `dispatch_intent` 的 `decision` 字段/枚举仍没有 `dispatch` 值；03a 沿用 RD-01 的 `propose` 决定 + 人工确认。是否扩展 Router 决定词表归 RD-03b。
- 跨成员委托、Web 工作读面未做；`apps/web` 未改。
- 普通 HTTP 建 Run 仍可指定 `workInputItemIds`，但不会被标成机器 Run；RD-03b 需在自动路径复用同一端口。
- 来源漂移负控直接改了 `task_message` 行（无编辑 HTTP 面），已注 `removeWhen`；其余负控的 paused Mandate / reopened approved / expiresAt 也是受控夹具，均注删除条件。

## 7 复跑

```bash
pnpm check
pnpm test:integration
```
