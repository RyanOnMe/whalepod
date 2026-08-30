# 一次性 Approval 闭环验收

- 对应场景/门禁：G5-01..07（04 §4）；Q0 / Q2
- 对应 Issue：#18（P1-14）
- 上次验证：2026-08-28 · feat/p1-14-approval-loop · 结果 PASS（Q0 单测+web 769、Q2 集成 230，含本链路新增 14 例 + 全链路 1 例）

## 验的是哪条用户路径

Bob 的 Run 里 DSH 工具触发高风险动作 → Task Room 出现 Approval 卡（工具/原因/脱敏
preview/有效期），成员只见「等待责任人批准」→ Bob（Run owner）点「批准一次」或「拒绝」
→ Hub 校验 owner-only、一次性（first-wins）→ approval.decide 命令经 Outbox 到 Node、
stdin 进 Runtime，DSH 挂起的审批以决定收口，工具继续或失败、Run 继续 → 不处理则到期
自动过期（等价拒绝）；Run 被取消则 pending Approval 一并 cancelled。

## 驱动

- HTTP 决策面（真人同一路径）：`POST /api/v1/approvals/:approvalId/decisions`，
  Fastify inject 驱动
  （apps/hub/tests/approval-decision.integration.spec.ts，13 例）：
  G5-02/03/04 决策与权限、重复幂等、冲突 409、G5-06 并发、G5-05 决策面过期、
  过期清扫、多 pending 剩余语义、401/404 形态。
- Orchestrator 深模块：过期清扫 `expireApprovals`、取消联动（cancelRunInTransaction）、
  Node decided 回显幂等（R6 变体），同文件后两个 describe。
- **全链路**（apps/node/tests/integration/run-projection-chain.integration.spec.ts
  新增 1 例）：真 Hub（buildApp+listen+真 PG+真 OutboxWorker）⇄ 真 Node 会话
  ⇄ 真 Runtime 子进程（DSH replay overlay，tool-approval fixture），双 Browser WS，
  无一环 mock——owner 决策后 publish_artifact 真的跑通（tool.finished succeeded）。
- Web 卡片（用户视角，mock 仅 HTTP 层）：apps/web/tests/approval-card.spec.tsx 5 例
  （owner 完整卡+双按钮、成员等待态、批准提交载荷与状态翻转、冲突显式报错、空态）。

## 观测

- 结构化事实落在 PG 表：`approval` 行（status/decided_by/decided_at）、
  `dispatch_outbox`（approval.decide 命令与 ack）、`run_event`（approval.requested /
  approval.decided 双受众行）、`team_events`（approval.changed / run.changed，payload
  含 taskId 供 Browser 按 Task Room 失效查询）。
- Run 状态机迁移经 domain `transitionRun`：waiting_approval ↔ running，终态禁复活。

## 判定（G5 逐条）

| 场景 | 判据与证据位置 |
|---|---|
| G5-01 卡双受众 | 全链路：owner 帧流含带正文的 approval.requested；member 帧流零 reason 正文、只有 reason='' 收缩卡与 approval.changed；`approval` 行 reason/preview 为脱敏全量（chain spec 断言 callId/preview 与 tool/call 参数同源） |
| G5-02 owner-only | 团队 Owner 角色对 Bob 的 Approval 决策 → 403 FORBIDDEN，行保持 pending，无 decide 命令（HTTP 例 + 深模块例双覆盖） |
| G5-03 allowed_once | 200 + 行 allowed_once + decided_by=owner + outbox approval.decide(callId) 被 Node ack + Run 回 running + tool.finished succeeded（全链路：publish_artifact 真执行、run completed） |
| G5-04 rejected | 行 rejected + decide(rejected) 命令入队 + Run 回 running；Runtime 侧「拒绝=失败 tool result、Run 可继续」由 Q3 approval 契约探针既有覆盖（本次未改 runtime-dsh） |
| G5-05 过期 | 决策面：过期后 allow → 409 APPROVAL_EXPIRED，行保持 pending；清扫面：`expireApprovals` 把到期 pending 写 expired、派发 decide(rejected)（等价拒绝解除 Runtime 阻塞）、Run 回 running、重复清扫幂等；多 pending 时只清到期者，剩余维持 waiting_approval |
| G5-06 并发 first-wins | Promise.all 并发 allow+reject → 恰一 200 一 409 APPROVAL_ALREADY_DECIDED，终态与胜者一致，命令/事件各恰一条（行锁 + 领域 decideApproval） |
| G5-07 取消联动 | 取消 waiting_approval Run → pending Approval 全部 cancelled（decided_by=owner）+ approval.changed，run.cancel 入队且无 approval.decide；Runtime 退出由既有取消链路（Runtime cancel→run.cancelled）覆盖 |

## 归因（失败先看哪层）

- 决策 4xx 语义错 → hub.domain（decide.ts 的 first-wins/过期门）。
- 命令没到 Node → hub.outbox（dispatch_outbox 行 acked_at）→ node.gateway。
- 决定不生效/Run 不回 running → node.supervisor→runtime.bridge（stdin approval.decide、
  ApprovalPort 收口）与 hub.domain（approval_closed 剩余 pending 计数）。
- 卡片不刷新 → hub.ws 扇出 payload（approval.changed.taskId）→ web event-router 失效键。

## 边界与未覆盖

- 已知 #52（waiting_approval→completed 乱序事件 fail-closed 断连）不在本 Issue 修复；
  本链路测试序列均先回 running 再 completed，不依赖该毒路径。
- `artifact.candidate` 投影/落库是 P1-15 交付：全链路用 tool.finished succeeded 作
  「工具继续执行」证据，不断言 artifact 事件。
- Q3（test:dsh-contract）本次未跑：未改 packages/runtime-dsh 与 apps/runtime；approval
  的 Runtime 侧拦截/决定语义由既有 Q3 探针锁定（allowed-once / rejected 两例）。
- 真实 10 分钟等待不可测：过期以「expires_at 已成过去 + 时钟真实推进」驱动，与
  FakeClock 推进语义等价（同一 expireApprovals 入口）。
- E2E（Q5）形态留 P1-19；本 Issue 以 jsdom 用户视角 + 双 WS 帧流 diff 覆盖同一行为。

## 复跑

```bash
# Hub 决策面/清扫/取消联动/回显幂等（真 PG 一次性容器）
pnpm test:integration approval-decision
# 全链路（真 Hub + 真 Node + 真 Runtime replay；G5-01/G5-03 闭环）
pnpm test:integration run-projection-chain
# Web 审批卡
pnpm vitest run --project web tests/approval-card.spec.tsx
# 静态门 + 单元 + web 全量
pnpm check
```
