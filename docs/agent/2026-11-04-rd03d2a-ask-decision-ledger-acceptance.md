# RD-03d2a：ask/decisionId 决策账本与回答绑定验收（ADR-0028 §8）

- 对应场景/门禁：Q0 / Q2
- 对应 Issue：#515（母 #486；前置 RD-03b #507、RD-03d1 #513）
- 上次验证：2026-11-04 · 分支 `feat/p1-515-rd03d2a-ask-ledger` · PASS

本切片边界：只做 `ask` 的确定性生成（自动派工无合格候选）、`decisionId` 合并、`choose_option`/`deny`/`defer` 的绑定回答与 non-binding 记录。`authorize_scope`、模型 Router 生成 ask、Run 终态自动下一 Run、跨成员草稿受众未做。

## 1 验的是哪条用户路径

Task 责任人：

1. 在已有 Task 上创建 work 与 `autoDispatch='existing_task'` 的 Mandate；
2. 一个新 Task 消息触发工作准入，自动派工找不到合格候选（本切片用空 Agent allowlist 构造）；
3. Hub 生成一个带 `decisionId` 的 open 问题，WorkDetail 的 `openQuestions` 对该 assignee 可见；
4. 同一来源重复准入不会产生第二个 open 问题；
5. assignee 对问题回答 `choose_option`（`retry`/`cancel`）、`deny` 或 `defer`；
6. 当前 Mandate 的 id/version 匹配时回答绑定、问题关闭；版本变化/暂停后旧回答只记录为 non-binding，问题保持 open。

## 2 驱动与证据

- 生产 HTTP：`POST /tasks/:taskId/works` → `POST /works/:workKey/mandates` → `POST /tasks/:taskId/comments` → `POST /works/:workKey/admission-checks`（自动派工无候选）→ `GET /works/:workKey` → `POST /works/:workKey/questions/:decisionId/answers`。
- DB：`work_question`（decisionId/status/options/mandateId/version/principal、`dispatch_intent_id`）、`work_question_answer`（binding/rejectionReason）、`dispatch_intent`（retry/cancel/deny 后的 cancelled 与 resolutionReason）。
- 判据文件：`apps/hub/tests/work-mandate.integration.spec.ts`（RD-03d2a describe，6 项：deterministic retry、版本变化 stale、暂停 stale、defer、deny、autoDispatch off 不提问）。
- 观测：HTTP 审计 `work.decision.answer` 带 `{workKey, decisionId, questionId, answerType, binding}`；问题摘要/refs 不含 Task 讨论正文。

## 3 判定

- **生成**：无候选自动派工后 `openQuestions` 恰有 1 条；`decisionId` 等于 `sha256(canonicalJson({workKey, blockedDecision:'dispatch', inputDigest, mandateVersion, questionType:'choose_option'}))`；`principalUserId`=assignee、`mandateId/version`=当前 Mandate、`dispatchIntentId`=关联 proposed 意图；`options` 固定 `retry`/`cancel`，推荐 `retry`。
- **合并**：同一来源用新幂等键重复准入后仍只有 1 条 open；已回答/已 defer 的同一决定不因重复准入重新开问。
- **不误问**：`autoDispatch='off'` 时 proposed 意图存在但 `openQuestions` 为空。
- **主体/参数**：非 assignee 回答 → 403；选项不在 options → 400；`authorize_scope` → 400 `UNSUPPORTED_ANSWER`。
- **绑定**：匹配时 `binding=true`、问题 `answered`、`reevaluate=true`（retry）；retry/cancel/deny 取消关联 proposed 意图（resolutionReason 以 `decision_` 开头），defer 不取消并返回 `deferred=true`。
- **non-binding**：Mandate 新版本 → 409 `DECISION_STALE`/`mandate_changed`；暂停 → `mandate_inactive`；answer 行 `binding=false`、问题保持 open、关联意图不被回答改写。
- **幂等**：同 Idempotency-Key 重放返回同一 answer；已 answered 用新键 → 409。
- **审计**：绑定成功 `work.decision.answer` outcome=success 带 `{workKey, decisionId, questionId, answerType, binding:true}`；stale 回答 outcome=denied 带 `binding:false`；均不含问题/回答正文。

## 4 门禁

| 门 | 命令 | 结果（2026-11-04） |
|---|---|---|
| Q0 | `pnpm check` | 223 文件 / 2433 项通过 |
| Q2 | `pnpm test:integration` | 90 文件 / 891 项通过（`work-mandate` 32 项） |

## 5 单点变异

| # | 判据 | 变异 | 实测 |
|---|---|---|---|
| M76 | 版本变化不绑定 | `staleReason` 去掉 current id/version 比对 | 红（stale 回答变 200） |
| M77 | stale 回答只记录 | 不写 non-binding answer | 红（answer 行缺失） |
| M78 | deny/retry 取消意图 | `cancels` 恒 false | 红（意图仍 proposed） |
| M79 | authorize_scope 未启用 | 删除 `UNSUPPORTED_ANSWER` 分支 | 红（返回 200） |
| M80 | 选项必须命中 | 删除 optionId 成员检查 | 红（非法选项返回 200） |
| M81 | 无候选才提问 | 删除 `openNoCandidateQuestion` 调用 | 红（openQuestions 为空） |
| M82 | decisionId 含 Mandate 版本 | 哈希去掉 mandateVersion | 红（decisionId 不等） |
| M83 | stale 回答留 denied 审计 | 删除 catch 里的 denied audit | 红（审计事件缺失） |
| M84 | 已回答决定不重新开问 | 只复用 open 行，忽略 answered | 红（defer 后重复准入又出现 open） |

## 6 边界与未交付

- 本切片只由确定性「自动派工无合格候选」产生 ask；模型 Router 的其它 ask 场景未接，`authorize_scope` 显式 400（RD-03d2b）。
- 回答本身不扩大 Mandate、不创建 Run；`retry` 只取消旧意图并返回 `reevaluate:true`，重新准入仍需新请求；`defer` 没有到期时间与自动重评（RD-03d3）。
- 同一问题只保留一条 binding 回答；stale 回答可多条（每次重试一条），不解除阻塞。
- 问题 refs 只保留前 4 条排除原因与 triggerRefs，避免把大对象写进讨论账本；完整排除原因仍在 `dispatch_intent`。
- 无 UI 入口；`apps/web` 未改。

## 7 复跑

```bash
pnpm check
pnpm test:integration
```
