# ADR-0025：来源修订、线程订阅与项目理解的事实边界

- 状态：提案（Proposed，#451，2026-11-01；二稿）。接受前不开 PC-03/PC-04 实现分支；本文件不是已采纳决定。
- 承接：计划 §4.2–§4.4、§5、§6；[ADR-0024](./0024-source-sharing-and-revocation.md) 的来源绑定、代次与撤权。
- 依赖：PC-00 (#463) 的 rc.8 输入引用与结构化结果探针；真实平台版本语义由 PC-01 (#448) 提供，未接通前保持 `not_run`。

## 问题

下一阶段要让「正常工作事件 → 项目理解 → 影响相关工作 → 新 Run 采用新版依据」成为可复核的链路。现在只有来源绑定与生命周期（ADR-0024），没有回答：

- 一条外部消息被编辑、撤回、乱序到达时，什么算同一版本、什么算新版本；
- 哪些内容可以自动成为项目事实，哪些只能是模型推断，谁能把推断升级为决定；
- 一个线程如何关联多个 Task/Run，只读订阅与执行授权如何分开；
- 人工纠正与后台重试、迟到结果冲突时谁优先；
- 这些状态在 PostgreSQL 里如何并发裁决，模型调用如何不进事务。

上游原型用同步仓储与内存/SQLite 状态回答了部分问题，但它的 Ticket 可被旧 Mandate 重开、过滤后仍保留正文、模型输出可直接影响工作状态——三条都与 WhalePod 的终态、权限和事实边界冲突（见复用分析 §5.1–§5.3）。本 ADR 固定替代规则。

## 决定

### 1 事实阶梯：五类对象，写入权限不同

| 类型 | 含义 | 谁能写 | 引用要求 | 能否升级 |
|---|---|---|---|---|
| SourceRevision | 来源在某一时刻的不可变版本（消息/文档/表格范围） | 采集 Node 经 Hub 校验后写入 | 自身即来源 | 不升级；新版本是新行 |
| Observation | 确定性事实：作者平台身份、发送时间、修订摘要、Run 状态、成果发布、实际消费 | 来源观察经 Node 帧；业务事实经 Hub 业务事务/Outbox | 来源观察：source citation；业务事实：business citation | 可被新 Observation 覆盖结论，旧行保留 |
| Inference | 模型解释：目标、潜在决定、影响、问题、建议关联 | 协调计算提交（ADR-0026），带引用与处理器版本 | 至少一条 source 或 business citation | 只能被新 Inference 或人工纠正取代；不能自我升级 |
| Decision | 人工确认的业务决定的投影 | 由既有业务事务的 Outbox 投影器写入；actor 必须是成员会话 | 必须带 `businessRef` 与 `businessVersion` | 只能由新的明确业务动作改写；不自动生成 |
| Correction | 人工纠正（否定/修正/标注无关） | 成员 | 指向被纠正条目（`targetEntryId`） | 追加行，不改写历史 |

不变量：

1. **模型不能写 Decision、Correction、Run 完成态或审批结果**。协调帧的结果处理器只接受 `kind=inference`；数据库 CHECK 与写入 API 都拒绝非成员 actor 写 decision/correction。
2. **Observation 与 Inference 必须带至少一条引用**（source 或 business）；无引用的模型文字不得进入项目读面，只留在评估记录里供排障。
3. **Correction 优先于任何自动结果**。同一目标条目被纠正后，迟到的评估结果按 §5 丢弃，不得复活被纠正结论。
4. **事实与推断在同一个读面并列展示但类型可见**；界面不得把 Inference 渲染成 Decision。

**两种引用**（同一 JSON 形状，按 `kind` 二选一）：

- source citation：`{ kind: 'source', sourceId, revisionId, resourceKey, threadKey?, locator, authorizationGeneration, observedAt, digest }`；
- business citation：`{ kind: 'business', businessRef, businessVersion, occurredAt }`，`businessRef` 指向既有业务事实（约定版本、审批记录、成果发布、交接接收）。

Decision 不新建独立决策存储：`context_entry` 的 Decision 行只是既有业务事实的带引用投影；既有业务表仍是权威。

**Decision 的有效性判定**（实施时按业务类型固定，不允许「按时间取最新」）：

| businessRef 类型 | 有效条件 |
|---|---|
| 任务约定版本 | 指向该 Task 当前已确认的 TaskSpecRevision；旧版本为历史 |
| 审批记录 | 指向该审批请求的最终决定；同一请求多条冲突即 `conflict` |
| 成果发布 | 已发布且未撤回的 Artifact；撤回则不可用 |
| 交接接收 | 已确认且未被 adopt 覆盖的接收版本；旧版本为历史 |

投影器在业务事务的同一 Outbox 周期内更新投影（`businessVersion` 变化即追加新行、旧行标 `superseded`）。两条不同 `businessRef` 同时解析为当前且内容互斥时，读面标 `conflict`，不得自动选一条。

### 2 修订与事件身份

- **事件身份与修订身份分开**：投递事件按 `(sourceId, eventId)` 幂等；内容版本按 `(sourceId, resourceKey, tokenKind, revisionToken, digest)` 唯一。
- **版本令牌种类**（写入 `tokenKind`）：
  - `platform-revision`：平台提供的修订号/更新时间，按平台顺序比较；
  - `content-digest`：规范化后 sha256；内容相同即同一版本（A→B→A 的第三次与第一次同版），事件仍逐条记录；
  - `observed-sequence`：无平台顺序时按观察序号；只用于「重读比较」，不用于跨节点比较。
- **重复事件带新内容**：同一 `eventId` 再次到达但 `revisionToken/digest` 不同，记 `duplicate_conflict`，触发重读当前内容；**不得静默当作 duplicate 丢掉新版本**。
- **迟到与乱序**：只有当前授权代次、且版本令牌新于已存最新版本时才能推进 `project_source.latestRevisionId`；乱序旧版只作为历史行保留（有界），不覆盖读面。
- **撤回/删除**：形成 `retracted` 版本（或删除事件），所有读面（含已冻结 Run 快照）只显示元数据与不可用标记，不再展示正文；正文按 ADR-0024 §8 清除。不能删除审计身份。
- **缺口**：补拉未覆盖的区间记录 `gap`（起止时间/游标、原因）；读面显示「可能缺 N 条」，不声称抓到了每次中间编辑。
- **正文落库**：只有通过来源范围、权限代次与租约校验的正文才写入；越界内容只留最小拒绝审计，不复用上游「过滤但仍保留」的行为（ADR-0024 §5）。

### 3 线程、订阅与工作关联

- **Thread** 是项目内的来源线程身份：`(sourceId, threadKey)`。一个 Thread 可服务多个 Task/Run（M:N），不以「一线程一任务」建唯一约束；不能跨 ADR-0024 的绑定项目边界。非线程类资源（文档/表格）的 `threadKey` 为空。
- **WorkLink** 把 Thread 关联到 Task 或 Run，记录 `kind` 与 `state`：
  - `own_work`：来自 Task 归属、责任人、任务约定或既有执行入口的明确关联；
  - `read_only`：成员显式订阅的只读参考；
  - `actual_consumption`：Run 快照真实选入且回执确认已读（ADR-0027）；
  - `model_inferred`：模型建议的关联，初始 `state='proposed'`；成员激活时改 `state='active'` 并转成 `read_only` 或 `own_work`，记录 `activatedBy` 与时间。模型不能自行激活。
- **唯一键与空值**：`(threadId, taskId, runId, kind)` 使用 `NULLS NOT DISTINCT`（PostgreSQL 15+）或等效部分索引；`CHECK ((taskId IS NULL) <> (runId IS NULL))` 保证二选一。失效用单一 `state` 表示（`proposed/active/invalidated`）并记 `stateChangedAt`，不再维护第二套 `invalidatedAt`。
- **订阅不是指令权**：任何 WorkLink（含 `own_work`）都不授予 `run.followup`、取消、审批、创建 Run 或向外部平台发消息的权限。执行仍按 ADR-0013 的明确执行意图。
- **来源撤销/不可用**：该来源的 Thread 与 WorkLink 立即失效（`state='invalidated'`），读面不再展示正文；历史 Run 的 `actual_consumption` 关联保留为不可用标记。
- **M:N 分发只到协调上下文与产品通知**；不向活跃 Run 注入参考（ADR-0027 §5）。

### 4 引用、水位与可重建

- 引用形状见 §1；`locator` 是平台内的范围/位置标识，不含本机路径或凭据。
- **水位只有一个权威**：`project_source.latestRevisionId/observedAt`（ADR-0024 已有）是来源观察水位；读面从它与 `source_event` 的缺口派生。协调检查点记录自己的 `processedRevisionId`（ADR-0026），不是第二份权威。**不新建 `project_watermark` 表**。
- **可重建的范围**：检查点与读面可从权威表重建——`source_revision` 元数据、`source_event`、`context_entry`、`work_link`、业务表。已被 ADR-0024 §8 清除的正文**不可重建**，重建只恢复元数据与不可用标记；不得声称重建了已清除内容。
- **读时判权**：每次展开、分页、模型装配与 Run 选入都复核当前权限；引用不是权限豁免。权限未知/过期时只显示元数据与不可用标记。

### 5 冲突、纠正与自动重试

- **冲突并列**：同一目标出现互斥 Observation/Inference 时，读面并列展示并标注来源、时间与类型，不自动裁决；Decision 只能由人给出。两条互斥 Decision（例如前后两次约定）也并列并标 `conflict`，**不按时间自动取最新**；只有新的明确业务动作能产生新的有效决定。
- **纠正追加**：Correction 不修改被纠正行；「当前有效集」= 未被 Correction 否定的条目；不存在冲突时按业务版本/时间取最新，存在冲突时并列。历史请求与历史 Run 仍显示当时快照。
- **迟到结果**：评估提交时若输入水位、任一来源代次、权限状态、模型/处理器身份、或纠正版本与评估开始时不一致，整份结果丢弃并记 `stale`；同输入重试不重复提醒，也不撤销纠正。
- **幂等**：评估身份 `inputDigest` = hash(输入条目与版本集合、每来源 `authorizationGeneration`、模型/provider 与处理器版本、规则版本、纠正版本)。`context_entry` 的 Inference 行记录 `evaluationId` 与 `inputDigest`，并有唯一约束，确保同一次评估不重复追加条目。

### 6 PostgreSQL 事务边界

- Hub 模块化单体与 PostgreSQL 继续是团队权威；**不引入第二份 SQLite/内存状态作为团队事实**。
- 确定性写入在单个异步事务内完成：锁来源/线程/条目行（`FOR UPDATE` 或唯一约束）、复核 `authorizationGeneration` 与权限状态、追加 revision/observation/work_link、写 Outbox。事务不跨模型等待。
- 模型判定发生在事务外；结果以「候选」提交，提交事务重新校验 §5 的围栏后落库或丢弃。
- 并发裁决用唯一索引与行锁，不用可重试的读-改-写：同一来源版本的 revision 唯一；同一 WorkLink 四元组唯一；同一评估身份唯一；同一项目同一时刻至多一个进行中的评估（ADR-0026）。
- Decision/Correction 的写入点：Decision 只由业务事务的 Outbox 投影器写（`actorKind='member'`，`businessRef` 必须可解析）；Correction 只由成员 HTTP 命令写。协调帧/内部结果处理器没有 decision/correction 写入口。
- 所有命令带幂等键；重放返回首次结果，不重复追加事件或通知。

### 7 数据草图（实施时以协议与 migration 为准）

| 表 | 关键字段 | 约束 |
|---|---|---|
| `source_revision` | `id`、`sourceId`、`resourceKey`、`threadKey?`、`tokenKind`、`revisionToken`、`digest`、`observedAt`、`authorizationGeneration`、`status`（current/superseded/retracted）、`locator`、`bodyRef` | `(sourceId, resourceKey, tokenKind, revisionToken, digest)` 唯一；正文保留按 ADR-0024 §8 |
| `source_event` | `id`、`sourceId`、`eventId`、`revisionId?`、`receivedAt`、`outcome`（accepted/duplicate/duplicate_conflict/stale/denied/gap）、`reason?` | `(sourceId, eventId)` 唯一；`denied` 只记最小拒绝审计 |
| `project_thread` | `id`、`projectId`、`sourceId`、`threadKey`、`status` | `(sourceId, threadKey)` 唯一；项目一致 |
| `work_link` | `id`、`projectId`、`threadId`、`taskId?`、`runId?`、`kind`、`state`（proposed/active/invalidated）、`stateChangedAt`、`createdBy`、`activatedBy?`、`evidenceRef?` | `(threadId, taskId, runId, kind)` 唯一（NULLS NOT DISTINCT）；task/run 二选一 CHECK |
| `context_entry` | `id`、`projectId`、`kind`（observation/inference/decision/correction）、`status`（active/superseded/conflict/retracted）、`title`、`bodyRef?`、`payload`、`threadId?`、`sourceId?`、`revisionId?`、`businessRef?`、`businessVersion?`、`targetEntryId?`（Correction）、`evaluationId?`/`inputDigest?`（Inference）、`createdBy`、`actorKind`、`processorVersion?` | Observation/Inference 必须有 citation 与 evaluationId（业务 Observation 可无 evaluationId）；Decision 必须有成员 actor、businessRef 与 businessVersion；Correction 必须有 targetEntryId |
| `context_citation` | `entryId`、`kind`（source/business）、source 字段或 `businessRef/businessVersion/occurredAt` | 与 entry 同事务写入；按 entry.kind 校验必填组 |
| `source_gap` | `sourceId`、`fromCursor`、`toCursor`、`reason`、`detectedAt` | 只追加；读面据此显示缺口 |

读面 API 的视图不含凭据、绝对路径、平台私密名称与未授权正文；分页按 entry/revision 身份，不按正文内容。

### 8 协议与 Node 交互

- 复用 ADR-0024 的 `source.permission_check/result` 与代次。
- PC-03 增加 `source.observation`（只读上行）：
  `{ requestId, sourceId, authorizationGeneration, eventId, resourceKey, threadKey?, parentResourceKey?, tokenKind, revisionToken, digest, observedAt, sentAt, authorPlatformId, locator, body?, retracted? }`。
  - `body` 在 `retracted=true` 时可省略；单帧正文 ≤256KiB，超限显式拒绝或由 Node 先落本地副本再分片申请，不允许把分片拼成一个未经验证的版本。
  - 新增 `source.observation_result`：`{ requestId, sourceId, outcome: accepted|duplicate|duplicate_conflict|stale|denied|gap, revisionId?, reason? }`。Hub 只接受当前代次与租约持有者；`denied` 只进最小审计，不落正文。
  - 作者身份只记不透明 `authorPlatformId` 与显示名元数据，不按显示名映射成员（ADR-0024 §3）。
- 正文与绝对路径只存在于 Node→Hub 的本地协议与 Hub 存储，不进入 Hub 日志、Team Event、Web 投影或证据包；**Node 本地 DSH session 日志是另一类敏感存储**，由 ADR-0027 §3 约束。

### 9 观测与归因

- `hub.context`：`source.revision_accepted/duplicate/duplicate_conflict/stale/retracted/gap`、`context.entry_recorded`、`context.entry_corrected`、`context.link_proposed/activated/invalidated`；字段只含不透明 id、类型、状态与时间。
- `node.source`：观察提交、租约拒绝、补拉缺口；不含正文。
- 关联身份沿用 trace/run/source/revision/entry；缺任何一层（接收/选取/交付/消费/拒绝）即判失败。

### 10 验证

- 正向：同一消息两次投递只产生一条事件与一条修订；编辑后形成新修订且读面更新；两个 Task 通过同一线程收到同一变化；人工纠正后读面以纠正为准；业务约定更新后 Decision 投影标旧版 superseded。
- 负控：重复事件不重复提醒；同 eventId 带新内容不得被静默吞掉；旧代次/非租约持有者提交被拒；乱序旧版不覆盖新版；模型结果缺引用不落读面；协调帧写 Decision/Correction 被拒（DB CHECK + API 各一条）；纠正后迟到结果不复活；撤权后正文读面为空；撤回版本的历史快照只显示元数据；日志/证据无正文与绝对路径。
- 外部接口用录制/回放替身；真实平台由 PC-01 烟测，不在 CI 声称真实权限。
- 每条不变量做一次单点变异（去掉代次校验、去掉纠正优先、允许模型写 Decision、允许重复事件吞新版本），必须变红。

### 11 不做什么

- 不建设通用 ContextEntry/Relation 图谱、向量库或全量历史摘要；先用少量可追溯引用支持闭环。
- 不新增 Project 私有 ACL 或成员级来源 ACL。
- 不把 Thread/Subscription 变成执行授权，不自动 `run.followup`、取消、审批或创建 Run。
- 不照搬上游 Ticket 的旧 Mandate 复活、过滤后保留正文、模型输出直接改工作状态。
- 不在本 ADR 决定后台协调计算的生命周期与费用（ADR-0026）或 Run 快照（ADR-0027）。

### 12 后果与重新评估

- 若真实平台无法提供稳定修订号或可靠内容摘要，只能以「重读比较」建立版本，读面必须显示「仅观察到 N 个版本」的缺口；不能声称抓到每次编辑。
- 若纠正频繁且读面并列成本过高，先优化卡片与筛选，不改变「纠正优先、历史不改写」。
- 若 PostgreSQL 事务粒度导致长锁，优先拆小事务并用 Outbox 派生，不允许把模型等待放进事务。
- 若 M:N 订阅在真实团队产生噪声，先调分发阈值与合并，不把订阅升级成指令权。

## 验证登记

本 ADR 是文档，不含机器证据。接受后由 PC-03/PC-04 创建 `docs/agent/project-context-ledger-acceptance.md`，登记修订/去重/乱序/纠正/撤权/M:N 分发与模型权限负控；未完成前不标记交付。
