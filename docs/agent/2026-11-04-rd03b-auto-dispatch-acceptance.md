# RD-03b：autoDispatch='existing_task' 自动派工与候选选择验收（ADR-0028 §6）

- 对应场景/门禁：Q0 / Q2
- 对应 Issue：#507（母 #486；前置 RD-03a #505）
- 上次验证：2026-11-04 · 分支 `feat/p1-507-rd03-auto-dispatch` · PASS

本切片边界：在 RD-03a 的 `proposed → approved → dispatched` 人工链之上，消费 `autoDispatch='existing_task'`，由系统按确定性候选规则直接 `proposed → dispatched`（`approvalBasis='mandate'`），并执行 `maxRunsPerWork`/`maxAttempts` 次数闸。固定草稿工具面/步级预批准（RD-03c）、Run 边界续接/ask（RD-03d）、cost/token usage 账本仍不做。

## 1 验的是哪条用户路径

Task 责任人：

1. 在既有 Task 上建 active Work 与 `autoDispatch='existing_task'` 的 Mandate，显式列出允许 Agent；
2. 把一条 Task 消息关联进工作收件箱；
3. 触发准入；准入事务生成 `proposed` 意图后，组合根调用自动派工端口；
4. 端口按 Mandate 声明顺序选 Agent、按 `lastSeenAt desc, id asc` 选在线 Device、按 `lastCheckedAt desc, id asc` 选可用 Workspace、优先 `draft` action class，并选与 triggerRefs 版本/摘要/授权代次一致的 pending 条目；
5. 复核 Task/Work/Mandate/来源/预算后创建机器 Run；意图落 `dispatched`、`approvalBasis='mandate'`、`approvedAt/dispatchedAt` 与候选/排除理由；
6. WorkDetail 的 `dispatchIntents` 能看到该意图与候选。

无候选/无在线设备/无可用工作区/无 pending 输入/已有活跃 Run 时保留 `proposed` 并记录排除理由，成员仍可人工派工；Mandate 失效、来源漂移、预算耗尽落终态拒绝，不建 Run。

## 2 驱动与证据

- 全走生产 HTTP/DB/事件路径：
  - `POST /tasks/:taskId/works`、`POST /works/:workKey/mandates`
  - `POST /tasks/:taskId/comments`、`POST /works/:workKey/inbox-items`、`POST /works/:workKey/admission-checks`
  - `GET /works/:workKey`、`GET /runs/:runId`
  - Run 终态/失败用真实 `runEventFrame(...runtime.ready/run.completed/run.failed...)` + `ingestNodeEvent`。
- 判据：`apps/hub/tests/work-dispatch.integration.spec.ts` 共 39 项（RD-03a 26 + RD-03b 13）；-t 过滤可单跑。
- 观测：`component=hub.dispatch`、`action=work.dispatch.auto`（`actor='system'`、workKey/intentId/runId/approvalBasis/onBehalfOfUserId/candidateCount/exclusionCount，不含正文）；预算/绑定拒绝记 `work.dispatch.auto_rejected`，回调内部故障记 `work.dispatch.auto_failed`；后两者不把已提交准入变成 500。
- DB：`dispatch_intent.status/approval_basis/approved_at/dispatched_at/candidates/exclusion_reasons/resolution_reason`、`run.origin/mandate_id/dispatch_intent_id/on_behalf_of_user_id`、`work.state/resume_mode/resume_condition`。

## 3 判定

- **正控**：唯一合规候选自动建 Run；Run 的 provenance 完整；work 转 `waiting(auto)`；意图候选 1 条；同准入重放不产生第二个 Run；WorkDetail `dispatchIntents` 返回 dispatched 意图。
- **候选顺序**：Mandate `allowedAgentIds` 第一个可用的 Agent 被选；其余记 `lower_priority`；在线 Device 取最近心跳；Workspace 取最近检查且 available；`allowedActionClasses` 含 `draft` 时优先 draft。
- **负控**：
  - allowlist 为空 → 保留 proposed，`agent/allowlist_empty`，Run 0；
  - Agent archived/无 revision/full_access → 保留 proposed + 排除理由；
  - 无在线 Device → `device/no_online_device`；有 Device 无可用 Workspace → `workspace/no_available_workspace`；
  - 触发来源没有 pending 条目 → `input/no_pending_trigger_item`；
  - `maxRunsPerWork` 或 `maxAttempts` 耗尽 → 意图 `rejected` + 稳定 `resolutionReason`，Run 不新增；
  - `autoDispatch='off'` 的既有 26 项人工链不受影响（仍必须人工 approve→dispatch）。
- **数据判据**：`dispatch_intent_status_fields` 要求 auto dispatched 同时有 `approvalBasis`/`approvedAt`/`dispatchedAt`/`runId`；`run_origin_fields` 与一意图一 Run 继续生效。

## 4 门禁

| 门 | 命令 | 结果（2026-11-04） |
|---|---|---|
| Q0 | `pnpm check` | 222 文件 / 2409 项通过（protocol 新增 `dispatchIntents` 读面 + 1 条自动派工静态边界） |
| Q2 | `pnpm test:integration` | 90 文件 / 863 项通过（`work-dispatch` 39 项） |

## 5 单点变异

每次只改一处，跑对应 `-t` 用例必须红；恢复后 `git diff` 核对无残留。

| # | 判据 | 变异 | 实测 |
|---|---|---|---|
| M33 | auto off 不自动派工 | 删 `mandate.autoDispatch !== 'existing_task'` 返回 | 红（off 用例意图已被自动派工） |
| M34 | approvalBasis=mandate | auto 落 `human` | 红（正控期望 mandate） |
| M35 | Agent 声明顺序 | 选最后一个 eligible | 红（选中顺序反了） |
| M36 | 空 allowlist 排除理由 | 空列表分支改恒假 | 红（缺 allowlist_empty） |
| M37 | 离线 Device 过滤 | 删 `deriveDeviceStatus !== online` | 红（离线设备仍被尝试） |
| M38 | 无 pending 输入不派工 | 空条目分支改恒假 | 红（无条目仍尝试建 Run） |
| M39 | maxRunsPerWork | 条件改恒假 | 红（第二次仍派工） |
| M40 | maxAttempts | 条件改恒假 | 红（失败后仍派工） |
| M41 | 准入后触发自动端口 | 回调调用注释掉 | 红（仍停在 proposed） |
| M42 | auto dispatched 必有 approvedAt | 删 `approvedAt` | 红（DB 约束失败/不放行） |
| M43 | 候选持久化 | 删 `candidates` 更新 | 红（读面候选为空） |
| M44 | WorkDetail 暴露 dispatchIntents | 删映射 | 红（读面看不到意图） |
| M45 | draft action 优先 | 优先判断改恒假 | 红（选了 research） |
| M46 | Device 最近心跳优先 | 排序反向 | 红（选了较旧设备） |
| M47 | Workspace available | 删 available 过滤 | 红（不可用工作区被选） |

## 6 边界与未交付

- 自动派工只由显式 `POST /works/:workKey/admission-checks` 触发；订阅快路径/入口程序（RD-02b entry）尚未自动调用该端口。
- 无候选时保留 proposed 并写排除理由，但没有后台重评 sweeper；设备上线/补条目后需要再次准入（同来源重放会重试）或人工派工。
- `maxCostMicros`/`maxTokens` 仍只存储：Node/Hub 尚无 usage 回传，不能声称已预占/结算；本切片只执行可判定的 `maxRunsPerWork`/`maxAttempts`。
- `maxRunsPerWork` 统计该 work 全部机器 Run（含历史 Mandate）；`maxAttempts` 统计 failed/cancelled/lost 机器 Run。人类运行与 Router/转交共享额度口径留待 usage 账本切片。
- 自动裁决使用发起准入的 assignee 会话作为 Run 创建 actor（复用既有指令权守卫），但意图 `approvalBasis='mandate'`、`origin='mandate'` 与 on-behalf 标记为机器来源；不伪造人类 approve 记录/消息。
- 候选选择限定“显式 allowlist + 同 assignee 单现场”；跨成员 Device/Workspace、多个候选的排名理由扩展未做。
- WorkDetail 保留原 `proposedIntents` 字段并新增 `dispatchIntents`（最近 50 条全状态）；Web 未改。
- `autoDispatch` 变更/暂停/撤销仍按 RD-03a 的取消链路；固定工具面、步级预批准、`mandateInvalidated` 归 RD-03c；Run 边界自动续接/ask 归 RD-03d。

## 7 复跑

```bash
pnpm check
pnpm test:integration
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests/work-dispatch.integration.spec.ts
```
