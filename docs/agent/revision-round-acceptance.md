# 交付物修订批次与批注复核（#430 / ADR-0021 §5）验收记录

- 对应场景/门禁：交付物审阅闭环后半（审阅页 + Hub + 待办）+ Q0/Q1/Q2/Q3
- 对应 Issue：P1-430
- 上次验证：2026-10-26 · feat/p1-430-delivery-loop · 定向 UI/Q2 PASS，组合 Q5 由集成树验证

## 验的是哪条用户路径

任务责任人从已发布交付物整理一轮修订：选择要处理的批注线程（回复随线程冻结）、
可附参考材料与补充方向 → 启动 Agent（默认可续接原产出会话，也可显式新执行）→
执行上下文里只出现本轮冻结的意见 → 责任人把本轮 Run 产出的候选显式关联为新版 →
发布新版后，批注作者确认「已解决/仍需修改」，责任人可写理由代为收口。

审阅页已接线：整理意见、冻结批次、明确续接原产出或开始新执行、选择自己的环境、检查并发布关联新版、文本差异与逐条人工复核。

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

- 独立页的批次草稿目前留在组件中；导航离开后需重新填写未冻结的选择/方向。已经冻结的意见与批次保存在 Hub，失败重试同一轮，不重复创建。
- 未跑生产装配 Q5/真实 Node→Runtime 执行：本页只证明 Hub 快照与下发 payload；
  Runtime 的首条指令注入由既有 #396 契约门覆盖（Q3 本轮 74 例通过，
  `executionContext` 同一条通路）。
- 未做并发压测：启动认领用条件更新，锁序与改派一致；高并发下的行为按单条用例。
- 图片/PDF/Office 的原位批注与预览仍在 #431。
- 批次取消、逐条意见的版本历史（多次复核）暂未提供；重复复核以最后一次为准。


## 2026-10-26 前端与个人待办接线

- 责任人点击「整理本轮修订」，选择最多 50 条顶层意见，按需补方向和已发布参考材料，再「固定本轮意见」。创建本身不启动执行。
- 默认尝试原产出会话：原 Agent、固定配置版本、自己的设备/工作目录必须仍匹配；不可续接就明确阻塞，成员可以选择「开始新执行」。不自动使用 Reviewer。
- 执行复用 `RunLauncher` 的配置、准备检查和完全权限确认；批次 `/start` 复用原 `RunOrchestrator`。显式选择的 `profileRevisionId` 传入后端，不因 Agent 当前配置改变而漂移。
- 启动失败保留指令与选择，同一意图复用幂等键。切换续接/新执行代表不同意图；批次自身防止重复 Run。
- 候选只可从本轮 Run 产出中明确选择，复用原发布 API。未发布候选在 round 单件/列表读面也只向拥有者展示。
- 发布后支持小型文本并排比较：标出首个差异行到最后差异行的范围，原始文本保持完整；非文本与超过 512KiB 的材料明确回退到下载。
- 作者可以确认自己的意见；责任人代收口须写理由。失败保留输入，Agent 不自动关闭意见。
- `organize_feedback` 面向已接受任务的当前责任人；未进入已启动批次、执行失败、候选被拒、仍需修改或固定后新增回复时出现。
- `resolve_comments` 只在本轮新版发布后提醒意见作者；待办按原稿版本聚合，直达准确审阅页，点击只导航。Run/Artifact 事件同时失效批次缓存，保留既有个人待办轮询。
- Task Room `reviewFeedback` 提供尚未确认解决数和对应交付物入口，完成确认框也提示；完成操作不增加硬闸。

### 本轮可复跑判据

```bash
pnpm exec vitest run --project web \
  apps/web/tests/revision-loop.spec.tsx \
  apps/web/tests/attention-home.spec.tsx apps/web/tests/select-menu.spec.tsx
pnpm exec vitest run --project unit apps/web/tests/event-router.spec.ts \
  packages/protocol/tests/review-round.spec.ts packages/protocol/tests/attention.spec.ts
pnpm exec tsx scripts/with-test-postgres.mts pnpm exec vitest run --project integration \
  apps/hub/tests/revision-round.integration.spec.ts \
  apps/hub/tests/personal-attention.integration.spec.ts
pnpm build
pnpm check
```

红色起点：提交 `843a4ec` 中 4 个新 UI 用例全部失败。定向 UI（闭环、待办、统一选择控件）52 例通过；真实 PostgreSQL 两文件 19 例通过；独立协议/实时路由 12 例通过。`pnpm build` 和最终 `pnpm check` 全通过（185 文件，1980 通过、7 个既有 expected fail，无意外失败）。新增公共路径用例通过 HTTP/Node 协议驱动批注→固定→启动→私有候选→发布→作者确认/退回→完成人工确认，无直插业务表。脱敏机器摘要见 `artifacts/evidence/revision-round-ui/summary.json`。

归因：页面选择/输入看 `web.delivery.revision`（`ReviewRevisionPanel` + `RunLauncher`）；待办事实看 `hub.task` 的 `/tasks/attention`；版本隐私、快照和确认看 `hub.review`；执行与准备仍沿既有 `hub.run` / `node.*` / `runtime.bridge`。组合 Q5 尚需在整合后的生产装配上驱动，组件/Hub 证据不能替代真人节时结果。


### 集成审查补充

已发布产物也可从本轮 Run 的显式选择菜单关联为新版（成员可能先在任务文件卡发布，再进入审阅页）；不根据文件名或最近产物自动关联。执行入口定位 `#task-execution`。独立红色提交 `5c52268` 中两例失败，修复后 `revision-loop.spec.tsx` 11 例通过；此后未重复全仓测试。
