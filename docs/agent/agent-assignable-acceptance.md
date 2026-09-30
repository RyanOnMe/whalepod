# Agent 可被指派（ADR-0009 切片⑦）验收

- 对应场景/门禁：Q0/Q1（本地已跑，`pnpm check` 1316 过）+ Q2（`agent-assign.integration.spec.ts` 6 用例已写，本地无 Docker 由 CI 必检项跑）
- 对应 Issue：#239（ADR-0009 决策 6；依赖 ④ #198 / ⑥ ADR-0010 形态，均已落地）
- 上次验证：2026-09-30 · `feat/p1-239-agent-assignable` · 结果 PASS（Q2 项待 CI）

## 验的是哪条用户路径

拆完任务直接指派给 Agent——「单人动线」不再有「指派完还要去执行区再发一句指令」的
空转：带 `assigneeAgentId` 建 Task（或 reassign 给 Agent），指派动作本身即一条
`origin='auto_assignment'` 的指令消息，经**同一条生产指令链**（sendInstruction）自动
建 Run。责任恒在人：`assignee_user_id` 落指派人（真人），Agent 只是执行者。

## 关键设计回放（为什么这么放）

- **`assignee_user_id` 保持 NOT NULL 恒真人**：Agent 指派时它 = 指派人（= 责任人）。
  设备归属解析（instruction-target）、`runs.owner_user_id` 固化、指令权第一分支
  （resolveInstructionRight）、0006 grant 触发器（granted_by = assignee）**全部零口径
  漂移**——它们读的「责任人」在 Agent 指派下语义连续。「责任在人」红线由列直接表达。
  多态只发生在展示层（`assignee_agent_id` 非空 → UI 显示 Agent 执行 + 真人责任人）。
- **Agent 出生 accepted**：Agent 没有受理动作，指派即受理（assignment 直接落 accepted）；
  accept/reject 端点对 Agent-task 恒 409（domain 状态机 accepted 态本就无 accept 边，
  命令层显式 409 是为了不给 500）。
- **自动驱动不做旁路**：`sendInstruction` 加 `origin` 参数（human | auto_assignment），
  判权/幂等/目标解析/降级全部复用；幂等键沿用指派请求的同一把 key——createTask/reassign
  的重放会命中 `run.create:<key>` 回执读回首次结果，不会二次驱动。
- **指令正文派生**：显式 `instruction`（reassign 可带）?? 任务标题 + 空行 + 描述。
- **驱动失败不谎报**：指派事务已提交（201 落定），驱动失败（如 DEVICE_OFFLINE）进响应
  `drive` 字段如实告知（与人发指令同口径：解析失败不落消息——不造一条注定 rejected 的账），
  UI toast「自动执行未开始，可在执行区手动发起」。

## 各层落点与判据

| 层 | 落点 | 判据 |
|---|---|---|
| protocol | CreateTask/Reassign `assigneeUserId` XOR `assigneeAgentId`（superRefine fail-closed，双带/双空 400）；reassign +`instruction` 可选；fixture ×2 + 负例 spec | `http-validation.spec.ts` 7 用例（含切片⑤ create-run 互斥的补课）+ roundtrip 170 |
| db | migration 0008 `task.assignee_agent_id`（可空 FK→agent；不加跨列 check——互斥由协议+命令层，理由写进 migration 注释）；NewTask/reassignTask 跟进（Agent 目标直接 accepted+acceptedAt） | Q2 落库断言 |
| domain | ASSIGNMENT_NEXT 注释固化「Agent 出生 accepted 不走人的受理」 | task.spec 新用例：accepted（Agent 出生态）对 accept/reject 无边 |
| hub | commands：createTask/reassign 多态目标 + `requireAssignableAgent`（存在且未归档）+ accept/reject 守卫；instruction.ts：`origin` 参数 + `agentAssignmentText`；routes：driveAgentAssignment（提交后驱动，错误映射进 drive 字段） | Q2 6 用例：出生 accepted/责任人=指派人/auto 消息经真实链锚定 Run（trigger_message_id ↔ run_id）/幂等同 Run 单消息/守卫（400×3、409×2）/reassign（403→200、责任人转移、显式 instruction 正文、Run 落新责任人设备）/两处 DEVICE_OFFLINE（task 仍建、drive 如实失败、零消息） |
| web | CreateTaskForm 候选含未归档 Agent（`agent:<id>` 前缀编码）+ 指派提示 + drive 结果 toast；TaskHeader「执行 Agent」格（useAgentName，与 RunLauncher 共享 agents 缓存）；AssignmentPanel Agent 分支（无 accept/reject）；InstructionList「指派自动驱动」标注 | `agent-assign.spec.tsx` 5 用例（含归档不进候选、提交体不带 assigneeUserId、不画 id） |
| 文档 | 03 §2.2（列+不变量改写，删「Agent 不能成为 assignee」的过渡注记）/§4（create/accept/reject/reassign 行）；CONTEXT.md Task/Assignment 词条 | 见对应小节 |

## 边界与未覆盖

- **「指派 → followup」分支不可达**：ADR-0009 决策 6 说有活跃 Run 时指派自动降级为
  followup——但 G2-05 守卫（reassign 拒绝活跃 Run）+ 创建路径天然无 Run，使该分支在
  assignment 入口不可达。sendInstruction 固有支持该降级，但**不写不可达用例**；若将来
  放开「活跃 Run 中改派 Agent」再补。
- Q2 六用例本地无 Docker 未跑——CI 必检项兜底，结果见 PR checks。
- Q5 e2e 未加 Agent 指派场景（本地无 Docker）；全链浏览器验证待 Q5 扩用例
  （ADR-0009 对⑦的 Q5 要求：@Agent 不误触发对成员指派同样适用——本片指派入口
  显式二选一，无误触发面）。
- crash window：指派事务提交后、自动驱动执行前 Hub 崩溃 → Task 已建、无指令无 Run。
  恢复路径：责任人（指派人）在执行区手动发指令（其指令权第一分支天然命中）；
  客户端同 key 重试也会补驱动（回放链路）。不引入补偿任务（出现窗口极小 + 有手动恢复）。
- Agent 被归档时已指派的 Task：既有守卫让后续指令/建 Run 失败（orchestrator 拒绝
  archived agent），UI 引导 reassign；无自动迁移。
- ADR-0009 决策 7 的「自动触发降级审批」在本片不出现（approval_policy 未落地=切片⑧，
  现状恒 approval_required 默认）——两片衔接点在⑧实现时回填。

## 复跑

```bash
pnpm check   # Q0+Q1（1316 用例）
pnpm exec vitest run --project web tests/agent-assign.spec.tsx   # 本片组件面
# Q2：pnpm test:integration -- agent-assign（需 Docker；CI 必检项同跑）
```
