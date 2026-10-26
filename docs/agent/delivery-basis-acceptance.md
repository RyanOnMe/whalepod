# 成果依据概览验收

- 对应门禁：Q0/Q1、Q2、Web 组件；组合生产路径由交付闭环验收补充。
- 对应 Issue：P1-440；决定见 ADR-0022。
- 上次验证：2026-10-26 · feat/p1-440-delivery-basis；定向 Unit 8/8、Web（含旧审阅回归）12/12、真实 PostgreSQL Q2 2/2 通过，Hub/Web 测试类型检查通过。完整 Q0 静态项通过，188 文件中 187 通过；唯一失败是存量 `hub-testing-resolution.spec.ts` 在全仓并发下 5 秒加载超时，限定并发的单文件复跑通过；因此不宣称完整 Q0 PASS，整合门仍需复跑。具体机器结果见同名证据目录。

## 验的是哪条用户路径

审阅人打开一份已发布成果，在同一页读取它的来源执行、执行当时已确认的任务约定、固定文件输入，以及明确包含该成果的最近已发布交接说明。后来确认新约定、发布新材料或给另一个 Run 发布交接说明，都不能替换这份成果的历史依据。模型整理文字保留待核实状态；发布者核实的含义限于其人工确认。

## 驱动

`apps/hub/tests/delivery-basis.integration.spec.ts` 使用现有 Fastify 组合根，通过设置、邀请、任务指派/接受、约定草稿/确认、设备配对、WebSocket inventory、创建 Run、设备上传与发布、交接草稿/发布、GET 依据的真实 HTTP/协议处理路径构造事实。终态帧由既有 Fake Adapter 注入，不直接插入或更新运行时业务表。

Web 组件走真实 api client；读面以网络响应打桩。新增面板只发 GET，读取失败显示重试；与文件/任务身份不匹配的响应拒绝展示。面板缓存放在既有 task-room 前缀下，使用原 `task.changed`/`run.changed`/`artifact.changed` 映射刷新，不创建事件类型。

## 观测

- `hub.review.delivery-basis`：`GET /artifacts/:artifactId/delivery-basis` 的 `sourceRun.id`、`agreement.revision.id`、固定 `taskInputs`/`handoffInputs`、交接版本 ID 与逐条 `verified`。
- 历史事实锚点：Run 的 `specRevisionId`、`artifactInputManifest`、`handoffInput`；不能拿 Task 当前约定补齐。
- 可见性：候选 Artifact 对非拥有者 404；固定输入与叙述引用逐件重新判定当前已发布状态，不回传不可见身份或数量。
- `web.review.delivery-basis`：加载/读错/显式空/历史未知/部分不可读/待核实/发布者核实的独立文案，读取重试没有命令 POST。

## 判定

自动判据包括：

1. 历史约定 ID 与正文仍是创建来源 Run 时的版本；最新约定不出现。
2. 来源 Run 固定输入只包含当时选中的材料；迟到发布不能填入显式空清单。
3. 交接必须同时匹配 Task、行级及系统块 sourceRunId、当前 Artifact ID/摘要/已发布状态；只共享 Run 或 Task 不够。
4. 私有候选及其名称、原始路径、storageKey、credentialSlot、DSH session 字段不进入审阅人响应。
5. 历史 NULL 是 unknown/complete=false；当前不可见材料被过滤但 complete=false；不拿当前元数据替换固定标题/摘要。
6. 缺失或串 Task 的历史约定明确 unavailable；不查询当前约定。
7. 模型条目 `verified=false` 显示待核实；人工 `verified=true` 显示发布者已核实，并保留“样本未覆盖全量”的原文。
8. 失败不是无记录，重试只读；响应身份不匹配拒绝展示；现有事件能够刷新对应 Task 的依据，其他 Task 不触发读取。

红检查提交 `782008b` 在实现缺失时因三个入口不存在而失败。匹配判据另含错误摘要、其他 Run/Task、候选与其他 Artifact 的负控。历史损坏/缺失只在仓库读取 seam 打桩，不靠写入伪造运行时状态。

## 归因

- 版本或材料漂移：先看 `hub.review.delivery-basis` 从哪个 Run 读取，再比对冻结输入与 `specRevisionId`；该模块不查询 Task 当前约定。
- 混入别的交接：看 `matchesDeliveryArtifact` 的五个匹配条件及发布版本系统块。
- 私有材料泄露：看 `requireReadableArtifact` 的首次守卫与 `publishedInputs`/`visibleNarrative` 的逐件过滤。
- 旧依据不更新：看 `web.review.delivery-basis` 缓存是否仍位于 task-room 前缀，以及既有 event-router 失效路径。
- 页面错误：schema/对象身份错误应进入读取失败，不能显示空态。

## 取证

脱敏结果放在 `artifacts/evidence/delivery-basis/`，以结构化测试结果、命令退出值与场景断言为准。发布前运行 `scripts/secret-scan.sh artifacts/evidence/delivery-basis`。不保存 Cookie/设备令牌、候选正文、原始工具参数或本机路径。

## 边界与未覆盖

没有新增验证状态机、检查自动采集或质量得分；工具运行成功不能证明当前成果正确，也不能证明验证充分。已发布自由文本保持发布者原意，本切片不推断或扩张它的真实性。

固定输入只反映产品记录到的输入，不能代表执行期间所有读取或 Agent 的实际理解。上游交接这里只展示固定文件清单，不复制接收者理解正文。若只读记录不完整，保留未知/不完整提示。

Q2 使用真实数据库与现有 Hub 组合根、Fake Adapter，未声称真实模型表现或浏览器生产装配已通过；组合 Q5、真人可理解性、节省劳动与“即时通讯＋个人 Agent”的对照效率仍由整合验收及后续真人试用裁决。本分支未测大规模输入的读面性能。

## 复跑

```bash
pnpm check
pnpm exec vitest run --project unit packages/protocol/tests/delivery-basis.spec.ts apps/hub/tests/delivery-basis.spec.ts apps/hub/tests/delivery-basis-projection.spec.ts
pnpm exec vitest run --project web apps/web/tests/delivery-basis.spec.tsx apps/web/tests/artifact-review.spec.tsx
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests/delivery-basis.integration.spec.ts
scripts/secret-scan.sh artifacts/evidence/delivery-basis
```
