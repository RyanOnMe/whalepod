# 取证地图：出问题去哪一层找什么

> 状态：随实现推进补全。标「待建」的条目由对应 Issue 落地后更新本表。
> 总原则：按 `component` 字段分层定位，用 `runId / traceId / commandId / eventSeq` 跨层对证据；不去翻与现象无关的日志。

## 分层证据位置

| 层 (component) | 证据 | 位置 | 状态 |
|---|---|---|---|
| browser | Playwright trace + 自动证据包（hub/node/vite 日志尾、run 事实、manifest） | `test-results/**/trace.zip`；`artifacts/evidence/e2e/<attemptId>/`（P1-19 collectEvidenceOnFailure，redactText 源头归约，Node READY 行含 Token 已排除） | 生效（P1-19） |
| hub.http / hub.domain / hub.db / hub.outbox / hub.ws | 结构化 JSON 日志（stdout，含 allowlist 字段） | Hub 进程 stdout；Compose 部署走 `docker compose -f deploy/compose.yml logs hub` | 待 P1-05 起 |
| hub.db | 团队事实：Team Event、`run_event`、`outbox` | PostgreSQL 直接查；测试用 `scripts/with-test-postgres.mts` 起的临时实例 | 待 P1-04 |
| node.gateway / node.workspace / node.supervisor | Node 结构化日志、本地 spool、SQLite registry | Node 本地状态目录（`~/.whalepod-node/`；#133 定名后按本行预留调整改名，旧 `~/.project311-node/` 不再写入）；诊断走本地 Unix socket | 待 P1-09/12 |
| runtime.bridge / dsh.agent | Runtime stderr 尾部（≤8 KiB，脱敏）、NDJSON 协议帧 | Node 暂存；owner-only | 待 P1-11/12 |
| artifact.store | 内容寻址 blob、candidate 元数据 | Hub `blobs/sha256/ab/<digest>` + DB | 待 P1-15 |

## 一把捞齐

- 按 Run/场景取证（P1-18）：`pnpm phase1:evidence -- --evidence <dir> [--run <id>]`；
  驱动 `pnpm phase1:drive`、判定+归因 `pnpm phase1:verify`（exit code 即结论）。
  采集由 `scripts/lib/phase1/` 六原语 harness 完成：真 Hub+真 Node+真 Runtime+双
  Browser WS，跨层 traceId/runId 索引在证据目录的 `index.json`（按 run 一把捞齐
  四层证据计数与文件）。验收细节见 [harness-acceptance.md](./harness-acceptance.md)。
- E2E 失败自动产包：`artifacts/evidence/<scenario-id>/<attempt-id>/`，含 `manifest.json`（git commit、DSH 版本、协议版本、种子、起止时间）、`assertions.json`、`api.jsonl`、`team-events.jsonl`、`node-events.jsonl`、`runtime-summary.jsonl`、`db-snapshot.json`、双浏览器截图。
- P1-19 E2E 自动产包：`artifacts/evidence/e2e/<attemptId>/`（`hub.log.txt`/`node.log.txt`/`vite.log.txt` 三层日志尾 + `run-<id8>.json` 相关 Run 全量事实白名单 + `manifest.json` traceId/error/runIds）。控制面 `/control/tails` 与 `/control/db/run/:id` 是打包数据源；归因按 component 前缀（hub.*/node.*/runtime.*）分层。
- 任何证据离开本机或进 git 之前：`scripts/secret-scan.sh <路径>`，命中即拒（Q7）。
  绝对路径模式覆盖 macOS home、Linux home 与 tmpdir 形态（含本机 os.tmpdir()
  锚点）；模式本身的可信度用 `scripts/secret-scan.sh --self-test` 逐条语料自检（#73）。

## 现象 → 先看哪层

| 现象 | 先看 |
| Agent 未收到约定/交接正文，或接收方无法阅读固定版本 | hub.run execution-context → node.run initialize → runtime.bridge 首条模型指令；页面看 HandoffPublishedContent，复跑 handoff-context-consumption-acceptance |
|---|---|
| 下拉描边判据报错，或 hover/键盘焦点导致误判 | browser：`artifacts/evidence/select-menu/state-probes.json` 的 state/hovered/focusVisible/transitioning 与解析颜色；对应纯判定 `shared/select-trigger-tokens.ts`，复跑与负控见 [select-menu-acceptance](./select-menu-acceptance.md) #398 |
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
| Run 状态不动 | hub.outbox 是否派发 → node.gateway 是否 ack → node.supervisor 是否拉起子进程 |
| Run 被拒且提到 DSH 不兼容（或说本地版本不可知） | `node.plugin` 的 preflight 拒绝消息（两侧版本）→ 手工跑 `node apps/runtime/dist/bin.js --print-dsh-version`（无输出 = dist 过期，探针 fail-closed）→ pack 清单的 `dshCompatibility`；复跑与边界见 [dsh-compat-guard-acceptance](./dsh-compat-guard-acceptance.md) |
| Run 失败码是 `PROFILE_MISMATCH` | `runtime.ready` 帧的 `profileDigest` 回声 vs Hub 固化 Revision digest（`POST /agents` 与 revisions 两条产出路径）、Node 的 `node.run` 结构化日志；对照点语义见 [dsh-compat-guard-acceptance](./dsh-compat-guard-acceptance.md) |
| 浏览器看不到进度 | hub.ws cursor 是否推进 → 浏览器是否收到 `resync.required` → hub.domain 是否产事件 |
| Run/工具/活动/发送图形与事实不符，或 Micro 窄屏溢出 | `artifacts/evidence/run-micro/<attempt>/result.json`：hub.run-projection 的 runId/seq/audience/callId/outcome/phase → web.micro/activity；HTTP outcome → web.instruction；筛选焦点/动效 → web.console；复跑 `pnpm test:e2e:micro`，见 run-micro-acceptance |
| 提示层位置/文案不对，或完成提醒开关「看起来开了但没授权」，或 toast 不消失/关不掉 | 同一份 `result.json` 的 `batch2` 段：hint 的等待与描述可达性 → web.hint；`data-on`/`data-ring`/偏好 → web.bell；fuse 时长与暂停 → web.toast；复跑 `pnpm test:e2e:micro`，见 run-micro-batch2-acceptance |
| 事件重复/缺序 | `run_event` 表 `(run_id, seq)` 是否有缺口/重复 → node spool 是否重发 |
| 审批卡住 | hub.domain `approval` 行状态 → node.gateway 决定帧 → runtime.bridge answerer |
| 候选无法检查或发布可见范围错误 | `artifacts/evidence/candidate-inspection/result.json`：web.artifact → Hub 内容读取鉴权 → artifact.store digest；复跑见 candidate-inspection-acceptance |
| Artifact 打不开 | artifact.store digest 与 DB metadata 比对 → hub.http 权限判定 |
| 开发机上进程越跑越多 / `ps` 里一堆看不出归属的 node | `scripts/check-stray-runtimes.sh`（探针残留即 FAIL，`--strict` 连自家 Node/Runtime/E2E 一起清；判定力用 `--self-test` 自证）；两处修复的形态与实测见 [stray-runtime-hygiene-acceptance](./stray-runtime-hygiene-acceptance.md) |
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
