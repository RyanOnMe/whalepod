# ADR-0026：项目持续协调的生命周期、受限计算与成本

- 状态：提案（Proposed，#452，2026-11-01）。接受前不启用任何后台模型提取或协调计算；本文件不是已采纳决定。
- 承接：计划 §4.1、§4.3–§4.4、§5.1、§6；[ADR-0025](./0025-source-revisions-and-project-understanding.md) 的事实阶梯与事务边界。
- 输入证据：PC-00 (#463) 的 rc.8 工具行禁用/输入引用/结构化结果探针；上游固定提交 `6337fc8` 的复用分析（§3、§5、§6.2）。
- 与既有决定的关系：ADR-0004（进程隔离）、ADR-0020（不新建 Hub 直连模型通道）、ADR-0023（隔离未验证前暂停）、ADR-0024（采集 Node 归属与撤权）。

## 问题

项目需要「记住哪些问题尚未解决、谁的工作采用了哪些依据、下一步在等谁」，并在相关变化到来时有界更新。上游原型用一个长期 main Session 加多个 Worker Session 实现；它假设模型常驻、工具可用、状态可被模型改。WhalePod 不能照搬：

- 团队状态权威在 PostgreSQL，模型不能持有第二份事实库；
- 业务 Run 有明确执行意图、终态不可复活、Node 隔离与审批；
- 来源可读不等于允许执行，后台计算不能借「协调」获得业务工具或对外发送能力；
- 费用、额度、停机与撤销必须由成员显式授权，不能用个人模型额度默认承担团队后台。

本 ADR 决定协调身份、检查点、唤醒、受限进程、结果提交、失败恢复与成本边界；不决定事实分类（ADR-0025）与 Run 消费（ADR-0027）。

## 决定

### 1 协调身份与不变量

- 每个 Project 一个**逻辑协调身份**，处理该 Project 已绑定、允许整团队共享的来源与投影；不跨项目扫描，不读取个人原始 Session、未共享候选或私有 Workspace。
- **逻辑身份不是常驻推理**：空闲时不轮询模型；确定性变化先入账，相关变化合并后才唤醒一次有界评估。
- **协调计算不是 Run**：不创建 Task/Run，不占 Task 单活跃名额，不写 Run 事件，不调用 `run.followup`、取消、审批或任何业务工具，不向外部平台发送消息。
- **协调输出不是业务事实**：只能写 ADR-0025 的 Inference（带引用）；Decision、Correction、Run 完成态、成果验收只能由成员经既有业务入口产生。
- **首次启用必须显式配置**：模型 Node、操作者成员、费用承担者、日额度、并发（默认 1）、单次输入上限、超时与停机行为；缺一项即保持 `autoExtraction=false`，只跑确定性路径。

### 2 生命周期：确定性先行，模型后有界

```
来源事件/业务事件
  → Hub 事务：revision/observation/work_link/watermark（ADR-0025）
  → 触发器合并：同一 Project 的相关变化合并为一次待评估
  → 评估记录（queued，单飞）
  → 选择已授权 Node（声明 coordination 能力 + 配置的模型凭据槽）
  → 受限计算（只读输入 + 结构化结果）
  → 提交事务：复核代次/权限/水位/纠正版本 → Inference 或丢弃(stale)
  → 读面更新 / 通知只到产品面
```

- **触发器**：来源新版本、撤权、权限未知/恢复、Task/Run 状态与成果发布、人工纠正、成员显式询问。相同输入集合在合并窗口内只产生一次评估；窗口与上限由配置固定，不按负载漂移。
- **检查点**（`project_coordinator_state`）：每来源已处理 revision、活动工作引用、未决问题引用、近期判断引用、纠正版本、规则/处理器版本、额度计数、最后成功/失败时间。检查点可从权威表重建。
- **无变化不唤醒**：模型不得为了「保持记忆」定期运行；没有相关输入时评估状态为 `skipped(no_relevant_change)`。
- **输入缺失/超限**：评估结果必须显式列出「未读取/被截断」的输入；不得声称读完。

### 3 评估身份、单飞与恢复

- `coordination_evaluation` 是协调工作的唯一任务身份（不是 Run）。关键字段：`id`、`projectId`、`inputDigest`（输入条目与版本集合 + 规则/处理器版本 + 纠正版本的哈希）、`status`（queued/dispatched/running/completed/failed/cancelled/stale/skipped）、`attempt`、`deadlineAt`、`nodeId`、`leaseExpiresAt`、`resultDigest`、`failureCode`、`cost`。
- `(projectId, inputDigest)` 唯一；同输入重试返回首次结果，不重复提醒，也不撤销纠正。
- **每 Project 同一时刻至多一个进行中的评估**：部分唯一索引（`status in ('queued','dispatched','running')`）或项目行锁；并发 1 的全局上限由 Node 侧再限一层。
- **租约与孤儿**：Hub 下发评估时给有界租约（默认 120 秒，可配置；心跳续租）。Node 进程崩溃或心跳丢失后租约到期，Hub 将评估标为 `failed(node_lost)`，可重排一次；**不自动重放可能有副作用的动作**（本设计的计算只有只读输入与结构化结果，仍按此纪律）。
- **取消**：成员暂停/撤销项目协调、来源撤销、项目归档时，Hub 取消 queued/dispatched 评估并通知 Node 终止子进程；迟到结果按代次/水位丢弃。
- **超时**：`deadlineAt` 到期由 Hub 判 `failed(timeout)`；Node 必须终止进程并清理临时目录，不能继续提交。

### 4 受限计算：能力边界来自装配，不来自提示词

- 协调计算运行在 Node 上的**独立受限 Runtime 进程**：独立 DSH_HOME、独立工作目录、无业务工具、无出站网络、无外部发送、无审批工具。
- **允许的工具面**只有两项：只读输入读取（清单白名单，等价于现有 `read_artifact_input` 语义）与结构化结果提交（受 schema 约束）。输入清单使用 ADR-0025 的 revision/entry 身份与 digest，不传本机路径。
- **禁止能力必须逐项在 boot 层禁用并有探针**：`tool-bash`、`tool-pwsh`、`tool-fs`（read/write/edit）、`tool-fs-search`、`tool-workflow`、`tool-str-replace-editor`、`tool-web`、`tool-jobs`、`tool-subagent*`、`tool-todo`、`tool-goal`、Code Mode `run_code`。PC-00 已证明 `disabled: true` 的机制与 `tool-bash` 一行；**其余每一行在启用前都要有自己的负控**（调用返回 `UNKNOWN_TOOL`、无副作用）。任何一行无法验证隔离，就停在确定性同步，不启用模型评估。
- **不依赖 `ctx.tools.restrict()` 作为权限边界**：vendor README 明示它只是可见性组合；可以用它减少模型可见面，但不能作为唯一控制。
- **模型凭据**：只来自操作者配置的专用凭据槽，存 Node SecretStore；默认拒绝使用成员个人模型额度。凭据缺失时评估以 `failed(credential_unavailable)` 结束，不落到确定性事实。
- **输出结构**：固定 schema——`suggestions`（影响的 Task/Run、类型、置信度、引用）、`open_questions`、`possible_decisions`、`notes_on_gaps`。所有条目必须带 ADR-0025 的 citation；schema 外字段拒绝。没有 `decision`、`completed`、`approved` 这类可执行业务状态的写入口。

### 5 输入、结果提交与围栏

- 输入上限：单次最多 N 个 revision、M 字节、K 个 token（默认建议 32 条 / 256KiB / 32k token，实施时以配置固定）；超出部分显式列入未纳入清单，不静默截断。
- 结果条目在提交事务内复核：
  1. `authorizationGeneration` 与权限状态仍为可读；
  2. 输入水位未前进到评估未覆盖的版本；
  3. 纠正版本未变化（人工纠正优先）；
  4. 项目协调未被暂停/归档。
- 任一不满足 → 整份结果 `stale` 丢弃并记原因；不得部分写入。
- 结果写入只追加 Inference 与引用；同一输入重试不追加重复条目（`inputDigest` 唯一）。
- **模型失败不阻塞确定性事实**：来源同步、Observation、WorkLink 照常；读面显示「理解落后于哪些变化」与最后成功时间。

### 6 成本、额度与停机

- **费用归属**：启用时由操作者指定费用承担者（成员或团队额度）与模型 Node；记录在协调配置审计里。个人额度不是默认值。
- **额度**：日调用数、日 token/费用上限、单次输入上限、并发 1、超时与最大重试次数。额度记录在 `coordination_budget`（按 UTC 日与 Project 聚合）。
- **耗尽行为**：额度耗尽立即停止新模型评估，确定性同步继续；读面标记「协调理解暂停（额度）」。额度恢复不自动补跑历史评估，只处理新的相关变化（避免积压风暴）。
- **停机/暂停**：项目协调暂停、Node 离线、凭据不可用、模型限流分别有状态与文案；不把「模型没跑」显示成「项目没有变化」。

### 7 数据草图（实施时以协议与 migration 为准）

| 表 | 关键字段 | 约束 |
|---|---|---|
| `project_coordinator_state` | `projectId`、`enabled`、`modelNodeId`、`operatorMemberId`、`billingOwner`、`credentialSlot`、`rulesVersion`、`processorVersion`、`dailyBudget`、`lastSuccessfulEvaluationId`、`pausedAt`、`pauseReason` | 每 Project 一行；配置变更写审计 |
| `coordination_evaluation` | §3 字段 + `inputManifest`（不透明 id/digest/字节数） | `(projectId, inputDigest)` 唯一；进行中唯一 |
| `coordination_budget` | `projectId`、`utcDate`、`evaluations`、`inputBytes`、`tokens`、`costMicros`、`limit` | `(projectId, utcDate)` 主键 |
| `coordination_audit_event` | `id`、`projectId`、`evaluationId`、`event`、`actor`、`reason`、`createdAt`、`payload` | 不含正文、平台名称、成员姓名 |

### 8 协议与 Node 装配

- `node.hello` 增加可选 `coordinationCapabilities: ['coordination.v1']`；Hub 只向声明能力的 Node 下发协调帧。旧 Node 不收到未知帧。
- 新增本地帧：`coordination.request`（评估 id、项目、输入清单、上限、截止时间）、`coordination.result`（结构化结果 + digest + 代次/水位）、`coordination.cancel`、`coordination.heartbeat`。载荷不含凭据与绝对路径；本机路径只在本地 wire。
- Node 侧新增 `coordination` 用途的 Runtime 启动入口与 supervisor 子命令，复用现有 SecretStore、进程隔离与临时目录清理；不得复用业务 Run 的装配或 Thread/Session 身份。
- Hub 不加载上游插件、不直连模型；模型调用只发生在 Node 的受限进程（ADR-0020）。

### 9 观测与证据

- `hub.context`：`coordination.enabled/paused/resumed`、`coordination.evaluation_queued/dispatched/skipped/stale/completed/failed`、`coordination.budget_exhausted`；字段只含不透明 id、状态、原因与计数。
- `node.coordination`：请求接收、租约续租/丢失、进程启动/终止、额度拒绝、结果提交；不含正文。
- `runtime.bridge.context`：本轮输入清单 digest、实际读取的条目、输出条数与 schema 校验结果。
- 证据包按计划 §9.2 归档；完整输入正文、模型请求/响应与凭据不进公共包。

### 10 验证

- 正向：相关变化合并为一次评估；结果带引用写入 Inference；读面显示更新水位；同输入重试不重复提醒。
- 负控：无变化不唤醒；并发第二份评估被单飞拒绝；额度耗尽不再调用模型；迟到结果因水位/代次/纠正变化被丢弃；暂停后不再下发；Node 崩溃/超时/租约丢失各自有终态；模型 schema 外输出被拒。
- **能力负控**：协调装配下逐项调用被禁工具返回 `UNKNOWN_TOOL` 且无副作用；输入读取只按清单；输出无法写业务表（读库断言 Task/Run 零变化）。
- 变异：去掉单飞唯一索引、去掉提交围栏、放开一个工具行，各观察一条红。
- 真实模型质量与费用在开发集/保留集分别评估（计划 §9.4），未跑保持 `not_run`。

### 11 不做什么

- 不启用常驻 Session、语义 Watchdog、推测执行或自动业务执行。
- 不向办公群发送消息，不代替成员发言，不自动创建 Run/followup/审批。
- 不跨项目扫描，不读取私人 Session/Workspace，不把共享长文当权限豁免。
- 不引入第二份 SQLite 作为团队状态权威，不在 Hub 直连模型。
- 不在能力隔离未验证时「先用提示词约束」上线。

### 12 后果与重新评估

- 若 rc.8 无法稳定禁用某个工具行，协调计算只能停在确定性路径；不得降低隔离要求。
- 若真实模型在 32k 输入内无法产生可用判断，先缩小输入与目标，不放开浏览器/Shell 等能力换质量。
- 若单飞与合并窗口导致理解延迟超出计划目标（p95 ≤60 秒），先调窗口与预算，不允许并发超 1 作为默认。
- 若团队不愿承担后台模型费用，保持 `autoExtraction=false`，协调读面只显示确定性事实与缺口。

## 验证登记

本 ADR 是文档，不含机器证据。接受后由 PC-04 创建 `docs/agent/project-coordination-acceptance.md`，登记单飞/合并/额度/迟到/崩溃/恢复与逐工具能力负控；PC-00 (#463) 的探针只证明机制，不等于本条交付。
