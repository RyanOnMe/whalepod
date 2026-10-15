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
|---|---|
| 指令去向变化、来源续跑或草稿丢失 | `artifacts/evidence/unified-execution/result.json`：web.execution 的草稿/唯一输入 → hub.run 的血缘/来源版本/现场 → runtime.bridge 会话身份；上下文在场另外复跑 Q3 resume 契约。见 unified-execution-acceptance |
| 拒绝后无法改派或改派重试冲突 | `artifacts/evidence/task-reassignment/result.json`：web.assignment → hub.task 的 pending/assignee → command_receipt → 新 Run 的 owner/device |
| Run 状态不动 | hub.outbox 是否派发 → node.gateway 是否 ack → node.supervisor 是否拉起子进程 |
| 浏览器看不到进度 | hub.ws cursor 是否推进 → 浏览器是否收到 `resync.required` → hub.domain 是否产事件 |
| Run/工具/活动/发送图形与事实不符，或 Micro 窄屏溢出 | `artifacts/evidence/run-micro/<attempt>/result.json`：hub.run-projection 的 runId/seq/audience/callId/outcome/phase → web.micro/activity；HTTP outcome → web.instruction；筛选焦点/动效 → web.console；复跑 `pnpm test:e2e:micro`，见 run-micro-acceptance |
| 提示层位置/文案不对，或完成提醒开关「看起来开了但没授权」，或 toast 不消失/关不掉 | 同一份 `result.json` 的 `batch2` 段：hint 的等待与描述可达性 → web.hint；`data-on`/`data-ring`/偏好 → web.bell；fuse 时长与暂停 → web.toast；复跑 `pnpm test:e2e:micro`，见 run-micro-batch2-acceptance |
| 事件重复/缺序 | `run_event` 表 `(run_id, seq)` 是否有缺口/重复 → node spool 是否重发 |
| 审批卡住 | hub.domain `approval` 行状态 → node.gateway 决定帧 → runtime.bridge answerer |
| 候选无法检查或发布可见范围错误 | `artifacts/evidence/candidate-inspection/result.json`：web.artifact → Hub 内容读取鉴权 → artifact.store digest；复跑见 candidate-inspection-acceptance |
| Artifact 打不开 | artifact.store digest 与 DB metadata 比对 → hub.http 权限判定 |
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
