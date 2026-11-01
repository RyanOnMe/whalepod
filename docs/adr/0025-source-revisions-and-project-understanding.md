# ADR-0025：来源修订、线程订阅与项目理解的事实边界

- 状态：提案（Proposed，#451，2026-11-01）。接受前不开 PC-03/PC-04 实现分支；本文件不是已采纳决定。
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

| 类型 | 含义 | 谁能写 | 能否升级 |
|---|---|---|---|
| SourceRevision | 来源在某一时刻的不可变版本（消息/文档/表格范围） | 采集 Node 经 Hub 校验后写入 | 不升级；新版本是新行 |
| Observation | 确定性事实：作者平台身份、发送时间、修订摘要、Run 状态、成果发布、实际消费 | Hub 事务（来自协议帧或既有业务事件） | 可被新 Observation 覆盖结论，但旧行保留 |
| Inference | 模型解释：目标、潜在决定、影响、问题、建议关联 | 协调计算提交（ADR-0026），带引用与处理器版本 | 只能被新 Inference 或人工纠正取代；不能自我升级 |
| Decision | 人工确认的业务决定 | 成员经既有业务入口（任务约定、审批、成果验收等） | 只能由新的明确业务动作改写；不自动生成，不另建决策表 |
| Correction | 人工纠正（否定/修正/标注无关） | 成员 | 追加行，`supersedesEntryId` 指向被纠正条目；不改写历史 |

Decision 不新建独立决策存储：`context_entry` 的 Decision 行以 `businessRef` 指向既有业务事实（约定版本、审批记录、成果发布），上下文条目只是带引用的投影；既有业务表仍是权威。

不变量：

1. **模型不能写 Decision、Correction、Run 完成态或审批结果**。模型输出只能落在 Inference；「Agent 自报完成」「考虑改为 8 万」「未核实身份说老板同意」都不得升级。
2. **Observation 与 Inference 必须带至少一条引用**（来源版本 + 位置）；无引用的模型文字不得进入项目读面，只留在评估记录里供排障。
3. **Correction 优先于任何自动结果**。同一目标条目被纠正后，迟到的评估结果按 §6 丢弃，不得复活被纠正结论。
4. **事实与推断在同一个读面并列展示但类型可见**；界面不得把 Inference 渲染成 Decision。

### 2 修订与事件身份

- **事件身份与修订身份分开**：投递事件按 `(sourceId, eventId)` 幂等；内容版本按 `(sourceId, resourceKey, revisionToken)` 唯一。同一 `message_id` 的新正文形成新 SourceRevision，不因事件去重被吞掉。
- **版本令牌来源优先级**：平台提供的修订号/更新时间 > 稳定内容摘要（规范化后 sha256）> 重读比较。没有可靠顺序时，Hub 重读当前内容并比较摘要；**不把两个观察拼成一个从未存在过的版本**。
- **迟到与乱序**：只有当前授权代次、且版本令牌新于已存最新版本时才能推进 `latestRevisionId`；乱序旧版只作为历史行保留（有界），不覆盖读面。
- **撤回/删除**：形成 `retracted` 版本（或删除事件），读面立即停止使用该版本；已冻结进 Run 的快照按 ADR-0027 只显示不可用标记。不能删除审计身份。
- **缺口**：补拉未覆盖的区间记录 `gap`（起止时间/游标、原因）；读面显示「可能缺 N 条」，不声称抓到了每次中间编辑。
- **正文落库**：只有通过来源范围、权限代次与租约校验的正文才写入；越界内容只留最小拒绝审计，不复用上游「过滤但仍保留」的行为（ADR-0024 §5）。

### 3 线程、订阅与工作关联

- **Thread** 是项目内的来源线程身份：`(sourceId, threadKey)`。一个 Thread 可服务多个 Task/Run（M:N），不以「一线程一任务」建唯一约束；不能跨 ADR-0024 的绑定项目边界。
- **WorkLink** 把 Thread 关联到 Task 或 Run，记录 `kind`：
  - `own_work`：来自 Task 归属、责任人、任务约定或既有执行入口的明确关联；
  - `read_only`：成员显式订阅的只读参考；
  - `actual_consumption`：Run 快照真实选入并收到消费回执（ADR-0027）；
  - `model_inferred`：模型建议的关联，默认 `proposed`，必须可纠正，不能单独触发自动选入。
- **订阅不是指令权**：任何 WorkLink（含 `own_work`）都不授予 `run.followup`、取消、审批、创建 Run 或向外部平台发消息的权限。执行仍按 ADR-0013 的明确执行意图。
- **来源撤销/不可用**：该来源的 Thread 与 WorkLink 立即失效（`invalidatedAt`），读面不再展示正文；历史 Run 的 `actual_consumption` 关联保留为不可用标记。
- **M:N 分发只到协调上下文与产品通知**；不向活跃 Run 注入参考（ADR-0027 §6）。

### 4 引用、水位与可重建

- **引用形状**（协议与视图共用）：`{ entryId, kind, sourceId, revisionId, resourceKey, locator, authorizationGeneration, observedAt, digest }`。`locator` 是平台内的范围/位置标识，不含本机路径或凭据。
- **水位**：每个来源记录 `lastObservedRevisionId/observedAt`；协调检查点记录「已处理到哪个 revision + 哪条 entry」。读面显示各来源水位、最后成功读取与缺口。
- **可重建**：检查点、条目与订阅可从权威表（source_revision、observation、decision、correction、work_link）重建；模型记忆不是第二份事实库。重建不得伪造从未存在的版本。
- **读时判权**：每次展开、分页、模型装配与 Run 选入都复核当前权限；引用不是权限豁免。权限未知/过期时只显示元数据与不可用标记。

### 5 冲突、纠正与自动重试

- **冲突并列**：同一目标出现互斥 Observation/Inference 时，读面并列展示并标注来源、时间与类型，不自动裁决；Decision 只能由人给出。两条互斥 Decision（例如前后两次约定）也并列并标 `conflict`，**不按时间自动取最新**；只有新的明确业务动作能产生新的有效决定。
- **纠正追加**：Correction 不修改被纠正行；「当前有效集」= 未被 Correction 否定的条目；不存在冲突时按时间取最新，存在冲突时按上一条并列。历史请求与历史 Run 仍显示当时快照。
- **迟到结果**：评估提交时若输入水位、来源代次、权限状态、或纠正版本与评估开始时不一致，整份结果丢弃并记 `stale`；同输入重试不重复提醒，也不撤销纠正。
- **幂等**：评估身份 = hash(项目、输入条目与版本集合、规则版本、处理器版本、纠正版本)；同一身份至多一条有效结果。

### 6 PostgreSQL 事务边界

- Hub 模块化单体与 PostgreSQL 继续是团队权威；**不引入第二份 SQLite/内存状态作为团队事实**。
- 确定性写入在单个异步事务内完成：锁来源/线程/条目行（`FOR UPDATE` 或唯一约束）、复核 `authorizationGeneration` 与权限状态、追加 revision/observation/work_link、写 Outbox。事务不跨模型等待。
- 模型判定发生在事务外；结果以「候选」提交，提交事务重新校验 §5 的围栏后落库或丢弃。
- 并发裁决用唯一索引与行锁，不用可重试的读-改-写：同一来源版本的 revision 唯一；同一 WorkLink 四元组唯一；同一评估身份唯一；同一项目同一时刻至多一个进行中的评估（ADR-0026）。
- 所有命令带幂等键；重放返回首次结果，不重复追加事件或通知。

### 7 数据草图（实施时以协议与 migration 为准）

| 表 | 关键字段 | 约束 |
|---|---|---|
| `source_revision` | `id`、`sourceId`、`resourceKey`、`revisionToken`、`digest`、`observedAt`、`authorizationGeneration`、`status`（current/superseded/retracted）、`locator`、`bodyRef` | `(sourceId, resourceKey, revisionToken)` 唯一；正文保留按 ADR-0024 §8 |
| `source_event` | `id`、`sourceId`、`eventId`、`revisionId`、`receivedAt`、`outcome`（accepted/duplicate/stale/gap） | `(sourceId, eventId)` 唯一 |
| `project_thread` | `id`、`projectId`、`sourceId`、`threadKey`、`status` | `(sourceId, threadKey)` 唯一；项目一致 |
| `work_link` | `id`、`projectId`、`threadId`、`taskId`/`runId`、`kind`、`state`（proposed/active/invalidated）、`createdBy`、`evidenceRef` | 四元组唯一；`proposed` 不得单独触发 Run 选入 |
| `context_entry` | `id`、`projectId`、`kind`（observation/inference/decision/correction）、`status`、`title`、`bodyRef`、`payload`、`businessRef`（Decision 必填）、`createdBy`、`processorVersion`、`supersedesEntryId` | Inference 必须有 citation；Decision 必须有成员 actor 与 `businessRef` |
| `context_citation` | `entryId`、`sourceId`、`revisionId`、`locator`、`generation`、`digest` | 与 entry 同事务写入 |
| `project_watermark` | `projectId`、`sourceId`、`lastRevisionId`、`observedAt`、`gap` | 每来源一行 |

读面 API 的视图不含凭据、绝对路径、平台私密名称与未授权正文；分页按 entry/revision 身份，不按正文内容。

### 8 协议与 Node 交互

- 复用 ADR-0024 的 `source.permission_check/result` 与代次；PC-03 增加 `source.observation`（只读上行）：`{ sourceId, authorizationGeneration, resourceKey, revisionToken, digest, observedAt, locator, body, retracted? }`，单帧正文 ≤256KiB；超限必须显式拒绝或由 Node 先落本地副本再分片申请，不允许把分片拼成一个未经验证的版本。
- Hub 只接受当前代次与租约持有者；重复 `(sourceId, eventId)` 返回 `duplicate`，旧版本返回 `stale`，越界/无权限返回 `denied` 且不落正文。
- 正文与绝对路径只存在于 Node→Hub 的本地协议与 Hub 存储，不进入日志、Team Event、Web 投影或证据包。

### 9 观测与归因

- `hub.context`：`source.revision_accepted/duplicate/stale/retracted/gap`、`context.entry_recorded`、`context.entry_corrected`、`context.link_proposed/activated/invalidated`；字段只含不透明 id、类型、状态与时间。
- `node.source`：观察提交、租约拒绝、补拉缺口；不含正文。
- 关联身份沿用 trace/run/source/revision/entry；缺任何一层（接收/选取/交付/消费/拒绝）即判失败。

### 10 验证

- 正向：同一消息两次投递只产生一条事件与一条修订；编辑后形成新修订且读面更新；两个 Task 通过同一线程收到同一变化；人工纠正后读面以纠正为准。
- 负控：重复事件不重复提醒；旧代次/非租约持有者提交被拒；乱序旧版不覆盖新版；模型结果缺引用不落读面；模型试图写 Decision 被拒；纠正后迟到结果不复活；撤权后正文读面为空；日志/证据无正文与绝对路径。
- 外部接口用录制/回放替身；真实平台由 PC-01 烟测，不在 CI 声称真实权限。
- 每条不变量做一次单点变异（去掉代次校验、去掉纠正优先、允许模型写 Decision），必须变红。

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
