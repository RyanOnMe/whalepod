# 交付物修订批次与批注复核（#430 / ADR-0021 §5）验收记录

- 对应场景/门禁：交付物审阅闭环后半（后端）+ Q0/Q1/Q2/Q3
- 对应 Issue：P1-430
- 上次验证：2026-10-24 · feat/p1-430-revision-round · PASS

## 验的是哪条用户路径

任务责任人从已发布交付物整理一轮修订：选择要处理的批注线程（回复随线程冻结）、
可附参考材料与补充方向 → 启动 Agent（默认可续接原产出会话，也可显式新执行）→
执行上下文里只出现本轮冻结的意见 → 责任人把本轮 Run 产出的候选显式关联为新版 →
发布新版后，批注作者确认「已解决/仍需修改」，责任人可写理由代为收口。

本切片只交付后端；审阅页的执行入口、待办与对比视图由前端批次接线。

## 驱动（怎么触发）

```bash
# 协议形状（批次创建/快照/复核）
pnpm exec vitest run --project unit packages/protocol/tests/review-round.spec.ts

# 执行上下文装配（含本轮意见、超限失败）
pnpm exec vitest run --project unit apps/hub/tests/execution-context.spec.ts

# Hub 全链：创建冻结 → 启动 Run → 上下文注入 → 候选关联 → 复核（真实 PostgreSQL；
# 9 例含选择边界、启动边界、崩溃恢复与超限退回）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/revision-round.integration.spec.ts
```

## 观测（看什么）

- `artifact_revision_round.input`：创建时冻结的 `ReviewInputManifest`（原稿、选定
  线程及回复、参考材料、方向）；创建后不再回写。
- `run.review_input`：启动时点固化的同一快照；`dispatch_outbox.payload.executionContext`
  含「本轮交付物审阅修订」、原稿标题、意见正文与回复。
- `run.artifact_input_manifest`：原稿 + 参考材料（同 Task、已发布、逐件摘要）。
- 状态：`preparing → starting → started`；`starting` 是启动认领，失败退回 `preparing`；
  崩溃恢复按 `run.review_input.roundId` 找回已建 Run。
- `artifact_revision_link`：候选必须 `runId = round.runId` 且同 Task；一批次一份新版。
- `artifact_comment_resolution`：作者或当前责任人写入，记录 `resolved_by` 与理由。

## 判定（成功长什么样）

- 非责任人创建/启动 403；设备离线明确 409 且批次退回可重试。
- 批次创建后补的批注不进入已启动执行；执行上下文与 `run.review_input` 都不含它。
- 重复「开始」返回同一 Run；认领后崩溃恢复也不会建第二条（Run 计数用例）。
- 候选不属于本轮 Run、或已关联另一份新版 → 明确 409。
- 新版未发布不能复核；作者可确认，责任人代收口缺理由 → 400，写理由后记录实际确认人。
- 任一断言缺数据或形状不符即 FAIL（Zod strict + 集成断言）。

## 归因（失败先看哪层）

- 快照/冻结问题：`apps/hub/src/modules/review/rounds.ts` 的 `createRevisionRound` 与
  `snapshotComments`；DB 看 `artifact_revision_round.input`。
- 上下文未到 Agent：先看 `run.review_input` 与 `dispatch_outbox.payload.executionContext`；
  再看 `buildExecutionContext`（hub）与 Runtime 的首条指令注入（#396 契约门）。
- 重复执行：看 `artifact_revision_round.status/run_id` 与 `run.review_input.roundId`；
  `starting` 停留说明建 Run 失败未退回或进程中途退出。
- 复核失败：`artifact_comment_resolution` 与候选 Artifact 的 `status/publishedAt`。

## 取证

```bash
git diff --stat main
# 上方三条命令复跑；03 文档 §2.6/§4 与 ADR-0021 §5 已同步
```

## 边界与未覆盖

- 前端未接线：审阅页的「整理本轮修订」「新版对比」「待复核」、以及待办
  `organize_feedback`/`resolve_comments` 留到前端批次；本切片没有新增待办类型。
- 未跑生产装配 Q5/真实 Node→Runtime 执行：本页只证明 Hub 快照与下发 payload；
  Runtime 的首条指令注入由既有 #396 契约门覆盖（Q3 本轮 74 例通过，
  `executionContext` 同一条通路）。
- 未做并发压测：启动认领用条件更新，锁序与改派一致；高并发下的行为按单条用例。
- 图片/PDF/Office 的原位批注与预览仍在 #431。
- 批次取消、逐条意见的版本历史（多次复核）暂未提供；重复复核以最后一次为准。
