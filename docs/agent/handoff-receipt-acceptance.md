# 跨 Task 交接与下游固定输入（#380 / ADR-0017 §5）验收记录

> 状态：实现与机器判据随批次③合入；本页登记「验了什么、怎么复跑、边界在哪」。
> 关联：ADR-0017、03 §「跨 Task 交接与下游固定输入」、docs/agent/evidence-map.md。

## 一句话

上游发布交接包后 `deliver`：选成员、新建或关联**同项目**下游 Task，落 pending receipt；
接收方填「本次准备做什么」（必填，差异可选且作为一条讨论消息落上游 Task）后 confirmed——
**确认不等于接受 Task、不自动启动 Run**。下游 Run 以**独立、显式选择**的 `run.handoff_input`
快照执行（逐件固定摘要，与同 Task 材料清单互不合并）；上游之后发新版本不改任何历史 Run，
下游显式 adopt 才产生**新 receipt**（旧 receipt/旧 Run 保留原版本）；重复确认/采用不重复创建。
Node 下载只在「该设备自己的 Run 的交接快照引用了该 Artifact」范围扩权，并逐件校验摘要。

## 机器判据（复跑入口）

| 判据 | 入口 | 覆盖 |
|---|---|---|
| 协议形状 | `pnpm test:unit`（`packages/protocol/tests/handoff-receipt.spec.ts`） | deliver 恰好一种下游目标；理解必填/限长；交接输入只在 new/resume 意图（followup/隐式拒绝）；快照 64 上限与摘要格式 |
| HTTP 面（真 PG；命令层直驱 + 真 Device Token） | `pnpm test:integration`（`apps/hub/tests/handoff-receipt.integration.spec.ts`） | deliver 建/联任务 + pending + 幂等重放不重复建；非责任人 403 / 跨项目 404 / 改派不符 409；confirm 仅接收方、空理解 400、差异落上游讨论、重复确认不覆盖、确认不启动 Run 且不接受 Task；下游 Run 快照逐件固化（含 pending 409、跨任务 404、改派 409）、与同 Task 清单互不合并、上游 v2 不改历史 Run、重跑继承/全新执行不带；adopt 无新版本 409、新 receipt 幂等、旧 receipt 保留；**下载授权**（快照内 200 且字节一致 / 快照外 404 / 第三台设备 404）与 node handoff-input 读面（本 Run 设备 200、他人 404） |
| Node 输入准备 | `pnpm test:unit`（`apps/node/tests/artifact-inputs.spec.ts` 交接组） | 两张清单汇入同一副本机制并逐件校摘要；交接材料摘要不符 → ARTIFACT_HASH_MISMATCH 且清目录；handoff-input=null 不是错误；形状不合 fail-closed；请求失败状态码折算 |
| 页面（真 Router+真 Query） | `pnpm test:unit`（`apps/web/tests/handoff-receipt.spec.tsx`） | 待确认→确认（请求体含理解与差异）→显示已确认理解；非接收人只读；有新版本提示+采用表单（请求体含理解）；执行区默认勾选并显示固定版本号、勾选/取消勾选的请求体两态；Run 固定输入面板显示交接来源（无交接时不出现该节） |

## 六原语对位

- **驱动**：deliver/confirm/adopt 走生产命令函数 + `transactCommand` 幂等台账；下游 Run 走
  `RunOrchestrator.create`（与 HTTP 同一入口）；下载/读面走 Fastify inject + 真实 Device Token
  （hashToken 比对）；页面走真 Router。
- **观测**：receipt/task/run 行与快照 JSON、上游 Task 讨论消息、HTTP 状态码与字节、请求体形状。
- **判定**：错误码（FORBIDDEN/NOT_FOUND/CONFLICT/VALIDATION_FAILED）、状态与版本号、幂等计数
  （任务数/行数/下载字节）。
- **归因**：交付/确认/adopt 在 hub.handoff（`receipts.ts`），快照解析在 hub.run
  （`handoff-input.ts`），下载授权在 db.run（`deviceHandoffInputReferences`）与 artifact 路由，
  Node 在 `artifact/inputs.ts`，页面在 web.handoff-receipt。
- **取证**：本页 + PR 描述；复跑命令见上表。
- **发现**：本页与 03 文档、ADR-0017 已登记；索引见 `docs/agent/README.md`。

## 边界（不得当成已完成）

1. **会话读面（GET /runs/:runId/handoff-input）未单独做 HTTP 用例**：它复用与
   input-manifest 完全同形的 `requireActor` 守卫（那条有独立用例）；本批 HTTP 面覆盖的是
   安全关键的设备侧（快照读 + 下载授权）。
2. **差异消息不做去重/线程关联**：同一个人用不同幂等键确认两次、两次都带差异时会有两条
   讨论消息——这是「用户说了两遍」的如实记录，不是重复；不做语义去重（首版边界）。
3. **关联既有任务只允许「责任人=被选成员」**：改派后由新责任人重新接收（旧 receipt 保留），
   不做转移（ADR-0017 §5 口径）。
4. **一个下游任务可以有多条 receipt（多版本/多上游）**：界面以「版本号最大的 confirmed」
   为活跃交接包；多上游并存是事实记录，不做合并视图（首版边界）。
5. **下载摘要校验在 Node 侧**：Hub 只保证快照摘要与已发布行一致（本批用例覆盖）；端到端
   的字节级校验在 Node 单测与本批 HTTP 用例（字节一致）覆盖，真 Hub/Node/Runtime 整链由
   批次④的生产装配 E2E 承载。
6. **run.handoff_input 是审计事实、不是数据迁移对象**：旧 Run 一律 NULL（语义=无交接输入），
   不回填；「红字改历史」在任何路径上都不存在。
