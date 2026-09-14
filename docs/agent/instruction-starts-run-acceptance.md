# 执行区指令起 Run 验收（P1-196 / 切片③c-2b）

- 对应门禁：Q0（静态）+ Q2（真实 PostgreSQL 集成）
- 对应决策：ADR-0009 决策 3/5 + **ADR-0010 决策 2**（执行区入口）
- 上次验证：2026-09-11 · `feat/p1-196-instruction-starts-run` · 结果 PASS

## 验的是哪条链路

执行区里说一句「让 Agent 干这个」：**有活跃 Run → 追问**（③c-1 语义）；**没有 → 建 Run**，
并把指令与 Run 双向锚定（`run.trigger_message_id` ↔ 消息 `run_id`）。

**驱动**：服务层走 `sendInstruction`（与路由同一条函数）+ 真人路径喂 `run.start` ack；
HTTP 面走 `POST /api/v1/tasks/:taskId/instructions` 的 Fastify inject。

## 判定（13 条机器判据，`apps/hub/tests/instruction-start-run.integration.spec.ts`）

| 判据 | 断言 | 结果 |
|---|---|---|
| 双向锚定 | 建 Run 后 `run.trigger_message_id` = 指令 id，指令 `run_id` = Run id、`kind='instruction'`、`instruction_state='pending'` | PASS |
| ack 两种命运 | `run.start` accepted → 指令 `accepted`；rejected → `rejected` + **理由落库**（`instruction_error_code` / `_message`） | PASS |
| 设备拒收 | gateway 拒绝 start（离线）→ 指令 `rejected(DEVICE_OFFLINE)`，Run 进 `failed`（不静默停在 pending） | PASS |
| 有活跃 Run | **不建第二个 Run**，降级为追问（活跃唯一约束不该被这条路径撞到） | PASS |
| 三段式① | 沿用该 Task **上一个 Run** 的设备/工作区（`source='last_run'`） | PASS |
| 三段式② | 没有上一轮 → 责任人**最近在线的设备** + 其可用工作区（`source='assignee_device'`） | PASS |
| 三段式③ | 无可用目标 → `undefined` / 409，**不建 Run、不落指令**（不猜） | PASS |
| Agent 不猜 | 无上一轮 Run 可继承且未显式给 `agentId` → 明确要求显式指定，且不留半成品 | PASS |
| 显式覆盖校验 | 别人的设备 → FORBIDDEN；工作区不可用 → VALIDATION_FAILED；已撤销 → DEVICE_OFFLINE | PASS |
| 库级约束（0005） | 触发消息必须与 Run **同 Task**（触发器拒绝跨 Task 锚点，且不留坏账行） | PASS |
| HTTP 201 | 显式目标 → 201，`outcome='started_run'`，指令 pending（命运由 ack 定） | PASS |
| HTTP 400 | body 非法 → **400**（不是 500：③b 的 `.parse()` 教训） | PASS |
| HTTP 409 | 无可用目标 → 409 `DEVICE_OFFLINE`，不建 Run、不落指令 | PASS |

## 归因（失败先看哪层）

- **404「agent has no profile revision」** → Agent 缺 Profile Revision（夹具问题，不是本片逻辑）；
- **500 而不是 409** → 运行面错误映射没生效：`RunCommandError` 的映射表在 run 插件里，任务路由
  要显式复用（本片首版即此，已改为共用 run 模块导出的 `ERROR_HTTP_STATUS` + `errorCodeOf`）；
- **没建 Run** → 先看三段式解析结果与设备是否「已 hello」（`dsh_distribution_version` 非空）；
- **指令停在 pending** → 看 `run.start` 的 ack 有没有回来（`settleTriggerInstruction` 挂在
  orchestrator 的 ack 分支上，锚点是 `run.trigger_message_id`）。

## 未覆盖与已知项

- **授权仍是「责任人」**：`orchestrator.create` 里的守卫没动，泛化到 `task_instruction_grant`
  是**切片④**的事（别在本片先造半套）。
- **UI 未跟上**：执行区输入框与设备选择器属于切片⑥；今天 `POST /instructions` 只有 API 调用方。
- **审批档位**：与手工起 Run 同档（ADR-0010 决策 5，不做自动降级）；`approval_policy` 字段本身
  在切片⑧。
- **同 Task 并发指令**：靠 `run_one_active_per_task` + Task 行锁串行化（既有语义），本片不新增机制。

## 复跑

```bash
pnpm check
npx tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/instruction-start-run.integration.spec.ts --testTimeout=30000
```
