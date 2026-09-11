# task_message 实体升级验收（#185 · ADR-0009 切片③a）

- 对应场景/门禁：Q2 数据门（`pnpm test:integration`，`packages/db/tests/task-message.integration.spec.ts`）+ Q0
- 对应 Issue：#185（ADR-0009 决策 2 的实体升级；切片③ 的第一片）
- 上次验证：2026-09-11 · `feat/p1-185-hub-task-message` · 结果 PASS（新增 6 用例全绿；Q0 绿）

## 验的是哪条用户路径

任务线程里的**一条消息**：讨论 / 指令 / 追问同住 `task_message`（由 `task_comment` 改名升级）。
本片只升级实体与数据层约束，**不含**指令路径（建 Run / 降级 followup）与线程读模型 UI——那两件
是切片 ③b / ③c。

## 驱动（怎么触发）

真 PostgreSQL（`scripts/with-test-postgres.mts` 起一次性容器）+ 真实迁移链
（`packages/db/migrations/` 按序应用，含新增 `0003_task_message.sql`）；写入走仓储函数
（`insertMessage` / `listMessages`），与 Hub 评论命令同一条路。

```bash
# 本片新增用例（6 条）
npx tsx scripts/with-test-postgres.mts vitest run --project integration \
  packages/db/tests/task-message.integration.spec.ts
# 全量数据门
pnpm test:integration
```

## 观测（看什么）

落库行的 `kind` / `origin` / `target_agent_id` / `run_id` / `instruction_state`，以及
PG 错误码与**约束名**（`23514` = check_violation）。

## 判定（6 条用例）

| 用例 | 断言 | 结果 |
|---|---|---|
| 老写法（只给 body） | 落库即 `kind=discussion` / `origin=human` / 三个新字段全空——既有调用点无需改动 | PASS |
| 讨论不得携带 Agent / Run / 受理状态 | 三种越界组合各报 `23514` + `task_message_discussion_inert`（「默认不驱动」钉在库里） | PASS |
| 指令必须有目标 Agent 与受理状态 | 缺 Agent、缺状态各报 `23514` + `task_message_instruction_addressed` | PASS |
| 追问必须挂在既有 Run 上 | 报 `23514` + `task_message_followup_attached` | PASS |
| 枚举取值 | `kind='shout'` → `task_message_kind_valid`；`origin='robot'` → `task_message_origin_valid`；`instruction_state='maybe'` → `task_message_state_valid` | PASS |
| 线程读取 | 按 `(createdAt, id)` 稳定排序，且只返回本 Task 的消息（单 Team 部署下用第二个 Task 验 `task_id` 过滤） | PASS |

## 归因（失败先看哪层）

- `23514` 但约束名不符 → 用例没隔离到目标约束（其它 check 先命中），先补齐必填字段再断言；
- `23505` + `team_singleton` → 单 Team 部署（`singleton_key=1` 唯一），测试里不要 seed 第二个团队，
  换 Task 即可；
- 迁移未生效 → `packages/db/migrations/0003_task_message.sql` 未按文件名序应用（台账表跳过）。

## 未覆盖与已知项

- **指令路径与状态收敛未验**：本片没有「kind=instruction → 建 Run / 降级 followup → 状态收敛」
  的代码（切片 ③b），`instruction_state` 的所有写入者都在后续切片。
- **公开 API 与 UI 未改名**：HTTP 仍是 `POST /tasks/:taskId/comments`、视图仍叫 `CommentView`
  （新增五个字段是**附加**的，老客户端不受影响）。改名与线程 UI 一起做（③c）。
- **`comment.created` 团队事件名未改**：仍是既有事件类型，保留兼容；改名同 ③c。
- **本地 integration 有超时脆弱性（既有，与本片无关）**：本机负载 7+ / Docker VM 打满时，若干部件
  用例按 5s 默认超时失败；`git stash` 后在 `main` 上同样复现（`comment.integration.spec.ts`、
  `artifact.integration.spec.ts` 皆然），故本地以「新增用例 + CI」为准，不据此判定回归。
