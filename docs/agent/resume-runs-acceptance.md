# 切片⑤ resume 续跑全链验收

- 对应场景/门禁：Q0/Q1/Q3（本地已跑）+ Q2（integration spec 已写，本地无 Docker 由 CI 必检项跑）
- 对应 Issue：#237（ADR-0009 切片⑤，前置探针 #176）
- 上次验证：2026-09-30 · `feat/p1-237-resume-runs` · 结果 PASS（Q2 项待 CI）

## 验的是哪条用户路径

一个 Run 终态后，责任人想在**记得上文**的前提下继续说（「接着上次聊」）——不是
不带上下文重跑（rerun 已有），也不是复活旧 Run（红线）。续跑建立**新 Run**，
装载**来源 Run 的同一条 DSH 会话**（persisted load：同 session id、同日志文件
原地追加，#176 探针证明的通道）。

## 各层落点与判据

| 层 | 落点 | 判据 |
|---|---|---|
| protocol | CreateRunRequest +`resumeFromRunId`（与 rerunOfRunId **互斥**，superRefine）；run.start payload +`resumeOfRunId`/`resumeSessionId`（**成对**，superRefine）；runtime.initialize +`resumeSessionId` | roundtrip fixture ×3（含新 create-run-resume-request）；230 用例绿；生成物重跑 |
| db | migration 0007 `run.resume_from_run_id` 自引用 FK（与 rerun 列并存，互斥不在 DB 层重复表达） | migration + NewRun/insertRun 跟进 |
| hub | orchestrator 四重守卫（同 Task / 终态 / `dshSessionId≠null` / **device+workspace 全等**——ADR-0009「同 Workspace 做成机器判据」的落点）；payload 成对下发；血缘落库；RunView/TaskRoomRun 加列 | `run-resume.integration.spec.ts` 5 用例（201+血缘+payload 成对 / 非终态·无会话·跨 Task / 换 workspace 拒绝 / 双带 400 / 幂等同 Run）——**本地无 Docker，由 CI integration 跑** |
| node | run-manager：initialize 的 `dshHomePath` 指向**来源 Run** 的 home（per-run 隔离下新 home 无旧日志，persisted load 的复用前提）；`resumeSessionId` 透传 | run-manager.spec 新用例：home 含来源 runId 段、不含新 runId 段；身份透传（40/40 绿） |
| runtime-dsh | 接缝转正：RuntimeSpec+`resumeSessionId`；session-owner 参数由「探针专用」转正（产品面来自 wire，探针注入保留兼容）；bridge 期望 id = `spec.resumeSessionId ?? probe ?? 默认`，身份一致性校验（装载对不上当场抛）成为「日志不在本机/退化新建」的 fail-loud 闸 | **Q3 新增 wire 驱动探针**（不走接缝，initialize 帧字段驱动）：同 session id + 上下文命中（fromRequest 占位符解析不出即抛）；36/36 绿（既有 35 含接缝版回归） |
| web | RunActions 终态第二动作「接着上次聊」（与「重跑此 Run」共用表单、目标固定来源 Run——与 Hub 守卫互为镜像，不给换选入口）；`resumeLineageLabel`（「续跑自第 N 次运行」，与 rerun 措辞分开）；types/fixture 跟进 | run-actions.spec 2 新用例：提交体含 resumeFromRunId 且**不含** rerunOfRunId（协议互斥的 UI 面）；血缘句区分（10/10，web 全量 330 绿） |
| 文档 | 03 文档 §2.6/§4/§6.3/§7.1；CONTEXT.md Run/DSH Session 词条 | 见对应小节 |

## 关键设计回放（为什么这么放）

- **同 Workspace 是机器判据不是口头约束**：`ResumeAgentOptions` 不收 cwd，续跑的
  工作目录来自持久化 header（旧值）——换 workspace 会「工具在新目录跑、会话按旧
  cwd 续」的静默错位；换 device 连日志都没有（日志在来源设备的 DSH_HOME）。所以
  Hub 四重守卫拒绝换目标、**不静默降级**成摘要 fallback（那是后续独立组件）。
- **DSH_HOME 复用来源 Run**：`runtimeHomeFor` 按 runId 隔离，新 runId 的 home 里
  没有旧日志——wire 上 Hub 成对下发 `resumeOfRunId`（Node 解析 home）+
  `resumeSessionId`（直达装载身份），两字段少一即畸形。
- **rerun 与 resume 是两个动作**：两列血缘、两句措辞、一个互斥（协议 superRefine
  fail-closed，同请求双带 400）。
- **终态竞态无新机制**：resume 建新 Run，不触发 followup 的 `rejected(run_terminal)`
  路径；并发双发由既有幂等键 + `run_one_active_per_task` 兜底。

## 边界与未覆盖

- Q2 integration（hub 五用例）本地无 Docker 未跑——CI 必检项兜底，结果见 PR checks。
- Q5 e2e 未加 resume 场景（本地无 Docker）；全链浏览器验证待 Q5 扩用例
  （ADR-0009 切片表对⑤的 Q5 要求：续跑上下文命中）。
- 换设备的摘要 fallback（ADR-0009 决策 3 提及）是后续独立组件，本片明确拒绝。
- `run.resumed` 团队事件（ADR-0009 决策 8 列名）未加：`run.changed` 已覆盖
  列表刷新语义，单独事件的消费面（谁需要区分「新建」与「续跑」的实时通知）
  待有真实需求再立。

## 复跑

```bash
pnpm check && pnpm test:dsh-contract   # Q0+Q1（1306 用例）+ Q3（36 用例）
pnpm exec vitest run --project unit apps/node/tests/run-manager.spec.ts
# Q2：pnpm test:integration（需 Docker）
```
