# 交接待办直达与接收路径（#428 / ADR-0021 §6）验收记录

- 对应场景/门禁：G7 交接接收段 + Q0/Q1/Q2；页面行为由 Web 组件用例承载
- 对应 Issue：P1-428
- 上次验证：2026-10-23 · feat/p1-428-handoff-entry · PASS

## 验的是哪条用户路径

下游接收人在首页看到「确认接收交接」→ 点击直达该任务的固定版本交接卡（不是运行详情、
不是任务顶部）→ 在没确认接收、也没接受任务的前提下可以直接向上游提问 → 阅读失败时
不能确认「已理解」→ 确认理解后交接事项消失、任务尚未接受仍保留「接受任务」事项 →
接受任务后两者都不再出现。

## 驱动（怎么触发）

真实命令路径，不直插业务表：

```bash
# Hub：发布交接 v1 → deliver 给第二成员 → personalAttention（真实 SQL 投影）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/handoff-attention.integration.spec.ts

# Web：首页待办导航 + 交接卡（固定版本、失败禁用、提问、未接受标注）
pnpm exec vitest run --project web \
  apps/web/tests/attention-home.spec.tsx apps/web/tests/handoff-receipt.spec.tsx
```

## 观测（看什么）

- `personalAttention` 返回的 `AttentionItem`：`kind='confirm_handoff'`、
  `objectId=receipt.id`、`runId=null`、`taskId=下游 Task`；接收人专属，owner/admin 不可见。
- 同任务同时待接受时顺序为 `confirm_handoff` → `accept_assignment`。
- 提问写入上游 Task 的 `task_message(kind='discussion')`，receipt 仍为 `pending`，
  下游 Task 仍为 `assignment_status='pending'`。
- Web 导航落点为 `/tasks/<id>#handoff-receipt`，焦点落在交接卡容器；导航过程无 POST。

## 判定（成功长什么样）

- 待接收事项只在接收人队列出现；确认、接受、任务终态后按事实消失，不复活。
- 同一任务多份交接逐份可见；待办链接指向 `#handoff-receipt-<receiptId>` 的具体卡片。
- 改派时未确认回执随责任转移：旧接收人不再有待办且不能再确认，新责任人可确认；
  已确认回执保留原确认人与原版本。
- 提问不要求先确认接收，不改变 receipt 与任务状态，不创建 Run；重试复用同一幂等键，
  问题正文带版本/下游任务上下文。
- 交接正文读取失败时确认按钮保持禁用；重试成功后才可确认（既有 #396 用例继续通过）。
- 任务未接受（pending）或指派被拒绝（rejected）时卡片都明确提示，不冒充已接受。
- 以上任一断言缺数据或形状不符即 FAIL（Zod strict + 集成断言）。

## 归因（失败先看哪层）

- 待办不出现：先看 `apps/hub/src/modules/task/attention.ts` 的 SQL 与 `handoff_receipt`
  状态；再看 Web `PersonalAttention` 的 kind→destination 映射。
- 落点不聚焦：看 `TaskRoomPage` 的 `#handoff-receipt` 分支与 `useHashFocus`；侧栏未展开
  时 hash 就绪条件会拦住聚焦。
- 提问失败：看 `POST /tasks/:taskId/comments` 的讨论消息约束（ADR-0010），不是交接模块。

## 取证

```bash
git diff --stat feat/p1-428-handoff-entry
# 测试输出按上方命令复跑；本页与 ADR-0021 登记在 docs/agent/README.md
```

## 边界与未覆盖

- 未新增交接状态机；改派只转移**未确认**回执的接收人，已确认回执仍是历史事实。
- 提问复用讨论消息（带版本/下游任务上下文），不上游实时推送提问者输入。
- 交接卡上的材料仍是受控下载链接，不在本切片做在线预览（#431）。
- 批注、审阅邀请与修订执行不在本切片（#429/#430）。
- 生产装配 Q5 本轮未重跑；新增行为由 Hub 集成 + Web 组件判据覆盖，底层交接 E2E
  （`handoff-loop`）保持不变。

## 复跑

从干净数据库执行上方两条命令；Web 用例不需要 Docker，Hub 用例由
`with-test-postgres.mts` 自起临时 PostgreSQL。
