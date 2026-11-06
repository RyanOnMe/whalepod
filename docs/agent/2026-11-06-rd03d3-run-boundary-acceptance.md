# RD-03d3 验收：Run 终态复核与 wait 到期重评（#518）

- Issue：#518（母 #486 / RD-03d / M1R-A）
- 契约：ADR-0028 §17.1、§17.3；ADR-0026 §13
- 前置：#519（受限模型评估闭环）、#520（决定应用/显式重评端口）；#517 已独立交付
- 日期：2026-11-06
- 状态：工程验收通过；不涉及真实模型语义质量（`modelQuality=not_run`）

## 1 本切片交付什么

本切片把「Run 终态」和「wait 到期」接进既有 Router 评估入口，但没有把确定性
通知/到期扫描冒充语义覆盖判断：

- Run 终态事务只落**边界复核标记**，真正的重评在 Router tick 的受控后续事务中完成；
- wait 到期由扫描关闭并触发一次**可去重代次**的重评；
- 是否形成 `dispatchIntent`、是否自动下一 Run，仍由受限模型提案与 Hub 两次裁决决定；
- 「有收件箱条目」「Run 结束」「wait 到期」本身都不直接创建意图、问题或 Run。

### 1.1 数据与仓储

- migration `0042_rd03d3_run_boundary.sql` 新增 `work_run_boundary`：
  - 每个机器 Run 至多一条（`run_id` 唯一），重复终态收敛/重启补写天然幂等；
  - 保存 project/work/task 引用、`work_key`、`run_id`、principal、`status`
    (`pending/enqueued/skipped`)、`trigger_key`、`evaluation_id`、`reason`；
  - check 约束钉住各状态字段组合、workKey 格式、trigger 长度与稳定 reason 形态。
- `packages/db/src/repositories/work-boundary.ts`：插入/取行/锁行/列待处理/标记
  enqueued/skipped；`listExpiredOpenWorkWaits` 的到期谓词改为 Drizzle `lte`
  （原实现把 `Date` 直接塞进 raw SQL，postgres-js 绑定会报
  `ERR_INVALID_ARG_TYPE`；本切片第一次真正调用它时暴露并修正）。

### 1.2 Run 终态复核

- `applyRunStatus` 的终态分支（completed/failed/cancelled/lost）在机器 Run
  （`origin='mandate'` 且 `workKey` 存在）上写一条 `pending` 边界标记；
  不调用模型、不建意图/Run、不改 Run 的 `workInputManifest`/快照。
- Router tick 的 `processRunBoundaries` 在每条边界自己的事务里：
  1. 锁边界行并复核仍为 `pending`（并发 tick 只有一个生效）；
  2. 复核 work 未退休、Run 仍绑定该 work/Task、Task 非终态、assignment accepted、
     责任人未漂移、work active、非 `full_access`、无活跃 Run；
  3. 复核最新 Mandate 是当前 active 未过期版本，且主体仍为当前 assignee；
  4. 复核成员启用、Router 配置启用且主体一致、协调器未暂停；
  5. 从该 Run 的派工意图 `triggerRefs` 取触发来源（来源不可读/不在 Mandate 范围
     时跳过，不伪造替代来源）；
  6. 以 `run-terminal:<runId>` 调用既有评估入队端口。
- 边界跳过一律记稳定 reason（`work_retired`、`task_terminal`、
  `assignment_not_accepted`、`owner_changed`、`work_not_active`、`full_access_task`、
  `active_run`、`mandate_inactive`、`mandate_principal_changed`、
  `assignee_inactive`、`router_unavailable`、`router_principal_changed`、
  `coordinator_paused`、`no_trigger_source` 等），不进入模型评估。
- `run-terminal:<runId>` 进入 `evaluationDigest`；同一 Run 的重复扫描复用同一
  评估（`findRouterEvaluationByDigest`），边界状态推进又提供一层幂等。

### 1.3 wait 到期重评

- `runRouterTick` 每轮扫描 `work_wait(status='open' and deadline_at <= now)`：
  - 按 Task → Coordinator → Work → wait 的既有锁序加锁并复核仍 open/已到期；
  - 仍有活跃 Run 时保持 wait open（不提前生产 ask/问题）；Run 终态后的下一轮 tick
    再处理；
  - 关闭为 `expired`；只有 work 正等待该 wait（`resumeCondition='router:<evaluationId>'`）
    时才恢复 `active`，别的等待条件不被顺手清掉；
  - 以 `wait-expiry:<waitId>:<generation>` 触发新评估；代次进入
    `evaluationDigest`，重复扫描因 wait 已不是 open 自然收敛。
- 到期后的结果仍由 #520 应用：`dispatch` → proposed 意图/自动派工；`wait` →
  新的 open wait；`ask` → 带 `decisionId` 的问题；`ignore` → 收口。本切片
  不生成确定性问题，也不把「到期」当作必须执行的证据。
- 新的 `ask`/`ignore` 结论会关闭旧 open wait（`superseded`）并恢复 work；
  与 `dispatch`/新 `wait` 的既有收口一致，避免旧 wait 到期后再触发一次重复评估。
  `ask` 先校验 `blockedDecision` 并落问题，再收口 wait：非法提案只落 stale，
  不能把仍有效的 wait/恢复条件一起毁掉。
- 当前 open wait 的 `evaluationId` 进入 `work` 清单条目与 `evaluationDigest`
  （rules `rd03r1.v2`）：新 wait 出现后，更早的已接受结果在重建时会因
  `waitEvaluationId` 变化被拒绝，不能在旧结论上关闭新 wait。

### 1.4 观测

- `hub.dispatch` 结构化日志（不含来源正文/模型摘要）：
  - `work.run_boundary.enqueued`：runId/workKey/evaluationId/triggerKey；
  - `work.run_boundary.skipped`：runId/workKey/reason（入队竞态时附稳定 errorCode）；
  - `work.wait.expired`：waitId/workKey/evaluationId/reason，或跳过时的
    `skip=router_rejected` + errorCode；
  - `work.decision.applied`：evaluationId/workKey/decision/status/reason/intentId/
    questionId/waitId；
  - `work.dispatch.auto`：evaluationId/workKey/intentId/runId（下一 Run）。
- 集成用例断言边界 enqueue/skip 日志字段，并断言日志串不含来源正文。

## 2 机器证据

### 2.1 集成用例

`apps/hub/tests/run-boundary.integration.spec.ts`（17 项，生产 HTTP + WS + 真实 PostgreSQL）：

1. `enqueues exactly one boundary review after a machine run terminal and dispatches the next Run only for a new uncovered input`：
   Run 活跃期间新增输入 → 终态后并发两次 tick 只产生一份边界评估；模型把旧输入
   标为 covered（引用已发布成果）、新输入标为 uncovered → 自动创建第二台机器
   Run；旧 Run 的 `workInputManifest` 不变，下一 Run 重新冻结输入；重复 tick 不
   产生第三台。断言边界日志字段且不含来源正文。
2. `does not create a next Run when the boundary decision says the new input is already covered`：
   `ignore` + covered → 无意图/问题/wait/新 Run，work 保持 active。
3. `leaves a boundary dispatch as a proposed intent when autoDispatch is off`：
   边界评估产生 dispatch 但 `autoDispatch='off'` → 意图保持 proposed，无新 Run。
4. `skips the boundary review when the mandate is no longer active`：
   暂停 Mandate → 边界 `skipped(mandate_inactive)`，无评估/Run。
5. `skips the boundary review when the task reaches a terminal state`：
   Task 取消/工作退休 → `skipped(work_retired)`。
6. `skips the boundary review when a terminal Task still has an active work`：
   防御窗口（终态 Task + 未退休 work）→ `skipped(task_terminal)`。
7. `skips the boundary review when the Router is disabled`：
   Router 配置停用 → `skipped(router_unavailable)`。
8. `skips the boundary review while another Run is active`：
   并发窗口内存在活跃 Run → `skipped(active_run)`。
9. `skips the boundary review when a reassignment has not been accepted`：
   Task 改派未承接 → `skipped(assignment_not_accepted)`。
10. `closes an expired router wait and re-evaluates it exactly once`：
    到期 wait 关闭 `expired`、work 恢复 active、只产生一份 `wait-expiry` 评估；
    重复 tick 不产生第二份。
11. `turns an unresolved expired wait into one question instead of a Run`：
    到期重评得到 `ask` → 一个带 `decisionId` 的开放问题，无 Run；重复 tick 不
    产生第二个问题/评估。
12. `does not touch a wait whose deadline has not arrived`：
    未到期 wait 保持 open、work 继续等待、不产生新评估。
13. `keeps an expired wait until the active Run ends`：
    活跃 Run 期间到期 wait 保持 open、不产生评估；Run 终态后的下一轮 tick 才
    关闭并重评。
14. `supersedes an open wait when a newer evaluation applies an ask`：
    新评估的 `ask` 关闭旧 wait 并恢复 work；旧 wait 的 deadline 过后重复 tick
    不再触发评估。
15. `refuses to apply an older decision after a newer wait replaces the open wait`：
    模拟「结果已接受、应用提交前崩溃」；新 wait 替换旧 wait 后，旧 ignore 重建
    digest 因 `waitEvaluationId` 变化落 `stale(input_or_authority_changed)`，
    不能关闭新 wait。
16. `does not create a next Run when the lifetime run budget is exhausted`：
    `maxRunsPerWork=1` → 边界评估仍可应用，但自动派工终态拒绝
    `max_runs_exhausted`，不产生第二台 Run。
17. `does not schedule a boundary for a human Run terminal`：
    人建 Run 终态不落边界标记。

### 2.2 门与实际结果

| 门 | 结果（2026-11-06 本机 macOS） |
|---|---|
| Q0 `pnpm check` | 通过：format / lint（0 error）/ full typecheck / boundaries / protocol generated / plugin fixture / 2506 unit+web tests |
| Q2 `pnpm test:integration` | 990 passed（96 files；新增本切片 17 项） |
| Q7 安全 | 18 passed + secret-scan 自检/实扫 + license-check |
| Q3/Q6 | 未触发：无 DSH/Runtime/Node 改动 |
| Q5/Q8/Q9 | 未触发：无 Web/镜像/安装面改动 |

### 2.3 单点变异

`scripts/mutate-router-evaluation.ts` 增加 S18–S28（11 条），基线套件加入本切片 spec：

| ID | 判据 | 变异 |
|---|---|---|
| S18 | 只有机器 Run 落终态边界 | 去掉 `origin='mandate'` 条件 |
| S19 | 有活跃 Run 不得复核派工 | 关闭 `active_run` 检查 |
| S20 | 改派未承接不得复核 | 关闭 `assignment_not_accepted` 检查 |
| S21 | 已退休工作不得复核 | 关闭 `work_retired` 检查 |
| S22 | 需要当前 active 未过期 Mandate | 关闭 `mandate_inactive` 检查 |
| S23 | 到期 wait 只关闭一次 | 跳过 `closeWorkWait` |
| S24 | 到期代次按 wait/generation 去重 | triggerKey 去掉 generation |
| S25 | 到期只恢复它自己挂起的 work | 关闭恢复条件 |
| S26 | 新 ask 收口旧 wait | 跳过 `supersedeOpenRouterWait` |
| S27 | 只扫描已到期的 open wait | 到期谓词改为永不命中 |
| S28 | Run 终态代次按 Run 稳定去重 | triggerKey 去掉 runId |
| S29 | 终态 Task（即使 work 未退休）不得复核 | 关闭 `task_terminal` 检查 |
| S30 | Router 停用不得复核 | 关闭 `router_unavailable` 检查 |
| S31 | 活跃 Run 期间不处理到期 wait | 关闭活跃 Run 检查 |
| S32 | 新 wait 围栏更早的已接受结果 | `waitEvaluationId` 固定为 null |

结果：全量变异为 65 条（含本切片 15 条），全部 `killed`；基线前后通过、源码还原通过。见
`artifacts/evidence/router-evaluation/mutations/result.json`。

## 3 取证位置

- Hub：`component=hub.dispatch` 的 `work.run_boundary.enqueued` /
  `work.run_boundary.skipped` / `work.wait.expired` / `work.decision.applied` /
  `work.dispatch.auto`；DB `work_run_boundary`、`work_wait`、`coordination_evaluation`、
  `router_application`、`dispatch_intent`、`run`。
- 集成用例：`apps/hub/tests/run-boundary.integration.spec.ts`。
- 变异：`artifacts/evidence/router-evaluation/mutations/result.json`。

## 4 未覆盖与边界

- **模型语义质量未验证**：covered/uncovered/unknown 是否语义正确仍 `not_run`；
  本切片只证明「只有有效 dispatch 提案才会形成意图/Run」的工程链。
- **unknown 不续跑**：`dispatch` 提案含 unknown 时 #519 接受端已拒绝；
  `ignore` 含 unknown 同样拒绝；`wait`/`ask` 可携带 unknown。本切片未放宽。
- **边界一次触发**：`router_unavailable`、`assignee_inactive`、`no_trigger_source`
  等跳过是终态记录；设备/配置恢复后需成员补充输入或显式重评，不会被 tick 无限
  重试。重启恢复覆盖仍为 `pending` 的边界与已入队/已派发的评估；若评估在
  `queueExpiresAt` 前设备始终离线而被 `skipped(stale_queue)`，不会自动重排，
  成员补充输入或显式重评恢复（`router.evaluation` 日志留有 failureCode）。
- **同一 tick 的触发竞态**：Run 终态与入口慢路径在同一 tick 竞争时，#520 的
  `input_superseded` 收口可能让边界记录指向被取消的评估；实际重评由胜出的
  新代次完成，输入集合仍是最新事实。验收不把边界行当作唯一执行凭据。
- **迟到回执**：沿用 ADR-0028 §3 的 `unconfirmed`/60s 窗口与迟到对账语义；本切片
  不修改 Run 快照、不复活 Run、不因迟到回执重派。窗口内 `consumed`、窗口后
  `duplicate`/`duplicate_consumption` 的既有判据在
  `apps/hub/tests/work-input-manifest.integration.spec.ts` 覆盖，本切片不重复实现。
- **到期后无法重评**：Router 配置缺失/停用、Mandate 失效时不生成确定性问题，
  只关闭 wait 并记录 `router_rejected`；责任人可补充输入或显式重评。
- 真实模型质量、真实租户/平台与真人效率保持 `not_run`。
