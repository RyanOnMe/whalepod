# ADR-0027：新 Run 的项目上下文快照、消费与固定历史

- 状态：提案（Proposed，#453，2026-11-01）。接受前不开 PC-05 实现分支；本文件不是已采纳决定。
- 承接：计划 §4.4、§5.1–§5.3、§6；[ADR-0025](./0025-source-revisions-and-project-understanding.md) 的事实阶梯与引用；[ADR-0026](./0026-project-coordination-lifecycle-and-cost.md) 的协调输出边界。
- 既有约束：ADR-0013（明确执行意图）、ADR-0016（Run Artifact 输入快照）、ADR-0017（任务约定与交接）、ADR-0020（执行上下文消费）、ADR-0022（成果交付依据）、ADR-0024（撤权与保留）。

## 问题

新 Run 需要采用项目已同步的上下文，同时保持现有执行依据的固定语义：任务约定、交接输入、Artifact 输入、审阅输入都在创建事务里固定，重放不换依据。现在缺的是：

- 哪些项目条目自动选入、哪些必须成员显式选择；模型推断能否成为执行依据；
- 选入后如何冻结版本与正文，来源过期、撤权或与确认要求冲突时如何表现；
- 派发前如何再判权、Node 如何核对字节，Runtime 是否真的消费（而不是只存了快照 ID）；
- 同一启动请求重放、新执行意图、活跃 Run 变化提示与旧 Run 历史如何分开；
- 历史 Run 在来源撤销后还能读到什么。

本 ADR 只决定 Run 侧的选择、快照、消费与历史；不决定来源版本规则（ADR-0025）或后台协调生命周期（ADR-0026）。

## 决定

### 1 选择规则：确定性优先，推断不自动成为依据

Run 创建事务内按固定规则选取，规则版本写入快照：

- **自动选入**：与本次 Task 存在 `own_work` WorkLink 的当前有效 Observation 与 Decision（ADR-0025 §3），以及这些条目引用的来源版本；只取有效版本，不取被纠正/撤回的版本。出现互斥 Decision 或未解决的冲突时，按「冲突与缺口」处理，不按时间自动取最新。
- **显式选入**：`read_only` 订阅与 `model_inferred` 建议默认不进入执行依据；成员可在创建界面勾选，勾选记录 `selectedByMemberId` 与理由（可空），并在快照中标记。
- **永不自动选入**：模型 Inference（包括协调者的建议）、未映射身份的表述、未通过权限检查的正文、个人 Workspace/私有 Session、未共享候选。
- **既有依据不变**：任务约定、交接输入与 Artifact 输入继续按 ADR-0016/0017/0020 固定；项目上下文不替换它们，也不因「刷新参考」静默换掉已固定的 Artifact 版本。
- **容量**：默认最多 32 条、合计 256KiB、单条 64KiB；超出部分进入「未纳入项」清单并写明原因（超限/无权限/冲突/推断未选），**不静默截断**。上限可在实施时配置，但必须显式展示。
- **冲突与缺口**：选中的来源在创建时权限未知/过期、必要条目缺失，或与已确认约定冲突时，创建返回可读的缺口说明；成员必须沿原业务入口作出明确选择（取消、调整任务或记录 `overrideReason` 后继续），不得静默覆盖约定或截断材料。

### 2 快照：创建时冻结，读时判权

- `run_project_context`（快照头）：`id`、`runId`、`projectId`、`selectionRuleVersion`、`snapshotDigest`、`entryCount`、`totalBytes`、`unselected`（JSON，只有原因与不透明 id）、`status`（frozen/partially_unavailable/invalidated）、`createdAt`。
- `run_project_context_entry`：`snapshotId`、`entryId`、`entryVersion`、`kind`（observation/decision）、`sourceId`、`revisionId`、`authorizationGeneration`、`digest`、`byteSize`、`title`、`body`（冻结副本，受容量上限）、`citation`（locator/observedAt 等）、`permissionStateAtSelection`、`selectedByMemberId`（显式选入时）。
- **冻结语义**：快照行不可改写；来源后续新版本、纠正或撤权都不修改已冻结正文与引用。旧 Run 永远显示当时依据。
- **读时判权**：任何读面（Run 详情、Web、Node 下载、Runtime 输入）在使用正文前复核当前权限与代次；权限不足时只显示标题、版本、摘要与 `unavailable` 标记，不返回正文。冻结不等于权限豁免。
- **保留**：按 ADR-0024 §8 的 RunProjectContext 行处理——随 Run 记录保留，撤销后不删除已交付记录，但当前权限不足时不读取、不展示正文。

### 3 派发前复核与 Node 字节核对

- 创建后、派发前（`run.start` 前）Hub 再次检查：来源代次、权限状态、条目 digest 与快照一致、约定/交接未变。任一失败 → 明确 `CONTEXT_UNAVAILABLE`（或沿用现有错误码族）并阻止派发；不自动换最新版本，也不静默丢条目。
- Node 通过受控下载接口按 `snapshotId` 取得条目内容（内容寻址，按 entryId 命名文件），逐条校验 `digest` 与 `byteSize`；不一致 → `CONTEXT_DIGEST_MISMATCH` 失败，不启动 Runtime。下载副本存于 `runtime-context/<runId>`，随 Run 终态清理（复用 `runtime-inputs` 的清理纪律）。
- 下载接口只对本次 Run 的 owner Node 与责任人可见；不返回快照外的条目，不返回绝对路径给 Hub/Web/日志。

### 4 Runtime 注入与真实消费判据

- `runtime.initialize` 增加可选 `projectContext`：`{ snapshotId, digest, entries: [{ entryId, kind, title, revisionId, digest, byteSize }], entriesDir }`（`entriesDir` 仅本地 wire，红线同 `artifactInputsDir`）。清单与目录成对出现，缺一 fail-closed。
- 首条指令包含固定段落：本次依据快照 id、条数、每条的 entryId/标题/版本，以及「用 `read_project_context` 按 entryId 读取；快照是执行依据，后来变化不自动替换」的说明。段落带由 `snapshotDigest` 派生的 nonce 标记，用于机器判定首条请求确实携带了该快照（replay 的 `{{fromRequest}}` 或等价探针）。
- 新增只读工具 `read_project_context`：参数只有 `entryId`，按清单白名单读取本地副本；返回结构化字段（entryId、kind、title、revisionId、digest、byteSize、content/截断标记），拒绝消息不含本机路径（语义与 `read_artifact_input` 相同）。
- **消费回执**：Runtime bridge 在首条指令装配与每次工具读取后发出 `run.context_receipt`（Node→Hub 的专用本地帧，不投影成产品 Run 事件），字段：`runId`、`snapshotId`、`promptDigest`、`nonceMatched`、`entriesDelivered`、`entriesRead`、`missing`、`digestVerified`、`at`。Hub 只在该帧到达后把快照标记为 `consumed`；**只保存快照 ID 或只写入执行上下文文本不算消费完成**。
- 回执的 `entriesRead` 是「模型实际读取」的证据；未读取的条目仍算已交付但未消费，读面分别显示。模型可以只读其中一部分（例如总结型任务），不能据此声称读过全部。

### 5 重放、新意图与活跃 Run

- 同一启动请求（同一幂等键）重放返回同一 `run_project_context` 快照，不重新选取「最新」。
- 只有新的明确执行意图（新 Run 创建）才按当时规则选择新版本；续跑/重跑是新 Run，按当时的项目上下文与既有 Artifact 输入规则装配，不修改旧 Run。
- 活跃 Run 期间发生来源新版本、纠正或撤权：只在读面显示「本次执行依据已变化」提示；不自动 `run.followup`、不注入参考、不取消工具、不改写正在执行的上下文。成员主动 followup 仍走现有权限、排队与撤销守卫。
- 旧 Run 的快照、引用与成果依据不改写；撤销后历史页显示 `unavailable` 与不可用原因。

### 6 撤权、不可用与历史

- 新 Run：来源撤销/不可用/权限未知时阻止选入与派发；已冻结但未派发的快照按 §3 失败。
- 活跃 Run：显示依据已变化；不承诺收回模型已读到的内容；不自动停止执行（除非责任人走既有取消路径）。
- 历史 Run：保留快照头、条目身份、digest、引用与不可用标记；正文读取按当前权限。撤销 24 小时内清除未冻结的来源副本（ADR-0024），快照正文按第 2 节保留策略处理。
- 来源不可用不清除任务约定、交接与 Artifact 固定输入；它们各自的保留规则不变。

### 7 数据与协议草图（实施时以协议与 migration 为准）

- Node wire：`run.start` 增加 `projectContext: { snapshotId, digest, manifest }`；`runtime.initialize` 增加同构字段 + `entriesDir`。
- 上行：`run.context_receipt`（Node→Hub，本地 wire 之外只含不透明 id 与计数）；Hub 校验 runId/snapshotId 归属后落库。
- HTTP 读面：Run 详情增加 `projectContext: { snapshotId, entries, unselected, consumedAt, unavailable }`；正文只在权限通过时返回；下载接口按 Run 与 Node 归属鉴权。
- 表：§2 两张 + `run_context_receipt`（`runId`、`snapshotId`、`promptDigest`、`entriesRead`、`digestVerified`、`at`，唯一键 `(runId, snapshotId)`）。
- 所有视图不含绝对路径、凭据、平台私密名称；`unselected` 只含原因与不透明 id。

### 8 观测与归因

- `hub.context`：`context.snapshot_created`、`context.entry_selected/unselected`、`context.dispatch_blocked`、`context.receipt_recorded`、`context.changed_notice`；字段只含不透明 id、kind、状态、计数。
- `node.context`：下载、逐条 digest 校验、字节核对失败、Runtime 启动；不含正文。
- `runtime.bridge.context`：初始化清单 digest、首条指令 nonce 是否匹配、读取的 entryId、输出是否引用。
- 归因按层：选入错误 → Hub 快照；交付错误 → Node 下载/校验；消费错误 → Runtime 回执。缺任何一层判失败。

### 9 验证

- 正向：创建 Run 自动选入 `own_work` 有效条目；显式勾选 `read_only` 条目进入快照；快照固定后来源出新版本，旧 Run 不变；同幂等键重放返回同一快照；新 Run 选新版本。
- 负控：`model_inferred` 未勾选不进入快照；来源撤销后派发被阻止；快照 digest 与下载内容不符时不启动 Runtime；非 owner Node 不能下载；活跃 Run 不因来源变化自动 followup；旧 Run 快照不被改写；只记快照 ID 而无回执时不得标 `consumed`；权限不足时历史正文不可读但元数据可见。
- 消费判据：首条请求包含快照 nonce（replay `{{fromRequest}}` 或等价探针）；`read_project_context` 返回结构化字段与正文；回执 `entriesRead` 与工具调用一致；只保存 ID 的变体必须红。
- 每条新判据做一次单点变异（去掉派发判权、去掉 digest 校验、允许推断自动选入、去掉回执要求），必须变红。

### 10 不做什么

- 不把订阅消息、@Agent、模型建议或来源变化直接变成活跃 Run 的指令、追问、取消或审批。
- 不自动给活跃 Run 注入只读参考；未来若需要，另立 ADR 定义 context 通道与消费回执。
- 不照搬上游 Ticket 的旧 Mandate 复活或 Assignment 自动重开；新执行必须新 Run。
- 不改写旧 Run 的输入、快照与成果依据；不把「刷新项目参考」当换版入口。
- 不在本 ADR 决定来源版本分类（ADR-0025）或协调计算费用（ADR-0026）。

### 11 后果与重新评估

- 若自动选入的条目过多导致执行上下文频繁超限，先收紧 `own_work` 关联质量与容量上限，不静默删条目。
- 若成员频繁显式勾选同类 `read_only` 条目，可评估把该关联升级为 `own_work`，但需成员确认，不能由模型自动升级。
- 若 `run.context_receipt` 在真实 Runtime 上难以稳定产生，先保留「首条请求 nonce + 工具调用记录」两层判据，不允许退回「只存快照 ID」。
- 若历史 Run 在撤权后仍需展示正文以满足审计，必须先做独立权限与脱敏设计，不能复用当前读面绕过。

## 验证登记

本 ADR 是文档，不含机器证据。接受后由 PC-05 创建 `docs/agent/run-project-context-acceptance.md`，登记选择/冻结/派发判权/字节核对/消费回执/撤权历史/重放与新意图判据；未完成前不标记交付。
