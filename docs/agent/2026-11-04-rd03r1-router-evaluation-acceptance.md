# RD-03r1：既有工作的模型 Router 受限评估验收

- 对应 Issue：#519；母 Issue：#486；契约：ADR-0026 §13、ADR-0028 §17。
- 相关质量门：Q0/Q1、Q2、Q3、Q6、Q7。
- 最终生产装配回放：2026-11-04 12:34:20.232（Asia/Shanghai），九场景及独立判定 PASS；最终代码提交 `8fabd08c755789420e3c3b6654c96a9057f3ebd3`，验收文档随后归档。
- 本文登记工程回放；真实模型语义质量保持 `not_run`。

## 验的是哪条用户路径

当前责任人已有 Task、工作和有效 Mandate。内部 Task 讨论、上下文条目或带原因的退回进入无有效订阅的慢路径后，Hub 冻结当前可读的输入清单，预留额度，交给显式配置的协调 Node。Node 通过独立 Runtime broker 和受内核禁网约束的 worker 读取清单、调用配置的模型端点并返回提案。Hub 重新核验主体、授权、输入、租约、读取与用量，保存合法提案，独立结算费用。

本切片止于被接受的 `dispatch / wait / ask / ignore` 提案。它不应用提案，不产生业务 Run、`dispatch_intent`、`work_question` 或新 Task。提案接入业务端口由 #520 实施。

## 驱动与生产装配

```bash
pnpm -r --if-present build
pnpm exec tsx scripts/run-router-evaluation.ts
pnpm exec tsx scripts/verify-router-evaluation.ts artifacts/evidence/router-evaluation/result.json
pnpm exec tsx scripts/mutate-router-evaluation.ts
scripts/secret-scan.sh artifacts/evidence/router-evaluation
```

`run-router-evaluation.ts` 启动真实 PostgreSQL、经包名解析的生产 Hub server、Node CLI bin 和 Runtime bin。团队初始化、邀请/配对、项目/Task/工作/Mandate、讨论/订阅及撤销均走生产 HTTP/WS；Node 使用独立配置与状态目录，通过 CLI 写入协调专用配置和凭据。SQL 只读取验收事实，不直插业务运行状态。确定性模型回放只替换 provider HTTP 出口，仍经过 broker 的实际网络请求、响应解析、usage 计算和隔离 worker。

有效订阅路径由普通讨论事件驱动，必须直达收件箱且 provider 调用为零。慢路径必须有实际模型请求、worker 输入读取、Hub 接受或拒绝以及费用结算，不能以 `work_entry_router_call` 单独证明模型已运行。

## 观测与判定

独立判定器消费 `result.json` 与同目录的 `events.jsonl`，缺文件、缺场景、缺评估、缺账本、零次慢路径调用或缺清理事实均失败。最终生产回放记录如下，复跑保留同一组判据。

| 场景 | 必须观察到的事实 | 最终结果 |
|---|---|---|
| dispatch | 一个模型请求，读取清单，`completed` 且提案为 dispatch | PASS，读取 5 项 |
| wait | 一个模型请求，读取清单，`completed` 且提案为 wait | PASS，读取 5 项 |
| ask | 一个模型请求，读取清单，`completed` 且提案为 ask | PASS，读取 5 项 |
| ignore | 一个模型请求，读取清单，`completed` 且提案为 ignore | PASS，读取 5 项 |
| missing_citation | 模型确实调用，非法引用结果失败，不保存成功提案 | PASS，`invalid_citation` |
| missing_usage | 模型确实调用，缺 usage 不接受，按预留保守结算 | PASS，`usage_missing` / `reserved` |
| fast | 有效订阅事件确实交付，模型调用数恰为零 | PASS |
| revoked | 模型启动后撤销 Mandate，迟到结果不能成为成功提案 | PASS，`stale` |
| restart | 模型启动后强杀 Node，再启动恢复；同一次评估不重放模型 | PASS，`node_lost`，调用数仍为 1 |

这次回放产生 8 个 Router 评估，每个恰有一条 reserved 和一条 settled 账本；`reservationsRemaining=0`、`privateInputsCleaned=true`。额外 Task、业务 Run、派工意图和人工问题均为 0。已知 usage 按实际结算；usage 缺失与崩溃不把未知支出当作零。

Hub HTTP/WS 集成测试另覆盖同输入并发/幂等、错误 attempt/lease、没有实际读取或模型启动标记、缺/伪造引用、覆盖不全与 unknown 派工、超出 Mandate 的 wait、配置/能力/责任人/授权变化、超时、取消、迟到、终态不可覆写与历史私有读面。DB 集成测试验证共享预算竞争、预留回滚、幂等结算、跨 UTC 日沿原 reserved 日期结算及全局团队策略。Node 恢复回归覆盖 12 项：正常 finish 后也须确认 PID 与整个 PGID 退出再清理；进程身份未知或权限不足时保留 cleanup pending，目录清理要求有效 evaluation UUID 和安全正整数 attempt。Router 私有历史禁用共享及持久缓存。用例数和验证结果见下表。

## 隔离与费用边界

协调配置、凭据槽和费用承担者均须显式匹配；不继承业务 Run 的 secret namespace。worker 不装载 Agent、Session、Plugin Pack 或审批 answerer，模型调用使用空工具面；broker 持有 provider 凭据并只访问配置端点，拒绝重定向。worker 环境不含 provider key、Device Token、代理变量或 `NODE_OPTIONS`，文件读取仅放行代码依赖和本次输入副本，文件写入与子进程能力不放行。macOS 使用内核网络策略，Linux 使用 seccomp；不支持的平台不声明协调能力，不降级启动。

真实 bin 契约验证：隔离外 provider 正控可达；同 worker 内 IPv4/IPv6 socket 必须得到内核拒绝，连接被拒绝不能冒充隔离成功；工具返回、正文/摘要漂移、缺文件、符号链接、非法编码、超限、缺凭据、重定向、usage、取消与启动确认都有拒绝判据。Router 真实 bin 契约共 48 项，覆盖 30 个工具名的逐项负控，逐能力与实际工具面检查已落实。macOS 已实跑；Linux 验证由 Ubuntu CI 执行：Q3 在必检 `check` 中，生产回放在必检 `integration` 中，证据上传前先扫描。

预算按 team/project 日额度和 work lifetime 额度同时预留，calls 指派发次数。结果 stale/拒收仍保留实际 usage，缺 usage 保守结算；仅明确确认模型未启动的输入/凭据准备失败可零 token/cost 结算。重试、新评估 digest、新 Mandate 或跨日均不重置工作用量。Router 不计入 `maxRunsPerWork`；已派发且有费用风险的 Router 失败与机器 Run 失败共同受 `maxAttempts` 限制。

Executor token/cost 账本与提案应用已由 #520 / RD-03r2 补齐；本切片原先的双向 `executor_usage_unavailable` 拒绝边界已被真实 `executor_usage_ledger` 与 `router_application` 取代。本文件保留 #519 当时的评估、读取、隔离与结算证据；提案未被应用的边界不再适用，见 [RD-03r2 验收](./2026-11-04-rd03r2-router-application-acceptance.md)。

## 分层归因与取证

| 现象 | 先看哪层与事实 |
|---|---|
| 有慢路径记录但没有模型请求 | `hub.work_entry` 的 call `evaluation_id/resolved_at/resolution_reason` → `hub.router` 的评估 status/failureCode → Node 能力与协调专用槽 |
| 提案被拒收 | `hub.router` 的 `router.result`，关联 evaluationId/attempt；对照清单、读取、modelStartedAt、当前授权与 lease/deadline |
| Node 重启或断线后重复调用 | `node.coordination` 的 `runtime_started/orphan_reconciled/evaluation_terminal`；本地 `coordination.sqlite` 的 attempt 身份、模型启动标记和结果发件箱 |
| 隔离或 provider 失败 | `runtime.bridge.coordination` 的 `worker_failed`；Q3 真实 bin 的分类失败码与内核网络探针；broker 私有 stderr 不投影原文 |
| 预留没释放或费用重复 | `coordination_usage_ledger` 的 evaluationId/attempt/phase、chargeMode 与 reserved 的 utcDate；`coordination_budget` 对应三层 scope |
| 私有输入残留 | Node journal 的 cleaned 与 cleanup_pending；本次 `coordination-home` 输入目录，退出后删除，删除失败进入重试 |

脱敏证据位于 `artifacts/evidence/router-evaluation/`，不提交原始正文、凭据或本机绝对路径。成功记录为 `result.json` 和 `events.jsonl`；失败时驱动删除旧 result，并写入已脱敏 `failure.log`。变异结果写入 `mutations/result.json`。该目录被 git 忽略；CI 不论验收成功或失败均先扫描再上传同目录，secret scan 失败则拒绝上传。证据离开本机前也须运行 secret scan。记录只保留不透明评估身份、状态、计数与账本模式。

## 最终质量门与变异记录

| 门 / 检查 | 结果 | 证据 / 数量 |
|---|---|---|
| Q0/Q1 `pnpm check` | PASS | 最终本地 231 文件 / 2504 项，12:33:39（Asia/Shanghai） |
| Q2 `pnpm test:integration` | PASS | 首次 Ubuntu CI 全量 92 文件 / 942 项（run 41771845277）；最终本地 Router 定向 37/37，含新增 6 项费用、覆盖与结果负控 |
| Q3 `pnpm test:dsh-contract` | PASS | 25 文件 / 147 项；Router 真实 bin 48 项，30 个工具名逐项负控 |
| Q6 `pnpm test:resilience` | PASS | 6 文件 / 34 项 |
| Q7 `pnpm test:security` | PASS | 4 文件 / 18 项；敏感扫描 11 条语料自证和实扫、626 项依赖许可均通过 |
| 最终生产装配九场景与独立判定 | PASS | `result.json`、`events.jsonl`，8 个评估 / 9 个场景 |
| 关键判据单点变异并恢复 | PASS | 26/26 被断言杀死；前后 Hub 37/37、Node 恢复 12/12，合计均 49/49 |
| 最终 secret scan / diff check | PASS | 所有改动文件及证据扫描通过，diff 检查通过 |

变异证据 `mutations/result.json` 生成于 2026-11-04 12:31:46.021（Asia/Shanghai）；每项均以退出码 1 和目标断言失败杀死，前后基线均通过。三份源文件均已恢复，SHA-256 分别为：

- `apps/hub/src/modules/router/service.ts`：`fecab0c5e4799aee9608be533aa6553e4d089380c866f2f7ad8d5298bf0036c1`
- `apps/node/src/coordination/manager.ts`：`d5047d6cb7ca9aebaa762c9c90f11e5b92e288a0ad275437568148127467ab5c`
- `apps/hub/src/modules/router/routes.ts`：`eee8c183f94dfb6cd4efdca2efd1fbd67ec72422e90276623e4f3e3b822cce07`

| ID | 移除的守卫与命中的失败断言 |
|---|---|
| R01 | 完成结果必须有 usage；缺 usage 被拒并结算、不保存提案 |
| R02 | 引用必须指向已读取清单条目；伪造引用被拒并结算 |
| R03 | 结果评估身份必须匹配；错误 digest 被拒并结算 |
| R04 | lease 不可伪造；错误 lease 被拒且不消耗有效 attempt |
| R05 | 结果必须属于对应 attempt；错误 attempt 被拒且不消耗有效 attempt |
| R06 | 重建输入后重查期限；重建期间到期的 lease 被拒 |
| R07 | unknown 覆盖不能 dispatch；对应结果被拒并结算 |
| R08 | 当前授权与配置约束结果接收；模型配置变化后的旧结果被忽略 |
| R09 | wait 不得超出 Mandate 期限；任意延长期限被拒 |
| R10 | 缓存命令读取需重新授权当前责任人；改派后重授权并隐藏旧主体历史 |
| R11 | 同身份并发命令复用评估；并发和重投去重且不重复预留 |
| R12 | 模型启动需要全部输入读取回执；缺回执不确认启动 |
| R13 | 每个来源恰有一个覆盖判定；即使所有唯一来源齐全，重复覆盖仍被拒 |
| R14 | Mandate 版本变化不重置已计费失败；新版本保留失败次数 |
| R15 | Hub 取消本身不能证明零模型费用；无启动确认的来源取消不能证明调用免费 |
| R16 | 完成结果需要读取之后持久化的模型启动标记；读取齐全仍要求启动证据 |
| R17 | usage 不得超出预留 token 和费用；超额结果被拒并结算 |
| R18 | unknown 覆盖不能 ignore；对应结果被拒并结算 |
| R19 | 结果 digest 必须覆盖精确接受的提案；错误结果 digest 被拒并结算 |
| R20 | 已持久化终态结果不证明孤儿进程已退出；清理输入前停止所属孤儿并保留终态记录 |
| R21 | 存活进程身份未知时保留私有输入的清理 pending |
| R22 | `kill(0)` 返回 EPERM 不证明 broker 已退出 |
| R23 | 无效 journal UUID 不能授权文件清理；保持 pending |
| R24 | 私有 Router 历史禁用共享和持久缓存；检查仅 owner 可读的空历史响应 |
| R25 | 进程组仍存活时 leader 退出不能授权清理；须等待两者均退出 |
| R26 | 清理 attempt 须为安全正整数；小数及超出安全整数范围均保持 pending |

## 边界与复跑

真实模型的覆盖语义、材料中的权限诱导识别与跨模型质量尚未按开发集/保留集验证，保持 `modelQuality=not_run`。回放的 PASS 只证明工程链、围栏与计费，不证明语义正确。外部来源、提案应用、自动下一 Run、wait 到期调度、扩权确认和新建 Task/工作均不在 #519 范围。

从干净构建复跑上述生产驱动及独立判定，再运行相关质量门。首次 Ubuntu CI run 41771845277 已成功；合入要求最终 PR 提交对应的 `check` 和 `integration` 两项必检均成功。Ubuntu CI 执行真实 bin Q3、Q2/Q6/Q7、生产回放及 26 项守卫变异；回放和变异证据在扫描通过后上传。任一关键门失败不得据本机 PASS 合入。
