# Project、Task、Comment 与 Agent Revision 验收

- 对应场景/门禁：G2-01..06（04-验收矩阵与测试策略.md）、Q0/Q1/Q2
- 对应 Issue：P1-06
- 上次验证：2026-08-26 · feat/p1-06-project-task-agent · 结果 PASS（干净 checkout 复验）

## 验的是哪条用户路径

两名成员围绕团队对象协作：Alice 建 Project 与指派 Bob 的 Task（Assignment 始终 pending，不静默接受）；Bob 接受/拒绝，Alice 重新指派（assignment 重置 pending）；Alice 与 Bob 各发 Comment（稳定排序）；任意 Member 拉 Task Room 聚合（Task + Assignment + Comments + Run 投影 + 已发布 Artifact metadata），聚合不泄露 runtime internals（dshSessionId / workspacePath / modelApiKey / storageKey）；责任人显式提交验收（需无活跃 Run 且有 published Artifact）、完成、取消（带活跃 Run 时 Task transition 与 Run cancel Outbox 同事务提交）；Owner/Admin 建不可变 Agent Profile Revision（revision 单调递增、digest 可重算、不可变快照不追随后续修改）。

## 驱动（怎么触发）

全部走真人同一条 HTTP 路径——Fastify `app.inject` 经 `/api/v1` 真实路由、Origin/Idempotency-Key/Cookie 中间件、Zod 严格解析与统一错误 envelope（六原语 #1）。数据库是 Docker 一次性 PostgreSQL 18：

```bash
pnpm test:integration     # Q2：packages/db + apps/hub 全部 integration spec
# 只跑本 Issue 的 5 个 spec：
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/project.integration.spec.ts apps/hub/tests/task.integration.spec.ts \
  apps/hub/tests/assignment.integration.spec.ts apps/hub/tests/comment.integration.spec.ts \
  apps/hub/tests/agent.integration.spec.ts
```

## 观测（看什么）

- DB 行：`project`、`task`（status / assignment_status / assignee_user_id / accepted_at / completed_at）、`task_comment`（按 (created_at, id) 排序）、`agent` + `agent_profile_revision`（revision 号、profile_digest、current_revision_id）、`team_event`（project.changed / task.changed / comment.created）、`run` + `dispatch_outbox`（cancel 用例）。
- HTTP envelope：`{ ok, data }` 成功体与 `{ ok:false, error:{code,message,requestId} }` 失败体。
- 脱敏：`GET /tasks/:taskId` 的 JSON 整串不含 `workspacePath|dshSession|modelApiKey`，Run 投影无 dshSessionId/deviceId/workspaceId/digest，Artifact 无 storageKey。

## 判定（成功长什么样）

- G2-01：建 Project + 指派 Bob 的 Task → 201，`status=open`、`assignment_status=pending`、`accepted_at=null`；两名成员都 GET 到。
- G2-03：Bob `POST /accept` → `assignment_status=accepted`、`accepted_at` 非空；非 assignee `accept` → 403 FORBIDDEN。
- G2-04：Bob `reject` → rejected；Alice `POST /reassign`（assignee 变自己）→ `assignment_status=pending`、`accepted_at=null`。
- G2-05：有活跃 Run 时 `reassign` → 409 CONFLICT，Run 状态不变。
- G2-06：Alice/Bob 各发一条 Comment → 时间线 `['alice first','bob second']`。
- 幂等：重复 `Idempotency-Key` 不产生第二个 Project/Task/Comment/Agent/Revision（command_receipt）。
- Agent revision：号 1/2/3 无间隔；同语义输入同 digest；`computeProfileDigest` 重算等于库存值；Member 建 Agent → 403；未知 pluginPack → 404；重名 → 409。
- Task Room：聚合形态正确且不含 runtime internals（02 Step 1 正则断言）。
- 生命周期：`submit-review` 无 published Artifact → 409，有则 `in_review`；`complete` → `done`（Run/Agent 不自动完成）；`cancel` 带活跃 Run → Task cancelled + Run cancel_requested + run.cancel outbox 同事务。

## 归因（失败先看哪层）

- Task/Assignment 状态不对 → `apps/hub/src/modules/task/commands.ts`（transitionTask/transitionAssignment 放行 + 守卫顺序）。
- 幂等不成立 → `packages/db/src/transaction.ts`（transactCommand + command_receipt）。
- Task Room 泄露 runtime internals → `apps/hub/src/modules/task/view.ts`（Run/Artifact 投影剥离字段）。
- Agent revision/digest 不对 → `apps/hub/src/modules/agent/commands.ts`（revision 锁分配 + computeProfileDigest 规范化键序）。
- cancel 不原子 → `apps/hub/src/modules/run/cancel.ts`（cancelRunInTransaction，与 P1-10 orchestrator 共享）。
- 错误码/状态码不对 → `apps/hub/src/app.ts`（统一错误处理器：ApiError/ZodError/DomainError 映射）。

## 取证

```bash
pnpm test:integration
bash scripts/secret-scan.sh apps/hub packages/db packages/protocol
```

## 边界与未覆盖

- **协议补条**：05 里程碑把「重新指派」列为 P1-06 交付，但 03 §4 路由表未单列 reassign。本 Issue 按 accept/reject 同形补 `POST /tasks/:taskId/reassign` + `ReassignTaskRequestSchema`（协议 SSoT 加法，fixture/catalog/drift 门同步）。reassign 仅允许从 accepted/rejected 出发（03 §3.1 无 pending→pending 边），pending 任务改 assignee 需先 accept/reject。
- Agent 变更不经 Team Event 广播（03 §5 的 8 类事件无 agent），Web 经 `GET /agents` 拉取。
- cancelRunInTransaction 为 P1-10 orchestrator.cancel 与 P1-06 cancelTask 共享的事务内写入；P1-16 将统一覆盖取消/强杀/重跑的其余态。
- Task Room 的 Run 投影是 team-visible 子集（无 dshSessionId/digest/device/workspace）；owner 专有的诊断摘要由 `GET /runs/:runId`（P1-13 接线）给出。
- `packages/db/tests/outbox.integration.spec.ts` 的「visibility timeout 重投」用例存在与本 Issue 无关的预存时钟敏感偶发（next_attempt_at 与 claim now 的微秒竞争），非本次引入。
- 真实 WebSocket 投影（task.changed/comment.created 推浏览器）是 P1-08；本 Issue 只落持久 team_event 行。

## 复跑

```bash
corepack enable && pnpm install --frozen-lockfile && pnpm -r --if-present build
pnpm check && pnpm test:integration
# 须在干净 checkout（不位于 .worktrees/ 布局）里跑，验证不依赖目录巧合。
```
