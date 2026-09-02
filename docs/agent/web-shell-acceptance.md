# Web 壳与 Task Room 验收（Q5 种子）

- 对应场景/门禁：Issue #11（P1-07）验收场景；Q5 浏览器门的先行单场景（Q5 全量 20 连跑待 P1-19）
- 对应 Issue：#11（P1-07）
- 上次验证：2026-08-27 · feat/p1-07-e2e-acceptance · 结果 PASS（连续 9 次全绿）

## 验的是哪条用户路径

Issue #11 验收原文：**Alice 创建 Task、Bob 在第二 BrowserContext 接受并评论；键盘可完成主链。**

真实环境全链路：一次性 PostgreSQL（随机端口随机密码，专属 label 生命周期管理）→
生产入口 `apps/hub/src/server.ts`（含 OutboxWorker/租约循环）→ vite dev server 同源
反代（`/api/v1`、`/ws/v1`）→ 真实 Chrome（channel: chrome）双 BrowserContext。
浏览器只见 5173 一个 origin，与生产同源部署同形（03 §4）。

## 驱动（怎么触发）

```bash
pnpm exec playwright test          # playwright.config.ts webServer 拉起全环境并跑场景
pnpm exec playwright test --ui     # 调试模式（可选）
```

环境生命周期（playwright webServer → scripts/e2e-serve.mts，本进程必须是 playwright
直接子进程，SIGTERM 才能到达）：

1. `scripts/lib/ephemeral-postgres.mts` 启动一次性 PG（`--label project311.e2e-postgres=true`，
   退出/被杀后的残留由下次启动按 label 自愈清理，不碰无关容器）；
2. `applyMigrations`（@project311/db 公开导出）应用迁移；
3. spawn 生产入口 Hub（PROJECT311_PUBLIC_ORIGIN 指向 web origin；Setup Token 落 0600 临时文件）；
4. spawn vite dev（5173，反代到 Hub 18080）；
5. 双端就绪后把环境清单（Hub origin、Setup Token）写到 0600 临时清单，供 spec 读取；
   Token 明文不进 git、不进日志。

## 判定（成功长什么样）

- **Alice**：真实 Setup 页（输入 Setup Token/团队名/用户名/显示名/密码）→ 项目页 →
  键盘创建项目（名称输入框内 Enter 隐式提交）→ 创建任务表单键入标题与责任人 User ID →
  Enter 提交 → 自动进入 Task Room，四区（header/assignment/comments/runs+artifacts）真实渲染。
- **Bob**：第二 BrowserContext 走真实登录页（键盘：用户名填写、密码框 Enter 隐式提交）→
  直接打开 Task URL → AssignmentPanel 显示「你被指派负责此任务，请接受或拒绝。」→
  焦点到「接受任务」按钮 Enter 激活 → 显示「你已接受此任务。」
- **留言**：textarea 键入 → Tab 到「发送留言」按钮 Enter 激活（textarea 内 Enter 是换行，
  Tab+Enter 是键盘链成立点）→ 留言出现在时间线。
- **跨会话可见性**：Alice 重载 Task Room → 看到 Bob 的留言原文与「责任人已接受此任务。」
  （非责任人视角的第三方陈述措辞；对应 AssignmentPanel 视角分支修复）+ 接受时间落位。
- **键盘可达性证据**：留言输入框 Tab 一步即达提交按钮（与 DOM 顺序一致）。

## 归因（失败先看哪层）

- 环境起不来 → `scripts/e2e-serve.mts` stderr（Hub/vite 提前退出会带日志尾部）与
  `scripts/lib/ephemeral-postgres.mts`（Docker/镜像/就绪超时）。
- 握手/权限不对 → `apps/hub/src/app.ts` Origin/Idempotency 钩子 + `auth/session.ts`。
- UI 断言不对 → 先看 `test-results/**/error-context.md` 页面快照（trace.zip 可回放）。

## 取证

```bash
pnpm exec playwright test                 # 场景本体
pnpm check && pnpm test:integration       # Q0/Q2（本次改动后 536/536 + 174/174）
bash scripts/secret-scan.sh apps/web scripts docs/agent
```

## 边界与未覆盖

- Bob 的账号经 HTTP API 以 Alice 会话开通（邀请开通 UI 不在 P1-07 范围）；Bob 登录之后
  的一切动作都走真实浏览器路径。
- Q5 浏览器门全量（连续 20 次无偶发）与更多场景随 P1-19 落地；本场景为种子。
- 浏览器实时事件（#13 已交付的 realtime 模块）接线进 Task Room 属 P1-13 组合根范围，
  本场景的可视性经显式 reload 驱动（诚实路径，不依赖轮询巧合）。

## 复跑

```bash
corepack enable && pnpm install --frozen-lockfile && pnpm -r --if-present build
pnpm exec playwright test
```

---

# P1-19 两浏览器全链 E2E 与恢复场景（Q5 正式门）

- 对应场景/门禁：Issue #23（P1-19）；Q5 浏览器门 = `scripts/q5-loop.sh 20`
  （连续 20 次完整 `pnpm test:e2e`，每轮全新冷启环境）。口径说明：`--repeat-each`
  会在同一实例内重放副本，与「一个 Hub 一次 Setup 一个团队」的产品模型架构性
  不兼容（实测副本卡死在 Setup 页），且每轮冷启本身就是被验收的路径。
- 对应 Issue：#23
- 上次验证：2026-09-02 · feat/p1-19-e2e-recovery · 结果 PASS（12/12 × 20 连跑，见下）

## 验的是哪条用户路径

Issue #23 验收原文：**两浏览器全链 + 恢复场景**——Bob 创建 Builder Run → Runtime
真起（DSH replay 子进程）→ 审批卡（两端 diff）→ 批准 → 完成 → Artifact 发布给
Alice 下载 → Alice 起 Reviewer Run 受控消费输入清单；Hub/Node 故障注入后恢复
（R1/R4/R5/R7/R8/R9）与取消/重跑（G7-01/G7-04）。

真实装配零 mock：浏览器 ⇄ vite 反代 ⇄ 生产 Hub 子进程 ⇄ 真 Node 会话（e2e-node：
WorkspaceRegistry/SecretStore/CommandStore/EventStore/RuntimeSupervisor/
DshRuntimeDriver/RunManager/startDeviceSession）⇄ 真 Runtime 子进程（apps/runtime
+ DSH replay overlay，经 `runtimeEnvPassthrough` 验收缝注入快照；该缝在生产
cli.ts 恒为空）。

## 三通道纪律（每步标注「走 UI / 走 HTTP 旁路 / 走控制面」）

| 场景 | 驱动 | 观测/判定 | 通道备注 |
|---|---|---|---|
| G5 审批卡两端 diff | Bob UI 启动 Run、焦点+Enter 批准 | Bob/Alice 两浏览器断言；403 判定走 HTTP 旁路 | 越权面（G5-02）UI 不渲染入口，仅旁路核验 |
| G6-04 发布/下载 | Bob UI 点发布、Alice UI 点下载（download 事件） | sha256 与 DB 行一致：HTTP 旁路 | 浏览器字节流与 blob 双核验 |
| G6-07 输入清单消费 | Bob UI 启动 Reviewer Run + 批准 | Node 控制面 `/input-manifest`（受理时留档） | 清单含 artifact sha、目录 runtime-inputs、不携带 Builder workspace 路径 |
| G4-04 frame diff | 两浏览器各自点选 Run 行看事件面板 | owner 行存在 / audience-owner=0 计数 | 受众过滤在服务端，UI 行类即证据 |
| R1 Hub 重启 | 控制面 SIGTERM+延迟拉起 | DB 事实（状态不丢）+ UI 批准后完成 + seq 连续 | Node 走产品退避重连，不加速 |
| R4 断 10s | 控制面 `/drop`（真 terminate + 窗口内拒连） | lease 内状态不变；重连后完成 | |
| R5 断 45s | 同上 | lease 到期 lost(RUNTIME_LOST)；重连后禁改写；UI「丢失」徽标 | |
| R7 丢 ack | 控制面 `/ack-drop`（Node 不发 command.ack） | outbox attempts≥2 且同 commandId；`/runtimes` spawnCounts=1 | 幂等判定 = 零第二 Runtime |
| R8 提交后崩溃 | 控制面 SIGKILL Hub + 延迟拉起 | worker 重启续派发：离开 queued 直至完成 | |
| R9 Node 崩溃 | 控制面 restartNode（SIGKILL 语义 + 同状态目录复活） | `/runtimes` pid → OS 级 kill 0 探活 = 死；Hub 端 lost(RUNTIME_LOST) 不复活 | recoverOrphans 真回收 |
| G7-01 取消 | Bob UI（键盘 Enter）点「取消 Run」 | DB cancelled + 进程不残留 + 终态后审批 409（旁路） | |
| G7-04 重跑 | Bob UI「重跑此 Run」+ 新指令 + 确认 | DB rerunOfRunId + 面板 lineage 文案 | 来源终态不改写 |

控制面（127.0.0.1 一次性 Token，0600 清单）只做进程生命周期与故障注入/取证，
**不执行任何产品动作**；产品动作一律走浏览器 UI 或契约 HTTP。

## 六原语对账

- **驱动**：真人路径（Chrome 双上下文、键盘 Enter、点选），旁路仅限账号开通与
  配对码（P1-07 同款登记）；恢复动作（重连/重发/回收）全由产品自身机制完成。
- **观测**：Hub/Node/Runtime 三层结构化日志（`component` 分层）+ DB run 事实白名单
  查询（run/runEvents/approvals/artifacts/outbox）+ Node 侧 pid/心跳/spawn 计数缝。
- **判定**：全部为可跑断言（状态机事实、seq 连续、sha256 一致、audience 计数、
  pid 存活），无「界面看起来正常」类判定。
- **归因**：失败时证据包含三层日志尾 + 相关 Run 全量事实 + manifest（traceId/
  test/error/runIds），按 component 前缀定位层。
- **取证**：`collectEvidenceOnFailure` 自动打包 `artifacts/evidence/e2e/<attemptId>/`
  （hub/node/vite 日志尾经 redactText 归约、run-*.json、manifest）；Node stdout
  （含控制 Token 的 READY 行）已被排除在证据外。
- **发现**（本轮实测发现，登记）：
  1. **Task Room 聚合查询（`['task-room', id]`）不在 realtime 失效映射内**：
     状态跃迁后的 Room 呈现依赖显式 reload/导航（P1-07 已按诚实路径处理，本门
     沿用）；RunLivePanel 的事件流键 `['run', id]` 是实时的。若要 Room 全实时，
     属产品改动（另立 Issue）。
  2. **心跳投影竞态**：Hub reconcile 用「30s 内最新心跳的 activeRunIds」判定
     nodeLostRun，而 Node 心跳默认 10s 一拍——run.start 受理与下一拍之间的窗口
     可把新 Run 误标 lost（E2E 实测复现）。E2E 装配已用「受理即补发心跳 +
     activeRunIds 取 supervisor∪受理 超集」把窗口压到亚秒；**产品侧建议**：Node
     run.start 受理后立即补发一拍心跳（或 Hub 对刚派发 Run 设启动宽限）。
  3. **终态 Run 的 Runtime 进程滞留**：completed 后 Node 不发 `runtime.shutdown`
     （bridge/bin 支持但无人调用），进程占容量到 supervisor 硬超时（默认 600s）。
     多 Run 复用单 Node 的场景会被 `NODE_CAPACITY_REACHED` 挡住。E2E 以
     120s 硬超时 + `/release` 回收缝兜底；产品侧值得收敛为终态即回收。
  4. **run.status_request 探针应答不 ack**：Node 回快照但不回 command.ack，
     outbox 对该行持续退避重发（观测到 attempts 10+）。功能无损，但属噪声，
     建议探针纳入 ack 或走非 outbox 通道。
  5. **webServer 进程包装泄漏**：`pnpm exec tsx` 双层包装令 playwright 只杀到
     外层，孤儿 serve 占死 18080/5173 并互相覆盖环境清单（本轮多轮失败根因）。
     已改 `node --import tsx` 单进程直启 + serve 启动自愈（comm/argv 精确判据；
     第一版 `pkill -f` 会误杀携带同样路径字样的父 shell，自伤教训）。
  6. **崩溃时机砸进「派发在途」窗口的歧义形态**（R8 早期配方实测一次）：Hub 在
     run.start 已投递、ack 未落库的毫秒窗被 SIGKILL 后，重启重发在 Node 侧呈现
     「commandStore 有记录但无处理日志、零事件、attempts 快速爬升」并最终走
     duplicate→lost 分支。属 G7-03 禁复活语义的安全侧（宁可 lost 不重放），但
     首投递为何无处理日志未成完全定论；R8 改用确定性窗口（拔线+崩溃），该形态
     保留为观察项。

## 归因速查

- 环境起不来 → `scripts/e2e-serve.mts` stderr（含提前退出的子进程日志尾）。
- Run 不动 → `/control/db/run/:id`（状态 + outbox attempts/acked）→ Node 日志
  component=node.*，再 Runtime（runtime.* 经 node 转发段）。
- UI 不更新 → 先分清「聚合 stale（需 reload，见发现 1）」vs realtime 键（面板）。

## 取证与复跑

```bash
corepack enable && pnpm install --frozen-lockfile && pnpm -r --if-present build
pnpm exec playwright test                                   # 全量 13 场景
bash scripts/q5-loop.sh 20                                  # Q5 门（20 连冷启）
pnpm check && pnpm test:integration                         # Q0/Q2
bash scripts/secret-scan.sh apps/web scripts docs/agent     # Q7 片段
```

失败证据自动落 `artifacts/evidence/e2e/`（gitignored）；trace 走
`pnpm exec playwright show-trace test-results/**/trace.zip`。
