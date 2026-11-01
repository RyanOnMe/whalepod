# ADR-0026：项目持续协调的生命周期、受限计算与成本

- 状态：提案（Proposed，#452，2026-11-01；二稿）。接受前不启用任何后台模型提取或协调计算；本文件不是已采纳决定。
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
- **首次启用必须显式配置**：模型 Node、操作者成员、费用承担者、凭据槽、日额度（调用数/token/费用三项）、并发（默认 1）、单次输入上限、超时与停机行为；缺一项即 `project_coordinator_state.enabled=false`。协调只处理同时满足「Project 协调已启用」且「该来源 `autoExtraction=true`」的来源；两个开关是 AND，不互相代替。

### 2 生命周期：确定性先行，模型后有界

```
来源事件/业务事件
  → Hub 事务：revision/observation/work_link（ADR-0025）
  → 触发器合并：同一 Project 的相关变化合并为一次待评估
  → 评估队列（queued；可合并/被新 queued 取代）
  → 选择已授权 Node（声明 coordination 能力 + 配置的模型凭据槽）
  → 受限计算（只读输入 + 结构化结果）
  → 提交事务：CAS 评估状态 + 复核代次/权限/水位/纠正版本 → Inference 或丢弃(stale)
  → 读面更新 / 通知只到产品面
```

- **触发器**：来源新版本、撤权、权限未知/恢复、Task/Run 状态与成果发布、人工纠正、成员显式询问。相同输入集合在合并窗口内只产生一次评估；窗口与上限由配置固定，不按负载漂移。
- **检查点**（`project_coordinator_state`）：每来源已处理 `processedRevisionId`（自己的消费进度，不是观察权威）、活动工作引用、未决问题引用、近期判断引用、纠正版本、规则/处理器版本、最后成功/失败时间。检查点可从权威表重建。
- **无变化不唤醒**：模型不得为了「保持记忆」定期运行；没有相关输入时评估状态为 `skipped(no_relevant_change)`。
- **输入缺失/超限**：评估结果必须显式列出「未读取/被截断」的输入；不得声称读完。

### 3 评估身份、单飞、合并与恢复

- `coordination_evaluation` 是协调工作的唯一任务身份（不是 Run）。关键字段：`id`、`projectId`、`inputDigest`、`status`、`attempt`、`deadlineAt`、`nodeId`、`leaseToken`、`leaseExpiresAt`、`supersedesId?`、`supersededById?`、`resultDigest?`、`failureCode?`、`usage`（tokens/cost/provider/model）。
- **输入身份**：`inputDigest = hash(项目、输入条目与版本集合、每来源 authorizationGeneration 与权限水位、规则版本、处理器版本、模型 provider/model、纠正版本)`。任一变化都会产生新的 `inputDigest`，旧结果不得复用。
- **同输入幂等**：已有 `completed` 的同 `inputDigest` 评估直接复用其结果，不重复提醒；`failed` 可 `attempt+1` 重试，但不得复活 `cancelled/stale`。
- **单飞只约束执行**：部分唯一索引只覆盖 `status in ('dispatched','running')`；`queued` 不占单飞名额。
- **队列合并**：同一 Project 已有一条 `queued` 时，新变化不新增第二条，而是更新该行的输入清单、重算 `inputDigest` 并记 `supersedesId`；`queued` 超过 TTL（默认 10 分钟）或输入已不可用时转 `skipped(stale_queue)`。
- **状态迁移**（终态不可复活）：

| 从 | 到 | 触发 |
|---|---|---|
| — | queued | 触发器产生 |
| queued | dispatched | 选中 Node、写入 leaseToken 与 deadline |
| queued | skipped | 无相关变化 / TTL / 输入不可用 |
| dispatched | running | Node 首次心跳 |
| dispatched/running | completed | 结果提交通过 CAS 与围栏 |
| dispatched/running | failed | Node 崩溃、超时、额度、凭据不可用、usage 缺失 |
| dispatched/running | cancelled | 成员暂停/撤销、项目归档、来源撤销 |
| dispatched/running | stale | 提交时围栏不满足（代次/水位/纠正/模型身份） |
| failed | （新 attempt） | 同一评估 `attempt+1` 重新入队；终态行保留 |

`completed/cancelled/stale/skipped` 为终态，不可复活；`failed` 只能新建 attempt。

- **租约与孤儿**：Hub 下发时写 `leaseToken` 与有界租约（默认 120 秒，心跳续租）。Hub sweeper 以 `status in ('dispatched','running') AND leaseExpiresAt < now()` 为谓词 CAS 到 `failed(node_lost)`；重排为新 attempt。
- **取消**：成员暂停/撤销、来源撤销、项目归档时，Hub 取消 queued/dispatched/running 评估并通知 Node 终止子进程；迟到结果按 CAS 与围栏丢弃。
- **超时**：`deadlineAt` 到期由 Hub 判 `failed(timeout)`；Node 必须终止进程并清理临时目录。

### 4 受限计算：能力边界来自装配与逐项负控

- 协调计算运行在 Node 上的**独立受限 Runtime 进程**：独立 DSH_HOME、独立工作目录、无业务工具、无审批工具、无通用出站网络与外部发送。
- **允许面**只有：只读输入读取（清单白名单，语义同 `read_artifact_input`）与结构化结果输出（受 schema 约束的输出通道，不是业务工具）。
- **禁止能力逐项列举并逐项负控**（不使用通配符）：`tool-bash`、`tool-pwsh`、`tool-fs`（read/write/edit）、`tool-fs-search`、`tool-workflow`、`tool-str-replace-editor`、`tool-web`、`tool-jobs`、`tool-subagent`、`tool-subagent-fork`、`tool-subagent-control`、`tool-subagent-report`、`tool-todo`、`tool-goal`、`tool-ralph`、`tool-ask-user`、Code Mode `run_code`。
- **每个能力项要有正控 + 禁用负控**：正控证明该装配下该行确实挂载且可执行（在探针专用 overlay 里临时启用），负控证明协调装配下调用返回 `UNKNOWN_TOOL` 且无副作用。只验证「不存在」不算证明 `disabled: true` 生效（PC-00 的教训）。`tool-workflow` 的 worker、`run_code`、subagent/fork 与沙箱升级各自是独立能力项，不能由 `tool-bash` 一行代表。
- **审批面显式关闭**：协调 Runtime 不安装审批 answerer；pre-execute guard 对除允许面之外的一切调用直接返回拒绝，且**不产生 `approval.requested`**。探针断言审批帧为零。若实现必须走审批策略，只能使用 deny-all，不能默认 `full_access`（PC-00 已证明 `full_access` 会让禁用行的审批断言失效）。
- **不依赖 `ctx.tools.restrict()` 作为权限边界**：vendor README 明示它只是可见性组合；可以用它减少模型可见面，但不能作为唯一控制。
- **网络边界**：区分「工具出站网络禁用」与「模型 provider 出口白名单」。受限进程只允许访问配置的模型 provider 端点；通用 HTTP/浏览/外部发送全部不可用。网络隔离需要独立探针（例如尝试访问非白名单地址必须失败），不能只靠提示词。
- **模型凭据**：来自操作者配置的**协调专用凭据槽**（`scope='coordination'`），存 Node SecretStore；Hub 在下发前校验槽位 purpose/owner/billing，缺省拒绝。默认不使用成员个人模型额度。凭据缺失 → `failed(credential_unavailable)`，确定性事实不受影响。
- **输出结构**：固定 schema——`suggestions`（影响的 Task/Run、类型、置信度、引用）、`open_questions`、`possible_decisions`、`notes_on_gaps`。所有条目必须带 ADR-0025 的 citation；schema 外字段拒绝；没有 `decision/completed/approved` 写入口。

### 5 输入、结果提交与围栏

- 输入上限：单次最多 N 个 revision、M 字节、K 个 token（默认建议 32 条 / 256KiB / 32k token，实施时以配置固定）；超出部分显式列入未纳入清单，不静默截断。
- **输入交付**：Hub 在 `coordination.request` 中给清单；Node 通过受控接口按 revision/entry id 下载正文，逐条校验 digest 与字节数，存 `coordination-inputs/<evaluationId>`；任一不符即 `failed(input_digest_mismatch)`，不启动模型。协调 Node 与采集 Node 可以不同，下载鉴权按评估归属，不把正文暴露给无关 Node。终态清理该目录。
- 结果帧携带 `evaluationId`、`attempt`、`leaseToken`、`resultDigest`、`usage`。
- 提交事务：
  1. 锁评估行；要求 `status in ('dispatched','running')`、`leaseToken` 一致、租约未过期；
  2. `authorizationGeneration` 与权限状态仍为可读；
  3. 输入水位未前进到评估未覆盖的版本；
  4. 纠正版本、规则/处理器/模型身份与 `inputDigest` 一致；
  5. 项目协调未暂停/归档；
  6. `usage` 存在且在额度内。
  任一不满足 → CAS 到 `stale`/`failed` 并记原因；不得部分写入。
- 写入只追加 Inference 与引用；同 `inputDigest` 不重复追加条目。
- **额度记账在 Hub 提交事务内**：按 `usage` 更新 `coordination_budget`；超限的结果不提交，评估标 `failed(budget_exhausted)`，后续派发被阻断。Node 的本地计数只作辅助，重启后以 Hub 账本为准。

### 6 成本、额度与停机

- **费用归属**：启用时指定费用承担者；承担者必须是**已确认的成员或团队额度**（记录 `billingAcknowledgedAt`），不能由操作者单方面指定他人。个人额度不是默认值。
- **凭据槽**：`coordination_credential { nodeId, credentialSlot, scope='coordination', ownerMemberId, billingOwnerMemberId, billingAcknowledgedAt }`；Node inventory 的槽位增加可选 `purpose`，Hub 拒绝 purpose 不匹配的槽位。
- **额度**：`coordination_budget` 同时记录 `callLimit/tokenLimit/costLimit` 与已用量；支持 Project 日额度与团队日总额度（团队额度是外层上限，多 Project 不能叠加突破）。
- **耗尽行为**：停止新模型评估，确定性同步继续；读面标记「协调理解暂停（额度）」。额度恢复不自动补跑历史评估，只处理新的相关变化。
- **停机/暂停**：项目协调暂停、Node 离线、凭据不可用、模型限流分别有状态与文案；不把「模型没跑」显示成「项目没有变化」。

### 7 数据草图（实施时以协议与 migration 为准）

| 表 | 关键字段 | 约束 |
|---|---|---|
| `project_coordinator_state` | `projectId`、`enabled`、`modelNodeId`、`operatorMemberId`、`billingOwnerMemberId`、`billingAcknowledgedAt`、`credentialSlot`、`rulesVersion`、`processorVersion`、`dailyCallLimit/dailyTokenLimit/dailyCostLimit`、`lastSuccessfulEvaluationId`、`pausedAt`、`pauseReason` | 每 Project 一行；配置变更写审计 |
| `coordination_credential` | §6 字段 | `(nodeId, credentialSlot)` 唯一；未确认的 billing owner 不能启用 |
| `coordination_evaluation` | §3 字段 + `inputManifest`（不透明 id/digest/字节数） | `(projectId, inputDigest, attempt)` 唯一；`inputDigest` 至多一条 `completed`（部分唯一索引）；进行中唯一（仅 dispatched/running，按 projectId）；终态不可复活 |
| `coordination_budget` | `scope`（team/project）、`projectId?`、`utcDate`、`calls`、`inputTokens`、`outputTokens`、`costMicros`、`callLimit`、`tokenLimit`、`costLimit` | `(scope, projectId, utcDate)` 唯一（NULLS NOT DISTINCT）；团队额度外层校验 |
| `coordination_audit_event` | `id`、`projectId`、`evaluationId?`、`event`、`actor`、`reason`、`createdAt`、`payload` | 不含正文、平台名称、成员姓名 |

### 8 协议与 Node 装配

- `node.hello` 增加可选 `coordinationCapabilities: ['coordination.v1']`；Hub 只向声明能力的 Node 下发协调帧，旧 Node 不收到未知帧。部署顺序沿用 ADR-0024 §9（先 Hub 后 Node；旧 Hub 拒绝带新字段的 hello）。
- 新增本地帧：`coordination.request`（评估 id、attempt、leaseToken、项目、输入清单、上限、截止时间）、`coordination.result`（结果 + digest + 代次/水位 + usage + evaluationId/attempt/leaseToken）、`coordination.cancel`、`coordination.heartbeat`。载荷不含凭据与绝对路径。
- Node 侧新增 `coordination` 用途的 Runtime 启动入口与 supervisor 子命令，复用 SecretStore、进程隔离与临时目录清理；不得复用业务 Run 的装配或 Session 身份。
- Hub 不加载上游插件、不直连模型；模型调用只发生在 Node 的受限进程（ADR-0020）。

### 9 观测与证据

- `hub.context`：`coordination.enabled/paused/resumed`、`coordination.evaluation_queued/coalesced/dispatched/skipped/stale/completed/failed`、`coordination.budget_exhausted`；字段只含不透明 id、状态、原因与计数。
- `node.coordination`：请求接收、租约续租/丢失、进程启动/终止、额度拒绝、输入 digest 校验、结果提交；不含正文。
- `runtime.bridge.context`：输入清单 digest、实际读取的条目、输出条数与 schema 校验结果。
- 证据包按计划 §9.2 归档；完整输入正文、模型请求/响应与凭据不进公共包。

### 10 验证

- 正向：相关变化合并为一次评估；结果带引用写入 Inference；读面显示更新水位；同输入重试不重复提醒；合并后的 queued 只有一个待评估。
- 负控：无变化不唤醒；并发第二份执行被单飞拒绝；queued 不占单飞且 TTL 生效；额度耗尽不再调用模型且结果不提交；usage 缺失即失败；迟到结果因代次/水位/纠正/模型身份变化被丢弃；租约到期后迟到结果不能提交；暂停后不再下发；Node 崩溃/超时/租约丢失各有终态；模型 schema 外输出被拒。
- **能力负控**：协调装配下逐项调用被禁能力返回 `UNKNOWN_TOOL` 且无副作用；每项附正控；审批帧为零；通用网络出口不可达、模型 provider 端点可达；输入只按清单读取；读库断言 Task/Run 零变化。
- 变异：去掉单飞唯一索引、去掉提交 CAS、去掉网络白名单、放开一个工具行、允许协调帧写 decision，各观察一条红。
- 真实模型质量与费用在开发集/保留集分别评估（计划 §9.4），未跑保持 `not_run`。

### 11 不做什么

- 不启用常驻 Session、语义 Watchdog、推测执行或自动业务执行。
- 不向办公群发送消息，不代替成员发言，不自动创建 Run/followup/审批。
- 不跨项目扫描，不读取私人 Session/Workspace，不把共享长文当权限豁免。
- 不引入第二份 SQLite 作为团队状态权威，不在 Hub 直连模型。
- 不在能力隔离未验证时「先用提示词约束」上线。

### 12 后果与重新评估

- 若 rc.8 无法稳定禁用某个能力项，协调计算只能停在确定性路径；不得降低隔离要求。
- 若真实模型在 32k 输入内无法产生可用判断，先缩小输入与目标，不放开浏览器/Shell 等能力换质量。
- 若单飞与合并窗口导致理解延迟超出计划目标（p95 ≤60 秒），先调窗口与预算，不允许并发超 1 作为默认。
- 若团队不愿承担后台模型费用，保持 `autoExtraction=false` 与协调关闭，读面只显示确定性事实与缺口。

## 验证登记

本 ADR 是文档，不含机器证据。接受后由 PC-04 创建 `docs/agent/project-coordination-acceptance.md`，登记单飞/合并/额度/迟到/崩溃/恢复与逐能力正负控；PC-00 (#463) 的探针只证明机制，不等于本条交付。
