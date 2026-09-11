---
status: proposed
---

# 0009 任务执行对话化：TaskSession 一等实体、Run 降级为执行区间、Agent 可指派、审批档位可配置

WhalePod 第一阶段的执行模型是「一次 Run = 一次 prompt = 一次性执行」：终态禁止复活（红线）、重跑只留血缘不继承上下文、对话是 Run 的内部细节而非产品实体。真实使用证明这个形态既不体现团队协作的便捷性，也牺牲了传统 agent 产品的核心能力（多轮对话、上下文连续）。本决策把任务执行模块重构为**对话式执行**：Task 持有持久会话线程，成员像聊天一样驱动 agent，而每一次发言仍产生一个有终态、带快照、可审计的执行区间。

## 背景

### 现状机制的实测（2026-09-11 复核，全部有代码锚点）

1. **Run 一次性**：`03-领域模型与运行协议.md` §3.2 状态机终态 `completed | failed | cancelled | lost` 禁止迁移；`rerun_of_run_id` 只是血缘标记（`orchestrator.ts:187-194` 只校验来源 Run 同 Task 且终态），新 Run 拿新 prompt 起**全新 DSH 会话**（`dshSessionIdOf(spec) = whalepod-run-<runId>`，`runtime-spec.ts:51`），上一轮对话上下文零继承。
2. **追问能力已铺好未接线**：`packages/protocol/src/runtime-wire.ts:83` 定义了 `run.followup`，`packages/runtime-dsh/src/bridge.ts` 的 case 会在同一 DSH 会话里追加一轮（`owner.followup(text)`）；但 `apps/hub/src` 没有任何路由暴露它，Web 端同样没有。
3. **会话续接有官方机制**：DSH 会话日志由 `dsh-session-persistence-jsonl` 持久化在设备上（per workspace）；`Session.fromRestore(id, seed, header)` / `create(id, { seed })` 用存储日志播种新会话，`session/end-seed` 标记事件区分历史与新事件（`dsh-session` lib/types 注释原文：「a resumed session's constructor seed is its full stored log」）。
4. **协作价值不显眼**：`CONTEXT.md` 把 `Agent assignment` / `Run owner` 列为 _Avoid_（责任必须在人），这与「责任在人」红线一致；但现状下「拆任务 → 人逐个发起 Run」把多 agent 编排的成本全压回人身上，单人使用时「成员 → agent」这一跳是纯开销。

### 为什么不推翻而是降级 Run

Run 状态机、审批闸门（ask-all 阻塞在 Runtime 执行路径）、终态裁决（Runtime 权威，ADR-0007）、事件账本与脱敏投影是第一阶段验证过的承重件，也是团队协作的安全价值本身。问题不在它们，在于**产品把「一次执行」当成了「一次对话」**。本决策保留全部执行语义，只把对话面提升为独立实体。

## 决策（2026-09-11 拍板：O1 对话式 + O2 可配置审批档 + O3-a 合并线程显式触发）

1. **新增一等实体 TaskSession（任务会话线程）**。每个 Task 有且只有一条持久会话线程，绑定该 Task 的 Workspace 与当前生效的 Agent Revision 快照链。Task Room 的讨论区与 agent 线程**合并为这一条线程**（O3-a）：成员留言、指令、agent 输出、执行卡（每次执行的状态/审批/取消入口）都在同一列按时间排列。

2. **Run 降级为「线程上的执行区间」**。每条**指令消息**创建一个 Run（沿用现有状态机、快照、幂等、血缘、终态语义，一个字不改）；线程里的纯讨论消息不产生任何执行。产品语义变化：
   - **活跃中追问**：Run 未终态时，新指令经 Hub 暴露的 `POST /runs/:id/followup` 走既有 `run.followup` 协议帧进入同一 DSH 会话（新增 Hub 路由与编排校验；协议层零改动）。
   - **终态后续跑**：新指令创建新 Run，Runtime 以 `fromRestore`/seed 接回该 Task 会话日志（同一 Workspace 上的 `whalepod-run-<上一Run>` 日志），`session/end-seed` 之后是新事件。旧 Run 一字不动——「终态禁止复活」红线保持，续的是**会话**不是 Run。
   - **会话归属规则**：TaskSession 锚定在「Task × Workspace」上；Workspace 变更（换设备）时线程仍在，新 Run 在新 Workspace 起新会话并以摘要注入上下文（fallback，等价 O1-b），摘要生成与脱敏走既有投影管线。

3. **指令必须显式（可控性规则，O3-a 成立的前提）**。
   - **默认不驱动**：线程消息只有显式 @Agent（或指令模式开关）才创建执行；其余消息永不触发。没有分类器，没有猜测。
   - **权限不降级**：执行主体恒为 Task 责任人的 Device 与 credential slot（触发者只是代发指令，审计记 `triggeredBy`）；审批仍归责任人；任何成员不能借线程让别人的凭据跑工具。
   - **上下文卫生**：agent 上下文默认只带指令消息与执行历史，人际讨论默认不进模型；引用消息可显式带入。
   - **审计链**：指令消息 ↔ Run 一一对应（`runs.trigger_message_id`），线程内 agent 输出挂在执行卡下。

4. **Agent 可被指派**。Assignment 的 assignee 放宽为「成员或 Agent」（`CONTEXT.md` 的 _Avoid_ 条目相应修订为「Run owner 仍为真人」——Run 的发起主体仍是人/指令触发者，Agent 只是执行者）：
   - assignee = Agent 时，指令（含指派时附带的任务描述）自动创建 Run，无需人再点一次；**任务验收不变**：`in_review → done` 仍必须真人显式完成（§3.1 不变）。
   - assignee = 成员时维持现状（人决定何时发指令）。

5. **审批档位可配置（O2）**。新增 `approval_policy`：`approval_required`（现状默认，每个敏感工具调用阻塞等审批）/ `full_access`（完全权限，Runtime 侧自动批准，等同 DSH 的权限预设）。层级：Agent Revision 带默认值 → Task 可覆盖 → Run 快照固化（`runs.approval_policy`，事后审计看到的就是当时生效的档位）。`full_access` 是显式签署的授权：创建/修改时二次确认文案 + Run 卡片与审计事件显著标记；凭据隔离、脱敏投影、事件账本不因档位改变而削弱。

6. **状态机与协议的改动面**。Task 状态机不变（§3.1）；Run 状态机不变（§3.2）——`run.followup` 只在 `running` / `waiting_approval` 受理，其余状态 409。协议新增：`run.followup` 的 Hub → Node 下行已在协议内，补 Hub HTTP/WS 面与 `run.resumed`（新 Run 携带 `resumeFromRunId` 与 seed 来源）事件；`runs` 表加 `trigger_message_id`、`approval_policy`、`resume_from_run_id`（与 `rerun_of_run_id` 并存：rerun 是**不带上下文重来**，resume 是**接着聊**，两者语义不同都保留）。TaskSession 不落新表——它由「Task × 当前 Workspace × 会话日志引用链」推导（`runs.resume_from_run_id` 链即线程）；若将来要线程级设置（如标题、固定指令）再立表，本次不发明。

## 后果

- **正向**：单人路径变快（拆完任务 @Agent 即走，追问接着上文）；多人协作第一次显形——A 拆任务 @Reviewer 自动跑，B 在同一线程追问，C 验收交付物，全部上下文、审批、凭据边界留在原位；传统 agent 产品的对话能力（多轮、上下文、随时打断追问）完整回归，且不牺牲任何已验证的安全语义。
- **代价与风险**：一，Runtime 侧 resume 需要实测验证 `fromRestore` 在长日志上的行为与耗时（最小验证先行：用 demo 设备跑两次 Run 验证 seed 接续与 `session/end-seed` 标记，不过测不上实现 PR）；二，审批档位给 `full_access` 开了「无人值守执行」的门，误配风险由快照固化 + 显著标记 + 审计事件承担，但这是**真实的放权**，安全评审必须过；三，合并线程让 Task Room 同时承载讨论与执行，UI 信息密度上升，消息类型（讨论/指令/执行卡）的视觉区分是硬需求；四，`runs` 表加列与 Assignment 多态是数据迁移，走既有 migration 纪律。
- **弃选**：O1-b（摘要注入起新会话）——上下文不完整，且「摘要由谁写、写成什么样」引入新的失真面，降级为换设备时的 fallback；O3-b（评论区/执行区分开）——安全感是假的，指令入口只是藏到另一个表单，控制面一条没少，还保住了「对话感为零」的现状；b 的并行形态（两个区并列）已在现状被证伪。Agent 全自动闭环（agent 自验收）——越过「责任在人」红线，不议。
- **后续（实现切片顺序建议）**：① resume 可行性探针（不涉模型，先验证机制）；② `run.followup` Hub 接线 + Web 追问输入（不动数据模型，先拿到「活跃中对话」）；③ resume 续跑（`resume_from_run_id` + seed）；④ 合并线程 UI（@触发 + 消息分型 + 执行卡）；⑤ Assignment 多态（Agent 可指派）；⑥ 审批档位。每片独立 PR，Q5 逐片扩用例（追问、续跑上下文命中、@触发不误触发、档位快照）。文档同步：`CONTEXT.md`、`03-领域模型与运行协议.md` §2.6/§3、`04-验收矩阵与测试策略.md` 的 Q5 范围随首片落地回填。
