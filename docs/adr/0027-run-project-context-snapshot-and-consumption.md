# ADR-0027：新 Run 的项目上下文快照、消费与固定历史

- 状态：提案（Proposed，#453，2026-11-01；评审稿）。接受前不开 PC-05 实现分支；本文件不是已采纳决定。
- 承接：计划 §4.4、§5.1–§5.3、§6；[ADR-0025](./0025-source-revisions-and-project-understanding.md) 的事实阶梯与引用；[ADR-0026](./0026-project-coordination-lifecycle-and-cost.md) 的协调输出边界。
- 既有约束：ADR-0013（明确执行意图）、ADR-0016（Run Artifact 输入快照）、ADR-0017（任务约定与交接）、ADR-0020（执行上下文消费）、ADR-0022（成果交付依据）、ADR-0024（撤权与保留）。

## 问题

新 Run 需要采用项目已同步的上下文，同时保持现有执行依据的固定语义：任务约定、交接输入、Artifact 输入、审阅输入都在创建事务里固定，重放不换依据。现在缺的是：

- 哪些项目条目自动选入、哪些必须成员显式选择；模型推断能否成为执行依据；
- 选入后如何冻结版本与正文，来源过期、撤权或与确认要求冲突时如何表现；
- 派发前如何再判权、Node 如何核对字节，Runtime 是否真的消费（而不是只存了快照 ID）；
- 同一启动请求重放、新执行意图、活跃 Run 变化提示与旧 Run 历史如何分开；
- 历史 Run 在来源撤销或消息撤回后还能读到什么。

本 ADR 只决定 Run 侧的选择、快照、消费与历史；不决定来源版本规则（ADR-0025）或后台协调生命周期（ADR-0026）。

## 决定

### 1 选择规则：只选确定性条目，推断永不进入执行依据

Run 创建事务内按固定规则选取，规则版本写入快照：

- **自动选入**：与本次 Task 存在 `own_work` WorkLink 的 Thread 下，当前有效的 Observation，以及 `businessRef` 解析到本 Task 当前约定/审批/发布/接收的 Decision（ADR-0025 §1 的有效性表）。只取有效版本，不取被纠正/撤回的版本。
- **显式选入**：成员可在创建界面勾选 `read_only` 订阅线程下的 Observation/Decision；`model_inferred` 关联必须先由成员激活（转成 `read_only` 或 `own_work`，记录 `activatedBy`），其线程下的条目才可被选中。选择记录 `selectedByMemberId`。
- **永不进入快照**：Inference（包括协调者的建议、影响判断、未决问题）、**未映射身份成员的 Decision/批准/完成类表述**、未通过权限检查的正文、个人 Workspace/私有 Session、未共享候选。成员也不能把 Inference 勾选为执行依据；建议只能影响成员自己的选择动作。
- **既有依据不变**：任务约定、交接输入与 Artifact 输入继续按 ADR-0016/0017/0020 固定；项目上下文不替换它们，也不因「刷新参考」静默换掉已固定的 Artifact 版本。
- **容量**：默认最多 32 条、合计 256KiB、单条 64KiB；超出部分进入「未纳入项」清单并写明原因（超限/无权限/冲突/推断不可选），**不静默截断**。超 64KiB 的单条直接标未纳入，不截断后冒充同一版本。
- **冲突与缺口**：
  - **权限未知/过期/不可用**：硬阻断，不允许继续，不存在 override；
  - **与已确认约定冲突或必要材料缺失**：创建返回缺口说明，成员必须沿原业务入口作出明确选择（取消、调整任务，或记录 `overrideReason` 后继续）；`overrideReason` 只覆盖业务冲突，不能覆盖权限。
- **未映射身份**：Observation 的选择不按显示名映射成员；**带引用的来源 Observation** 即使作者未映射也可选入，但必须标 `identityUnverified=true`；未映射身份的 Decision/批准/完成类文字不得成为 Decision，也不得因“看起来像决定”被选入。界面同时显示「身份未核实」。

### 2 快照：创建时冻结，读时判权，逐条可失效

- `run_project_context`（快照头）：`id`、`runId`、`projectId`、`selectionRuleVersion`、`snapshotDigest`、`headerText`、`headerDigest`、`entryCount`、`totalBytes`、`unselected`（JSON，只有原因与不透明 id）、`overrideReason?`、`status`（frozen/partially_unavailable/invalidated）、`deliveredAt?`、`consumedAt?`、`consumedAllAt?`、`createdAt`。
- `run_project_context_entry`：`snapshotId`、`entryId`、`entryVersion`、`kind`（observation/decision）、`citation`（source 或 business，ADR-0025 §1）、`sourceId?`、`revisionId?`、`threadId?`、`businessRef?`、`authorizationGeneration?`、`digest`、`byteSize`、`title`、`body`（冻结副本，受容量上限）、`entryStatus`（frozen/retracted/source_tombstoned）、`statusReason?`、`permissionStateAtSelection`、`identityUnverified?`、`selectedByMemberId?`、`deliveredAt?`、`readAt?`。
  - `entryVersion` = ADR-0025 条目的业务版本：Decision 取 `businessVersion`，source Observation 取 `revisionId + latestObservedAt`（A→B→A 时用最新观察时间，不用 revision 行首次 observedAt）；只用于展示与对账，不替代 `digest`。
- **Digest 与 header**：
  - `snapshotDigest` = sha256(规范化 JSON：`selectionRuleVersion` + 按 `entryId` 排序的 `[{entryId, kind, digest}]`)，不含时间戳；
  - `headerText` 在**创建事务内**生成并持久化（≤4,000 字符），不依赖派发时再生成；标题超过 60 字符时确定性截断；截断后仍超限则创建失败 `CONTEXT_UNAVAILABLE`，不生成快照；
  - `headerDigest` = sha256(最终 `headerText`)，随 `run.start` 下发，供回执复算。
- **冻结语义**：快照行不可改写来源版本或正文；后续新版本、纠正、撤权不修改已冻结内容。自动选入的条目不会因为后来出现新版本而被替换。
- **deliveredAt 与 readAt 的语义**：`deliveredAt` 只表示清单与本地副本已交付（Node 下载完成），**不代表正文进入过模型**；`readAt` 才表示该条目正文经 `read_project_context` 进入过模型请求。撤销清理只删除 `deliveredAt` 已写、`readAt` 为空且受影响的本地副本；`readAt` 非空的条目与 session/spill 一律不动。`run.start` payload、`runtime.initialize` 的 headerText/headerDigest 与 `executionContext` 在撤销前后逐字节不变。
- **逐条状态**（存储三类，权限类不可读是读时计算，不落库）：
  - `retracted`：来源版本被撤回/删除，**所有读面（含历史 Run）不再展示正文**；
  - `source_tombstoned`：源 `source_revision` 行按 ADR-0024 §8 清除后，引用元数据墓碑化；**快照冻结正文仍按 ADR-0024 §8 随 Run 保留**，读面在权限允许时仍可展示正文，同时标注「来源版本已清理」；不重建来源正文；
  - `frozen`：其余条目。
- **读时判权**：任何读面（Run 详情、Web、Node 下载、Runtime 输入）在使用正文前复核当前权限与代次；权限不足时视为不可读（不改变存储状态）。`frozen` 不等于权限豁免。
- **快照头状态**：全部条目可读为 `frozen`；部分不可读/已撤权为 `partially_unavailable`；全部不可读或 `retracted` 为 `invalidated`。状态只由条目状态与读时权限派生，不回写正文。
- **引用不建 FK**：快照只保存不透明 `revisionId/entryId` 与 digest，不对可能被墓碑清除的 `source_revision` 建外键；避免 ADR-0024 的 30 天/24 小时清除与快照保留互相阻塞。

### 3 派发前复核、能力协商与 Node 字节核对

- 创建后、派发前（`run.start` 前）Hub 再次检查：来源代次、权限状态、条目 digest 与快照一致、约定/交接未变。任一失败 → Run 走现有派发失败路径，标 `failed(CONTEXT_UNAVAILABLE)`，outbox 记录终止；**不自动换最新版本，也不静默丢条目**。
- **能力协商**：`node.hello` 增加 `contextCapabilities: ['project-context.v1']`。快照 `entryCount>0` 时，Hub 只向声明能力的 Node 派发；Node 未声明或旧 Node → `CONTEXT_UNAVAILABLE`，不派发。`entryCount=0` 时可不携带 `projectContext`，但仍记录空快照。
- Node 通过受控下载接口按 `snapshotId` 取得条目内容（内容寻址，按 entryId 命名文件），逐条校验 `digest` 与 `byteSize`；不一致 → `CONTEXT_DIGEST_MISMATCH` 失败，不启动 Runtime。下载副本存于 `runtime-context/<runId>`，随 Run 终态清理（复用 `runtime-inputs` 的清理纪律）。
- **spill 根受管**：Run 装配必须显式把 `spill-local.root`（或等价 spill 根）指到 `runtime-home/<runId>/spill`，**不得落 OS tmpdir**。rc.8 默认 `mkdtemp(tmpdir()/dsh-spill-*)`，未配置时正文超过 spill 阈值（50,000 字节）会写到系统临时目录，终态删除与零命中扫描都会漏掉（PC-00 核对）。`runtime-context`、`runtime-home` 与 spill 根同属本次 Run 的受管副本，纳入 §6 的删除、脱敏与扫描。
- 读面接口：`GET /api/v1/runs/:runId/project-context`（成员视图，按条目状态与当前权限返回）与 `GET /api/v1/runs/:runId/project-context/bundle`（Node 下载，按 Run 归属与设备鉴权）。两者都只返回快照内条目。
- 下载接口只对本次 Run 的 owner Node 与责任人可见；不返回快照外的条目，不返回绝对路径给 Hub/Web/日志。
- **新增错误码**：`CONTEXT_UNAVAILABLE`、`CONTEXT_DIGEST_MISMATCH` 在实施时登记进 `ErrorCodeSchema`、03 §10、fixtures 与对齐测试；本 ADR 不接受「或沿用某个现有码」的模糊处理。

### 4 Runtime 注入与真实消费判据

- `runtime.initialize` 增加可选 `projectContext`：`{ snapshotId, digest, headerText, headerDigest, entries: [{ entryId, kind, title, revisionId?, businessRef?, digest, byteSize }], entriesDir }`（`entriesDir` 仅本地 wire，红线同 `artifactInputsDir`）。清单与目录成对出现；`entryCount>0` 时该字段必填，缺一 fail-closed。
- **headerText** 由 Hub 在**创建事务内**生成并持久化（≤4,000 字符；标题截断规则见 §2），包含：快照 id、条数、每条 entryId/标题/版本、nonce，以及「用 `read_project_context` 按 entryId 读取；快照是执行依据，后来变化不自动替换」的说明。nonce = `sha256(snapshotDigest + '|' + runId)` 的前 16 个十六进制字符，以 `[project-context:<nonce>]` 形式出现。
- **正文不进 `executionContext`**：项目上下文正文的**专用通道**是 Node 下载副本与 `read_project_context` 进入模型；既有 `executionContext` 最多追加一段 ≤2,000 字符的摘要（快照 id、条数、缺口），并仍受 100,000 字符总上限校验。两处都不允许把 256KiB 正文塞进 wire 文本。Run 的通用 shell/fs 工具仍可读取受管目录，专用通道**不是读隔离**（见 §6 限制）。
- **只读工具 `read_project_context`**：参数只有 `entryId`，按清单白名单读取本地副本；返回结构化字段（entryId、kind、title、revisionId/businessRef、digest、byteSize、content/截断标记），拒绝消息不含本机路径（语义与 `read_artifact_input` 相同）。
- **两级回执**：
  - `runtime.context_receipt`（Runtime→Node，本地 stdio wire）：首条指令装配后发 `{ snapshotId, headerDigest, nonceMatched, entriesDelivered }`；每次工具读取后发 `{ snapshotId, entryId, digestVerified, byteSize }`。
  - `run.context_receipt`（Node→Hub，专用上行帧，不投影成产品 Run 事件）：`{ runId, snapshotId, receiptSeq, headerDigest, nonceMatched, entriesDelivered[], entriesRead[], readEvents[{ entryId, digestVerified, byteSize, at }], missing[], digestVerified, at }`，append-only；`entriesDelivered` 是该快照已交付条目累计，`entriesRead/readEvents` 是**本批新增读取**，Hub 侧累计取并集；Node 可按批合并，但必须保留每次读取的 entryId 与时间。
- **Hub 接受谓词**（全部成立才更新状态）：
  1. `runId/snapshotId` 归属本次 Run，且 Run 处于 `dispatching/running/waiting_approval`（终态后到达的回执拒绝并记 `receipt_late`）；
  2. `nonceMatched === true`；
  3. `headerDigest === sha256(headerText)`（Hub 用创建事务里持久化的 headerText 复算）；
  4. `digestVerified === true` 且 `entriesRead ⊆ entriesDelivered ⊆ 快照条目`，本批 `entriesRead` 与 `readEvents` 的 entryId 集合完全一致；
  5. `receiptSeq` 单调、无重复。
- 状态：首条合格回执把条目标 `deliveredAt`；某条出现在 `entriesRead` 时标 `readAt`；至少一条被读后快照标 `consumed`，全部读完标 `consumedAll`。`entriesRead=0` 的快照永远不算 `consumed`。
- **首条回执 watchdog**：仅当 `entryCount>0` 且已下发 `projectContext` 时启用。Run 进入 `running` 后的 60 秒内（可配置，上限 120 秒）没有合格的首条回执，Hub 将 Run 置 `failed(CONTEXT_UNAVAILABLE)` 并终止执行；空快照 Run 不启用 watchdog，不得误杀。
- **条目级消费表**：新增 `run_context_consumption(snapshotId, entryId, threadId?, runId, readAt)`，唯一 `(snapshotId, entryId)`；回执事务内写 `readAt` 与 receipt，消费行由**同一事务的 savepoint**写入，失败只记 `consumption_gap`，不回滚读取事实。PC-06 以该表作为「实际消费」证据；不把条目级消费塞进 `work_link`。
- **信任边界**：Node 是本次 Run 的受信执行代理（owner 设备），回执是**自报证据**，用于防止「只存快照 ID」「漏读」「部分交付」，**不防恶意 Node**。Hub 校验 `entriesRead` 与本批 `readEvents` 一致、headerDigest 可复算、序号单调；不声称独立验证模型真的读了内容。若未来需要更强证据，另立 ADR 设计设备审计或抽样对账。

### 5 重放、新意图与活跃 Run

- 同一启动请求（同一幂等键）重放返回同一 `run_project_context` 快照，不重新选取「最新」。
- 只有新的明确执行意图（新 Run 创建）才按当时规则选择新版本；续跑/重跑是新 Run，按当时的项目上下文与既有 Artifact 输入规则装配，不修改旧 Run。
- 活跃 Run 期间发生来源新版本、纠正或撤权：只在读面显示「本次执行依据已变化」提示；不自动 `run.followup`、不注入参考、不取消工具、不改写正在执行的上下文。成员主动 followup 仍走现有权限、排队与撤销守卫。
- 旧 Run 的快照、引用与成果依据不改写；撤销/撤回后按 §2 的逐条状态显示。

### 6 撤权、不可用与历史

- 新 Run：来源撤销/不可用/权限未知时阻止选入与派发；已冻结但未派发的快照按 §3 失败。
- 活跃 Run：显示依据已变化；不承诺收回模型已读到的内容；不自动停止执行（除非责任人走既有取消路径）。
- 历史 Run：保留快照头、条目身份、digest、引用与逐条不可用标记；正文读取按当前权限与 §2 的条目状态。来源撤销 24 小时内清除未冻结的来源副本（ADR-0024），快照正文按第 2 节保留策略处理。
- **本地 DSH session 日志与副本**：`read_project_context`/`read_artifact_input` 的正文会随 `tool/result` 写入 Node 本地 session JSONL（`compression: none`，PC-00 已证同类行为），也可能被 compaction 摘要或 spill 文件复制。Hub 的 `run_project_context_entry.body` 按 ADR-0024 §8 **保留**（不在本 ADR 物理清除）；Node 本地副本按以下规则处理：
  - **Run 终态**：删除 `runtime-context/<runId>` 与 `runtime-home/<runId>/spill`；对 `runtime-home/<runId>` 做一次脱敏扫描：把 `read_project_context`/`read_artifact_input` 的 tool/result 正文、含 entry digest/上下文 nonce 的 compaction 摘要与 spill 文件替换为 `[redacted: project context]`（保留 callId、entryId、耗时与对话结构，保证续聊可装载）。终态后（含此前处于 `cleanup_pending` 的 Run）再跑一次完整扫描并清空队列。
  - **来源撤销/撤回/权限未知/过期/恢复**：分两档。**活跃 Run** 先应用不可读集合，再**逐条删除** `deliveredAt` 已写、`readAt` 为空且受影响的 `runtime-context` 本地副本（只删未读受影响文件，不整目录删除、不误伤未撤销条目；`readAt` 非空条目不动），并维护不可读条目集合（`revoked/retracted/permission_unknown/permission_denied/permission_unavailable`），`read_project_context` 对集合内条目返回不可用；**不删除 spill/session、不脱敏 `runtime-home`、不取消工具、不注入**。这是 0024 §5「停止正文使用」对**未读副本/新交付**的最小动作，不改写已注入的 `run.start`/header/`executionContext`；已读正文、已 spill 或已写入 session JSONL 的内容属于已交付内容，按 0024 §7.4 例外不收回（§6 限制）。权限恢复时按**新 `authorizationGeneration`**移除不可读标记（必须 ≥ 条目快照代次且等于 Hub 当前来源代次；旧代次即使 `stateVersion` 更高也不得恢复），且仅当快照条目仍有效、本地副本仍存在；已删除副本不自动重下，读面显示「本地副本已清理」。**Run 终态后 24 小时内**再执行 `runtime-context/<runId>` 整目录删除、spill 删除与 `runtime-home` 脱敏；删除失败进入 `cleanup_pending`，活跃 Run 的失败项也按每小时重试直到成功或终态转入终态清理队列。最终零命中只在终态后判定。Hub 快照正文按 0024 §8 保留但 `retracted` 条目不可读。`runtime-context` 与 spill 属于 **RunProjectContext 本地冻结副本**，不按来源规范化副本的 24 小时条款处理。
  - **助手转述**：模型对正文的改写/转述属于已交付内容（0024 §7.7「无法收回」），不承诺按语义删除；但助手消息里出现 entry digest、原文片段或上下文 nonce 时按同一规则物理替换（逐字引用会被命中并替换，纯改写不保证）。零命中判据只扫这些标记与原文片段，不把任意转述当失败。
  - **范围限制**：零命中只承诺 Node 受管目录（`runtime-home`、`runtime-context`、`coordination-home`）；模型 provider 侧的请求/响应日志与平台保留不在本轮清除范围，不得把本地零命中写成全链路无正文。
  - **通用工具读边界（已知限制）**：Run 仍挂载 `tool-bash`/`tool-fs`，rc.8 的 sandbox 默认只 deny 写、不 deny 读。撤销时已逐条删除受影响条目的 `runtime-context` 未读副本，但**已写入 session JSONL、compaction 摘要或 spill 的正文仍可被通用工具读取**；本 ADR 的撤销只保证「不再经专用读工具交付正文 + 未读受影响副本被删除」，**不承诺通用工具读隔离**，也不把 `run.context_state` 当成正文读隔离。要做到读隔离需另立 ADR（独立用户/namespace/Seatbelt+Landlock deny-read 或受控 broker），ADR-0023 的隔离暂停仍然有效；已交付内容无法收回。
  - **离线/丢失设备**：Node 维护本地待清理队列，分两类：活跃 Run 的未读副本删除重试项（成功后移除；Run 终态时转入完整清理）与终态 Run 的完整清理项（带 `runTerminalAt`）。设备离线时读面显示「本地清理待完成」，下次启动先清扫两类队列。**在线 Node 运行期每小时重试同一队列**（与 ADR-0026 的协调目录一致），失败持续记 `cleanup_pending` 并保留在队列，不依赖重启；物理限制如实说明：设备永不回来时无法保证远端清除。
  - **证据包**：禁止收录完整 DSH JSONL；只允许脱敏片段与 digest。
  - **负控**：Run 终态后（含撤销后进入终态的 Run）扫描 `runtime-home/<runId>`、`runtime-context/<runId>`（以及协调的 `coordination-home/<evaluationId>`）中的原文片段与 digest，必须零命中；活跃 Run 在撤销时只验证撤销条目读取被拒且本地文件保留，终态后才要求零命中；删除脱敏步骤的变异必须变红。

### 7 数据与协议草图（实施时以协议与 migration 为准）

- Node wire：`run.start` 增加 `projectContext: { snapshotId, digest, headerText, headerDigest, manifest }`；`runtime.initialize` 增加同构字段 + `entriesDir`。
- 撤销与权限状态通知：Hub 在来源撤销/撤回、权限 `unknown/expired/denied/unavailable`、恢复时向 owner Node 下发 `run.context_state`（`{ runId, snapshotId, stateVersion, entryIds[], state: revoked|retracted|permission_unknown|permission_denied|permission_unavailable|restored, authorizationGeneration, reason }`，不含正文）。Hub 持久化 `run_context_state`（每 Run 单调 `stateVersion`，`(runId, snapshotId, stateVersion)` 唯一并校验 `snapshotId` 与 Run 当前快照一致）并通过带 commandId/ack 的命令通道下发，未 ack 自动重试；Node 持久化、**先应用不可读状态并完成受影响未读副本删除后才 ack**（删除失败则 ack 失败并保留 `cleanup_pending` 重试），并在 Node/Runtime 重启或重连时重放当前状态（Node hello 后 Hub 也补发未 ack 状态）。Runtime 启动/重启时**先加载本地持久化状态再接受 `read_project_context`**；Runtime 按 `stateVersion` 单调应用并回本地 ack，Node 未收到 ack 时重放，旧版本不覆盖新状态。`stateVersion` 只解决通知顺序，权限恢复还须校验 `authorizationGeneration`：`restored` 必须携带 Hub 当前来源代次且 ≥ 条目快照代次，旧代次即使 `stateVersion` 更大也不得解除不可读（记 `state_stale_generation`）。`read_project_context` 对不可读条目返回不可用；撤销时活跃 Run 逐条删除受影响条目的未读副本（§6），不重启、不取消、不改写已交付内容。
- 上行：`runtime.context_receipt`（Runtime→Node，本地）与 `run.context_receipt`（Node→Hub，专用帧）；Hub 校验归属与 §4 谓词后落库。
- HTTP 读面：Run 详情增加 `projectContext: { snapshotId, entries[{ entryId, kind, title, entryStatus, readAt }], unselected, deliveredAt, consumedAt, unavailable }`；正文只在条目为 `frozen` 且权限通过时返回；下载接口按 Run 与 Node 归属鉴权。
- 表：`run_project_context`（§2 头字段，含 `headerText/headerDigest`）、`run_project_context_entry`（§2 条目字段 + `deliveredAt`/`readAt`）、`run_context_receipt`（`runId`、`snapshotId`、`receiptSeq`、`headerDigest`、`nonceMatched`、`entriesDelivered`、`entriesRead`、`readEvents`、`missing`、`digestVerified`、`at`；唯一键 `(runId, snapshotId, receiptSeq)`）、`run_context_consumption`（`snapshotId`、`entryId`、`threadId?`、`runId`、`readAt`；唯一 `(snapshotId, entryId)`）、`run_context_state`（`runId`、`snapshotId`、`stateVersion`、`entryIds`、`state`、`authorizationGeneration`、`reason`、`ackedAt?`；唯一 `(runId, snapshotId, stateVersion)`，`stateVersion` 单调）。
- 所有视图不含绝对路径、凭据、平台私密名称；`unselected` 只含原因与不透明 id。

### 8 观测与归因

- `hub.context`：`context.snapshot_created`、`context.entry_selected/unselected`、`context.dispatch_blocked`、`context.receipt_recorded/receipt_invalid`、`context.entry_retracted/source_tombstoned`、`context.changed_notice`；字段只含不透明 id、kind、状态、计数。
- `node.context`：下载、逐条 digest 校验、字节核对失败、Runtime 启动；不含正文。
- `runtime.bridge.context`：初始化清单 digest、headerDigest/nonce 是否匹配、读取的 entryId、输出是否引用。
- 归因按层：选入错误 → Hub 快照；交付错误 → Node 下载/校验；消费错误 → Runtime 回执。缺任何一层判失败。

### 9 验证

- 正向：创建 Run 自动选入 `own_work` 线程下的有效 Observation/Decision；成员激活 `model_inferred` 后其线程下的确定性条目可显式选入；快照固定后来源出新版本，旧 Run 不变；同幂等键重放返回同一快照；新 Run 选新版本；回执后条目 `readAt` 与 `run_context_consumption` 写入。
- 负控：Inference 不能被选入（界面与 API 各一条）；未映射身份成员的 Decision/批准/完成表述不得成为 Decision，未映射作者的带引用 Observation 可被选入且标 `identityUnverified`；未激活的 `model_inferred` 线程条目不自动选入；权限未知/过期时不存在 override 路径；来源撤销后派发被阻止；快照 digest 与下载内容不符时不启动 Runtime；撤回版本的正文在历史页不可读；`source_tombstoned` 后快照正文仍按 0024 保留但标注来源版本已清理；非 owner Node 不能下载；活跃 Run 不因来源变化自动 followup；只记快照 ID 或无 `entriesRead` 时不得标 `consumed`；`nonceMatched=false`、`headerDigest` 不符、`entriesRead` 越界、`receiptSeq` 重复各自拒绝；首条回执超时 → `failed(CONTEXT_UNAVAILABLE)`，空快照 Run 不被 watchdog 误杀；旧 Node 未声明 `project-context.v1` 时带内容的快照不派发；Run 终态后（含撤销后进入终态的 Run）对 `runtime-home/<runId>`、`runtime-context/<runId>`、`coordination-home/<evaluationId>` 按原文片段与 digest 扫描零命中；活跃 Run 撤销只要求受影响未读副本删除、读取被拒且未撤销条目不受影响（助手改写转述按 §6 的边界处理）。
- 消费判据：首条请求包含 `[project-context:<nonce>]`（replay `{{fromRequest}}` 或等价探针）；`read_project_context` 返回结构化字段与正文；回执 `entriesRead` 与工具调用一致；只保存 ID 的变体必须红。
- 每条新判据做一次单点变异（去掉派发判权、去掉 digest 校验、允许 Inference 选入、去掉回执谓词、允许旧 Node 派发），必须变红。
- 留存负控：正文 >50KB 强制走 spill 后，终态扫描 `runtime-home/<runId>/spill` 与 `runtime-context/<runId>` 必须零命中（spill 根落到 OS tmpdir 时该判据必须红）；来源撤销时活跃 Run 中 `deliveredAt=1 AND readAt=0` 的受影响副本被逐条删除、`readAt=1` 的条目与未撤销条目保留、撤销条目读取被拒，`run.start` payload/headerDigest/`executionContext` 前后逐字节不变；Run 进入终态后才整目录删除并零命中。权限 `unknown/expired/denied/unavailable` 时同样不可读，恢复时按新代次恢复可读；`stateVersion` 更大但 `authorizationGeneration` 更旧的 `restored` 必须被拒（`state_stale_generation`），旧代次不得解除不可读。`run.context_state` 丢失/未 ack 必须重试，删除失败时 Node 不得 ack；Runtime 重启后先加载状态、首读即被拒；映射成员在聊天里写「approved」仍只是 Observation，不能成为 Decision，也不能据此写业务状态。已写入 session/spill 的正文可被通用 bash/fs 读取，属 §6 已列限制，不得用「撤销后零暴露」表述。

### 10 不做什么

- 不把订阅消息、@Agent、模型建议或来源变化直接变成活跃 Run 的指令、追问、取消或审批。
- 不自动给活跃 Run 注入只读参考；未来若需要，另立 ADR 定义 context 通道与消费回执。
- 不照搬上游 Ticket 的旧 Mandate 复活或 Assignment 自动重开；新执行必须新 Run。
- 不改写旧 Run 的输入、快照与成果依据；不把「刷新项目参考」当换版入口。
- 不在本 ADR 决定来源版本分类（ADR-0025）或协调计算费用（ADR-0026）。

### 11 后果与重新评估

- 若自动选入的条目过多导致执行上下文频繁超限，先收紧 `own_work` 关联质量与容量上限，不静默删条目。
- 若成员频繁显式勾选同类 `read_only` 条目，可评估把该关联升级为 `own_work`，但需成员确认，不能由模型自动升级。
- 若 `run.context_receipt` 在真实 Runtime 上难以稳定产生，可保留「headerDigest + 逐条读取回执」两层判据，不允许退回「只存快照 ID」。
- 若历史 Run 在撤权后仍需展示正文以满足审计，必须先做独立权限与脱敏设计，不能复用当前读面绕过。
- 若 ADR-0024 的 24 小时清除与快照正文保留冲突，按 §2 的 `source_tombstoned` 处理**源 revision 引用**，快照正文仍按 0024 §8 保留；不修改已采纳 ADR 的清除期限。

## 验证登记

本 ADR 是文档，不含机器证据。接受后由 PC-05 创建 `docs/agent/run-project-context-acceptance.md`，登记选择/冻结/派发判权/能力协商/字节核对/回执谓词/撤权历史/重放与新意图判据；未完成前不标记交付。
