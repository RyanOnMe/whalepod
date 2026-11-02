# RD-01 持续工作、Mandate 与影子准入验收

- 对应场景/门禁：ADR-0028 §2/§4/§7 的基础承接链；Q0 静态门、Q2 数据门
- 对应 Issue：#483（RD-01）
- 上次验证：2026-11-02 · 合入提交 `a2e414d`（PR #487，squash）· PASS
- 本切片边界：只落协调元数据与影子决定；**不建 Run、不发 outbox、不写 TeamEvent/Decision/Correction/Artifact、不调用模型、不实现工作收件箱/订阅快路径/自动派工**。

## 验的是哪条用户路径

Task 的当前责任人在既有 Task 上创建一份持续工作，确认一份带职责、来源、Agent、工具与额度上限的 Mandate；随后成员可以对一条真实 Task 讨论消息或项目上下文条目显式触发「影子准入」。系统必须给出可解释的 `ignore/wait/propose` 决定（`ask` 属 Router 语义，本切片不产生），并为 `propose` 留下一条仅处于 `proposed` 的派工意图；整个过程不得创建任何 Run 或业务事实。责任变更后，旧工作不得被新 assignee 接管或自动复活。

## 驱动（怎么触发）

全部走生产 HTTP 与真实 PostgreSQL（`apps/hub/tests/work-mandate.integration.spec.ts`）：

```bash
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-mandate.integration.spec.ts
```

覆盖的端点：

- `POST/GET /api/v1/tasks/:taskId/works`、`POST /api/v1/works/:workKey/retire`
- `POST/GET /api/v1/works/:workKey/mandates`
- `POST /api/v1/mandates/:id/pause|resume|revoke`
- `POST /api/v1/works/:workKey/admission-checks`
- `GET /api/v1/works/:workKey`

来源使用生产路径：Task 评论（`POST /tasks/:taskId/comments`）、约定确认（`agreement/draft` → `agreement/confirm`）产生的 Decision 条目、以及成员纠正（`POST /projects/:projectId/context/:entryId/correction`）。数据夹具分两类：①「已定向 instruction 消息」——生产路径创建它必然同时建 Run/outbox，无法隔离本切片判据；消息本身不是运行时投影，测试不写任何运行时状态；② `createAgentWithPolicy` 直接插入 `plugin_pack/agent/agent_profile_revision` 以验证候选 Agent 与 `full_access` 拒绝，这些是参照数据而非运行时投影。两类都在「边界」登记。

## 观测（看什么）

- 协调表：`work`、`work_mandate`、`router_decision`、`dispatch_intent`。
- 业务计数：`run`、`dispatch_outbox`、`team_event` 在准入前后必须完全相同。
- 结构化日志：`component='hub.work'`、`action='work.admission_decided'`，字段只含 `workKey/decision/reason/sourceType/sourceId/mandateVersion/duplicate`，不含正文。
- 审计：显式路由的 `work.create`、`work.retire`、`work.mandate.create`、`work.mandate.pause/resume/revoke`、`work.admission.check`；Task 终态自动退休 work 只落 task 命令审计与状态，不额外伪造 `work.retire` 审计。
- 读面：`GET /works/:workKey` 返回工作、当前 Mandate、最近决定、仍为 `proposed` 的意图与处理水位；`GET /works/:workKey/mandates` 按版本从新到旧返回，并标记 `current`。

## 判定（成功长什么样）

### 1. 身份与授权

- 非 Task assignee 创建/退休工作、创建/变更 Mandate、触发准入一律 `403 FORBIDDEN`；Owner/Admin 不绕过。
- `POST /tasks/:taskId/works` 只接受已接受、非终态 Task；未接受返回 `409 ASSIGNMENT_NOT_ACCEPTED`，终态返回 `409 TASK_TERMINAL`。
- 同一 Task 同时最多一份未退休工作；重复创建 `409 CONFLICT`；退休后允许创建后继工作，历史仍可读。
- `work.work_key` 是 Hub 生成的 UUIDv7，项目内可读；`human_owner_user_id` 固化为创建时 assignee。
- Task 改派后：work 转 `waiting(owner_confirmation)` 并取消旧 proposed；新 assignee 可在旧工作上退休（已测），不得创建/pause/resume Mandate（`409 CONFLICT`），但可 `revoke` 作为安全停止（已测，返回 `current=false`）；首次改派后的准入返回 `wait(owner_changed)`；改派回来也不自动复活。

### 2. Mandate 版本化与停止

- 首次创建 `version=1,status=active,current=true,autoDispatch=off`；四个身份字段全部等于当前 assignee。
- 新 Mandate 版本递增；`pause`、`resume`、`revoke` 各追加新版本并递增，旧版本保留（`current=false`）。
- `active → paused → active → revoked` 合法；从 revoked/expired/superseded 继续迁移返回 `409`；重复同状态操作幂等。
- 撤销或新版本产生时，旧 `proposed` 意图全部置 `cancelled`；因此不存在“撤销后还能确认/派发”的意图。
- 应用校验拒绝：草稿受众非本人、`bash` 等固定草稿工具面外工具、过去时间 `expiresAt`、非允许 action class、重复数组项、已归档/无 Revision/`full_access` 的候选 Agent。
- 到期未落库时读面按 `expired` 呈现；准入按 `mandate_expired` 忽略。

### 3. 准入规则（确定性）

| 输入事实 | 期望 |
|---|---|
| 无 active Mandate / paused / revoked / superseded / draft | `ignore(no_mandate)` |
| active Mandate 已过 `expiresAt` | `ignore(mandate_expired)` |
| Task 已 `done`/`cancelled` | 优先判定：work 同事务转 `retired`、旧 proposed 取消；准入 `wait(work_state)`，`refs.detail='task_terminal'` |
| work `waiting`/`retired`（非终态 Task） | `wait(work_state)`，带 `deadlineAt`；读面 `currentMandate=null` |
| Task 的 `approvalPolicy='full_access'` | `wait(full_access_task)`，不产生 `proposed`；已有 proposed 在策略切换时取消 |
| Task `assignmentStatus!='accepted'`（如同人改派后待接受） | `wait(assignment_pending)`，不提案 |
| Task 改派给另一名成员 | work 转 `waiting(owner_confirmation)`，旧 proposed 取消；首次准入 `wait(owner_changed)`，改派回来后 `wait(work_state)`，都不自动复活；新 assignee 只能 revoke/retire，不能 create/pause/resume |
| `work.human_owner != task.assignee`（改派后的第一判定） | `wait(owner_changed)` |
| 同一 `(work, sourceType, sourceId, sourceVersion, sourceDigest)` 重复检查 | 返回既有决定，`duplicate=true`，不追加决定/意图（Issue #483 原文写 `ignore(duplicate)`；本切片选择返回既有决定并显式标 `duplicate=true`，避免为去重伪造第二条决定） |
| 来源类型不在 Mandate `allowedSourceTypes` | `ignore(source_not_allowed)` |
| Task 消息是 `instruction`/`followup` | `ignore(already_directed)` |
| Task 消息作者已不是启用成员 | `ignore(source_inactive)` |
| 上下文条目 `status!=active` 或已 `correctedAt` | `ignore(source_inactive)`，`refs.detail='corrected'/'inactive'` |
| 外部来源条目（`sourceId!=null`，权限代次未复核） | `ignore(source_inactive)`，`detail='source_permission_unverified'` |
| 系统 Inference | `ignore(system_produced)` |
| 条目无法归属到本 Task（含无引用/异 Task） | `ignore(source_out_of_scope)` |
| 其余讨论消息/有效上下文条目 | `propose(needs_semantic)` + 一条 `dispatch_intent(status='proposed', approvalBasis=null, runId=null)` |

- 所有决定都保存 `source_digest`、`input_digest`（含工作、规则版本、最新/active Mandate 版本、逐来源授权代次）与 `rules_version='rd01.v1'`；不保存来源正文。同一毫秒内的来源更新也因 `source_digest` 进入去重身份而不会被旧决定吞掉。
- `proposed` 意图的 `expiresAt = min(now + waitDeadlineSeconds, mandate.expiresAt)`；`candidates/exclusionReasons` 为空数组（RD-01 不做候选选择）。
- 准入前后 `run/dispatch_outbox/team_event/context_entry/artifact/task_spec_revision` 计数相等；`dispatch_intent` 只会出现 `proposed`/`cancelled`；`work-boundaries.spec.ts` 对工作模块的模型/Node/Run/outbox/业务写入依赖做静态判红。
- 同一 `Idempotency-Key` 只在同一 actor + 资源 + 请求摘要作用域内重放；跨成员/跨资源/不同请求体共享同一 key 不得返回他人或旧请求的结果；准入回执重放会回读当前决定/意图状态。

## 归因（失败先看哪层）

- HTTP/授权：`hub.audit` 的 `work.*` 成功动作；403 先核对 HTTP 状态、`task.assigneeUserId` 与 `getEnabledMember`（当前路由只为成功动作写审计，拒绝路径不写 `hub.audit`）。
- 准入决定：`hub.work`/`work.admission_decided` 的 `decision/reason/mandateVersion`；再查 `router_decision` 与 `dispatch_intent`。
- 状态迁移：`work_mandate` 按 `work_id, version desc` 读最新；检查 `current=true` 是否为最高版本。
- 无 Run/outbox：查 `run`、`dispatch_outbox`、`team_event` 的计数差；为 0 才通过。
- DB 约束：`work_task_current_unique`、`router_decision_source_unique`、`work_mandate_identity`、`work_state_fields` 的 `23505/23514` 会被路由翻译成 `409/400`，不泄露 SQL。

## 取证

```bash
# Q0
pnpm check

# Q2（全量）
pnpm test:integration

# 本切片定向
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-mandate.integration.spec.ts

# 提交前敏感扫描
scripts/secret-scan.sh apps/hub/src/modules/work packages/protocol/src/work.ts \
  packages/db/migrations/0024_work_mandate_shadow.sql
```

- 2026-11-02 合入验证（`a2e414d`）：Q0 `2269 passed`（含 1 条边界单测）；Q2 `85 files / 717 tests passed`；定向 `25 passed`。
- 迁移：`packages/db/migrations/0024_work_mandate_shadow.sql`；Drizzle 镜像 `packages/db/src/schema/work.ts`。0024 是未合入分支上的新迁移；应用过中间提交 `a4f0a85` 的本地库必须重置（迁移台账只按文件名记录，不会校验内容）。

### 单点变异（每条改一处、跑对应用例、必须红、随后恢复）

| 编号 | 变异 | 对应判据 | 结果 |
|---|---|---|---|
| M1 | 去掉 assignee 相等检查 | 非 assignee 创建/退休 403 | RED |
| M2 | 去掉 assignment accepted 检查 | 未接受 Task 409 | RED |
| M3 | 不拒绝 `full_access` 候选 | 候选校验 400 | RED |
| M4 | 去掉工作责任人变更检查 | 存储的 work owner 与 assignee 不一致时建 Mandate 409 | RED（故障注入用例） |
| M5 | Mandate 状态迁移恒允许 | revoked 后 pause 409 | RED |
| M6 | 新版本产生时不取消 proposed | pause/resume/revoke 后意图 `cancelled` | RED |
| M7 | 退休时不取消 proposed | 退休后意图 `cancelled` | RED |
| M8 | 幂等 key 去掉 actor/task/请求摘要作用域 | 跨成员/跨请求同 key 不串结果 | RED |
| M9 | 去掉 `no_mandate` 分支 | 无 Mandate 返回 `ignore(no_mandate)` | RED（500：后续来源白名单分支解引用 undefined Mandate） |
| M10 | 去掉 work 非 active 分支 | 退休工作 `wait(work_state)` | RED |
| M11 | 去掉责任人变更分支 | 改派后 `wait(owner_changed)` | RED |
| M12 | 去掉 Task 终态分支 | 终态 Task `wait(task_terminal)` | RED |
| M13 | 不判断 Mandate 到期 | 到期 `ignore(mandate_expired)` | RED |
| M14 | 不检查来源类型白名单 | `ignore(source_not_allowed)` | RED |
| M15 | 不检查 correctedAt（只看 status） | 被纠正条目 `ignore(source_inactive)` | RED |
| M16 | 不区分 instruction 消息 | `ignore(already_directed)` | RED |
| M17 | 去掉决定插入的冲突忽略（唯一索引） | 同来源版本二次检查不新增决定 | RED（409） |
| M18 | 版本列表不标当前版本 | `current` 只有最高版本为 true | RED |
| M19 | 固定工具面加入 `bash` | 面外工具 400 | RED |
| M20 | 不判断 Task `full_access` | full_access Task 只 `wait`，不提案 | RED |
| M21 | 不判断 Task `assignmentStatus` | 待接受 Task 只 `wait(assignment_pending)` | RED |
| M22 | 工作模块加入 `fetch(` | 模型/网络依赖静态边界判红 | RED |
| M23 | 不检查 context entry `status`（只看 correctedAt） | superseded 条目 `ignore(source_inactive)` | RED |
| M24 | 改派时不取消 proposed | 改派后意图 `cancelled` | RED |
| M25 | Task 终态时不退休 work | 取消 Task 后 work `retired`、意图 `cancelled` | RED |
| M26 | 新 assignee 的 revoke 安全停止也拒绝 | 改派后新 assignee revoke 200/current=false | RED |

- M9 的红色形态是 500：去掉分支后代码继续走到来源白名单分支，解引用 `mandate.active.allowedSourceTypes`（undefined）抛出 TypeError；它仍是「无 Mandate 不得提案」的 fail-closed 负控，不是允许通过。
- M17 的红色形态是 409：去掉 `onConflictDoNothing` 后第二次同来源版本插入撞唯一索引，路由翻译为冲突；恢复后回读既有决定并返回 `duplicate=true`。
- M4 通过故障注入覆盖：正常改派先把 work 置 waiting，状态检查也能拒绝；测试直接构造「stored work owner ≠ assignee」的不一致状态，让 owner 检查成为唯一拒绝判据。

## 边界与未覆盖

- **影子切片**：不实现 `approved/dispatched`、派工端口、Run/outbox、系统 actor；`dispatch_intent` 只落 `proposed/cancelled`。M1R-A 的自动续接、工具步级预批准、草稿/提问/暂停与额度执行均未做。
- **工作收件箱/订阅快路径未做**：没有 `pending/delivered/consumed/unconfirmed/returned/superseded/retracted/expired`，没有投递/消费回执，也没有「已知订阅补充不调用 Router」的判据。归 RD-02a/02b。
- **Task 改派**：生产改派命令把该 Task 的未退休工作转 `waiting(owner_confirmation)` 并取消 proposed；首次准入返回 `owner_changed`，改派回来也不会自动复活。RD-01 没有「新 assignee 确认承接」端点，新 assignee 的合法路径是显式退休旧工作后另建（已测）；确认承接归后续切片。Agent 目标只有在 human assignee 变化时才走 waiting；同一 human 改派给 Agent 不改变 human owner，RD-03 必须在候选/Revision/现场复核，未单独做双管理员场景测试。
- **到期不落库**：没有 sweeper；读面派生 `expired`，准入每次按 `expiresAt` 判断。RD-02/03 接入定期收敛。
- **同来源版本的重复是终局**：去重身份是 `(work, sourceType, sourceId, sourceVersion, sourceDigest)`；同一内容一旦裁决，改变 Mandate 后不会自动重评（需要来源产生新版本/新摘要）。Issue #483 原文写 `ignore(duplicate)`，本切片实际返回既有决定 + `duplicate=true`，已在规则表和本节登记。RD-02 的工作收件箱用 supersede/新输入解决。
- **夹具**：`insertMessage` 造一条已定向 instruction，避免生产路径同时建 Run 污染「准入不建 Run」判据；`createAgentWithPolicy` 直插 pack/agent/revision 作为候选参照；`rejects a mandate when stored work ownership is inconsistent` 直接改 `work.human_owner_user_id` 做故障注入（正常路径不会产生该状态），删除条件为 RD-02 归一化旧行或生产路径能真实产生/核对不一致工作。三者都不是运行时投影，测试未写 Run/outbox/TeamEvent；`tests/` 不属于 `checkHarnessDbSeeds` 的 `scripts/` 扫描面，故未登记白名单。
- **无模型调用**：`apps/hub/tests/work-boundaries.spec.ts` 对工作模块做静态依赖判红（模型 SDK、DSH、Runtime/Testkit、Run/outbox、业务写入、`fetch(` 任一出现即失败）；不是网络抓包。真实 Router 语义与成本归后续切片。
- **`ask` 未实现**：RD-01 程序规则只产生 `ignore/wait/propose`；`ask` 需要 Router 语义与问题生命周期，归后续/模型切片。
- **工具面只到名称级**：`read/write/edit/glob/grep` 名称白名单之外一律拒绝；路径/资源范围、固定草稿面逐名正负控与 `approval_required` 步级预批准归 RD-03。
- **旧 Mandate 版本仍在库**：pause/resume/revoke 追加新版本，旧版本保留历史；派工端口必须校验 `work.mandateId === intent.mandateId`，RD-03 负责。
- **未测/不可达分支**：外部来源条目（`sourceId!=null`）、`followup` 消息、`done` Task（与 cancelled 共用终态守卫）、archived/no-revision Agent、来源创建者停用后已有决定的重评、同毫秒重复编辑、Mandate 创建/状态回执的过期视图在 RD-01 没有生产触发路径或保持外部可见性；相应代码为 fail-closed 或归后续切片。
- **授权代次**：`authorizationGeneration` 仍是 `member/internal/source.unverified` 常量；成员在决定后被停用不会回撤已有 proposed（RD-03 派发前必须逐来源复核）。
- **Task 终态**：complete/cancel 同事务退休工作并取消 proposed；`work` 历史保留，`currentMandate=null`。
- **Mandate 回执**：创建/状态命令的 Idempotency-Key 可重放首次视图，可能显示旧 `status/current`；读面 `GET /works/:workKey` 为当前事实。准入回执已做当前状态回读。
- **同来源新版本**：新版本/新摘要会追加新 proposed，不自动 supersede 旧 proposed；RD-02 收件箱处理。
- **`full_access` 检查当前 Revision**：Mandate 只存 Agent id，RD-03 在派发时固定精确 Revision 并再次校验；当前检查防止把已知 full_access Agent 写进 Mandate。
- Q5/Q3/Q6/Q7 未跑：本切片无 Web、Node、Runtime、DSH 契约或安全策略改动。

## 复跑

```bash
git switch main && git pull
pnpm install --frozen-lockfile
pnpm --filter @whalepod/protocol build
pnpm --filter @whalepod/db build
pnpm check
pnpm test:integration
pnpm exec tsx scripts/with-test-postgres.mts \
  pnpm exec vitest run --project integration \
  apps/hub/tests/work-mandate.integration.spec.ts
```
