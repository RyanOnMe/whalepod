---
status: proposed
---

# 0009 任务执行对话化：TaskSession 一等实体、Run 降级为执行区间、Agent 可指派、审批档位可配置

WhalePod 第一阶段的执行模型是「一次 Run = 一次 prompt = 一次性执行」：终态禁止复活（红线）、重跑只留血缘不继承上下文、对话是 Run 的内部细节而非产品实体。真实使用证明这个形态既不体现团队协作的便捷性，也牺牲了传统 agent 产品的核心能力（多轮对话、上下文连续）。本决策把任务执行模块重构为**对话式执行**：Task 持有持久会话线程，成员像聊天一样驱动 agent，而每一次发言仍产生一个有终态、带快照、可审计的执行区间。

## 背景

### 现状机制的实测（2026-09-11 复核，全部有代码锚点）

1. **Run 一次性**：`03-领域模型与运行协议.md` §3.2 状态机终态 `completed | failed | cancelled | lost` 禁止迁移；`rerun_of_run_id` 只是血缘标记（`orchestrator.ts:187-194` 只校验来源 Run 同 Task 且终态），新 Run 拿新 prompt 起**全新 DSH 会话**（`dshSessionIdOf(spec) = whalepod-run-<runId>`，`runtime-spec.ts:51`），上一轮对话上下文零继承。
2. **追问能力只铺到 Node↔Runtime 这一段**：`run.followup` 定义在 `packages/protocol/src/runtime-wire.ts:83`（`{runId, text}`，**没有触发者字段**），`packages/runtime-dsh/src/bridge.ts:339-340` 收到即在同一 DSH 会话追加一轮（`owner.followup(text)`）。但 **Hub→Node 下行全集 `NodeDownstreamSchema`（`node-wire.ts:313-321`）里没有这一帧**（03 §6.3 同样没有），`apps/hub/src` 也没有任何 followup 路由——所以"接线"实际包含一次**协议变更**，不是零成本（见决策 3、8）。
3. **会话续接有官方机制**：DSH 会话日志由 `dsh-session-persistence-jsonl` 持久化在设备上（按 `meta.cwd` 分目录，per workspace 成立）；`Session.fromRestore(id, seed, header)` 与 store 层 `SessionStore.create(id, options)`（`options.seed`）用存储日志播种新会话，`session/end-seed` 标记事件区分历史与新事件（`dsh-session` lib/types 注释原文：「a resumed session's constructor seed is its full stored log」；注意静态 `Session.create` 是**位置参数**，记法别混）。`dsh-agent` 侧 `CreateAgentOptions.seed` + `meta.parentSession` 已支持续接——探针可行性有底，但**尚未在 WhalePod 的 Runtime 里实测**。
4. **协作价值不显眼**：`CONTEXT.md` 把 `Agent assignment` / `Run owner` 列为 _Avoid_（责任必须在人），这与「责任在人」红线一致；但现状下「拆任务 → 人逐个发起 Run」把多 agent 编排的成本全压回人身上，单人使用时「成员 → agent」这一跳是纯开销。

### 为什么不推翻而是降级 Run

Run 状态机、审批闸门（ask-all 阻塞在 Runtime 执行路径）、终态裁决（Runtime 权威，ADR-0007）、事件账本与脱敏投影是第一阶段验证过的承重件，也是团队协作的安全价值本身。问题不在它们，在于**产品把「一次执行」当成了「一次对话」**。本决策保留全部执行语义，只把对话面提升为独立实体。

## 决策（2026-09-11 拍板：O1 对话式 + O2 可配置审批档 + O3-a 合并线程显式触发）

1. **新增一等实体 TaskSession（任务会话线程）**。每个 Task 有且只有一条持久线程，锚定「Task × 当前 Workspace」。Task Room 的讨论区与 agent 线程**合并为这一条线程**（O3-a）：成员留言、指令、agent 输出、执行卡（每次执行的状态/审批/取消入口）在同一列按时间排列。

2. **线程消息落库（新实体 `task_message` 承载，不新立 TaskSession 表）**。`task_comment`（§2.2）只是人际评论，缺三样：消息类型、驱动关系、被谁授权。故线程消息统一走**扩展后的消息实体**（字段：`id / task_id / author_user_id / kind(discussion|instruction|followup) / body / target_agent_id nullable / run_id nullable / instruction_state / created_at / edited_at`），由 `task_comment` 迁移而来（同一张表的升级，不是并列两张）。它是审计链的锚点：**每条指令消息必然指向一个 `run_id`**——要么它创建了那个 Run，要么它是那个活跃 Run 的追问。线程展示 = 该 Task 的消息流按时间归并（含 Run 事件投影），不靠链式推导。

3. **Run 降级为「线程上的执行区间」**。指令消息创建 Run（沿用现有状态机、快照、幂等、血缘、终态语义，一个字不改）；讨论消息不产生任何执行。产品语义：
   - **活跃中追问**：Run 非终态时，指令消息不建新 Run，而是成为该 Run 的 followup，经 `POST /runs/:id/followup` 下发。**成本要说清：这不是"协议层零改动"**——`run.followup` 只存在于 Node↔Runtime 的本地 stdin wire（`runtime-wire.ts:83`），Hub→Node 下行全集 `NodeDownstreamSchema`（`node-wire.ts:313-321`）里**没有**这一帧。切片②的真实成本 = node-wire 加帧 + schema/fixture 生成 + Node run-manager 分发到 Runtime stdin + 受理 ack 语义。
   - **终态后续跑**：新指令创建新 Run，Runtime 以 seed/`fromRestore` 接回该 Task 会话日志（同一 Workspace 上的 `whalepod-run-<上一Run>`），`session/end-seed` 之后是新事件。旧 Run 一字不动——「终态禁止复活」红线保持，续的是**会话**不是 Run。
   - **换 Workspace 的 fallback**：线程仍在，新 Run 在新 Workspace 起新会话并以摘要注入上下文（原 O1-b 降级为 fallback）。摘要器是新组件（现行投影管线只有确定性脱敏，没有摘要器——本 ADR 不谎称现成）：该 Run 的执行卡必须带**可见标记**（「上下文经摘要接续」），不许静默降级。
   - **受理即落账（消竞态）**：指令消息先落 `instruction_state=pending`，Hub 向 Node 下发后按受理结果落 `accepted | rejected`；Run 进入终态时仍在 `pending` 的指令一律落 `rejected(run_terminal)`。**不存在"已受理、零痕迹、未执行"**——这是审计规则四的机器判据。

4. **指令必须显式，且授权模型说清楚（可控性规则）**。
   - **默认不驱动**：线程消息只有显式 @Agent 才成为 `kind=instruction`；其余一律 `discussion`，永不触发执行。没有分类器，没有猜测。
   - **谁可以发指令（新守卫，替代现行两条不变量）**：现行实现是「只有 Task 责任人能建 Run」（`orchestrator.ts:130-132`）+「Device 必须属于操作者」（`orchestrator.ts:166-168`）。本决策**显式改写这两条**为：
     - **执行主体不变量（不放宽）**：Run 的 Device、Workspace、credential slot 恒为 **Task 责任人的**——这条比现状更严（现状是「操作者 = 责任人」隐含同一人），任何成员都不能让别人的凭据跑工具。
     - **指令权（新）**：默认仅责任人可发指令；责任人可在 Task 上把指令权**显式授予**具体成员（`task_instruction_grant`，一条 Task 一张授权名单）。未授权成员的 @ 一律落 `discussion` 并在 UI 提示「无指令权」。触发者恒记 `triggered_by_user_id`。
     - **审批权不变**：仍归 Run owner（= 责任人）。
   - **上下文卫生**：agent 上下文默认只带该 Task 的指令消息与执行历史；`discussion` 消息不进模型，引用消息可显式带入。
   - **审计链**：见第 2 条（消息 ↔ Run 的指向关系 + `instruction_state` 收敛）。

5. **并发语义（多人同时 @ 同一 Task）**。
   - 建 Run 沿用唯一的活跃约束（`run_one_active_per_task`）：**指令到达时若该 Task 已有非终态 Run，该指令自动降级为该 Run 的 followup**（不建新 Run、不 409），这是对话式下的自然语义——"接着说"永远成立。
   - 消除 check-to-act 竞态：降级判定与 followup 落库在**同一事务**内按「SELECT … FOR UPDATE 活跃 Run」执行；Run 恰好在此刻终态时事务重试，退化为建新 Run（resume）。
   - `waiting_approval` 期间到达的指令：**排队不丢**。Hub 侧落 `instruction_state=pending` 并在 Run 回到 `running` 后下发；Node 侧不得在审批阻塞中把追问塞进执行路径。
   - **终态竞态（评审指出的真实危险）**：Node 在首个 `run.completed` 即 finalize + `runtime.shutdown`（`run-manager.ts:723-728 / 830-844`），在途追问会被连同 Runtime 一起拆掉。规则：Hub 只对**非终态且已 ack 过 start** 的 Run 下发 followup；Node 收到 followup 时若 Run 已 finalize，回**受理失败**（新增 followup ack），Hub 据此把该指令落 `rejected(run_terminal)` 并提示用户「上一轮已结束，已改为新回合」——由 UI 引导改为 resume 新 Run。

6. **Agent 可被指派**。Assignment 的 assignee 放宽为「成员或 Agent」（`CONTEXT.md` 的 _Avoid_ 条目相应修订：「Run 的发起主体/审批主体仍是真人，Agent 只是执行者」）：
   - assignee = Agent 时，指派动作本身即一条 `kind=instruction` 的消息，自动创建 Run（无活跃 Run）或 followup（有活跃 Run）；无需人再点一次。
   - **验收不变**：`in_review → done` 仍必须真人显式完成（§3.1 不变）。
   - assignee = 成员时维持第 4 条的指令权模型。

7. **审批档位可配置（O2）**。新增 `approval_policy`：`approval_required`（现状默认）/ `full_access`（完全权限，Runtime 自动批准，等同 DSH 权限预设）。
   - **解析与快照**：Agent Revision 带默认（非空）→ Task 覆盖（**nullable，NULL = 继承，不物化**）→ 建 Run 时**解析成具体档位并写 `runs.approval_policy`**。因此"Revision 更新后 Task 跟不跟"有唯一答案：未覆盖的 Task **跟**（每次建 Run 重新解析），已覆盖的不跟（Task 值优先）。
   - **谁可设置**：Task 级覆盖由 Task 责任人设置（他是凭据所有者，档位放松的是他的凭据风险）。
   - **自动触发的降级规则**：assignee = Agent 的自动 Run 若解析结果为 `full_access`，**不得静默生效**——降级为 `approval_required` 并在执行卡标注原因（"自动触发不放行完全权限"）；要完全权限必须有人当场发指令。
   - **下传路径（成本列明）**：Runtime 姿态在 agent 创建时固化（`session-owner.ts:106-111`），按 Run 配档位需给 `runtime.initialize` 加字段——**这又是一处 runtime-wire 协议变更**，与切片②的 node-wire 变更同性质，不得再被漏算。
   - `full_access` 是显式放权：二次确认 + Run 卡片与审计事件显著标记；凭据隔离、脱敏投影、事件账本不因档位而削弱。

8. **状态机与数据改动面汇总**。Task 状态机不变（§3.1）；Run 状态机不变（§3.2）——followup 只在 `running` 受理，`waiting_approval` 排队，其余状态受理失败。数据：`task_comment` 升级为 `task_message`（加 `kind / target_agent_id / run_id / instruction_state / triggered_by_user_id`）；新表 `task_instruction_grant`（Task 指令权授权名单）；`runs` 加 `approval_policy`、`resume_from_run_id`、`trigger_message_id`（与 `rerun_of_run_id` 并存：rerun 是**不带上下文重来**，resume 是**接着聊**）。协议：node-wire 加 followup 下行帧与受理 ack；runtime-wire 的 `runtime.initialize` 加审批档位字段；Hub 侧新增 `POST /runs/:id/followup`、`POST /tasks/:id/messages`、授权名单读写，以及 `run.resumed` 事件。线程**不落新表**（由 `task_message` 的消息流承载，含 `run_id` 指向），线程级设置（标题、固定指令）将来若要再立表，本次不发明。

## 后果

- **正向**：单人路径变快（拆完任务 @Agent 即走，追问接着上文）；多人协作第一次显形——A 拆任务 @Reviewer 自动跑，B（被授权后）在同一线程追问，C 验收交付物，上下文、审批、凭据边界留在原位；传统 agent 产品的对话能力（多轮、上下文、随时打断追问）回归，且不牺牲任何已验证的安全语义。
- **代价与风险**：一，**两处协议变更**（node-wire followup 下行 + runtime-wire 审批档位）意味着 Q3 契约门要同步扩，成本高于"接线"量级——这是评审纠正后的诚实估计；二，resume 需要实测：`fromRestore` 在长日志上的行为与耗时，**以及逐次 resume 全量历史以新 session id 重新持久化带来的近平方存储增长**（并入探针项）；三，`full_access` 是真实的放权，无人值守执行的风险由快照固化 + 自动触发降级 + 显著标记承担，安全评审必须过；四，合并线程让 Task Room 同时承载讨论与执行，消息分型（讨论/指令/followup/执行卡）的视觉区分是硬需求；五，`task_comment` → `task_message` 是**表结构升级 + 数据迁移**（不是加列），走既有 migration 纪律并保留回滚路径。
- **弃选**：O1-b（摘要注入起新会话）——上下文不完整且引入新的失真面，降级为换 Workspace 的 fallback（带可见标记）；O3-b（讨论区/执行区分开）——安全感是假的，指令入口只是藏到另一个表单，控制面一条没少，还保住「对话感为零」的现状；Agent 全自动闭环（agent 自验收）——越过「责任在人」红线，不议。
- **后续（实现切片顺序，含依赖）**：① resume 可行性探针（不涉模型；同时验长日志耗时与存储增长）；② **协议先行**：node-wire followup 下行帧 + 受理 ack + Node 分发（含 Q3 契约门扩用例）；③ Hub 接线：`POST /runs/:id/followup` + 消息实体升级（`task_message`，含 `instruction_state` 落账）——**②③ 是"活跃中对话"的最小可交付，②之前拿不到**；④ 授权模型（`task_instruction_grant` + 指令权守卫改写）；⑤ resume 续跑（`resume_from_run_id` + seed）；⑥ 合并线程 UI（@触发 + 消息分型 + 执行卡，依赖 ③④）；⑦ Assignment 多态（Agent 可指派，依赖 ④⑥）；⑧ 审批档位（含 runtime-wire 变更 + 自动触发降级规则）。每片独立 PR，Q5 逐片扩用例（追问受理/终态竞态、续跑上下文命中、@不误触发、越权指令被拒、档位快照与自动降级）。文档同步：`CONTEXT.md`、`03-领域模型与运行协议.md` §2.2/§2.6/§3/§6、`04-验收矩阵与测试策略.md` 的 Q3/Q5 范围随对应切片回填。
