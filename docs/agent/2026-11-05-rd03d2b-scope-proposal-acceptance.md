# RD-03d2b 验收：authorize_scope 的草案 → 确认 → 新 Mandate 版本（#517）

- Issue：#517（母 #486 / RD-03d / M1R-A）
- 契约：ADR-0028 §7、§8、§17.3
- 前置：#515（ask 决策账本）、#520（Router 决定应用与 authorize_scope 问题生产）
- 日期：2026-11-05
- 状态：工程验收通过；不涉及真实模型，模型语义质量 `not_run`

## 1 本切片交付什么

本切片把「责任人回答扩权问题」接成完整流程：**回答只生成 pending 草案，确认才建立新 Mandate 版本**。它不改写 #515 的问题/回答账本，也不复用 #520 的提案应用幂等凭据。

### 1.1 数据与协议

- migration `0041_rd03d2b_scope_proposal.sql` 新增 `work_mandate_proposal`：
  - 一问一案（`question_id` 唯一）、一答一案（`answer_id` 唯一）；
  - 保存 `base_mandate_id/version`、principal、完整 scope JSON、`status`、`result_mandate_id`；
  - `status` 只允许 `pending/confirmed/superseded/expired/cancelled`，并用 check 约束钉住各状态的 `confirmed_at/closed_at/result_mandate_id` 组合。
- 同一 migration 放宽 `work_question_status_fields`：`superseded` 允许保留 `answered_at`，以支持「回答 → 待确认 → 确认后 superseded」。
- `WorkQuestionAnswerRequest` 新增可选 `scope`，直接复用 `CreateWorkMandateRequestSchema`（含默认值与上限）；非 `authorize_scope` 回答携带 `scope` 会被拒绝。
- 工作读面 `WorkDetail` 新增 `pendingMandateProposals`（只列当前责任人、pending）；回答响应新增 `scopeProposal`；新增确认响应 `{proposal, mandate, question}`。
- 新路由 `POST /works/:workKey/mandate-proposals/:proposalId/confirm`（Idempotency-Key）。

### 1.2 回答

`POST /works/:workKey/questions/:decisionId/answers` 对 `questionType='authorize_scope'`：

1. `choose_option` 降级仍返回 `UNSUPPORTED_ANSWER`；`deny`/`defer` 可正常绑定并关闭问题（不生成草案、不扩大 Mandate）；
2. 必须携带 `scope`，使用与创建 Mandate 相同字段/语义的 `WorkAuthorizeScopeRequestSchema` 解析；该 schema 不带默认值，避免只提交部分字段被静默补全成更宽授权；
3. 语义校验与创建 Mandate 共用 `assertMandateScope` / `assertAllowedAgents`：数组去重、草稿受众必须是本人、`expiresAt` 在未来、Agent 存在且非归档、非 `full_access`；
4. 当前 Mandate 版本/责任人/工作状态不匹配时，仍只落 `binding=false` 回答并 409 `DECISION_STALE`，不生成草案；
5. 通过后写 binding 回答 + pending 草案；**不更新 work.mandateId、不改变 inputDigest、不扩大当前 Mandate**；
6. 回答后问题先转 `answered`（不再出现在 `openQuestions`），确认后转 `superseded`；同一问题再次回答因不再 open 返回 409，不产生第二份草案（问题行锁 + Work 锁保证并发收敛）；
7. 若问题关联了旧派工意图（当前生产端不产生这种组合），回答会取消该意图，保证确认前旧意图不能派发。

### 1.3 确认

`confirm` 在 Task→Work→proposal 锁序下：

1. 仅 Task 当前 assignee；从未参与该问题的成员 403；已改派的旧责任人（principal）得到 409 `DECISION_STALE(assignee_changed)`；
2. assignment 必须 accepted、Task 非终态；
3. proposal 属于该 Work 且仍 `pending`；已确认的重复请求返回同一 Mandate 版本，不建第二版；
4. 主体验证：proposal.principal = 当前 actor、work.humanOwnerUserId = actor、work active；
5. 范围复验：存储的 scope 重新按 schema 解析，并重跑 `assertMandateScope` / `assertAllowedAgents`；Mandate 后 Agent 被归档等漂移落 `scope_invalid` / `scope_agents_changed`；
6. base 复验：`latest mandate` 必须仍是 proposal 的 base（id/version 一致）、work 指针一致、status active 且未过期；否则 `mandate_changed` / `mandate_inactive`；
7. 通过后在同一事务内建 `version=latest+1` 的 active Mandate（身份为当前 assignee）、更新 work.mandateId、取消旧 proposed 意图、撤回旧订阅，并把问题转 `superseded`、草案转 `confirmed` 且回填 `result_mandate_id`；
8. 任何 stale 失败都不生成新版本；已落库的草案/问题不自动解除阻塞，等待新的问题代次或人工处理。

### 1.4 旧草案收口

新 Mandate 版本（手工创建、承接工作、暂停/恢复/撤销）、工作退休、Task 终态/改派、Task 切到 `full_access` 都会把该 work 下仍 pending 的草案及其问题标为 `superseded`；确认路径用 `keepProposalId` 保留正在确认的一份。读面还额外只展示「work active + base 仍是当前 active 未过期版本」的草案，即使生命周期收口漏掉也不会显示成可确认。

### 1.5 审计

- 回答：`work.decision.scope_answer`，只记 workKey/decisionId/questionId/proposalId/baseMandateId/version。
- 确认：`work.decision.scope_confirm`（success/denied），只记 proposalId/decisionId/questionId/mandateId/version 与稳定 reason。
- scope 正文、Agent 列表、上限值都不进入审计；验收用例用唯一数值 `4242` 断言审计串不含它。

## 2 机器证据

### 2.1 集成用例

`apps/hub/tests/work-scope-proposal.integration.spec.ts`（18 项，生产 HTTP + 真实 PostgreSQL）：

1. `records a pending proposal without expanding the current mandate, then confirms one new version`：回答后 work 指针/版本不变、无新 Mandate、草案 pending、读面可见；确认后 version=2、问题 superseded、草案 confirmed、旧版本保留；同 key 与不同 key 重复确认都返回同一版本；审计不含 scope 数值。
2. `rejects wrong answer types, missing or invalid scope, and non-assignee actors`：`choose_option` 降级、缺 scope、重复数组、他人草稿受众、不存在的 Agent 均 400；跨成员回答/确认 403；同一问题第二次回答 409；未知 proposal 404。
3. `supersedes the pending proposal when a new mandate version appears, and refuses confirmation`：新版本建立后草案/问题 superseded，确认 409 `DECISION_STALE(proposal_superseded)`，不建第三版。
4. `refuses confirmation when the base mandate has expired`：base 过期后确认 409 `mandate_inactive`，不建新版本。
5. `refuses confirmation when the base mandate advanced without a pending supersede`：模拟崩溃/旧数据里仍 pending 的旧草案，确认 409 `mandate_changed`。
6. `refuses confirmation after the work is retired`：退休后草案收口，确认 409，不复活工作。
7. `returns DECISION_STALE to the reassigned owner and hides the proposal from the new assignee`：旧责任人确认得 `assignee_changed`；新 assignee 读面看不到旧草案；新责任人显式承接工作后草案 superseded。
8. `converges concurrent confirmations to exactly one new mandate version`：两个并发确认都成功返回同一 version=2，库中仅两条 Mandate。
9. `allows denying an authorization request without creating a proposal`：`deny` 回答正常绑定并关闭问题，但不生成草案、不改 Mandate；`choose_option` 仍被拒绝。
10. `reports a repeated confirmation as not current after a newer mandate version`：确认后再暂停产生 v3，重复确认（同 key 与不同 key）返回 v2 但 `current=false`，不误报当前授权。
11. `supersedes a pending proposal when the task becomes full_access`、12. `supersedes a pending proposal when the task reaches a terminal state`：Task 策略/终态生命周期收口草案，读面不再显示，确认不会创建 Mandate。
13. `refuses confirmation while the work is waiting`：work 非 active 时确认 409 `work_inactive`。
14. `refuses confirmation after the answered scope itself expires`：回答后草案自身过期，确认 409 `scope_invalid`。
15. `refuses confirmation when the task policy changed to full_access`：绕过生命周期收口的旧草案仍被确认入口拒绝（`task_policy_changed`）。
16. `converges concurrent same-key scope answers to one proposal`：同 key 并发回答都返回同一 answer/proposal，库中各一条。
17. `does not expose another member pending proposal in the work detail`：Task 已指向新成员但旧草案尚未被生命周期收口时，新成员的工作读面仍不显示旧草案。
18. `replays a pre-#517 answer receipt without a scopeProposal field`：旧裸视图回执重放返回 200，补 `scopeProposal: null`，不重复写回答。

`apps/hub/tests/router-application.integration.spec.ts` 的 ask 用例改为：「authorize_scope 问题只接受完整 scope 的 pending 草案，不接受缺 scope 或 choose_option 降级」，并断言不建 Run。

### 2.2 门与实际结果

| 门 | 结果（2026-11-05 本机 macOS） |
|---|---|
| Q0 `pnpm check` | 通过：format / lint（0 error）/ full typecheck / boundaries / protocol generated / plugin fixture / 2506 unit+web tests |
| Q2 `pnpm test:integration` | 973 passed（95 files；新增本切片 18 项 + #520 ask 用例更新） |
| Q7 安全 | 18 passed + secret-scan 自检/实扫 + license-check 通过 |
| Q3/Q6 | 未触发：无 DSH/Runtime/Node 改动 |
| Q5/Q8/Q9 | 未触发：无 Web/镜像/安装面改动 |

### 2.3 单点变异

`scripts/mutate-router-evaluation.ts` 增加 S01–S17（S03 随「回答即 answered」语义并入 S07，不单独保留），可用 `MUTATION_IDS=S01,...` 只跑本切片：

| ID | 判据 | 变异 |
|---|---|---|
| S01 | authorize_scope 回答必须携带 scope | 删除缺 scope 检查 |
| S02 | 扩权问题不能被降级成 choose_option | 关闭答案类型匹配检查 |
| S04 | 回答只生成 pending 草案 | 写入 confirmed |
| S05 | 只有当前 assignee 能确认 | 关闭 assignee 检查 |
| S06 | 确认要求 base Mandate 仍是当前版本 | 关闭 base 复核 |
| S07 | 确认把旧问题关闭为 superseded | 跳过 `markWorkQuestionSuperseded` |
| S08 | 新 Mandate 版本收口旧 pending 草案 | 删除 supersede 调用 |
| S09 | pending 草案只对当前责任人可见 | 删除 principal 过滤 |
| S10 | 工作读面暴露 pending 草案 | 读面恒返回空 |
| S11 | 重复确认返回同一版本 | 删除 confirmed 早返回 |
| S12 | 草案创建前校验 Agent | 跳过 `assertAllowedAgents` |
| S13 | 改派旧责任人得到 DECISION_STALE | 关闭 `assignee_changed` |
| S14 | base 过期不得确认 | 关闭 `mandate_inactive` |
| S15 | 确认重新校验回答的 scope | 跳过 confirm 的 `assertMandateScope` |
| S16 | full_access Task 不得确认 | 关闭 `task_policy_changed` |
| S17 | 确认要求 work active | 关闭 `work_inactive` |

结果：全量变异为 50 条（含本切片 16 条），全部 `killed`；基线前后通过、源码还原通过。见 `artifacts/evidence/router-evaluation/mutations/result.json`。

## 3 取证位置

- Hub：`component=hub.audit` 的 `work.decision.scope_answer`、`work.decision.scope_confirm`；DB `work_mandate_proposal`、`work_question`、`work_question_answer`、`work_mandate`、`work`。
- 集成用例：`apps/hub/tests/work-scope-proposal.integration.spec.ts`、`apps/hub/tests/router-application.integration.spec.ts`。
- 变异：`artifacts/evidence/router-evaluation/mutations/result.json`。

## 4 未覆盖与边界

- 确认后不自动触发 Router 重评；责任人随后续准入或显式入口重新评估（终态/到期自动调度归 #518）。
- `authorize_scope` 问题的生产仍只来自 #519/#520 的受限模型应用；本切片不产生问题，也不判断扩权是否语义合理。
- 回答阶段问题先 `answered`、确认后 `superseded`；`answered_at` 保留，读面用 `pendingMandateProposals` 表示“已答待确认”。
- 改派后旧草案对新 assignee 不可见；新 assignee 需先显式承接工作（RD-03d1），承接会收口旧草案。
- 草稿受众仍限同一责任人；跨成员草稿受众需后续 ADR。
- 草案自身 `scope.expiresAt` 过期后面上仍可能显示为 pending（读面只按 base Mandate 的 active/未过期过滤），确认会 fail-closed 为 `scope_invalid`；把过期草案自动转 `expired` 归后续调度切片。
- `proposal_invalid`、`scope_agents_changed`、`principal_changed`、`ASSIGNMENT_NOT_ACCEPTED`/`TASK_TERMINAL` 等防御分支有代码守卫但无逐条专门用例；当前生产入口不会在未触发前置守卫的情况下到达这些分支。
- 同 key 回执重放会按当前指针重渲染 `current`；若回放者已失去 assignee 身份，返回的仍是其本人历史草案/版本，不暴露新责任人数据。
- 真实模型质量、真实租户/平台与真人效率保持 `not_run`。
