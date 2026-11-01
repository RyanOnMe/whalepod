# ADR-0026：项目持续协调的生命周期、受限计算与成本

- 状态：提案（Proposed，#452，2026-11-01；评审稿）。接受前不启用任何后台模型提取或协调计算；本文件不是已采纳决定。
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
- **首次启用必须显式配置**：模型 Node、操作者成员、费用承担者、凭据槽、日额度（派发次数/token/费用三项）、并发（默认 1）、单次输入上限、超时与停机行为；缺一项即 `project_coordinator_state.enabled=false`。协调只处理同时满足「Project 协调已启用」且「该来源 `autoExtraction=true`」的来源；两个开关是 AND，不互相代替。

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

- `coordination_evaluation` 是协调工作的唯一任务身份（不是 Run）。关键字段：`id`、`projectId`、`inputDigest`、`status`、`attempt`、`deadlineAt`、`nodeId`、`leaseToken`、`leaseExpiresAt`、`supersedesId?`、`supersededById?`、`resultDigest?`、`failureCode?`、`modelStartedAt?`、`usage`（tokens/cost/provider/model）。
- **输入身份**：`inputDigest = hash(项目、输入条目与版本集合、每来源 authorizationGeneration 与权限水位、规则版本、处理器版本、模型 provider/model、纠正版本)`。任一变化都会产生新的 `inputDigest`，旧结果不得复用。
- **同输入幂等**：已有 `completed` 的同 `inputDigest` 评估直接复用其结果，不重复提醒；`failed` 可 `attempt+1` 重试，但不得复活 `cancelled/stale`。
- **单飞只约束执行**：部分唯一索引只覆盖 `status in ('dispatched','running')`；`queued` 不占单飞名额。派发前在同一事务复核：同 `inputDigest` 已 `completed` 则 `skipped(already_completed)`，不派发（合并后到完成前的竞态也走这条）。
- **队列合并**：同一 Project 已有一条 `queued` 时，由 `(projectId) WHERE status='queued'` 部分唯一索引保证至多一条。合并按以下顺序执行（同一事务）：
  1. 若已有同 `inputDigest` 的 `completed` 行：不合并，queued 行转 `skipped(already_completed)`；
  2. 否则 `UPDATE ... WHERE id=? AND status='queued' AND manifestVersion=?`，更新输入清单、重算 `inputDigest`、`manifestVersion+1`、`coalescedAt`；若新 `inputDigest` 已有历史行（任何终态，不只 `failed`），取 `attempt = maxAttempt+1` 避免 `(projectId, inputDigest, attempt)` 唯一冲突；
  3. 0 行（已被派发/取消）→ 若仍无 queued 则新建 queued，否则放弃。
  合并只对 `queued` 生效，派生到 `dispatched/running` 的行不可改。`queued` 有 `queuedAt/queueExpiresAt`；每次合并刷新 `queueExpiresAt = min(now+TTL, queuedAt+maxQueueLifetime)`（默认 TTL 10 分钟、总寿命 30 分钟），避免饿死。TTL sweeper 由 Hub 定时任务执行，转 `skipped(stale_queue)`。
- **failed 重试**：`failed` 新建行前按顺序检查：① 已有 queued → 把失败行标 `supersededBy` 指向 queued 并跳过（新 queued 已含更新输入）；② 同 `inputDigest` 已有 `dispatched/running` → **仍新建 queued（`attempt=maxAttempt+1`），不等待**：同 digest 的 running 成功时，该 queued 在派发前复核 `completed` 会 `skipped(already_completed)`；running 失败/取消时 queued 自然接上，不需要额外的终态 hook；③ 同 `inputDigest` 已有任意终态：`completed` 直接复用其结果，其余（failed/stale/cancelled/skipped）取 `maxAttempt+1` 新建，避免 `(projectId, inputDigest, attempt)` 唯一冲突。新建行同样先做 completed 检查。
- **状态迁移**（终态不可复活）：

| 从 | 到 | 触发 |
|---|---|---|
| — | queued | 触发器产生 |
| queued | dispatched | 选中 Node、写入 leaseToken 与 deadline |
| queued | skipped | 无相关变化 / TTL / 输入不可用 / already_completed / budget_exhausted |
| queued | cancelled | 成员暂停/撤销、项目归档、来源撤销 |
| dispatched | running | Node 首次心跳 |
| dispatched/running | completed | 结果提交通过 CAS 与围栏 |
| dispatched/running | failed | Node 崩溃、超时、额度、凭据不可用、usage 缺失 |
| dispatched/running | cancelled | 成员暂停/撤销、项目归档、来源撤销 |
| dispatched/running | stale | 提交时围栏不满足（代次/水位/纠正/模型身份） |
| failed | （新 attempt） | 同一评估 `attempt+1` 重新入队；终态行保留 |

`completed/cancelled/stale/skipped` 为终态，不可复活；`failed` 只能**新建一行** `attempt+1`，新行 `supersedesId` 指向失败行，失败行保留。

- **租约与孤儿**：Hub 下发时写 `leaseToken` 与有界租约（默认 120 秒，心跳续租）。Hub sweeper 以 `status in ('dispatched','running') AND leaseExpiresAt < now()` 为谓词 CAS 到 `failed(node_lost)`；重排为新 attempt。
- **取消**：成员暂停/撤销、来源撤销、项目归档时，Hub 取消 queued/dispatched/running 评估并通知 Node 终止子进程；迟到结果按 CAS 与围栏丢弃。
- **超时**：`deadlineAt` 到期由 Hub 判 `failed(timeout)`；Node 必须终止进程并清理临时目录。

### 4 受限计算：能力边界来自装配与逐项负控

- 协调计算运行在 Node 上的**独立受限 Runtime 进程**：独立 DSH_HOME、独立工作目录、无业务工具、无审批工具、无通用出站网络与外部发送。
- **允许面**只有：只读输入读取（清单白名单，语义同 `read_artifact_input`）与结构化结果输出（受 schema 约束的输出通道，不是业务工具）。
- **以工具名而不是 patch 行 id 做判据**：协调装配启动后枚举实际注册的工具名，只允许输入读取工具与结果通道；其余工具名必须不存在。`disabled` 行只负责让插件不挂载，验收看的是模型可调用的工具名集合。必须覆盖的已知行与模型工具名包括（实施时以 boot 清单为准，不以此表替代枚举）：`tool-bash → bash`、`tool-pwsh → pwsh`、`tool-fs → read/write/edit`、`tool-fs-search → glob/grep`、`tool-workflow → workflow`、`tool-str-replace-editor → str_replace_editor`、`tool-web → web_search/web_fetch`、`tool-jobs → job_output/job_list/job_kill`、`tool-skill → skill`、`tool-subagent → subagent`、`tool-subagent-fork → subagent_fork`、`tool-subagent-control → send_message/interrupt_agent`、`tool-subagent-list-agents → list_agents`、`tool-subagent-report → report`、`tool-todo → todo_write`、`tool-goal → goal/update_goal`、`tool-ralph → ralph`、`plan-mode → exit_plan_mode`，以及 Code Mode `run_code`。`tool-ask-user` 在当前 `dsh-base` 没有挂载行；若未来挂载，`ask_user_question` 必须进入清单。未挂载的工具不要求正控，但工具名清单判据仍要证明它不存在。
- **每个能力项要有正控 + 禁用负控**：正控证明该装配下该工具名确实存在且可执行（在探针专用 overlay 里临时启用），负控证明协调装配下调用返回 `UNKNOWN_TOOL` 且无副作用。只验证「不存在」不算证明 `disabled: true` 生效（PC-00 的教训）。`tool-workflow` 的 worker、`run_code`、subagent/fork 与沙箱升级各自是独立能力项，不能由 `tool-bash` 一行代表。平台相关行按平台矩阵处理（例如 `pwsh` 只在 Windows 装配里要求正控；macOS 以实际注册清单为准），但**工具名清单判据在每个平台都必须跑**。
- **审批面显式关闭**：协调 Runtime 不安装审批 answerer；在 **approval gate 之前**加路由 guard，对除允许面之外的一切调用直接拒绝，且**不产生 `approval.requested`**。探针在默认 `approval_required` 装配下断言审批帧为零。PC-00 已证明：`approval_required` 下未知工具仍会先进入审批门，`full_access` 只是让审批断言恒真；因此协调装配必须用「路由 guard + 无审批人」证明零打扰，不能默认 `full_access` 当作隔离证据。
- **不依赖 `ctx.tools.restrict()` 作为权限边界**：vendor README 明示它只是可见性组合；可以用它减少模型可见面，但不能作为唯一控制。
- **网络边界**：区分「工具出站网络禁用」与「模型 provider 出口白名单」。受限进程只允许访问配置的模型 provider 端点；通用 HTTP/浏览/外部发送全部不可用。网络隔离需要独立探针（例如尝试访问非白名单地址必须失败），不能只靠提示词。
- **模型凭据**：来自操作者配置的**协调专用凭据槽**（`scope='coordination'`），存 Node SecretStore；Hub 在下发前校验槽位 purpose/owner/billing，缺省拒绝。默认不使用成员个人模型额度。凭据缺失 → `failed(credential_unavailable)`，确定性事实不受影响。
- **输出结构**：固定 schema——`suggestions`（影响的 Task/Run、类型、置信度、引用）、`open_questions`、`possible_decisions`、`notes_on_gaps`。所有条目必须带 ADR-0025 的 citation；schema 外字段拒绝；没有 `decision/completed/approved` 写入口。

### 5 输入、结果提交与围栏

- 输入上限：单次最多 N 个 revision、M 字节、K 个 token（默认建议 32 条 / 256KiB / 32k token，实施时以配置固定）；超出部分显式列入未纳入清单，不静默截断。
- **输入交付**：Hub 在 `coordination.request` 中给清单与本次上限（`inputTokensEstimate/maxInputTokens/maxOutputTokens/maxCostMicros`）；Node 通过 `GET /api/v1/coordination/evaluations/:evaluationId/inputs/:entryId` 按条目下载正文（必须携带 `leaseToken` 与 `attempt` 鉴权），逐条校验 digest 与字节数，存 `coordination-home/<evaluationId>/inputs/`；任一不符即 `failed(input_digest_mismatch)`，不启动模型。**每次下载都复核当前 `authorizationGeneration`、权限状态与评估归属**（ADR-0025 §4 的读时判权）；request 之后被撤销/过期/撤回的条目返回 `denied`，评估转 `cancelled(source_unavailable)`，不下载、不启动模型。超过 `maxInputTokens` 时 Node 必须拒绝（`failed(input_too_large)`），不得截断后冒充同一输入；`inputTokensEstimate` 的估算器在实现中固定为保守上界，不交给调用方自由估计。协调 Node 与采集 Node 可以不同，下载鉴权按评估归属，不把正文暴露给无关 Node。
- **错误码分层**：`input_digest_mismatch`、`input_too_large`、`credential_unavailable`、`source_unavailable`、`usage_missing`、`over_budget` 先作为 `coordination_evaluation.failureCode` 的内部枚举；只有需要过 wire 的码才映射到 `ErrorCodeSchema`（实施时登记进 03 §10、fixtures 与对齐测试，落地前不声称已登记）。`credential_unavailable` 与现有 `MODEL_CREDENTIAL_UNAVAILABLE` 的映射在实施时明确，不直接把六个小写失败码塞进 wire `ErrorCode`。
- **派发前额度硬闸与预留**：Hub 在派发事务内检查 Project 与团队的「已用 + 已预留」call/token/cost；`calls` 明确定义为**派发次数**（每次进入 dispatched 计 1，含之后未启动模型的失败派发），不是 provider 模型调用数，读面文案写「派发次数」。token 预留 = **输入估算 + maxOutputTokens**（输入估算按输入清单与固定估算器计算，估算器必须是保守上界——按字节/最小 token 比加固定开销，或由 `coordination.request` 传 `maxInputTokens` 并要求 Node 在超过上限时拒绝（`failed(input_too_large)`），不得截断后冒充同一输入；估算超过剩余额度即不派发），不足即 `skipped(budget_exhausted)`，**不派发、不发生模型调用**。派发同一事务原子 `calls+1` 并预留 `reservedTokens`（输入估算 + 输出上限）与 `reservedCostMicros`，`coordination.request` 携带 `inputTokensEstimate/maxInputTokens/maxOutputTokens/maxCostMicros`，Node 不得越过输出与输入上限；单次调用是否允许越过日 token 上限由实现固定为「不允许」，否则 token 硬闸不成立。
- 结果帧携带 `evaluationId`、`attempt`、`leaseToken`、`resultDigest`、`usage`。
- 提交事务：
  1. 锁评估行；要求 `status in ('dispatched','running')`、`leaseToken` 一致、租约未过期；
  2. `authorizationGeneration` 与权限状态仍为可读；
  3. 输入水位未前进到评估未覆盖的版本；
  4. 纠正版本、规则/处理器/模型身份与 `inputDigest` 一致；
  5. 项目协调未暂停/归档；
  6. `usage` 存在且未越过派发时的上限。
  任一不满足 → CAS 到 `stale`/`failed` 并记原因；不得部分写入。
- 写入只追加 Inference 与引用；同 `inputDigest` 不重复追加条目。
- **计费与结果接受分离**：只有进入 `dispatched` 的评估才写账本；`queued` 直接 `skipped/cancelled` 的从未派发，不写账本（数据表约束同步表述为「派发必有 reserved，已派发终态必有 settled」）。派发事务写 `coordination_usage_ledger` 预留记录（`phase='reserved'`，usage 为空，按输入估算 + `maxOutputTokens` 与 `maxCostMicros` 预留），无论后续结果如何都保留。评估行记录 `modelStartedAt`：Node 必须在调用模型 provider **之前**通过 `coordination.heartbeat`（或等价的 `model_started` 上报）发出第一个值，Hub 只保留首次值；该字段是结算依据，不是模型已产生 token 的证明。终态在**独立已提交事务**追加 `phase='settled'`，规则固定为：
  1. `modelStartedAt IS NULL` 且终态属于**明确可证明未启动模型**的 `input_digest_mismatch`、`input_too_large`、`credential_unavailable`、`cancelled(source_unavailable)`（且取消发生在模型启动前）→ settle 为 0，不按预留上限多记；
  2. `modelStartedAt IS NULL` 且不属于档 1 的任何其它终态（`failed(node_lost)`、`failed(timeout)`、`failed(usage_missing)`、`completed`、`stale`、成员/项目取消、崩溃/孤儿等）→ **一律保守兜底**：有可信 `usage` 按实际，否则按 reserved 上限；禁止落 0；
  3. `modelStartedAt` 非空：有 `usage` 按实际结算（即使越过派发上限也记实际并标 `over_budget`，不能少记）；`usage` 缺失按 reserved 上限兜底。
  结算事务先 `INSERT ... ON CONFLICT (evaluationId, attempt, phase) DO NOTHING`，只有插入成功才在**同一事务**把 `coordination_budget` 的对应预留转实耗；ledger 与 budget 任一失败整体回滚，由 sweeper 重试，不得拆成两个事务。跨 UTC 日按 reserved 记录的 `utcDate` 结算，不按结算时刻的日期；settled 行的 `utcDate` 必须等于同 `(evaluationId, attempt)` reserved 行的 `utcDate`，用 DB CHECK 或统一写入逻辑钉死，不靠实现纪律。sweeper 扫描 `phase='reserved'` 且无对应 `settled`、且评估已终态或租约已过期的行，按上述规则在同一事务完成 ledger、budget 与评估标记。结果是否被接受与账本是否记账互不影响。派发后 Node 崩溃/不上报/持续 stale 都会消耗 call 与预留，下一次派发按「已用 + 已预留」受限。`failed` 重试每次重新计费。账本数据来自 Node 上报的 `usage` 与 Hub 的预留——只对诚实 Node 的记账与硬闸有效，provider 侧对账不在本轮；不得把 Hub 账本写成独立可验证的计费事实。

### 6 成本、额度与停机

- **费用归属**：启用时指定费用承担者；承担者必须是**已确认的成员或团队额度**（记录 `billingAcknowledgedAt`），不能由操作者单方面指定他人。个人额度不是默认值。
- **凭据槽**：`coordination_credential { nodeId, credentialSlot, scope='coordination', ownerMemberId, billingOwnerMemberId, billingAcknowledgedAt }`；Node inventory 的槽位增加可选 `purpose`，Hub 拒绝 purpose 不匹配的槽位。
- **额度**：策略上限（Project/团队）记录在 `project_coordinator_state` 与团队配置；已用量与当日余额记录在 `coordination_budget`，两处不重复：前者是策略，后者是账本/余额。`dailyCallLimit` 统计**派发次数**（含未启动模型的失败派发），不是 provider 模型调用数；读面文案写「派发次数」。支持 Project 日额度与团队日总额度（团队额度是外层上限，多 Project 不能叠加突破）；团队账本更新用行锁或原子 UPDATE。
- **耗尽行为**：停止新模型评估，确定性同步继续；读面标记「协调理解暂停（额度）」。额度恢复不自动补跑历史评估，只处理新的相关变化。
- **停机/暂停**：项目协调暂停、Node 离线、凭据不可用、模型限流分别有状态与文案；不把「模型没跑」显示成「项目没有变化」。
- **本地目录与日志清除**：协调 Runtime 的 DSH_HOME 不承担续跑，评估终态（completed/failed/cancelled/stale/skipped）后删除 `coordination-home/<evaluationId>/` 整棵目录（含 `inputs/`、session JSONL、spill 文件）。装配必须显式把 `spill-local.root`（或等价 spill 根）指到 `coordination-home/<evaluationId>/spill`，**不得落 OS tmpdir**；否则终态删除与零命中扫描会漏掉真正的正文副本（PC-00 核对 rc.8 默认 `mkdtemp(tmpdir()/dsh-spill-*)`）。Node 启动时清扫超过 24 小时的孤儿 `coordination-home/*`，运行期定时器每小时清扫一次；设备离线时清扫延迟到下次启动，读面显示「本地清理待完成」。协调输入正文不得在 Node 上长期留存。

### 7 数据草图（实施时以协议与 migration 为准）

| 表 | 关键字段 | 约束 |
|---|---|---|
| `project_coordinator_state` | `projectId`、`enabled`、`modelNodeId`、`operatorMemberId`、`billingOwnerMemberId`、`billingAcknowledgedAt`、`credentialSlot`、`rulesVersion`、`processorVersion`、`dailyCallLimit/dailyTokenLimit/dailyCostLimit`、`lastSuccessfulEvaluationId`、`pausedAt`、`pauseReason` | 每 Project 一行；配置变更写审计 |
| `coordination_credential` | §6 字段 | `(nodeId, credentialSlot)` 唯一；未确认的 billing owner 不能启用 |
| `coordination_evaluation` | §3 字段 + `queuedAt`、`queueExpiresAt`、`manifestVersion`、`coalescedAt?`、`modelStartedAt?`、`inputManifest`（不透明 id/digest/字节数） | `(projectId, inputDigest, attempt)` 唯一；`(projectId) WHERE status='queued'` 部分唯一；`(projectId) WHERE status in ('dispatched','running')` 部分唯一；`inputDigest` 至多一条 `completed`（部分唯一索引）；终态不可复活 |
| `coordination_budget` | `scope`（team/project）、`projectId?`、`utcDate`、`calls`、`inputTokens`、`outputTokens`、`costMicros`、`reservedTokens`（输入估算 + 输出上限）、`reservedCostMicros` | `(scope, projectId, utcDate)` 唯一（NULLS NOT DISTINCT）；上限在策略侧（`team_coordination_policy` + `project_coordinator_state`），账本记已用与预留 |
| `coordination_usage_ledger` | `evaluationId`、`attempt`、`phase`（reserved/settled）、`usage`（settled 前为空）、`utcDate`（reserved 时固定）、`chargedAt`、`outcome` | append-only；`(evaluationId, attempt, phase)` 唯一；仅 dispatched/running 派发必有 reserved，已派发终态必有 settled；queued 终态不记账；settled 插入成功后同事务更新预算 |
| `team_coordination_policy` | `teamId`、`dailyCallLimit/dailyTokenLimit/dailyCostLimit`、`updatedAt` | 每 Team 一行；团队外层上限 |
| `coordination_audit_event` | `id`、`projectId`、`evaluationId?`、`event`、`actor`、`reason`、`createdAt`、`payload` | 不含正文、平台名称、成员姓名 |

### 8 协议与 Node 装配

- `node.hello` 增加可选 `coordinationCapabilities: ['coordination.v1']`；Hub 只向声明能力的 Node 下发协调帧，旧 Node 不收到未知帧。部署顺序沿用 ADR-0024 §9（先 Hub 后 Node；旧 Hub 拒绝带新字段的 hello）。
- 新增 Hub↔Node 协调帧（不是进程内本地帧）：`coordination.request`（评估 id、attempt、leaseToken、项目、输入清单、`inputTokensEstimate/maxInputTokens/maxOutputTokens/maxCostMicros`、截止时间）、`coordination.result`（结果 + digest + 代次/水位 + usage + evaluationId/attempt/leaseToken）、`coordination.cancel`、`coordination.heartbeat`（含首次 `modelStartedAt`；Node 在调用 provider 前必须先发一次）。载荷不含凭据与绝对路径。Runtime 与 Node 之间的 `runtime.context_receipt` 是另一类本地帧（ADR-0027）。
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
- **账本与清理负控**：queued 直接失败/取消不写账本；派发后明确未启动模型的终态 settle 0，但 `calls` 保持 1（按「派发次数」口径）；模型已调用但 `modelStartedAt` 未上报即崩溃/孤儿 → 必须按 reserved 兜底，不得落 0；派发后 `input_digest_mismatch` → token/cost 为 0、calls 为 1；`input_too_large` → token/cost 为 0、calls 为 1；`node_lost` 且 `modelStartedAt IS NULL` → calls 为 1、token/cost 按 reserved 兜底；`usage > reserved` → ledger 记实际、结果拒绝、下一次派发被阻塞；派发后崩溃/孤儿由 sweeper 结算且预算预留转实耗，重复结算不重复计入；正文超过 spill 阈值（例如 >50KB）必须落在 `coordination-home/<evaluationId>/spill`，终态后整棵目录删除并按原文片段/digest 零命中（落 OS tmpdir 时判据必须红）；首次删除失败后定时器重试至零命中。
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
