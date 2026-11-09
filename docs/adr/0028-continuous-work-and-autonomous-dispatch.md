# ADR-0028：持续工作承接、工作收件箱与受授权的自主派工

- 状态：已采纳（Accepted，2026-11-02；原提案 #480，2026-11-02）。RD-01/02a/02b/03 按后续 Issue 交付；**自动创建 Task/约定/新工作、同一活跃 Run 动态注入、跨成员委托仍不在本 ADR**，须另立 ADR。RD-03 的真实执行仍以 PC-05b 的撤权/回执恢复/清理完成为前置。
- 采纳说明：本 ADR 只授权既有 Task 与既有订阅之上的持续工作承接、收件箱、快慢路径、Router 决定、Mandate 与受控草稿执行；`autoDispatch` 默认关闭，`full_access` 不得用于自主 Run，固定草稿工具面外的工具不可用。M1R-A 不能代替 M1R-B；未登记/未完成的切片不据本 ADR 声称已交付。
- 2026-11-04 契约补充：§17 与 ADR-0026 §13 固定模型 Router 的评估、证据与决定应用接缝；模型提案、Hub 裁决、扩权确认和自动续跑分别交付，尚未实现的部分保持未交付。
- 技术基线：`07db6e3`（含 ADR-0028 提案合入；PC-03a/04a/05a 已合入）。
- 承接：[阶段计划](../agent/2026-10-30-project-context-coordination-plan.md) §1–§3、§5；[Router 与 Executor 持续协作方案](../agent/2026-11-02-router-executor-autonomous-dispatch-plan.md)（讨论稿）。
- 既有决定：ADR-0009、ADR-0010、ADR-0013、ADR-0015、ADR-0016、ADR-0017、ADR-0024、ADR-0025、ADR-0026、ADR-0027。
- **本 ADR 的边界**：只决定「既有 Task/既有订阅之上的持续工作承接、收件箱、快慢路径、Router 决定、Mandate 与受控草稿执行」；**不授权自动创建 Task/约定，不授权新工作自动立项，不授权同一活跃 Run 的动态注入**。这三项分别需要后续 ADR；本 ADR 的 M1R-A 不能代替 M1R-B 或完整产品目标。

## 问题

PC-03a/04a/05a 已经让平台内事件形成事实账本、确定性协调与新 Run 的固定上下文消费，但协调仍只读：成员遇到变化时仍要自己判断、重写提示词、搬上下文，必要时手建 Task。已有工作的订阅没有可靠承接路径，「收到」「交付」「实际消费」没有在工作层面分开。

本 ADR 要回答的是**基础承接链**：

- 一份持续工作如何稳定标识，既不是 Task/Run/Session，也不另造业务工单状态机；
- 变化如何可靠进入工作收件箱，离线、重复、乱序、撤权、Run 提前结束与回执丢失时如何收敛；
- 哪些变化走订阅快路径直达承接工作，哪些进入 Router；谁负责识别、歧义时如何处置；
- Router 的 dispatch/wait/ask/ignore 如何与 Hub 确定性裁决分工，模型不能凭 schema/置信度取得执行权；
- Mandate 如何表达职责、资源、成果与上限，撤销/到期/额度耗尽时哪些 Run 可以取消、哪些不能；
- 自动化止于研究/分析/草稿；正式发布、外发、业务承诺与最终业务验收如何继续由人决定；
- M1R-A 能证明什么、不能证明什么。

## 决定

### 1 范围：本 ADR 决定什么、不决定什么

**决定**：既有 Task 上的持续工作身份、工作收件箱、订阅快路径、Router 决定与确定性裁决、Mandate、系统 actor/派工端口、受控草稿执行、撤销/额度、观测与验收。

**不决定、也不授权**：

- 自动创建 Task、Task 约定或新的业务记录；RD-04 的新工作发现及预授权立项由 [ADR-0030](./0030-project-work-discovery-and-creation.md) 单独约束，尚待实施与验收。`workKey` 是协调元数据，不是业务记录；本 ADR 不允许 Router/模型自动创建 `workKey`。
- 同一活跃 Run 的动态增量上下文；须另立 ADR 定义初始快照与追加引用、权限、安全消费与逐项回执。
- 真实办公平台适配与来源正文（PC-01/PC-02b/PC-03b/03c）。
- Router 的具体模型、提示词与供应商；本 ADR 只固定其运行位置与授权边界。

### 2 持续工作身份（workKey）

- `workKey` 是 Hub 生成的不可猜、稳定身份，项目内唯一。**本 ADR 的唯一创建入口是成员在既有 Task 上显式创建/关联工作**（一次设置确认的一部分）；Router/模型不能创建或自动派生 `workKey`，派工端口只能使用已存在的 `workKey`。名称相近的独立工作不得合并。
- `workKey` 不是 Task、Run、Session 或一条事件。工作记录只保存协调元数据：目标摘要、真人责任人、当前承接者、当前关联 Task、Mandate 引用、订阅引用、输入水位、待处理/未决引用；目标、决定、成果、未决问题的**权威事实仍在 Task/Run/ADR-0025 账本**，工作记录只存引用，不复制正文。
- **本 ADR 内一个 Task 至多一份未退休工作**（`unique (task_id) where state <> 'retired'`）。`retired` 工作保留历史；同一 Task 上创建后继工作需要成员显式动作，不在本 ADR 自动发生。多份活跃工作共用 Task 留给后续 ADR。
- 工作生命周期：
  - `active`：可接收新输入，可在 Run 边界评估派工；
  - `waiting`：暂时不可派工，记录 `resumeCondition` 与 `resumeMode`。`resumeMode='auto'`（Run 活跃、上游未就绪、设备离线、容量不足）在条件清除后自动回到 `active`；`resumeMode='owner_confirmation'`（Task 改派/责任人变化）必须由**新 assignee** 显式承接后才回到 `active`，不自动复活旧 Mandate；
  - `retired`：Task 终态或成员显式结束，终态不复活。
  M1R-A 的续接是 `active → waiting(resumeMode='auto')`（Run 启动）→ `active`（Run 终态且复核通过）→ 下一 Run；不是第二套任务状态机，不承载业务验收。
- **工作元数据的权限**：只有该 Task 的**当前责任人（assignee）**可以创建/退休工作；仅被授权的成员不能占用或释放责任人的工作槽。Task 改派后工作转 `waiting(resumeMode='owner_confirmation')`，由新责任人确认承接或退休；旧 Mandate 不自动转移，不自动续接。
- `inputDigest = sha256(canonical({workKey, selectionRuleVersion, items:[{source, identity, version, digest, authorizationGeneration}], workAuthorizationVersion}))`：**每个来源条目携带自己的授权代次**，`workAuthorizationVersion` 标识整份工作的 Mandate 版本。它**不复用** ADR-0026 的评估 `inputDigest`，也不等于 ADR-0027 的 `snapshotDigest`；三者分别标识评估输入、Run 快照与工作输入。派工前必须逐来源复核权限代次，不能只比较一个汇总 digest。
- Run 与工作的关系：Run 增加可空 `workKey`；机器派工产生的 Run 必须有 `workKey`，人类自建 Run 可以为空；一个 Run 至多归属一份工作，一份工作可跨多个 Run。Task 单活跃 Run、终态不复活、创建时固定输入全部不变。
- 重复通知与同版本重读不产生第二份工作或第二个待处理项；新版本只改变待处理输入。已完成/取消的 Task 不直接重开；新缺口需要新的、在授权内的机器工作意图。

### 3 工作收件箱与消费

- 收件箱以 Hub PostgreSQL 为权威，保存工作身份、来源与版本、`inputDigest`、授权引用与代次、因果父级、订阅、交付记录、承接者、退回原因与消费水位。离线、排队或模型忙时保持待交付；恢复后按身份幂等补送。
- **状态机**（每条输入独立）：
  - `pending`：在箱、未交付；
  - `delivered`：已交付到具体 Executor/Run（含排队与已写入 Node 未确认）；
  - `unconfirmed`：Run 已结束/失败/取消但未收到消费回执，处于对账窗口；
  - `consumed`：在明确执行边界被实际消费；
  - `returned`：承接者带原因退回；Router 可决定重新入箱或另建输入；
  - `superseded`：可替代部分被更新版本取代；
  - `retracted`：来源撤权/删除，停止重投；
  - `expired`：超过 Mandate 的等待/处理期限。
  每次交付尝试单独记录 `sentAt/ackedAt/failedAt`。`delivered` 的 Run 在未消费情况下结束/失败/取消时，先标记 `unconfirmed` 并进入对账窗口（默认 60 秒，可配置）；窗口内收到的终态读取回执仍可把该项置为 `consumed`；窗口结束仍无回执才回到 `pending`（原因 `run_ended_unconsumed`，保留尝试历史），不得永久卡在 delivered。回到 `pending` 后若迟到回执才到，只更新 `work_input_consumption` 对账记录；若该项已被下一 Run 领取但尚未消费，下一交付标记 `duplicate` 并撤回；若下一 Run 已消费，记录 `duplicate_consumption` 异常并停止再投，不自动重放。工作输入回执是独立对账通道，**不复活 Run，也不改变 ADR-0027 对 `run.context_receipt` 的终态拒绝规则**。
- **撤回与不可变清单**：下一 Run 的 `workInputManifest` 创建后不可改。若迟到回执到达时该清单内的条目尚未被读取，端口/Node 按撤权信号拒绝后续读取并把该条目标记 `duplicate`；若已被读取，只能记录 `duplicate_consumption`，不修改 Run 快照、不向模型伪称没发生，也不发起第三次投递。重复消费是已记录的异常，不是可自动修复的路径。
- **合并是新建而非覆盖**：可替代的重复/状态变化生成一个 `superseded` 旧项与一个新项；独立要求、人的纠正、未决问题、不同来源约束各自保留为独立项。合并身份固定为 `(workKey, source, identity, version)`；禁止按内容相似度合并。
- **消费证据**：`work_input_consumption` 绑定输入 id/版本/digest、`workKey`、Run、Executor、Run 的输入清单摘要、读取回执 id 与时间。WebSocket 已发送、工具返回成功、Agent 自称「看过」都不算消费；正文读取使用与 ADR-0027 同类的可核验回执，缺回执显示「未确认」。
- **如何成为 Run 的输入**：派工时把选中的输入冻结为 `workInputManifest`（条目 id、版本、digest、正文摘要），Run 记录该清单摘要；正文按需读取并回执。它不是活跃 Run 注入：Run 创建后清单不可变；新输入只能进入下一 Run。若条目已由 ADR-0027 的项目上下文快照承载，则复用其 digest/回执，不重复计入消费。
- **首切片（M1R-A）**：活跃 Run 期间的变化留在收件箱；Run 终态后复核「成果是否覆盖变化、授权与 Task 是否有效、最新输入是否仍需执行」。通过后按 Mandate 的 `autoDispatch` 决定是否建立下一 Run（见 §7/§13）；不能因「有通知」自动建 Run。
- 收件箱不得伪装成 `run.followup`，不得改写 Run 原始快照，不得把资料更新当作停止/取消/扩权指令。当前 Run 不能接收时持续保管到合法边界，不静默丢弃。
- 退回必须带原因（无关/新缺口/冲突/权限失效/输入不完整）并保留消费水位；Router 按同一身份去重，必要时补上下文重新选择承接者。转交不扩大受众；Executor 不得把私有内容转给其他成员或 Agent。

### 4 两处快慢路径

- **入口程序准入**先处理可验证事实：监听范围、当前权限代次、重复身份/版本、订阅是否有效、系统自产状态。输出四类：`drop(reason)`、`deliver(workKey)`、`route_router`、`wait(reason, deadline)`。已确定的重复、无权或无需唤醒内容静默处理并留最小原因，不调用模型。
- **「同一持续职责」是确定性的**：只由当前有效的订阅/WorkLink 与工作关联决定，不由语义相似度决定。没有有效订阅/关联的补充不直接投递，而是进入 Router 作为新缺口候选。
- **快路径**：有效订阅 + 工作关联 + 权限仍有效 → 直接进入承接工作收件箱；不逐条调用中心 Router 模型。快路径仍受准入、资源权限、预算与工具边界约束。
- **慢路径**：无承接者、无有效订阅、新缺口、目标冲突、Executor 退回或超出原职责 → Router 补上下文、查已有工作、判断是否已覆盖，给出 dispatch/wait/ask/ignore。
- 程序无法判定「无关」时不得按关键词丢弃，标记 `route_router` 交有界语义判断。Router 仍不能决定时进入 `ask` 或带明确期限的 `wait`（期限来自 Mandate 的 `waitDeadline`；缺省 15 分钟后转 `ask` 并附原因）。任何路径都不得静默消失。
- 快路径必须可判定：验收要证明「已知订阅补充没有调用 Router」与「无订阅的新缺口调用了 Router」；只证明「最后有结果」不算。

### 5 Router 决定与 Agent 选择

| 决定 | 适用情况 | 产品行为 |
|---|---|---|
| `dispatch` | 职责明确、依据可用、尚未覆盖，且授权/Agent/现场/费用校验通过 | 形成 `dispatchIntent`，关联已有工作与 Task，经派工端口调用统一 Run 入口；是否自动执行由 Mandate 的 `autoDispatch` 决定 |
| `wait` | 上游未就绪、同一工作运行中、Task 单活跃、离线、短期限流或容量不足 | 收件箱保留，记录 `deadlineAt` 与原因，到期重评；不反复请人确认 |
| `ask` | 真实业务冲突、目标取舍、必要扩权、无合格候选或无法恢复 | 生成一个带 `decisionId` 的问题，含出处、选项、推荐与正确主体 |
| `ignore` | 无关、重复、普通自报状态、假设尚不构成工作，或无需行动 | 留最小原因；不建工作、不发确认、不制造提示词任务 |

- **先合法，再比较适合程度**：
  1. 硬筛：Mandate 允许的 Agent/Profile Revision、资料与工具、成果受众、真人责任人、Node/Workspace、凭据与费用同时满足；归档/不合格候选不排序。**`full_access` 的 Agent/Profile 或任务不得成为自主派工候选**（现有 `full_access` 是整档放行，无法表达逐工具边界）；没有非 `full_access` 的合格候选时只能 `ask`/`wait`。
  2. 连续性：当前工作已有承接 Agent 优先；再按可核验证据（同类已验收成果数、格式/工具适配、预计时间、成本）排序；平票按稳定规则：已有承接者 → 已验证同类成果数多 → 预计成本低 → `agentId` 字典序。无数据不构造能力分。
  3. 准备：摘要、在线、Workspace、凭据、容量；绿色准备不等于质量或价格证明。
  4. 派发前复核：固定 Agent/Revision、Mandate 版本、责任人/现场、输入摘要、预算；等待期间变化重评，不静默改目标。
- 模型只提出结构化决定与候选；**Hub 的派工端口确定性裁决**。schema 合法、置信度、命令语气、材料中的「请执行」都不构成授权。涉嫌越权的材料按策略拒绝，不包装成扩权问题。
- Router 不写业务表、不直接创建 Run。它提交 `dispatchIntent` 到 Hub 端口；端口在同一事务复核 Mandate、候选资格、输入摘要、预算、现场与 Task 约定，再调用统一创建核心。审批、终态、幂等、固定输入规则全部复用。
- Agent 与执行现场分别选择；团队 Agent 不授予其他成员设备或凭据；后台 Router 走新授权接缝，不冒充真人调用准备/指令接口；替换只选已授权合格候选，保留交接与新执行身份；resume 不自动换 Agent/设备/Workspace。
- Router 的语义模型运行在 ADR-0026 §4 的受限 Node 协调装配（或明确命名的同等级受限装配）；Hub 不直连模型。输入只按清单读取，不聚合私有 Session、未共享候选或凭据。

### 6 系统 actor、派工端口与统一入口

- `dispatchIntent` 是机器意图的权威记录：`id`、`workKey`、`taskId`、`triggerRefs`（来源/版本）、`inputDigest`、`decision`、`decisionId?`、`mandateId` 与版本、`authorizedByUserId`、`onBehalfOfUserId`、`agentId/profileRevisionId`、`deviceId/workspaceId`、预算、`status`、`approvalBasis: 'human'|'mandate'`、`createdAt`、`approvedAt?`、`runId?`。
- **身份关系（本 ADR 严格限制）**：`principalUserId`（确认 Mandate 的成员）、`onBehalfOfUserId`、`humanOwnerUserId` 必须是**同一名成员**，且该成员必须是该 Task 的**当前责任人（assignee）**；仅被授权的成员不能作为自主 Mandate 主体（人类 Run 仍可按既有授权路径）。`authorizedByUserId`（批准/生成该意图所依据的成员）必须等于 `principalUserId`；`approvalBasis='mandate'` 时也必须由该 Mandate 确认记录支撑。`draftRecipientUserId` 默认同一人。不得用 A 的 Mandate 在 B 的 Task/设备上执行，也不得代另一成员承担费用。后续 ADR 才能开放跨成员委托。
- `dispatchIntent` 状态机（闭合）：
  - `proposed` → `approved`（人类确认，`approvalBasis='human'`）/ `dispatched`（仅 `autoDispatch='existing_task'` 且端口复核通过，`approvalBasis='mandate'`）/ `rejected` / `expired` / `superseded` / `cancelled`；
  - `approved` → `dispatched`（端口复核通过）/ `rejected`（复核失败：输入变化、Task/责任人变化、预算不足等）/ `expired` / `cancelled` / `superseded`；
  - `dispatched` 是意图终态，记录 `runId`；Run 之后的失败/取消不回写意图状态。
  - `expired` 由 `expiresAt`、`waitDeadline` 或 Mandate 到期触发；`superseded` 由同一 work/输入的新意图取代；`cancelled` 由撤销/责任人停止触发。`rejected/expired/cancelled/superseded/dispatched` 均不再创建 Run。
  `autoDispatch='off'` 只能走 `proposed → approved → dispatched` 的人工确认入口（成员在工作读面确认，不用既有建 Run 表单冒充）；`existing_task` 可走 `proposed → dispatched`，但 `approvalBasis='mandate'` 与 Mandate 确认记录必须同时存在。
- Run 记录 `origin='mandate'`、`mandateId`、`dispatchIntentId`、`onBehalfOfUserId`、`workKey`；审计显示系统 actor + 所代表成员，不伪造成员会话或成员消息。ADR-0013 的「明确执行意图」由 `dispatchIntent`（含 `approvalBasis`/批准记录）满足，不靠伪造人类触发消息。
- 派工端口 `dispatch(intent)` 是机器 Run 的唯一入口：锁 Task、**加载并核对被引用的 Mandate**（`mandate.principalUserId = mandate.humanOwnerUserId = onBehalfOfUserId`、`mandate.version` 与意图一致、未过期、未撤销；任一不符即 `rejected`/`ask`，旧 Mandate 不得随改派转移）、复核 `onBehalfOfUserId` 是当前 assignee 且仍有指令权、`authorizedByUserId = principalUserId`、`workKey` 存在且状态为 `active`、`work.taskId === intent.taskId`、指派已接受、约定有效、无活跃 Run、候选/设备/现场/凭据/预算、`inputDigest` 未变，并**逐来源复核权限代次**；`waiting/retired` 工作不得派工。通过后调用与人类建 Run 相同的创建核心与状态机。系统 actor 仍走 `resolveInstructionRight` 等既有守卫，不绕过；没有 `dispatchIntent` 的机器 Run 一律拒绝；人类建 Run 行为不变。
- 派工记录保存候选与排除理由；Router 模型不写最终决定，只有端口裁决后才落 `status='dispatched'` 与 `runId`。端口只写协调记录（intent/decision）并调用业务 Run 创建；不写 Decision/Correction/成果验收等业务事实。

### 7 持续授权（Mandate）

- 界面以自然职责、可读默认与摘要确认呈现；内部契约机器可判定：

| 契约范围 | 内部字段（最低集） |
|---|---|
| 主体与职责 | `principalUserId`、`onBehalfOfUserId`、`humanOwnerUserId`（本 ADR 三者同一人，且必须是 Task 当前 assignee；仅被授权成员不能作为 Mandate 主体）、`projectId`、职责范围、`expiresAt`、`version` |
| 资料与执行资源 | 允许来源/代次、`agentIds/profileRevisionIds`、模型/现场、凭据槽、`toolAllowlist`（只从固定草稿工具面内选取，含路径/资源范围） |
| 工作与成果 | `autoDispatch: 'off' | 'existing_task'`、`allowedActionClasses: ('research'|'analysis'|'draft'|'revise')[]`、`draftRecipientUserId`（默认同一 human owner）、草稿受众；发布/外发/承诺固定为禁止 |
| 总上限与停止 | `maxRunsPerWork`、`maxCostMicros`、`maxTokens`、`maxAttempts`、`waitDeadline`、暂停/撤销 |

- 一次确认只覆盖该范围内的日常研究/分析/草稿；不授权其他项目、设备、资料或费用。其他成员资源的拥有者许可独立成立。
- `autoDispatch='existing_task'` 是本 ADR 唯一允许的自动模式：只能续接**已有、已接受、非终态、约定有效、无活跃 Run 的 Task**；不得新建 Task/约定/新工作。默认 `off`；`off` 时 Router 生成 `proposed` 意图，必须由 **Task 当前 assignee** 在工作读面确认到 `approved`，再由端口复核派发（`dispatched`）。仅被授权的成员不能批准自主意图（仍可按既有权限发人类 Run 指令）。`off` 路径是默认路径，RD-03 必须端到端验收。
- **固定草稿工具面（restricted machine profile）**：自主 Run 只装配**按工具名枚举的白名单**，不是按能力描述推断；至少排除 ADR-0026 §4 已识别的全部扩展能力，以及 `tool-bash`/任意 Shell、Code Mode `run_code`、`workflow`、`subagent*`、`job*`、`skill`、浏览器/网络访问、消息发送、正式发布/覆盖正式材料、业务写入与审批代决工具。允许面仅限读取授权资料、写入指定草稿区域、本 ADR 允许的分析/计算。`toolAllowlist` 只能从这个固定面内选择，Mandate 不能把面外工具加进来；面外工具不是「走审批」，而是根本不可用。RD-03 必须逐名列出工具面并做正控/负控；面中若出现任意未枚举工具，判红。落入面内但不在 allowlist 的步骤走现有审批。
- 授权在**决定提交、派发前与每次工具调用前**复核。撤销/到期/硬额度触发后：阻止新派工；`proposed/approved` 意图置 `cancelled`；尚未发给 Node 的机器 Run 走既有取消路径；已经产生副作用的 Run 不自动杀死（见 §9），但每次工具调用都被重新复核，`mandateInvalidated` 后只允许读/收尾类步骤。
- 自主 Run 必须以既有 `approval_required` 档运行，并在其上加一层 **Mandate 步级预批准**：只有「固定草稿工具面 + allowlist + 允许的 action class + 路径/资源范围」同时通过的步骤才免逐次审批；其余走现有审批。该预批准层是 RD-03 的前置实现，不是后续 ADR 的占位；`full_access` 不用于自主 Run。
- 草稿交 `draftRecipientUserId`（默认同一 human owner）的私有 Artifact 候选范围；Router/另一 Agent 不因协调职责获得私有正文；首个执行切片限同责任人授权现场。[ADR-0029](./0029-private-draft-grants-and-agent-input.md) 单独规定已完成草稿的按件授权与受控 Agent 输入；不改变本 ADR 的 `draftRecipientUserId` 边界，不借正式发布路径绕过人的决定。按件能力尚待实施与验收。

### 8 执行边界与人的介入

- 自动范围仅限研究、分析、核算、比较、生成与修订草稿。正式发布/覆盖正式材料、对外发送、业务承诺、审批代决与最终业务验收**永远由人**通过既有业务入口完成；Run 成功不等于 Task 验收。
- `ask` 生成 `decisionId = hash(workKey, blockedDecision, inputDigest, mandateVersion, questionType)`；同一 `decisionId` 只有一个开放问题，重复问题合并。
- 回答绑定谓词：回答主体必须是正确责任人（本 ADR 为 Task 当前 assignee）、`decisionId` 一致、回答类型匹配请求；对 `choose_option`/`deny`/`defer`，还必须满足 `mandateId` 与版本等于当前有效、未过期、未撤销的 Mandate。Mandate 版本变化、过期或撤销后，旧 `decisionId` 的回答只记录、不解除阻塞；必须按新 Mandate 重新评估并生成新 `decisionId`。回答类型只有 `authorize_scope` / `choose_option` / `deny` / `defer`；**业务承诺与正式发布不通过 ask 回答生效**，即使回答是「同意」。
- `authorize_scope` **不直接让旧 Mandate 生效**：它只表示责任人同意创建新版本 Mandate。流程为：回答记录 → 生成 `mandateVersion+1` 的草案 → 责任人明确确认新 Mandate（同一人，不能代人）→ 旧 `decisionId` 关闭为 `superseded` → Router 用新版本重新评估并生成新的 `dispatchIntent`/`decisionId`。在确认前，旧 Mandate 版本不扩大，旧意图不得派发；答案本身不改变 `inputDigest` 或授权范围。
- 普通消息不需要人确认一次；人的一句话不自动解释为所有工作的批准。业务决定、已读、草稿就绪与正式验收分开。
- 连续不合格/无合格 Agent/预算耗尽：停止新增尝试，提出调整范围、资源或等待的选项；不由多个 Agent 重复询问。失败可能已有副作用时先核对真实结果，不换 Agent 重放。
- 自动停止正常业务执行、把补充升级为新指令或同意扩权，均需各自授权，不能由「订阅」推导。

### 9 撤销、到期与在途 Run

本节是对 ADR-0015 与 ADR-0027 的**限定修订**，只适用于本 ADR 的机器派工 Run：

- 撤销/到期/硬额度后，`proposed`/`approved` 意图置 `cancelled`（不是调用 Run 取消）；`queued`/尚未写入 Node 的机器 Run 走既有取消路径；`run.start` 已写入 Node 但 Runtime 尚未执行的，按既有取消升级链收敛。
- **已经开始执行/产生副作用的机器 Run 不自动杀死**；标记 `mandateInvalidated`，每次工具调用前复核并阻断未授权/面外动作（`mandateInvalidated` 后只允许读/收尾），通知 human owner。是否停止由 owner 通过既有取消路径决定；已发生的工具副作用先核对真实结果，不承诺收回，不伪造已撤销。
- 人类自建 Run、ADR-0027 既有 Run 与 `run_project_context` 行为不受本节影响；其撤销/清理继续按 ADR-0024/0027 执行。
- 同一 Run 的撤销、派工、消费回执竞态在 RD-03 的实施切片里用事务与状态机固定；本节只决定产品语义。

### 10 记录、观测与成本

- 记录最低字段：触发与来源版本、`workKey`、快/慢路径与原因、`dispatchIntent`、Router 决定与 `decisionId`、候选/排除理由、选中 Agent/Revision、Mandate 版本、human owner/现场、`inputDigest`、预算、交付/消费状态、实际 Run。系统 actor + 所代表成员，不伪造成员会话。
- 观测分层：`hub.router`、`hub.work_inbox`、`hub.dispatch`、`node.work_inbox`、`run.*`；字段只含不透明 id、状态、原因与计数，不含正文、凭据、绝对路径。
- 费用与次数沿用 ADR-0026 的账本口径，并**扩展到派工/执行 Run**：派工预占上限，Run 终态按实际 usage 结算；Router、Executor、复核、转交与重试共享 `maxRunsPerWork/maxCostMicros/maxTokens/maxAttempts`，`allowedActionClasses` 限定动作类别，拆任务不重置。账本缺失或 usage 不可得时不得派发。
- 「深度耗尽」在本 ADR 定义为：请求的 action class 不在 `allowedActionClasses`，或 `maxRunsPerWork/maxAttempts` 用尽；两者都必须在派发前拒绝并留下原因。
- 成员读面显示处理水位、出处、未处理变化、「未确认消费」、当前 Mandate 状态与待确认 `dispatchIntent`；不生成无依据的完成百分比。

### 11 对既有 ADR 的修订（仅限本 ADR 范围）

| ADR | 修订/保留 |
|---|---|
| ADR-0009 / ADR-0010 | **修订**：普通讨论仍不直接触发执行；但 Router 可对讨论做有界语义判断，形成协调输入/收件箱项/`dispatchIntent`（不得创建 `workKey`）。执行只能经 Mandate + 派工端口；不存在「讨论直接起 Run」的分类器，也不恢复自动触发降级。**修订 ADR-0009 决策 7 的审批档语义**：仅自主 Run 引入 Mandate 步级预批准层（固定工具面 + allowlist + action class + 路径范围）；`full_access` 仍不用于自主 Run，人类 Run 的审批档不变。讨论/执行展示与命令入口仍分离 |
| ADR-0013 | **扩展**：机器意图以 `dispatchIntent` 作为显式执行意图记录，不伪造人类触发消息；仍复用统一 Run 创建核心与审批/终态规则 |
| ADR-0015 / ADR-0027 | **限定修订**：仅机器派工 Run 的未启动/未写 Node 部分可随撤销自动取消；已执行 Run 不自动杀死；其余撤销/清理行为不变 |
| ADR-0016 / ADR-0017 | **保留**：Artifact/约定/交接固定语义不变；本 ADR 不自动创建 Task/约定，不伪造确认，不关闭约定开关 |
| ADR-0024 | **保留并扩展**：撤权停止重投、未读本地副本按既有清理链删除/隔离；已消费内容不声称收回 |
| ADR-0025 | **修订**：工作收件箱是一个新的交付通道，不只到协调上下文/产品通知；只对当前有效、已激活、权限通过的订阅/WorkLink 直通；`model_inferred` 链接仍须成员激活；Router 的新缺口判断不自动创建链接或人工 Decision |
| ADR-0026 | **部分修订 §1/§11**：新增受 Mandate 约束的派工端口（仅既有 Task、仅本 ADR 范围）；保留不常驻、**Router 模型不写业务事实**、不越权、不篡改旧快照、不自动发布/外发、不跨项目、不建第二事实库、不 Hub 直连模型；端口只写协调记录并调用业务 Run 创建，`autoDispatch` 默认关闭 |
| ADR-0027 | **保留**：Run 快照固定、不回写；工作输入以独立清单/快照进入下一 Run，不做活跃注入；工作输入消费回执走独立对账通道，终态后只对账、不复活 Run，也不改变 ADR-0027 对 `run.context_receipt` 的终态拒绝 |

现有 Task 首切只复用责任、约定、现场与执行设施；完整的新工作自动承接不在本 ADR 内。

### 12 分片与里程碑

| 切片 | 交付 | 退出条件 |
|---|---|---|
| RD-01 目标职责、双路径准入与影子 Router | Mandate 契约、程序准入、Router 影子决定与 `dispatchIntent` 记录；不创建 Run、不写业务事实（影子记录只落协调表） | 影子数据可解释；新缺口/无关/重复/权限失效各有判据；模型不取得执行权；无 Run/业务事实变化 |
| RD-02a 持续工作身份与收件箱 | `workKey`、工作记录、收件箱状态机、交付/消费回执、退回/撤权/重新入箱；输入由成员显式关联或既有工作接收，不声称订阅快路径 | 重复/乱序/断线/回执丢失/跨工作错投/旧代次/撤权/部分合并负控；消费只在明确边界成立；生产 HTTP/WS/PostgreSQL/Node 装配 |
| RD-02b 订阅快路径 | 有效订阅/WorkLink 的补充直达承接工作收件箱；证明已知补充不调用 Router | 依赖 RD-02a；无有效订阅不得直投；Router 未被调用的证据；权限/撤权/旧代次负控 |
| RD-03 / M1R-A 既有 Task 的受控草稿执行 | `autoDispatch='existing_task'`、系统 actor/派工端口、固定草稿工具面/allowlist、草稿、最小提问/暂停/撤销、Run 边界续接 | 依赖 RD-01 + RD-02a + RD-02b；Task 已接受、非终态、约定有效、无活跃 Run；PC-05b 的撤权/回执恢复/清理已完成；取消/额度/工具越权/未知副作用/私有草稿负控；自动续接与消费证据均通过 |
| 后续 ADR（不在本 ADR） | M1R-B、新工作自动立项、自动 Task/约定、跨成员草稿受众、同一活跃 Run 动态输入、RD-04/05 | 各自独立评审采纳；不得用 RD-03 绿灯代替 |

- M1R-A 的完成条件是 RD-01 + RD-02a + RD-02b + RD-03 通过，且 `autoDispatch='existing_task'` 的自动续接在真实装配上可复跑；它证明订阅快路径，但**不证明**新缺口自动承接、自动新建 Task/新工作或无需手建 Task。
- M1R-B（快慢路径持续协作 + 新工作自动承接）**不在本 ADR 授权范围**；须新 ADR 采纳并完成 RD-04/05 后才能声明。
- 每个切片先影子/受控再开放真实执行，独立开关；后一切片不得用前一切片绿灯代替自己的验收。

### 13 验证

- 逐环证据：入口准入、订阅匹配、是否调用 Router、收件箱状态、Node 实际交付、消费回执、退回、派工决定与成果分别留证；缺任一环即失败。回放验工程，真实模型验语义/路由质量，真人对照验提示词/搬运/维护/打扰是否减少，三者分别报告。
- 必须判红（每条新判据做单点变异并恢复）：
  - 无有效订阅/关联的补充不得走快路径；有新缺口时 Router 必须被调用；快路径必须带「Router 未被调用」证据；
  - 越出 Mandate 职责/资源/费用/期限/`allowedActionClasses` 的 dispatch 必须拒绝；无 `dispatchIntent` 或未经 `approved`/端口裁决的机器 Run 必须拒绝；A 的 Mandate 不得在 B 的 Task/设备/凭据上派工；改派后旧 Mandate 与新 assignee 配对必须拒绝；`waiting/retired` 工作或 `workKey` 与 `taskId` 不一致时必须拒绝；
  - 工作创建/退休只能由 Task 当前 assignee 执行；仅被授权的成员不能占用/释放工作槽；Task 改派后工作必须进入 `waiting(resumeMode='owner_confirmation')`，新 assignee 显式承接或退休前不得派工，旧 Mandate 不转移；
  - **固定草稿工具面外的工具必须不可用（不是走审批）**：`tool-bash`/Shell、`run_code`、`workflow`、`subagent*`、`job*`、`skill`、浏览器/网络、发布/外发/消息/业务写入/审批代决即使出现在 Mandate 中也必须拒绝；面内但不在 `toolAllowlist` 的步骤才走现有审批；草稿不得投给 `draftRecipientUserId` 之外的成员；
  - `full_access` 的 Agent/Profile/Task 只能产生 `ask`/`wait`，不得 dispatch；
  - `autoDispatch='off'` 的 `proposed → approved → dispatched` 人工确认链必须端到端通过；`existing_task` 的 `proposed → dispatched` 必须带 `approvalBasis='mandate'` 与 Mandate 确认记录；`approved → rejected` 的端口复核失败不得创建 Run；`rejected/expired/cancelled/superseded` 意图不得创建 Run；
  - 独立要求、人的纠正、未决问题不得被合并吞掉；同版本重复不得产生第二次交付；
  - `delivered` 未消费的 Run 结束后先进入 `unconfirmed` 对账窗口；窗口内终态回执可置 `consumed`；窗口后才回 `pending`；迟到回执到达时：下一 Run 未读则撤回该交付并禁止后续读取；已读则记录 `duplicate_consumption`，不得第三次投递，也不得声称未发生重复消费；
  - 撤权后未读副本按既有清理链删除/隔离；已消费不声称收回；撤销不得自动杀死已执行机器 Run；`mandateInvalidated` 后下一次工具调用必须被复核并阻断面外/未授权动作；
  - 失败可能已有副作用时必须先核对真实结果，不得换 Agent 重放；无法判断时转人工；
  - 普通 Run 结果不得自激 Router/Executor 循环；无变化不得轮询模型；
  - 私有 Session、未共享候选、凭据、跨项目内容不得进入 Router 输入；
  - ask 的重复问题必须合并；错误主体/错误 `decisionId`/过期 Mandate 的回答不得解除阻塞；`authorize_scope` 必须走「新 Mandate 草案 → 责任人确认 → 新 decisionId」流程，答案本身不得扩大旧 Mandate；业务承诺不得经 ask 回答生效；
  - 预算/次数/action class 耗尽后不得派发或继续工具调用；拆任务不重置额度。
- M1R-A 验收必须走生产 HTTP/WS/PostgreSQL/Node/Runtime 与真实授权装配；测试夹具不得直插业务状态或绕过派工端口。PC-05b 未完成前 RD-03 只允许影子/受控测试，不启用真实自主执行。

### 14 不做什么

- 不自动正式发布、外发、覆盖正式材料或作业务承诺；不把 Run 成功当作 Task 验收。
- 不自动创建 Task、约定或新工作（本 ADR 范围外）；不伪造真人确认或关闭约定开关。
- 不改写旧 Run 快照、不向活跃 Run 注入、不自动停止正常业务执行。
- 不让 Router/Executor 获得审批代决或扩大受众的权限；不借正式发布路径绕过人的决定。
- 不聚合全量原始 Session、不引入云端计算或语义 Watchdog、不在 Hub 直连模型、不建第二事实库。
- 不要求成员为每个事件配置规则；不把「人手建 Task + 写提示词」当作完整目标的前提。

### 15 后果与重新评估

- 若模型在有界输入内无法稳定判断新缺口/无关，先只保留订阅快路径与人工新工作；不放开权限或扩大输入换质量。
- 若 Mandate 过重，简化界面与默认值，但不削弱机器可判定、可撤销的契约。
- 若工具 allowlist 无法由 Runtime 强制路径/资源范围，或固定草稿工具面无法排除 Shell/浏览器/网络，RD-03 停在影子模式，不降级为 `full_access` 或「走审批」。
- 若真人数据不能证明减少提示词、搬运与重复解释，保持 `autoDispatch='off'`。
- 若同 Run 动态输入成为硬需求、或新工作自动立项被批准，另立 ADR；不在本 ADR 上补丁实现。
- 若真实外部来源不可用，内部事件与回放只用于机制验证，不声称真实平台闭环。

### 16 待决问题（不构成本 ADR 的实现授权）

- 收件箱 wire 协议、DB 表、保留期与回执帧的具体形状（语义已定，RD-02 固化）。
- Router 的模型/provider、提示词与评测集；影子模式的样本与成本模型（RD-01）。
- `toolAllowlist` 的具体工具目录与路径强制方式（RD-03）；本 ADR 只固定禁止面与受限机器档。
- Mandate 步级预批准的具体实现（审批帧、缓存与失效）；RD-03 的前置交付。
- 跨成员草稿受众与委托读取（后续 ADR）。
- 新工作自动立项、自动 Task/约定确认来源、M1R-B（后续 ADR）。
- 同一活跃 Run 的动态增量上下文（后续 ADR）。
- 采纳后 RD 切片的实际 Issue 拆分与负责人。

### 17 模型 Router 的评估、覆盖证据与决定应用（2026-11-04 补充）

本节细化 §4/§5/§8/§10，与 ADR-0026 §13 配套；不扩大 §1 的既有 Task/工作、同责任人与受限草稿范围。

#### 17.1 输入与覆盖判断

- 首轮入口只覆盖既有工作上的内部 Task 讨论、上下文条目和带原因的退回；有效订阅仍逐事件直达收件箱，不逐条调用中心 Router。Run 终态与 wait 到期在后续调度切片复用同一评估入口，不把所有普通 Run 状态投影当作新缺口递归唤醒模型。
- 清单冻结：触发来源、当前 Task 约定、work 目标与 Mandate、待处理变化、已交付/已消费元数据、当前获准读取的准确成果依据及省略项。按清单下载时和提交结果时均复核读取权、版本、digest 与逐来源权限代次；不传原始 Session、不聚合未共享候选，不为覆盖判断扩大私有成果受众。
- 覆盖提案逐项给出 `covered / uncovered / unknown`，引用输入和成果的准确身份/版本/digest，并说明与目标/约束的关系。`covered` 必须有可核验的成果依据；Run 成功、已读回执或 Agent 自报完成单独都不成立。缺材料、无权读、超限或冲突未解时为 `unknown`，带期限 wait 或向正确主体 ask，不默认已覆盖，也不凭缺证据自动重做。
- Hub 能核验引用、版本、读取证据与授权，不能据 schema 合法声称模型语义正确。工程验收用回放，真实模型质量按阶段计划 §9.4 的开发集/保留集另验；未跑保持 `not_run`。

#### 17.2 结构化提案与两次裁决

- Router 输出严格的 `dispatch / wait / ask / ignore` 联合 schema，公共部分含评估身份、版本化引用、覆盖判断和有界摘要。未知字段、引用不在清单、需要的证据未实际读取、输出缺失或不合法必须拒绝；模型不能生成权威授权、已派发状态、业务 Decision 或消费回执。
- `dispatch` 指向一个已有 work/Task，列明未覆盖的输入、拟执行 action class 和成果目标；候选建议只能引用获准候选。Hub 先合法性筛选，首轮复用 RD-03b 的 Mandate 声明顺序与稳定现场选择，不新增无证据能力分；更复杂的连续性/能力排序另行验证。模型提议 `dispatch` 只可映射现有 `proposed` 意图，不等于 `dispatched`。
- `wait` 包含稳定原因、可核验恢复条件和受 Mandate 约束的 `deadlineAt`；`ask` 包含正确主体、blockedDecision、`choose_option` 或 `authorize_scope` 类型、出处、选项和推荐；`ignore` 包含无需行动的依据。普通材料中的命令语气不构成授权，涉嫌越权的材料按策略拒绝，不包装成扩权邀请。
- **第一次裁决是结果接受**：按 ADR-0026 §13 的 schema、引用、租约、身份与费用围栏接受并保存提案。没有接受记录不得应用。**第二次裁决是 Hub 应用**：用评估结果 id 做幂等凭据，按 Task→Work 的既有锁序复核当前主体、Task/约定、Mandate、来源/成果/回答水位、输入和额度；状态变化后旧结果不可应用，须重新评估。
- Hub 应用在同一事务内记录结果应用状态与协调副作用，防止崩溃后重复生意图/问题；业务 Run 仍只由 §6 的统一派工端口创建，并在派发前再次复核来源、候选、现场、预算与 Task 单活跃约束。系统 actor 与所代表成员分开记录，不伪造成员消息或会话。
- `autoDispatch='off'` 默认只产生待人工确认的 `proposed`；`existing_task` 仅在全部守卫、Router/Executor 共享费用预留和用途隔离通过后自动派发。重复接受/应用/派发、断线或重启只产生同一条有效意图与 Run；未知副作用不得自动重放。

#### 17.3 提问、回答与重评的拆分

- Router 接线切片负责生产并持久化 `choose_option` 和 `authorize_scope` 问题，复用 §8 的确定性哈希与 #515 的责任人读面/绑定规则；哈希 `decisionId` 由 Hub 计算，不接受模型自报身份。模型摘要/选项不得把私有来源正文带入团队投影；问题归当前责任人，Router 日志只记不透明引用与计数。
- `authorize_scope` 问题生产不依赖确认实现：接线切片允许展示问题，但在 #517 交付前该类型回答继续明确拒绝，不能降级为普通 `choose_option` 来扩大权限。#517 单独交付「回答 → 新 Mandate 草案 → 当前责任人明确确认 → 旧问题 superseded → 新版本重评」。
- 绑定回答作为下一评估的版本化输入，推进 `evaluationDigest`，不改写旧评估、不直接改变工作 `inputDigest` 或授权范围，也不复活旧意图。暂缓与重试都有可去重的重评触发记录；回答本身不等于已执行或成果验收。
- 接线切片只持久化 wait 的原因/期限，并提供显式触发重评的生产入口；#518 再接 Run 终态和 wait 到期调度。只有获得「未被成果覆盖且仍需执行」的有效提案才允许自动下一 Run；`unknown`、已有活跃 Run、未确认扩权、授权/额度失效均不得直接续跑。
- #517 与 #518 都依赖受限模型评估和 Router 决定接线；两者之间无必需的先后依赖。当前授权内的续跑可独立验证，需要扩权的工作保持阻塞，不能绕过 #517。

#### 17.4 前两个实现切片与退出条件

| 切片 | 纵向结果 | 退出边界 |
|---|---|---|
| #519 · RD-03r1 模型 Router 受限评估闭环 | 内部慢路径 → Hub 评估/冻结清单/预留 → Node 独立受限 Runtime → 读取证据/四类提案 → Hub 接受结果与结算 | 四类回放、围栏、工具/网络负控、零审批、费用、超时/崩溃/清理可复跑；Task/业务 Run/dispatch_intent/work_question 无新增，不应用提案 |
| #520 · RD-03r2 Router 决定接 Hub 承接与派工端口 | 已接受提案 → Hub 幂等应用 → 收件箱/意图/问题/wait 记录 → 现有人工或自动派工链 | `off` 与 `existing_task` 全链；业务执行 token/cost 账本补齐；改派/版本/额度/越权/重复负控；ask 生产含 authorize_scope；确认生效留 #517，终态/到期调度留 #518 |

- 两切片已按 #486 的 RD-03 / M1R-A 范围登记为 #519/#520；首切不以 PC-00 的局部禁用探针替代完整隔离验收，第二切不以首切提案入库冒充已执行。
- 证据须区分入口调用记录、实际模型派发/读取、提案接受、Hub 应用、业务 Run 与成果。触发和独立判定沿生产 HTTP/WS/PostgreSQL/真实包解析与 bin 路径；关键判据有单点变异，证据脱敏后登记验收索引。
- 无有效订阅走慢路径必须有实际模型调用证据；有效订阅逐事件快路径必须证明模型调用为零。执行边界的覆盖评估另记触发原因，不能用逐事件快路径零调用约束阻止必要的边界判断。

## 验证登记

本 ADR 是文档，不含机器证据。采纳后由 RD-01/02a/02b/03 分别创建 `docs/agent/` 验收文档，登记准入、订阅匹配、Router 调用/不调用、收件箱状态、交付与消费、退回、撤权、额度、固定草稿工具面、步级预批准与系统 actor 的正负控；未完成前不标记任何切片交付。PC-05b 未完成前，RD-03 只允许影子或受控测试。
