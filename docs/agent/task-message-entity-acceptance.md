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
| 受理成功必有 Run | `accepted` 无 `run_id` → `23514` + `task_message_accepted_has_run`（评审实测原先可入库）；四种合法组合（pending±run / rejected±run / accepted+run）不得被误伤 | PASS |
| 线程读取 | **同一 `createdAt` + 逆序 id** 的两行按 `(createdAt, id)` 读出确定顺序，且只返回本 Task 的消息（单 Team 部署下用第二个 Task 验 `task_id` 过滤） | PASS |
| **老库升级**（评审点名缺失项） | 独立 schema 只应用 0001/0002 → 按旧表结构灌 3 行真实数据（含 10 000 字边界与首尾空白）→ 应用 0003：行数不变、全部成 `discussion/human`、body 逐字完好、`task_comment%` 约束与索引零残留、`accepted_has_run` **按约束名**生效 | PASS |
| **反向 SQL**（回滚收口） | 跑 0001→0003 后按骨架反向执行：零失败，列/约束/索引名逐名回到迁移前；台账行须显式删除否则 0003 被静默跳过 | PASS |

## 变异验证（证明用例有牙）

| 变异 | 期望 | 结果 |
|---|---|---|
| 去掉 `asc(taskMessages.id)` 决胜键 | 排序用例必须变红 | ✅ 变红（**整改前**该用例两行 `createdAt` 不同，去掉兜底照样绿——断言落空，评审抓出） |
| 删掉 `task_message_accepted_has_run` | 「受理成功必有 Run」用例必须变红 | ✅ 变红 |
| `instruction_state='accepted'` 且无 `run_id` 入库 | 必须被拒 | ✅ `23514`（整改前可入库） |
| 把 `accepted_has_run` 改成恒真（等于删约束） | 迁移用例也必须红 | ✅ 修复后变红（**修复前**该用例用正则「任一约束名」+ 一行同时违反两条约束 ⇒ 空转照样绿，评审抓出） |
| 反向 SQL 漏掉某条约束改名 | 回滚用例必须红 | ✅ 逐名比对会红（迁移与骨架漂移即失败） |

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
- **回滚：骨架已机器验证，但不随仓库发 down-migration**。反向 SQL 由
  `packages/db/tests/task-message-rollback.integration.spec.ts` 常驻验证（跑 0001→0003 再反向，
  断言列/约束/索引名**逐名**回到迁移前；任何人改 0003 而忘了同步骨架就会红）。迁移尾部另有
  一条**台账提醒**并经用例钉住：反向 SQL 不含删 `_schema_migrations` 行，而**不删就会被下次
  部署静默跳过 0003**（应用代码已按 `task_message` 写 → 起服务即报 relation 不存在）。
  真回滚仍须先备份、现场按骨架执行。
- **`run_id` / `target_agent_id` 未建索引**（PG 不自动索引外键）：③b 要查「某 Run 的消息」时补；
  另无「`run_id` 必须属于同一 Task」的跨表约束（仓库全局无此类先例）。
- **`origin='auto_assignment'` + `kind='discussion'` 仍可入库**：自相矛盾的来源（自动指令不该
  是讨论），危害低（审计查询会命中一条惰性讨论），未加约束。
- **schema ↔ SQL 漂移无门禁**：本仓检查链没有 drizzle 漂移步骤，约束名/索引名不一致机器看不见
  （本片靠人手核对 + 升级用例里的残留名断言兜住一部分）。
- **本地 integration 有超时脆弱性（既有，与本片无关）**：本机负载 7+ / Docker VM 打满时，若干部件
  用例按 5s 默认超时失败；`git stash` 后在 `main` 上同样复现（`comment.integration.spec.ts`、
  `artifact.integration.spec.ts` 皆然），故本地以「新增用例 + CI」为准，不据此判定回归。
