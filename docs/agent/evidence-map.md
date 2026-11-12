# 取证地图：出问题去哪一层找什么

> 状态：随实现推进补全。标「待建」的条目由对应 Issue 落地后更新本表。
> 总原则：按 `component` 字段分层定位，用 `runId / traceId / commandId / eventSeq` 跨层对证据；不去翻与现象无关的日志。

## 分层证据位置

| 层 (component) | 证据 | 位置 | 状态 |
|---|---|---|---|
| browser | Playwright trace + 自动证据包（hub/node/vite 日志尾、run 事实、manifest） | `test-results/**/trace.zip`；`artifacts/evidence/e2e/<attemptId>/`（P1-19 collectEvidenceOnFailure，redactText 源头归约，Node READY 行含 Token 已排除） | 生效（P1-19） |
| hub.http / hub.domain / hub.db / hub.outbox / hub.ws | 结构化 JSON 日志（stdout，含 allowlist 字段） | Hub 进程 stdout；Compose 部署走 `docker compose -f deploy/compose.yml logs hub` | 待 P1-05 起 |
| hub.db | 团队事实：Team Event、`run_event`、`outbox` | PostgreSQL 直接查；测试用 `scripts/with-test-postgres.mts` 起的临时实例 | 待 P1-04 |
| hub.context | 来源绑定生命周期：`source.bound/paused/resumed/revoked/unavailable/permission_*`，只含不透明 sourceId/projectId/状态/代次；租约获取/换发/释放看 `source_audit_event.lease_changed`（过期租约不续租） | Hub stdout 按 `component=hub.context`；DB：`source_audit_event`、`team_event(source.changed)`、`project_source` 水位、`source_collection_lease` | 生效（PC-02a #455）；`node.source` 待 PC-02b |
| hub.context（Run 状态） | `context.state_pull` / `context.state_acked` / `context.state_ack_invalid`（runId/snapshotId/stateVersion/失败条数，不含正文与路径）；撤销传播看 `run_project_context.state_version/state_digest`、入口 `entry_status/status_reason`、`run_context_state_ack`、`dispatch_outbox(type=run.context_state/context.state_sync)`；回执接受/重复/迟到/拒绝看 `context.receipt_recorded/receipt_duplicate/receipt_late/receipt_invalid`，ack 发送失败看 `context.receipt_ack_send_failed`，首条回执超时看 `context.receipt_watchdog`（runId/snapshotId/waitedMs，不含正文） | Hub stdout 按 `component=hub.context`；DB：`run_project_context`、`run_project_context_entry`、`run_context_state_ack`、`run_context_receipt`、`dispatch_outbox` | 终态 blocked 看 `runs.resume_context`（非空 `run_project_context` 由 `setRunStatus` 同事务写 `blocked`；已 ready 的 Run 还会沿 `resume_from_run_id` 把根来源与全部 resume 后代标 `blocked`；`GET /runs/:id` 的 RunView 暴露）；生效（PC-05b-1 #498 / PC-05b-2 #499 / PC-05b-3 #500） |
| node.context（状态应用） | `project context state applied`（stateVersion/deleted/quarantined/failed/pending/paused）、状态摘要不符/代次倒退丢弃、清理重试计数；回执先入队再发送、重连重放与 Hub ack 清理看 `action=node.context.receipt_outbox`（event=queued/acknowledged，receiptSeq、pending 数）；本地 `runtime-context/<runId>/state.json`、`runtime-home/<runId>/quarantine/`、`context-state.sqlite`、`context-receipt-outbox.sqlite` | Node stdout 按 `component=node.context`；本地文件与 SQLite：`run_context_state`、`context_cleanup_task`、`context_receipt_outbox` | 终态清理看 `action=node.context.terminal_cleanup`（event=deferred/done/cleanup_pending/schedule_failed/facts_read_failed/facts_write_failed/queue_read_failed/cleanup_pending_write_failed，runId/mode/attempts/errorName）；本地 `terminal-cleanup.sqlite` 的 `run_runtime_facts`/`run_terminal_cleanup`（含 `owns_home/session_ready`）、`runtime-home/<runId>/spill`、`runtime-context/<runId>`、`runtime-home/<runId>/quarantine/`；生效（PC-05b-1 #498 / PC-05b-2 #499 / PC-05b-3 #500） |
| hub.dispatch | 派工意图人工确认/拒绝/派发：`component=hub.dispatch` 的 `action=work.dispatch.approve/reject/dispatch`（workKey/intentId/status/runId/agentId/deviceId/actionClass/approvalBasis/onBehalfOfUserId，不含来源正文与自由文本 reason）；DB：`dispatch_intent`（status/approval_basis/approved_at/dispatched_at/run_id/agent_id/profile_revision_id/device_id/workspace_id/action_class/resolution_reason）、`run`（origin/mandate_id/dispatch_intent_id/on_behalf_of_user_id/work_key/mandate_invalidated_at/mandate_invalidated_reason/executor_usage/executor_cost_micros）、`work`（waiting auto 的 `resume_condition=run:<id>`）、`executor_usage_ledger`（reserved/settled、chargeMode）、`coordination_budget`（work/team/project 与 Router 共享）；普通 create 拒绝机器来源；Mandate 变更取消未执行机器 Run 记 `work.dispatch.machine_run_cancelled`；在途 Run 失效记 `work.dispatch.mandate_invalidated`（invalidated/failed 计数）并写 `dispatch_outbox(type=run.mandate_invalidated)`；自动派工记 `work.dispatch.auto`（actor=system、candidateCount/exclusionCount/runId/approvalBasis/actionClass），拒绝 `work.dispatch.auto_rejected`，失败 `work.dispatch.auto_failed`；RD-03d3 边界调度记 `work.run_boundary.enqueued/skipped`（runId/workKey/evaluationId/triggerKey/reason）、`work.wait.expired`（waitId/workKey/evaluationId/reason，跳过时附稳定 errorCode）、`work.decision.applied`（evaluationId/workKey/decision/status/reason/intentId/questionId/waitId）与 `work.dispatch.auto`（下一 runId），均不含来源正文；DB `work_run_boundary`（status/reason/trigger_key/evaluation_id）、`dispatch_intent.candidates/exclusion_reasons` | Hub stdout 按 `component=hub.dispatch`；DB 同上 | 生效（RD-03a #505 / RD-03b #507 / RD-03c1 #509 / RD-03c2 #511 / RD-03r2 #520 / RD-03d3 #518）；`run.start`/`runtime.initialize` 的 `toolPolicy` 不含正文/路径；Executor 用量见 [Router 应用验收](./2026-11-04-rd03r2-router-application-acceptance.md) |
| hub.audit (work) | 工作/Mandate 写命令审计：`work.create/retire/accept`、`work.mandate.create/pause/resume/revoke`；`work.accept` 只记 actor/workKey/mandateId/version，不含目标正文；ask 回答 `work.decision.answer` 只记 workKey/decisionId/questionId/answerType/binding；扩权回答/确认 `work.decision.scope_answer/scope_confirm` 只记 proposalId/decisionId/questionId/mandateId/version 与稳定 reason，不含 scope 正文、Agent 列表或上限值 | Hub stdout 按 `component=hub.audit`、`action=work.*`；DB：`work`（state/resumeMode/resumeCondition/humanOwnerUserId/mandateId）、`work_mandate`、`dispatch_intent`、`work_question`、`work_question_answer`、`work_mandate_proposal`（status/base_mandate_id/version/result_mandate_id） | 生效（RD-01 #484 / RD-03d1 #513 / RD-03d2a #515 / RD-03d2b #517） |
| hub.work_input | 60s 未消费回执：`work.input_returned`（只含本轮收口 `count`，不含条目标识）；消费回执：`work.input_receipt`（receiptSeq、consumed/duplicate/duplicateConsumption/late/idempotent 计数）；坏回执：`work.input_receipt_invalid`（reason，不关连接）；对账看 `run_work_input_receipt`、`work_input_consumption`、`work_inbox_delivery`（acked_at/status/failure_reason）与 item 的 `delivery_run_id/delivered_at/unconfirmed_at/consumed_at` | Hub stdout 按 `component=hub.work_input`；DB：`run_work_input_receipt`、`work_input_consumption`、`work_inbox_delivery`、`work_inbox_item` | 生效（RD-02a-2a #492 / RD-02a-2b #493） |
| hub.work_subscription | 订阅创建/撤销：`work.subscription.create`（workKey/subscriptionId/targetType/status/duplicate）、`work.subscription.revoke`（status/duplicate）；不记调用方 reason 文本，状态原因看 `work_subscription.status_reason` | Hub stdout 按 `component=hub.work_subscription`；DB：`work_subscription`、`work_inbox_item(subscription_id,retraction_scope)`、`work_inbox_delivery` | 生效（RD-02b #485） |
| hub.work_entry | 入口准入：`work_entry_admission`（trigger/outcome/reason/router_invoked/subscription_id/inbox_item_id/deadline_at）；慢路径调用：`work_entry_router_call`（reason/input_digest，无正文）；快路径证据是 admission `deliver` + router call 零行 | DB：`work_entry_admission`、`work_entry_router_call`、`work_inbox_item`、`work_inbox_delivery`（无独立 stdout logger；按 DB 行归因） | 生效（RD-02b #485） |
| hub.router | `router.evaluation` / `router.result`（evaluationId/workKey/attempt/status/reason）；入口 call 的 `evaluation_id/resolved_at/resolution_reason`；评估清单、读取、model_started_at、租约与终态；费用 reserved/settled、chargeMode 与三层余额；应用失败 `router.application_deferred` / `router.application_failed`（evaluationId/reason，不含提案正文） | Hub stdout 按 `component=hub.router`；DB：`coordination_evaluation`（purpose=router）、`work_entry_router_call`、`router_configuration`、`coordination_team_policy`、`coordination_usage_ledger`、`coordination_budget`、`router_application`、`work_wait`、`work_run_boundary`、`dispatch_intent`、`work_question`、`work_inbox_item`、`executor_usage_ledger` | RD-03r1 #519 / RD-03r2 #520 / RD-03d3 #518；工程回放与最终门结果见 [受限评估验收](./2026-11-04-rd03r1-router-evaluation-acceptance.md) 与 [Router 应用验收](./2026-11-04-rd03r2-router-application-acceptance.md) |
| hub.discovery | 影子发现的准入、许可、清单下载/读取、模型启动、候选、费用和撤权；状态日志 `discovery.evaluation/read/model_start/result/cancel/usage_settled` 只含不透明身份及固定原因 | DB：`discovery_admission`、`discovery_consent`、`discovery_candidate`、`coordination_evaluation`（purpose=discovery，`discovery_downloaded_ids` 和 `read_entry_ids`）、同一协调用量账本；Node 使用独立 capability 与 Hub 启动回执 | #532，复跑见 [RD-04a 验收](./rd04a-shadow-discovery-acceptance.md)；不产生业务 Run 或项目事实 |
| node.coordination / runtime.bridge.coordination | Node 的 `runtime_started/evaluation_terminal/orphan_reconciled/cleanup_pending` 与 Runtime 的 `worker_failed`；模型启动/读取先写本地 journal，结果重发至精确 attempt/lease ack，孤儿恢复不重放模型；输入删除失败可重试 | Node 本地状态目录的 `coordination.sqlite`（coordination_attempt）与 `coordination-home`；脱敏回放事实 `artifacts/evidence/router-evaluation/` 的 `result.json` 和 `events.jsonl`，失败日志同目录 | RD-03r1 #519；目录/凭据/输入正文不进入投影和证据；Linux 隔离以 Ubuntu CI 的真实 bin 结果为准 |
| node.work_input | `work inputs prepared`（runId/count）、`work input receipt forwarded`（receiptSeq/delivered/read）与丢弃原因；本地副本与待发回执 | Node stdout 按 `component=node.work_input`；本地 `runtime-work-inputs/<runId>/` 与 `work-input-receipts.sqlite` | 生效（RD-02a-2b #493） |
| node.gateway / node.workspace / node.supervisor | Node 结构化日志、本地 spool、SQLite registry；`run.mandate_invalidated` 的转发/重复 ack/终态 ack-only 记 `component=node.run_manager`（runId/reason，无正文）；#501 并发重复 `run.start` 按 runId 串行化并回放首次结果，判据看 `command.ack`（含拒绝回放）、`active_runtime` 行身份/pid、`supervisor.isActive` 与 `run.snapshot`（无 lost），见 [P1-501 验收](./2026-11-08-p1-501-duplicate-run-start-acceptance.md) | Node 本地状态目录（`~/.whalepod-node/`；#133 定名后按本行预留调整改名，旧 `~/.project311-node/` 不再写入）；诊断走本地 Unix socket | 待 P1-09/12；RD-03c2 命令路径生效；#501 串行化生效 |
| runtime.bridge / dsh.agent | Runtime stderr 尾部（≤8 KiB，脱敏）、NDJSON 协议帧 | Node 暂存；owner-only | 待 P1-11/12 |
| artifact.store | 内容寻址 blob、candidate 元数据 | Hub `blobs/sha256/ab/<digest>` + DB | 待 P1-15 |
| hub.managed-draft / node.managed_draft | 专用设备、冻结来源读取、本机模型一次性裁决和可信候选上传；撤销先提交时零模型 POST，旧 Run 标记不可补写 | 生产 HTTP、实际 WebSocket、DB `dispatch_intent` / `run.managed_draft_source_digest` / `dispatch_outbox` / `managed_draft_execution` / `managed_draft_candidate`；[复跑与证据边界](./rd03c3a-source-gates-acceptance.md) | #533；仅回环模型，正式执行固定拒绝 |
| hub.draft-share | A 核对固定候选并发出邀请，指定 B 接受后读取；普通读面不可见，撤销后禁止新读取 | 真实候选；生产 HTTP、真实 PostgreSQL `draft_share_grant` / `draft_share_read_admission`；[复跑与证据边界](./rd03c3a-source-gates-acceptance.md) | #533；默认关闭，显式配置的本机阅稿验证 |

## 一把捞齐

- 按 Run/场景取证（P1-18）：`pnpm phase1:evidence -- --evidence <dir> [--run <id>]`；
  驱动 `pnpm phase1:drive`、判定+归因 `pnpm phase1:verify`（exit code 即结论）。
  采集由 `scripts/lib/phase1/` 六原语 harness 完成：真 Hub+真 Node+真 Runtime+双
  Browser WS，跨层 traceId/runId 索引在证据目录的 `index.json`（按 run 一把捞齐
  四层证据计数与文件）。验收细节见 [harness-acceptance.md](./harness-acceptance.md)。
- E2E 失败自动产包：`artifacts/evidence/<scenario-id>/<attempt-id>/`，含 `manifest.json`（git commit、DSH 版本、协议版本、种子、起止时间）、`assertions.json`、`api.jsonl`、`team-events.jsonl`、`node-events.jsonl`、`runtime-summary.jsonl`、`db-snapshot.json`、双浏览器截图。
- P1-19 E2E 自动产包：`artifacts/evidence/e2e/<attemptId>/`（`hub.log.txt`/`node.log.txt`/`vite.log.txt` 三层日志尾 + `run-<id8>.json` 相关 Run 全量事实白名单 + `manifest.json` traceId/error/runIds）。控制面 `/control/tails` 与 `/control/db/run/:id` 是打包数据源；归因按 component 前缀（hub.*/node.*/runtime.*）分层。
- Router 受限评估（#519）与提案承接（#520）：`pnpm exec tsx scripts/run-router-evaluation.ts` 走生产装配，`pnpm exec tsx scripts/verify-router-evaluation.ts artifacts/evidence/router-evaluation/result.json` 独立重判，同目录的 `events.jsonl` 也是必需输入。按 evaluationId/attempt 关联入口、模型调用、读取、接受/拒收及 ledger 的 reserved/settled；九场景缺任一即失败。#520 额外重判 `intents=1`/`questions=1`/`waits=1`/`applications=4` 且 `runs=0`，并核对 dispatch/ask/wait/ignore 的承接对象；Executor 账本 scope/零计费/封顶由 `packages/db/tests/executor-ledger.integration.spec.ts` 钉住。`authorize_scope` 的回答/确认由 `apps/hub/tests/work-scope-proposal.integration.spec.ts` 钉住（pending 草案、新版本、stale/改派/过期/并发）。变异复跑用 `pnpm exec tsx scripts/mutate-router-evaluation.ts`（含 #517 的 S01/S02/S04–S17），结果写入 `artifacts/evidence/router-evaluation/mutations/result.json`。成功事实和失败脱敏日志均位于该目录，CI `always` 上传。
- RD-04a 影子发现（#532）：`artifacts/evidence/rd04a/result.json` 关联普通评论、原订阅、发现授权、清单/双层回执、私有候选、撤权及费用，独立判定不依赖运行驱动。见 [RD-04a 验收](./rd04a-shadow-discovery-acceptance.md)。
- RD-05a 快慢路径组合（#546，2026-11-12）：`artifacts/evidence/rd05a/<当前完整 HEAD>/<本次 UUID>/`，UUID 即 campaignId，独占创建不覆盖。`attempt.json` 绑定启动/commit/harness/assembly；`result.json` 关联一装配、一 Project、两成员、bootstrap/continuation/discovery 三正向与隔离第四负向；`events.jsonl` 对证阶段、回执、实际工具读/错误和 Run 状态。driver、独立 checker、negatives 都显式传本次 `result.json`，不搜索旧报告；required integration 只核对并扫描/上传该 attempt，secret-scan 失败不得上传，失败包不是 PASS。本轮组合仍 `not_run / 待本轮结果`。费用区分普通 Executor/coordination 模拟账本与私有回环 `loopback_unmetered`，无 paid 请求不等于零模型请求/零费用。旧 c2/c3 封存原字节不得重签。见 [RD-05a 验收](./2026-11-12-rd05a-combined-paths-acceptance.md)。
- RD-04c2 新任务私有草稿（#542）：`artifacts/evidence/rd04c2/` 关联执行授权、专用来源、自动派工、DSH 读取、候选私有性和首读前撤权。见 [RD-04c2 验收](./2026-11-12-rd04c2-discovery-draft-acceptance.md)。
- RD-04c3 真实 Executor 与结算（#544）：`artifacts/evidence/rd04c3/` 关联接收方、逐件授权、调用预留、供应商 token、四级预算和私有候选。见 [RD-04c3 验收](./2026-11-12-rd04c3-guarded-executor-acceptance.md)。
- RD-04a 判断质量（#532）：`artifacts/evidence/discovery-quality/` 按回放、真实开发集、冻结保留集分别取证；试点修复后的装配独立记录在 `pilot-fences/`。人工确认单独绑定原始结果，不改机器记录。内部 `discovery_observation` 只保存已接受的分类与精确引用，不含候选理由。见 [发现判断质量验收](./rd04a-discovery-real-model-quality.md)。
- M1R-A 生产续接（#486）：`artifacts/evidence/m1r-a/` 按来源/订阅、收件箱条目、两次 Run、边界评估及候选成果关联。复跑与判据见 [M1R-A 验收](./m1r-a-production-acceptance.md)。
- Router 真实模型（#486）：`artifacts/evidence/router-quality/` 按开发集、冻结配置与保留集分别取证，判分独立于待测模型。复跑与范围见 [真实模型质量验收](./router-real-model-quality-acceptance.md)。
- 任何证据离开本机或进 git 之前：`scripts/secret-scan.sh <路径>`，命中即拒（Q7）。
  绝对路径模式覆盖 macOS home、Linux home 与 tmpdir 形态（含本机 os.tmpdir()
  锚点）；模式本身的可信度用 `scripts/secret-scan.sh --self-test` 逐条语料自检（#73）。

## 现象 → 先看哪层

| 现象 | 先看 |
|---|---|
| RD-05a 组合缺一条链、Run/来源串轮，或拿旧结果替代本次 | 先核对本次 HEAD/UUID 的 attempt/result/provenance 和 `acceptance.campaign` 阶段：快入口零 Router、终态边界两次评估 → catalog 稳定后发现 → 三条正向 → 独立第四负向；再按 `hub.work_entry` / `hub.dispatch` / `hub.router` / `hub.discovery` / `hub.work_input` 及 `acceptance.replay` 逐件关联。取证失败看本 attempt 的脱敏 failure.log；复跑三个 CLI 必须显式传同一 result。见 [RD-05a 验收](./2026-11-12-rd05a-combined-paths-acceptance.md) |
| RD-05a 私有标题/终态/真实工具错误疑似泄漏或首读前更正仍执行 | 三面成员 HTTP/实时 WS/历史重放先确认非空及公开对照；再看 `artifact.store` 和精确 callId/tool-role/错误摘要。第四 Run 按来源作者的生产 HTTP correct、授权收口、已送达回执、零成功读取/后续请求/草稿归因，不能用普通候选正文策略代替发现执行更强隔离。见 [RD-05a 验收](./2026-11-12-rd05a-combined-paths-acceptance.md) |
| 补充进了收件箱，续跑却没读到正文或草稿不可见 | `hub.work_entry` 的订阅/条目 → `hub.dispatch` 的边界/评估/意图/新 Run → `node.work_input` 下载与 `hub.work_input` 读取回执 → `artifact.store` 候选上传及双账号下载状态。见 [M1R-A 验收](./m1r-a-production-acceptance.md) |
| 筹备评论未进入发现或候选不再可读 | 先查 `discovery_admission` 的归属、固定原因及版本；再查 `hub.discovery` 的配置/许可、清单、下载/Runtime 回执及租约；已撤回时用授权候选 HTTP 与团队对照，勿查询正文日志。 |
| 新任务已授权但未派工、未实际读取，或草稿权限异常 | 按 execution id 查 `hub.discovery` 和源版本，再核对唯一 Run/outbox、`node.work_input` 的交付与 `hub.work_input` 的读取回执；用 `artifact.store` 和双账号 HTTP/WS 检查草稿受众。 |
| 慢路径有 Router 调用记录却没有模型、结果被拒收、费用未释放或 Node 重启后重复请求 | `hub.work_entry` call 的 evaluation_id/resolution_reason → `hub.router` 评估状态/读取/模型启动/lease/deadline → `node.coordination` journal 与孤儿恢复 → `runtime.bridge.coordination` 分类失败；费用对照 usage ledger 的 evaluationId/attempt/phase 和三层 budget。复跑与范围见 [#519 验收](./2026-11-04-rd03r1-router-evaluation-acceptance.md) |
| 输入栏焦点重叠、审批参数裁切、文件菜单溢出或 Esc 关掉外层面板 | `web.app-ui`：`artifacts/evidence/focused-workspace/<本次目录>/facts.json` 的 prompts/approvals/files 九组测量，独立复跑 `verify-app-ui-evidence` 与 `verify-workspace-evidence`；bundle 异常看 `vendor/collectui/manifest.json`，见 app-ui-polish-acceptance |
| 管理页裁切、邀请展开/复制、插件卡审核、Agent 关闭回焦或设备配对展示异常 | `web.management`：management-pages facts.json；复跑 verify-management-evidence；见 reactbits-management-acceptance |
| 动效静止、反向跳变、预览重开丢状态或窄屏裁切 | `web.motion` | `artifacts/evidence/focused-workspace/<本轮目录>/motion.json`、`motion-*.png`、只读短录屏；独立判定器与 CSS token/卸载窗口 |
| 项目展开失焦、列表刷新重播、设置隐藏错误或待办分类/讨论草稿异常 | `web.pages`：focused-workspace facts.json 的三档四组页面观测；复跑 verify-pages-evidence 与总判定器；见 reactbits-pages-acceptance |
| 工作台搜索/空态溢出、手机找不到搜索、抽屉关闭失焦或完成后仍显示活动 | `web.workbench`：同目录 facts.json 的 start/room/run 九组观测；复跑 `verify-workbench-evidence` 与工作区总判定器；见 reactbits-workbench-acceptance |
| Agent 未收到约定/交接正文，或接收方无法阅读固定版本 | hub.run execution-context → node.run initialize → runtime.bridge 首条模型指令；页面看 HandoffPublishedContent，复跑 handoff-context-consumption-acceptance |
| 下拉描边判据报错，或 hover/键盘焦点导致误判 | browser：`artifacts/evidence/select-menu/state-probes.json` 的 state/hovered/focusVisible/transitioning 与解析颜色；对应纯判定 `shared/select-trigger-tokens.ts`，复跑与负控见 [select-menu-acceptance](./select-menu-acceptance.md) #398 |
| R8 崩溃前 run.start 已 ack，或不确定是否真正命中派发前窗口 | node.gateway + hub.outbox：`artifacts/evidence/r8-window/result.json` 的 held/faultId/liveSockets 与 before/after 派发事实；独立重判及负控见 [r8-window-acceptance](./r8-window-acceptance.md) |
| 指令串到别的 Run、或 Run 被别的会话事件提前结算、或出现本 Run 不该有的 running/idle、或指令发出无回执 | Q3 三个契约探针（single-run-isolation / instruction-receipt / event-stream-scope）：先看 `bridge.handleCommand` 的 runId 闸与 `session-owner.deliverSessionEvent` / `deliverAgentStatus` 的两条过滤，再看 `node.run` 的 protocolViolation 日志；复跑与边界见 [runtime-contract-negatives-acceptance](./runtime-contract-negatives-acceptance.md) |
| DSH 升级半途失败 / 回滚后版本对不上 | Q3 的 lock-drift + 回滚演练（`helpers/lock-drift.ts` 的 findings：kind 点名哪一处漏改）；真实安装面看 `--print-dsh-version` 的自报与 `node_modules/.pnpm/@deepseek-ai+dsh-session@*` 残留；复跑与人工门步骤见 [dsh-rollback-drill-acceptance](./dsh-rollback-drill-acceptance.md) 与 dsh-upgrade skill |
| 指令去向变化、来源续跑或草稿丢失 | `artifacts/evidence/unified-execution/result.json`：web.execution 的草稿/唯一输入 → hub.run 的血缘/来源版本/现场 → runtime.bridge 会话身份；上下文在场另外复跑 Q3 resume 契约。见 unified-execution-acceptance |
| 拒绝后无法改派或改派重试冲突 | `artifacts/evidence/task-reassignment/result.json`：web.assignment → hub.task 的 pending/assignee → command_receipt → 新 Run 的 owner/device |
| 创建任务失败只看到英文分类消息 / 不知道下一步 | `apps/web/tests/create-failure-guidance.spec.tsx`（引导主位 + 细节行错误码 + 持续阻塞）与 p1-312 的真页面一条；归因先看 ProjectsPage 的 `createTaskFailureCopy` 是否接线、Hub 原文是否变了；见 [create-failure-guidance-acceptance](./create-failure-guidance-acceptance.md) |
| 换版（升级/回滚）后 Run 报错码分不清「进程丢了」还是「换了版本」 | `runs.failure_code`：`RUNTIME_VERSION_CHANGED`（Node 重启做孤儿恢复时比对 `active_runtime.dsh_version` 与本次启动探针）vs `RUNTIME_LOST`（Hub 租约过期那条路，看不出换版）；复跑与边界见 [runtime-version-change-acceptance](./runtime-version-change-acceptance.md) |
| 取消后状态对不上（出了两条终态帧 / 取消后还多跑了一轮 / 排队中的追问被取消后仍执行） | Q3 契约探针 `packages/runtime-dsh/tests/dsh-contract/cancel-race.contract.spec.ts`：先看终态帧与 `turn/end` reason 的映射（`bridge.ts` 的 `turnSettled`），再看 `agent/inbox/spliced` 的 `target`（`next-turn`=追问入队 / `next-step`=插话）与 `agent.status` 收敛；复跑与边界见 [cancel-race-acceptance](./cancel-race-acceptance.md) |
| 设备视图少报 pack / DSH 版本停在旧值（明明装了或换了版本） | 先看 `GET /devices` 的 `dsh_distribution_version` / `plugin_pack_digests`（#37 列，纯展示面）与 cli stderr 的 `node.plugin`/`node.session` 行；归因：`gateway/hello-facts.ts`（读盘/探针回落）→ `session.ts` 的补发守卫 → Hub `node-websocket.ts` 的 hello 分支（覆盖，不是首写/合并）；判据与边界见 [hello-facts-refresh-acceptance](./hello-facts-refresh-acceptance.md) |
| 创建任务重复建出两个 / 重试后多一个任务 | `artifacts/evidence/create-recovery/result.json`：web.api 的幂等键（同义键要同值）→ hub.task 的 `task.create:<key>` 回放与命令回执；复跑 `pnpm exec playwright test --project=p1-345`，见 create-to-recovery-acceptance |
| 执行归错人 / 用错设备（创建者 vs 责任人） | 同一份 `result.json` 的路径 2/3 段：hub.run 的 ownerUserId 与 deviceId（`GET /runs/:id`）→ 双方各自的 `GET /devices`；对照任务 `assigneeUserId/assigneeAgentId` 与 `assignmentStatus` |
| 指派 Agent 建任务时看不到执行命运（toast 不出现，或把受理/排队说成已开始执行） | `artifacts/evidence/p1-312/`：web.api 的信封读法（`data.drive` 恒 undefined 即 #312 复发——`drive` 是 `data` 的兄弟）→ web.assignment 的收窄与如实文案 → web.toast；任务与执行事实对 hub.task 的 201 与 `GET /tasks/:id` 聚合（有没有 Run）。复跑 `pnpm exec playwright test --project=p1-312`，见 create-drive-toast-acceptance |
| Run 终态后 session/spill 仍在、Runtime 退出后没删，或 resume 报 blocked | `node.context` 的 `action=node.context.terminal_cleanup`（deferred 先看本 Run 的 Runtime 是否仍活跃、再看共享 home 活跃使用者（`active_runtime.dsh_home_path`）；cleanup_pending 看 `run_terminal_cleanup.last_error/attempts`；done 后仍存在看文件权限/`runtimeContextDirFor`）→ Hub `runs.resume_context` 是否按 `run_project_context.entry_count` 写 blocked；Q3 spill 根看 `<dshHomePath>/spill` 与 tmpdir 默认根零正文。见 [PC-05b-3 验收](./2026-11-03-pc05b3-terminal-cleanup-acceptance.md) |
| Run 状态不动 | hub.outbox 是否派发 → node.gateway 是否 ack → node.supervisor 是否拉起子进程 |
| Run 被拒且提到 DSH 不兼容（或说本地版本不可知） | `node.plugin` 的 preflight 拒绝消息（两侧版本）→ 手工跑 `node apps/runtime/dist/bin.js --print-dsh-version`（无输出 = dist 过期，探针 fail-closed）→ pack 清单的 `dshCompatibility`；复跑与边界见 [dsh-compat-guard-acceptance](./dsh-compat-guard-acceptance.md) |
| Run 失败码是 `PROFILE_MISMATCH` | `runtime.ready` 帧的 `profileDigest` 回声 vs Hub 固化 Revision digest（`POST /agents` 与 revisions 两条产出路径）、Node 的 `node.run` 结构化日志；对照点语义见 [dsh-compat-guard-acceptance](./dsh-compat-guard-acceptance.md) |
| 浏览器看不到进度 | hub.ws cursor 是否推进 → 浏览器是否收到 `resync.required` → hub.domain 是否产事件 |
| Run/工具/活动/发送图形与事实不符，或 Micro 窄屏溢出 | `artifacts/evidence/run-micro/<attempt>/result.json`：hub.run-projection 的 runId/seq/audience/callId/outcome/phase → web.micro/activity；HTTP outcome → web.instruction；筛选焦点/动效 → web.console；复跑 `pnpm test:e2e:micro`，见 run-micro-acceptance |
| 提示层位置/文案不对，或完成提醒开关「看起来开了但没授权」，或 toast 不消失/关不掉 | 同一份 `result.json` 的 `batch2` 段：hint 的等待与描述可达性 → web.hint；`data-on`/`data-ring`/偏好 → web.bell；fuse 时长与暂停 → web.toast；复跑 `pnpm test:e2e:micro`，见 run-micro-batch2-acceptance |
| 事件重复/缺序 | `run_event` 表 `(run_id, seq)` 是否有缺口/重复 → node spool 是否重发 |
| 审批卡住 | hub.domain `approval` 行状态 → node.gateway 决定帧 → runtime.bridge answerer |
| 候选无法检查或发布可见范围错误 | `artifacts/evidence/candidate-inspection/result.json`：web.artifact → Hub 内容读取鉴权 → artifact.store digest；复跑见 candidate-inspection-acceptance |
| 成果依据串版本、把缺失当空、交接对应错误或旧面板不刷新 | `hub.review.delivery-basis` 的来源 Run、历史约定及固定输入；`matchesDeliveryArtifact` 精确关联；`web.review.delivery-basis` 的 task-room 缓存前缀与既有事件映射。复跑 delivery-basis-acceptance，脱敏结果见 `artifacts/evidence/delivery-basis/` |
| Artifact 打不开 | artifact.store digest 与 DB metadata 比对 → hub.http 权限判定 |
| Office 预览没有出现、内容与原件不符或下载回退异常 | `preview-info` 三态/sourceSha256 → node.artifact 的稳定转换失败码 → hub.artifact 派生件读取权限 → web.OfficePreview 查询与受控 PDF 读取；复跑见 [office-preview-acceptance](./office-preview-acceptance.md)，真实格式样本只验证 PDF 签名，Q5 组合闭环尚未覆盖 |
| 开发机上进程越跑越多 / `ps` 里一堆看不出归属的 node | `scripts/check-stray-runtimes.sh`（探针残留即 FAIL，`--strict` 连自家 Node/Runtime/E2E 一起清；判定力用 `--self-test` 自证）；两处修复的形态与实测见 [stray-runtime-hygiene-acceptance](./stray-runtime-hygiene-acceptance.md) |
| 来源绑定被拒 / 撤销后仍能同步 / 权限水位不变 | `hub.context` 的 `source.*` → `project_source` 的 status/permissionState/authorizationGeneration → `source_collection_lease` → `source_audit_event`；复跑见 [project-source-lifecycle-acceptance](./project-source-lifecycle-acceptance.md) |
| 疑似泄露 | 直接跑 `scripts/secret-scan.sh` 扫相关证据与日志 |
| 性能回归疑云 | `pnpm test:load`（Q8 短档）报告 JSON：传播/ingest p95、空闲段 RSS 斜率、droppedConnections；判据/边界见 `docs/agent/load-performance-acceptance.md` |

## 绝不进入证据的东西

密码、Setup/Invite/Device Token、模型密钥、绝对路径、完整 DSH Session JSONL、未发布 Artifact 正文（04 文档 §9）。

## 操作条件（#319）

提交验收提示与行为不一致：先查 hub.task 的 reviewEligibility 与 web.task 条件解析；处理人未知查成员名录；复跑与取证见 [action-conditions-acceptance](./action-conditions-acceptance.md)。

## 首次执行准备（#320）

准备检查无法确认：先查hub.device连接/Node版本与node.preparation；缺项查本机registry/SecretStore；旧结果被复用查web.preparation的版本/目标scope。复跑与证据见[execution-preparation-acceptance](./execution-preparation-acceptance.md)。

## 指令授权撤销（#321）

撤销后仍驱动：先查hub.task-grants、作者启用态与Outbox attempt_count；拒绝消息长期pending查状态结算/事件；旧页权限不变查web.execution真实帧失效。复跑见[instruction-revocation-acceptance](./instruction-revocation-acceptance.md)。

### 交付输入快照（#325）

输入集合漂移先对照GET /runs/:id/input-manifest与Node同源清单，查hub.run创建事务；旧未知409是明确的兼容边界。Node下载/摘要校验查node.artifact，再查runtime.bridge输入。复跑见run-input-snapshot-acceptance，证据artifacts/evidence/operation-flow-batch3/input-snapshot/。

### 产出复核入口（#326）

所选材料与运行不符时先比对web.delivery.review中的artifactId和GET /runs/:id/input-manifest；新发布不得替代旧输入。无权/活跃阻塞查web.execution，准备与审批仍沿原链。复跑artifact-review-entry-acceptance，证据artifacts/evidence/delivery-review/。

### 意见修订与人工验收（#327）

修订误接Reviewer先查web.delivery.revision的producerRunId、实际请求intent及Run血缘；材料看新Run固定manifest与旧Reviewer清单对比。状态应由新Run将in_review退回in_progress，done仅由真人complete命令产生。复跑delivery-revision-acceptance，证据artifacts/evidence/delivery-revision/。

## 第四批个人行动投影

个人队列错项/缺项先看hub.task的GET /tasks/attention与Session身份、对象状态；严格响应判据见personal-attention-acceptance。设备输入与运行状态沿原node/runtime证据地图；脱敏日志位于artifacts/evidence/operation-flow-batch4/input-projection。

首页个人待办/最近任务不更新：先对hub.task响应与web.query事件失效键，再看WS重连和候选可见页轮询；动作未定位先看web.route锚点与异步审批事件。复跑见attention-entry-acceptance，证据入operation-flow-batch4/home-entry。

## 第四批组合验收

个人入口五类动作/隐私/实时失效：先看web.attention的personal-attention/result.json，再运行verify-attention-evidence；断点按attention-trial-acceptance定位到web.realtime、hub.task/approval/artifact或runtime.bridge。脱敏组合包位于artifacts/evidence/operation-flow-batch4/trial-validation。真人记录独立使用operation-flow-trial-template.json，not_run不能写成PASS。

## 第五批执行准备往返

离开任务后丢稿、串任务/身份、待发请求重复：先看web.execution.draft的AppShell会话作用域与mode/source/owner绑定，再对HTTP载荷和幂等键。复跑execution-draft-acceptance；脱敏证据入operation-flow-batch5/draft，不记录草稿正文、秘密和本机路径。

准备页无返回/回错任务先看web.route的preparationTask与当前会话已访问上下文；返回后仍用旧授权/设备则看web.query首次重读与web.execution阻塞。复跑preparation-return-acceptance，证据入operation-flow-batch5/return；准备快照不进入草稿，协作者仍不探查责任人现场。

首次准备往返组合证据：web.preparation.return → preparation-return-production-acceptance；生产原件artifacts/evidence/preparation-return/result.json，独立verify-preparation-return-evidence判定，脱敏整包operation-flow-batch5/production。逐项缺失/目标改变/导航副作用/未完成Run必须FAIL，真人结果保持not_measured。

准备验收重跑失败后仍显示成功：先核对web.preparation.return.failed-attempt；scripts/run-preparation-return.mts在Playwright前清理且非正常退出后再次失效；scripts/check-preparation-return-failed-attempt.mts覆盖导航/服务启动/收尾三段真实Playwright失败，确认旧result被失效、独立CLI拒绝。观测位于artifacts/evidence/preparation-return-failed-attempt/result.json；负向后必须重新生成成功证据，不能恢复旧文件。

聚焦工作区切换丢稿、详情遮挡或关闭不还焦：先看 web.workspace / web.route；审批与候选异常先对 hub 的受众投影。复跑 focused-workspace-acceptance；证据位于 artifacts/evidence/focused-workspace/<本次目录>，独立判定器 verify-workspace-evidence 缺事实或截图即失败。

工作区 Micro 菜单被裁切、键盘焦点或减少动态异常：先看 web.micro 定位读数；约定开关与服务端不一致先看 web.agreement PATCH 与刷新；材料勾选先看 web.execution 的输入快照。证据与复跑入口见 focused-workspace-acceptance。

抽屉重复标题、二级页层级、确认框裁切或关闭不还焦：先看 web.surfaces 的30条布局和三档确认边界；持久化权限与候选异常再看 Hub 任务 GET 与受众投影。复跑与证据 schema 见 [secondary-surfaces-acceptance](./secondary-surfaces-acceptance.md)，证据在 focused-workspace 本次目录，由 verify-workspace-evidence 独立重判。

P1-437：主题与状态核心的触发、证据、独立判定和归因见 [Agent 状态核心验收](./agent-state-core-acceptance.md)；主要组件为 `web.agent-state`、`web.agent-core`、`web.theme.cascade`、`web.theme.contrast`。


## 交付物修订闭环（#430）

固定意见/重试重复执行先查 web.delivery.revision 的 ReviewRevisionPanel/RunLauncher 请求与 hub.review 的 round 状态及 review_input.roundId。待办缺项查 hub.task 的个人身份/公开候选/最新人工结果，成员变更不授予权限。未发布新版泄露先查 hub.review 的 actor 过滤；页面不更新先查 web.query 的 artifact-revision-rounds 失效。复跑见 [revision-round-acceptance](./revision-round-acceptance.md)，脱敏摘要在 artifacts/evidence/revision-round-ui/summary.json。

## 交付闭环组合验证（#442）

修订上下文、版本隐私、人工复核、历史依据或 Office 安全回退问题，先看 [delivery-loop-acceptance](./delivery-loop-acceptance.md) 的组件归因表；生产驱动事实在 artifacts/evidence/handoff-loop/result.json，脱敏归档在 artifacts/evidence/delivery-loop。Office 档必须经 test:e2e:delivery 和独立判定，原件下载/批注可用，不能用旧转换成功记录冒充当前安全回退证据。真人劳动记录见内部体验手册，回放结果不计效率。

Office 派生预览当前暂停（ADR-0023）：看到 ISOLATION_REQUIRED 时查看 [Office 安全回退验收](./office-preview-acceptance.md)，不通过安装/指定 soffice 绕过；若仍能读取旧 PDF，优先排查 hub.artifact 的读取和旧回执路径。合成负控摘要在 artifacts/evidence/office-preview-isolation。
