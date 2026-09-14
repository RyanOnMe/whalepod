# 讨论/执行分栏的读模型隔离验收（P1-194 / 切片③c-2a）

- 对应门禁：Q0（静态）+ Q2（真实 PostgreSQL 集成）
- 对应决策：**ADR-0010**（取代 ADR-0009 的 O3-a）
- 上次验证：2026-09-11 · `feat/p1-195-discussion-execution-separation` · 结果 PASS

## 验的是哪条链路

任务的读模型：讨论流（评论区）与执行流（执行区）如何切分。

**驱动**：走真人路径——`getTaskRoom(handle, taskId)`（任务详情的同一个读模型入口）+ 真实
`sendRunFollowup`（追问）+ db 层插入（讨论/指令夹具）。不开测试专用近道。

**为什么必须有**：ADR-0009 的 O3-a 把讨论与指令混进一条流，两种发言的**命运完全不同**——
讨论「落了就算送达」，指令带着 `pending`/`accepted`/`rejected` 三种命运、要权限、还牵出运行卡。
混在一列里时「我这句话被 Agent 拒了」与「我的讨论没发出去」长得一模一样。用户当场否决该设计。

## 判定（6 条机器判据，`apps/hub/tests/discussion-separation.integration.spec.ts`）

| 判据 | 断言 | 结果 |
|---|---|---|
| 讨论流只含讨论 | 混合任务里 `comments` **恰好**只有 `kind='discussion'`，指令/追问（含 `rejected`）一条都不出现 | PASS |
| 执行流只含指令 | `instructions` 恰好 `instruction` / `followup`，带 `instructionState` 与拒绝理由、带 `runId` | PASS |
| 互斥不漏 | 两流 id 集合无交集，且并集等于 `listMessages`（审计全量） | PASS |
| 评论区空态 | 只有指令的任务：`comments === []`（不是 `undefined`） | PASS |
| 执行区空态 | 只有讨论的任务：`instructions === []` | PASS |
| 顺序契约 | 两条流都按 `(created_at, id)`（同刻按 id 升序，钉的是契约不是堆序） | PASS |

## 变异验证（每条确认变异落盘、构建退出码为 0、结束时树还原）

| 变异 | 红 | 归因 |
|---|---|---|
| A 讨论流改回全量 `listMessages`（=O3-a 的形态） | **3** | 讨论流只含讨论 / 互斥不漏 / 空态之一 |
| B `listDiscussionMessages` 去掉 kind 过滤 | **3** | 同上（隔离在 db 口径与视图两处各有一道） |

## 归因（失败先看哪层）

- **讨论流里出现指令** → `apps/hub/src/modules/task/view.ts` 是否用了 `listDiscussionMessages`
  （而不是 `listMessages`）；
- **执行区看不到指令** → `TaskRoomView.instructions` 是否装配；db 侧 `listInstructionMessages`
  的 kind 过滤是否被改动；
- **被拒理由读不到** → `instruction_error_code` / `_message`（migration 0004 加的两列）。

## 未覆盖与已知项

- **UI 尚未跟上**：分栏后的执行区（并列两栏、指令输入框、运行卡覆盖层）属于**切片⑥**；
  在此之前 Web 端仍只渲染讨论流——**不构成功能回退**，因为今天 Web 端**没有任何创建指令的入口**
  （`POST /tasks/:taskId/comments` 只发讨论），指令只能由 API 产生。
- **原型的形态已过期**：`prototype/task-room-conversational.html` 画的是合并线程 + 「@Agent 开头
  才是指令」，按 ADR-0010 决策 4（`@` 只用于提到人）需在切片⑥重画。
- **公开命名未统一**：`CommentView` / `comment.created` / `POST /comments` 仍在用；ADR-0010
  明确放到切片⑥（那时本来就重写这批文件），避免半成品改名。
- **讨论流不提示「有人发起了执行」**：用户倾向不加系统提示；若实际使用出现信息真空再单独立项。

## 复跑

```bash
pnpm check
npx tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/discussion-separation.integration.spec.ts --testTimeout=30000
```
