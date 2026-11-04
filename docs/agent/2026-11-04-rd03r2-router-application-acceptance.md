# RD-03r2 验收：Router 决定接 Hub 承接与派工端口（#520）

- Issue：#520（母 #486 / RD-03 / M1R-A）
- 契约：ADR-0028 §17、ADR-0026 §13
- 前置：#519 受限 Router 评估（本验收不重复其隔离/读取/清理证据）
- 日期：2026-11-04
- 状态：工程验收通过；真实模型语义质量 `not_run`

## 1 本切片交付什么

本切片把「已接受的 Router 结果」接到既有工作承接与派工端口，并补齐业务 Executor 的用量账本。它不改写 #519 的评估、读取、租约与结算语义。

### 1.1 幂等应用端口

- 新表 `router_application` 以 `evaluation_id` 为主键；应用状态与意图/问题/wait/收件箱副作用同事务写入。
- `applyRouterEvaluation` 在 Task→Work 锁序下：
  1. 锁定评估行，重复调用直接返回既有应用行；
  2. 用 `rebuildRouterEvaluation` 按当前责任人、Task/约定、Mandate、来源/成果/消费/回答水位、配置版本与设备能力重建清单，摘要必须等于已接受的 `evaluationDigest`；
  3. 再复核 Task 非终态、assignment 已接受、Mandate 当前有效、ActionClass 在授权内、无活跃 Run；
  4. 失败落 `router_application.status=stale` 与稳定 `reason`，不产生意图/问题/wait/Run。
- 结果接受事务提交后尝试应用；应用失败不回滚 ack，`runRouterTick` 扫描 `completed` 且无应用行的评估补做。应用行与副作用同事务，崩溃不会留下「有意图无应用行」或反之。

### 1.2 四类提案映射

| 提案 | Hub 应用结果 | 不做什么 |
|---|---|---|
| `dispatch` | 为未覆盖来源幂等补入 `work_inbox_item`（同身份/版本/摘要复用，撤回/已交付拒绝），生成 `dispatch_intent(status='proposed')`；`autoDispatch='off'` 等待责任人确认；`existing_task` 经既有 `autoDispatchProposedIntent` 走同一端口 | 不直接创建业务 Run；不绕过来源/候选/预算复核；不把模型输出当执行权限 |
| `wait` | 写 `work_wait(status='open')`（稳定原因、恢复条件、Mandate 约束内的 deadline）；无活跃 Run 时把 work 置 `waiting(auto, router:<evaluationId>)` | 不做到期自动调度（#518） |
| `ask` | 按 ADR-0028 §8 的确定性哈希生成 `work_question`，支持 `choose_option` 与 `authorize_scope`；问题只归当前责任人 | #517 前 `authorize_scope` 回答继续明确拒绝，不降级成扩权选择 |
| `ignore` | 只写 `router_application`（含原因与引用/覆盖 refs）；不改收件箱消费状态 | 不创建意图/问题/wait/Run，不标记已消费/已完成 |

### 1.3 显式重评

- `POST /api/v1/works/:workKey/router/re-evaluate`：
  - `{waitId}`：关闭当前 open wait（`resumed`），把 work 恢复 `active`，以 `wait:<waitId>:<generation>` 作为 triggerKey 入队新评估；重复请求由 Idempotency-Key 与 digest 去重。
  - `{evaluationId}`：只接受已结束（failed/stale/skipped/cancelled）的评估，以 `retry:<id>:<attempt>` 入队。
- 回答（`choose_option` 绑定）进入下一次评估的 `answer` 清单；回答本身不执行、不派工。

### 1.4 Executor 用量账本

- Agent Profile Revision 新增可选 `inputPriceMicrosPerMillionTokens` / `outputPriceMicrosPerMillionTokens`（成对配置，进入 profileDigest）。
- 新表 `executor_usage_ledger`：每个机器 Run 一条 `reserved`、至多一条 `settled`；与 Router 共用 `coordination_budget` 的 work lifetime 与 team/project 日行。
- 派工（人工确认与自动同闸）在创建 Run 的同一事务内：
  - 预占 token：取 Agent `maxTokens` 与 work lifetime 剩余额度的较小值；无可用上限即 `budget_exhausted`；
  - 预占 cost：按 Profile 单价上限（输入/输出单价取高者）计算；单价缺失即 `executor_usage_unavailable`，不把未知费用按零处理；
  - 团队/项目日额度在 Router 配置存在时复用其上限；`calls` 为派发次数，Router 与 Executor 共享；
  - 预留失败回滚整个派工事务（包括已建 Run），再在事务外把意图落 `rejected`。
- Run 终态与结算同事务：Node 终态事件携带累计 `usage` 时按实际 token 与 Profile 单价结算；缺失时按 reserved 兜底。`run.executor_usage` / `executor_cost_micros` 留读面回溯。
- 崩溃兜底：tick 扫描「Run 已终态、ledger 仍只有 reserved」的行，按预留结算。

### 1.5 Node/Runtime 用量上报

- Node projector 聚合 DSH `assistant/message.usage` 的 input/output tokens，只随 owner 终态 `run.completed` / `run.failed` / `run.cancelled` 上行；project 受众行继续不带 token 用量。
- `ProjectedRunEvent` 的终态变体新增可选 `usage`；Hub 在终态事务内先固化到 `run.executor_usage`，再由 `applyRunStatus` 结算。
- 无 usage（本地取消、租约丢失、旧 Node）不猜测实耗，按预留兜底。

## 2 机器证据

### 2.1 新增集成用例

`apps/hub/tests/router-application.integration.spec.ts`（9 项）：

1. `applies dispatch to a proposed intent and settles the machine Run usage`：off 链生成 proposed 意图 + 收件箱条目；人工 approve/dispatch 后建 Run；reserved 行与 work 账本；`run.completed(usage)` 后 actual 结算、Run 用量与预算归零；重复应用不产生第二条意图。
2. `auto-dispatches existing_task exactly once after application`：应用后既有端口自动建一条 `origin=mandate` Run，`approvalBasis=mandate`；重复应用不建第二条。
3. `persists wait and re-evaluates explicitly without treating it as execution`：wait 行、work waiting、显式重评关闭 wait 并恢复 active，不建 Run。
4. `applies ask to the question ledger and keeps authorize_scope answers rejected`：`authorize_scope` 问题只归当前责任人；回答返回 `UNSUPPORTED_ANSWER`。
5. `applies ignore without creating intent, question, wait or Run`：ignore 无任何承接副作用，收件箱不新增。
6. `refuses dispatch application while a machine Run is active`：活跃 Run 时应用落 `stale(active_run)`。
7. `refuses dispatch proposals whose action class is outside the mandate`：越权 action class 落 `stale(action_class_forbidden)`，无意图。
8. `falls back to the reservation when terminal usage is missing`：终态无 usage 时按 reserved 结算，预算预留归零。
9. `shares work lifetime budget between Router and Executor and blocks unpriced dispatch`：同一 work 的 Router/Executor 用量共享；无单价候选被自动与人工派工共同拒绝。

`apps/node/tests/projector.spec.ts`：DSH usage 聚合只进 owner 终态事件。

### 2.2 既有用例调整

- `apps/hub/tests/router-evaluation.integration.spec.ts`：原「四类提案零业务副作用」改为「接受并恰好应用一次」；`dispatch` 因补入收件箱使下一次评估 digest 前进，测试断言新评估而非复用旧结果；`wait` 同理。原「未知 Executor 支出双向拒绝」的占位用例由本切片的真实账本用例替代。

### 2.3 门与实际结果

| 门 | 结果（2026-11-04 本机 macOS） |
|---|---|
| Q0 `pnpm check` | 通过：format / lint（0 error）/ full typecheck / boundaries / protocol generated / plugin fixture / 2506 unit+web tests |
| Q1 单元 | `pnpm test:unit` 2506 passed；Node projector 33 项含新增 usage 聚合用例 |
| Q2 集成 | `pnpm test:integration` 950 passed（93 files；含 #519 与新增 9 项） |
| Q3 DSH 契约 | `pnpm test:dsh-contract` 147 passed |
| Q6 故障 | `pnpm test:resilience` 34 passed |
| Q7 安全 | `pnpm test:security` 18 passed + secret-scan 自检/实扫 + license-check 通过 |
| Q8/Q9 | 本切片未触发；无镜像/安装面改动 |

### 2.4 单点变异

`scripts/mutate-router-evaluation.ts` 增加 A01–A07，可用 `MUTATION_IDS=A01,...` 只跑本切片：

| ID | 判据 | 变异 |
|---|---|---|
| A01 | 应用按 evaluationId 幂等 | 删除既有应用行早返回 |
| A02 | 活跃 Run 阻止第二次派工应用 | `if (false)` |
| A03 | action class 受 Mandate 限制 | `if (false)` |
| A04 | 显式重评恢复 work | `if (false)` |
| A05 | 无单价 Executor 派工 fail-closed | 删除单价缺失检查 |
| A06 | 有 usage 时按实际结算 | chargeMode 恒为 reserved |
| A07 | 共享 work token 上限 | `if (false)` |

结果：`status=pass`，A01–A07 全部 `killed`，基线前后通过、源码还原通过，见 `artifacts/evidence/router-evaluation/mutations/result.json`（`MUTATION_IDS=A01..A07` 写入同一 summary）。

## 3 取证位置

- Hub：`component=hub.router` 的 `router.result`、`router.application_deferred`、`router.application_failed`；DB `router_application`、`work_wait`、`dispatch_intent`、`work_question`、`work_inbox_item`、`executor_usage_ledger`、`coordination_budget`。
- Node：`run_event` 的 owner 终态 `usage`；本地 DSH session 事件仍是唯一模型实耗来源。
- 业务 Run：`run.executor_usage` / `run.executor_cost_micros`。
- 证据目录：`artifacts/evidence/router-evaluation/mutations/result.json`（与 #519 共用，按 mutation id 区分）。

## 4 未覆盖与边界

- `authorize_scope` 的「回答→草案→确认→新 Mandate→重评」留 #517；本切片只生产问题并继续拒绝该类型回答。
- Run 终态驱动的自动下一 Run、wait 到期自动扫描留 #518；本切片只提供显式重评端口与可去重的 wait 记录。
- 真实模型质量（是否给出正确覆盖/派工判断）保持 `not_run`；本文件只证明工程应用、围栏、账本与负控。
- Executor 费用依赖 Agent Revision 配置单价；未配置时机器派工（含人工确认）fail-closed。这是本切片的有意边界，不把未知费用按零结算。
- 单价变更产生新 Revision 与新 profileDigest；已有工作账本不因换 Agent/新 Mandate 重置。
- Linux/远端 runner 的最终门结果以 CI 实值为准；本地 macOS 结果不替代。
