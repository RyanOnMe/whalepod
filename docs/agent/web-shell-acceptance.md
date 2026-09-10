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
pnpm test:e2e                      # 整门全量（两项目各自冷启；单 invocation 跑双
                                   # project 会共享 webServer，第二次 Setup 必 409）
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
pnpm exec playwright test --project=p1-07 # 场景本体（单项目：双 project 单 invocation
                                          # 共享 webServer 会二次 Setup 409，全门用 pnpm test:e2e）
pnpm check && pnpm test:integration       # Q0/Q2（本次改动后 536/536 + 174/174）
bash scripts/secret-scan.sh apps/web scripts docs/agent
```

## 边界与未覆盖

- Bob 的账号经 HTTP API 以 Alice 会话开通（邀请开通 UI 不在 P1-07 范围）；Bob 登录之后
  的一切动作都走真实浏览器路径。
- Q5 浏览器门已由 P1-19 落地（`bash scripts/q5-loop.sh 20`；本场景经 projects
  拆分独立冷启，见下文 P1-19 段）。
- 浏览器实时事件（#13 已交付的 realtime 模块）接线进 Task Room 属 P1-13 组合根范围，
  本场景的可视性经显式 reload 驱动（诚实路径，不依赖轮询巧合）。
- 键盘链路的**焦点可见性**不在本场景判据内：这里判的是"键盘能不能走完主链"，不判"走的时候
  看不看得见焦点落在哪"（原 `--focus-ring` 与相邻色只有 1.53–1.81:1）。两块分开记：
  可见性已由 #164 的机器门（`apps/web/tests/focus-ring.spec.ts`）与
  [focus-ring-acceptance.md](./focus-ring-acceptance.md) 登记；渲染态确认仍待 Q5。

## 对比度门：浏览器侧 WCAG AA 扫描（Issue #159）

**为什么单开一条**：`apps/web/tests/theme-contrast.spec.ts`（#152）只在 **token 表**上
校验"我声明出来的配对"，抓不到颜色由**继承 / color-mix / 组件内部**得出的情形。两次真
发生过的回归都在它之外：`.run-live-text` 深底深字（只设了底、没设文字色），以及 #151 把
`rgb(34,197,94)`（2.28:1）当成功色钉住。所以判据必须落在**真实渲染结果**上。

- 扫描器：`apps/web/tests/e2e/contrast-sweep.ts`
  （`sweepContrast` / `findContrastOffenders` / `expectNoContrastOffenders`）。
  判据：正文级 ≥4.5:1；大字号（≥24px 或 ≥18.66px 且粗体）≥3:1（SC 1.4.3 原文如此）。
  例外只允许写进 `CONTRAST_EXEMPT` 并给出理由。
- 挂点（不新增冷启栈，全部复用 Q5 既有项目已渲染出的真实页面）：

  | 项目 | 挂点 | 取样前的等待（防假绿） |
  |---|---|---|
  | p1-142 | 未登录的 `/setup` 与 `/login` | 各等 `#setup-token` / `#login-username` 可见 |
  | p1-142 | 有设备态的 `/devices` | 等 `e2e-node` 上屏之后 |
  | p1-142 | 390×844 下 `/`、`/devices`、`/members`、`/agents`、`/plugins` 五页 | 逐页等 `.mutation-hint` 计数 0 + 该页内容节点可见 |
  | p1-142 | 折叠导航展开态 | 等链接在可访问性树里可见 |
  | p1-07 | 项目页（1280 与 390 两档）、Task Room 空态、满态（Alice 与 Bob 两侧） | 等各自的 list/空态断言先过 |
  | p1-19 | Run 实况面板可见那一刻 | 等 `run-live-events` 文本收敛 |

**判据本身防三种"假绿"**（一审逼出来的，都写进了失败信息）：
① 前景 alpha 必须合成到底色（否则 `rgba(15,17,21,.35)` 压白会被报成 ≈18.9:1，真值 ≈2.28:1——这两个数是一审独立复算后更正的）；
② 看不懂的颜色（`oklch()` 等）与无法判定的底色（渐变 / `backdrop-filter`）一律**计为失败**并列出，
不许静默放过；③ **一个文字元素都没量到**也算失败——那说明扫描点取在内容渲染之前。

**首轮跑出来的两个真实不达标（都不是误报，已在本 PR 修掉）**：

| 现场 | 实测 | 根因 | 修法 |
|---|---|---|---|
| 顶栏「退出登录」（`button.button-quiet`） | blue-600 `rgb(37,99,235)` 压 ink `rgb(15,17,21)` = **3.66:1** | #153 把 `--color-signal` 从旧亮蓝收敛到 blue-600 后，深色顶栏上的安静按钮成了"深底深蓝字" | `.app-header .button-quiet` 改用该容器自己的前景族 `--color-signal-soft`（blue-100 压 ink = **15.49:1**），并写清"深色容器给前景、按钮别自带 signal"的通则 |
| `.badge` 一族（未开始/进行中等） | blue-600 压 `--color-signal-soft`（blue-100）= **4.24:1** | 同一 token 用在两种底上：blue-600 压白达标（5.17:1），压自己的浅底就不够；green/red/amber 一族在浅底上都取 900 档，只有 blue 缺 900 档 | L1 补 `--dsw-static-blue-900`（上游 `design-platform.css` 静态段逐字 `rgb(14, 48, 116)`）→ 应用层 `--color-signal-strong`，徽标文字/描边改用它（**10.16:1**） |

两个新配对已加进 `theme-contrast.spec.ts` 的 AA 清单（**14 对**全过，最低 4.78:1）。

**门不是空的（变异/红→绿证明）**：修好之前，p1-142 与 p1-07 都因上面两条**变红**（失败信息
逐条打印 元素/文字/颜色/底色/实测比值）；`vendor-dsh-ui.spec.tsx` 的孤儿变量门做过注入变异
（加一个无消费者的 `--dsw-static-orphan-proof-999` → 变红，还原 → 绿，该文件在含 #156 的
main 上是 **56** 个用例；#156 之前是 25 个——引用计数时要说清是哪棵树）。

**已知盲区（诚实列出，当前仓库 0 命中，但它们是"未判定"而非"通过"）**：
`::before/::after` 生成的文本；`-webkit-text-fill-color`；非祖先覆盖层（浮层压住文字）；
动画中间态（单次取样，无重试）；**深色主题**（本仓无切换入口，扫描只跑浅色）；Firefox /
Safari（Q5 用系统 Chrome）；悬停 / 焦点态；非文字对比度（3:1）目前只在设备状态色块一处断言
——**焦点环就是其中一条真缺口**：`--focus-ring` = signal@40%，实测压 paper **1.77:1**、
压 ink **1.53:1**，低于 3:1，已单列 #164。

**大字号阈值已建模**：`min` 默认 4.5，但字号 ≥24px（或 ≥18.66px 且粗体）按 3:1 判——
这是 WCAG 原文判据而不是放宽，改动时不要"顺手统一成 4.5"。

## 复跑

```bash
corepack enable && pnpm install --frozen-lockfile && pnpm -r --if-present build
pnpm exec playwright test --project=p1-07   # 单项目冷启（理由见上方取证块注记）
```

---

# P1-19 两浏览器全链 E2E 与恢复场景（Q5 正式门）

- 对应场景/门禁：Issue #23（P1-19）；Q5 浏览器门 = `scripts/q5-loop.sh 20`
  （连续 20 次完整 `pnpm test:e2e`，每轮全新冷启环境）。口径说明：`--repeat-each`
  会在同一实例内重放副本，与「一个 Hub 一次 Setup 一个团队」的产品模型架构性
  不兼容（实测副本卡死在 Setup 页），且每轮冷启本身就是被验收的路径。
- 对应 Issue：#23
- 上次验证：2026-09-07 · feat/p1-19-e2e-recovery @ bdff8b1 · **Q5 PASS（20/20
  连续冷启全绿，每轮 task-room 1/1 + full-chain 13/13）**；期间门禁抓并修掉
  Docker 端口发布竞态三形态（见「发现」第 7 条），另修 chain spec 等待条件错位
  （#91/#92）。Q0 `pnpm check` 全绿；Q2 集成 283/283；CI check+integration 双绿。
  ⚠ 见「发现」0/2/3 条：Q5 绿在装配兜底下取得，产品缺陷分账 #87/#88/#89/#90
- **后续更正（#89，2026-09-07）**：上述「装配兜底」中 **Workspace 投影一支已删除**
  ——`scripts/e2e-node.mts` 不再自行拼发 `node.inventory`，`scripts/lib/phase1/chain.ts`
  不再直插 `schema.workspaces`；投影改由产品侧 session 层上报、cli 注入事实源建立。
  删缝后 `pnpm test:e2e` **连 3 轮全绿**（每轮 task-room 1/1 + full-chain 13/13）。
  **边界说清**：上面那个 20/20 是在**缝尚未删除**的 bdff8b1 上取得的，不得当作删缝
  后的证据；Q5 二十连按口径属发布门，P1-20 会在无兜底的树上重跑。#88/#90 两条
  分账**状态不变**（均未修）。
- **后续更正（#87，2026-09-09）**：「装配兜底」中**心跳竞态一支已删除**——产品侧
  正解为 Hub reconcile 新生儿宽限（PR #122，活 Run 不再被心跳窗口误判 lost）+
  Run 出生时间走领域时钟；`scripts/e2e-node.mts` 的 monkey-patch（受理即补发心跳
  + `activeRunIds` supervisor∪受理超集 + 心跳加密 2s）按账体约定全删，E2E 直面
  真实 10s 心跳节奏。删补丁后 `bash scripts/q5-loop.sh 20` **20/20 连续冷启全绿**
  （每轮 task-room 1/1 + full-chain 13/13，轮次日志 `artifacts/q5/run-*.log`），
  其中含 R5 lost 判定场景——竞态原复现路径（约五成概率）20 轮零复发。#87 关账。
- **后续更正（#88，2026-09-09）**：「装配兜底」中**容量/回收一支已删除**——产品侧
  修复两腿：① Node 在终态单一收敛点（finalizeRun）下发 `runtime.shutdown`
  （协议帧，bridge/bin 收敛后 EOF 退出），宽限内不退升级 SIGTERM→SIGKILL，
  supervisor 6h 硬超时降为最后兜底；② Hub 心跳见「已终态 Run 仍报 active」
  入队 admin run.cancel 收敛 Node 侧滞留 Runtime（R5 断连窗形态；账本不动，
  终态禁复活），Node 对本地已终态 Run 的迟到 cancel 只回 ack（免打扰守卫）。
  E2E 装配随之收敛为**生产同值**（capacity 2 / runtimeTimeoutMs 6h），
  `/release` 回收缝删除，spec 改为断言产品自动回收（waitForRuntimeReleased）。
  删缝后 `bash scripts/q5-loop.sh 20` **20/20 连续冷启全绿**（生产同值装配：
  capacity 2 / 6h 硬超时兜底 / 无 `/release` 缝；每轮 task-room 1/1 +
  full-chain 13/13，含 R5 收敛取消与 G5/G7-01 自动回收断言；轮次日志
  `artifacts/q5/run-*.log`）。#88 关账。#90 分账状态不变。

## 验的是哪条用户路径

Issue #23 验收原文：**两浏览器全链 + 恢复场景**——Bob 创建 Builder Run → Runtime
真起（DSH replay 子进程）→ 审批卡（两端 diff）→ 批准 → 完成 → Artifact 发布给
Alice 下载 → Bob 起 Reviewer Run 受控消费输入清单；Hub/Node 故障注入后恢复
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
  0. **生产 cli 未接线 node.inventory（#89，Alpha 阻断）**：Hub 的 workspace
     投影唯一来源是 `node.inventory` 帧，而生产 cli/gateway 不发送该帧（真实用户
     RunLauncher 选不到 Workspace）。E2E 曾在装配层连接后手动补发（走 Hub 既有真人
     路径），**掩盖了该产品缺口**：本门全绿不代表生产 Run 启动链路可跑通。
     **已修（#89）**：session 层每条连接建立后上报、cli 注入事实源，且 e2e-node 与
     phase1/chain.ts 两条代偿缝已删除（chain 原本更糟——直插 `schema.workspaces`
     绕开协议建投影）；改由真 bin 的组合根测从入口验收
     （`apps/node/tests/integration/cli-inventory.integration.spec.ts`）。
     接线过程中另挖出两处同源 p0：#95（cli 无顶层 `main()` 调用，二进制静默
     no-op）、#97（runtime 入口未 `exports`，`start` 启动即死），均已修。
  1. **Task Room 聚合查询（`['task-room', id]`）不在 realtime 失效映射内**：
     状态跃迁后的 Room 呈现依赖显式 reload/导航（P1-07 已按诚实路径处理，本门
     沿用）；RunLivePanel 的事件流键 `['run', id]` 是实时的。若要 Room 全实时，
     属产品改动（另立 Issue）。
  2. **心跳投影竞态（立账 #87，已修）**：Hub reconcile 用「30s 内最新心跳的 activeRunIds」判定
     nodeLostRun，而 Node 心跳默认 10s 一拍——run.start 受理与下一拍之间的窗口
     可把新 Run 误标 lost（E2E 实测复现）。**已修（#87 / PR #122）**：Hub 侧
     reconcile 加新生儿宽限 + Run 出生时间走领域时钟；E2E 装配的「受理即补发心跳 +
     activeRunIds 超集」monkey-patch 已删除，删后 Q5 20 连全绿（见头部更正段）。
     残留跟进：#124（宽限锚点精确化 + lastSeenAt 时钟域收敛）、#123（观测收口）。
  3. **终态 Run 的 Runtime 进程滞留（立账 #88，已修）**：completed 后 Node 不发
     `runtime.shutdown`（bridge/bin 支持但无人调用），进程占容量到 supervisor 硬
     超时——生产值 **6h** 且 `capacity: 2`：两个终态 Run 即可把设备容量占死
     最长 6 小时。**已修（#88）**：Node 终态收敛点发 `runtime.shutdown` +
     宽限信号升级；Hub 心跳收敛终态仍 active 的 Run（admin run.cancel）；
     E2E 装配收敛为生产同值、`/release` 缝删除（见头部更正段）。
  4. **run.status_request 探针应答不 ack（立账 #90·问题1）**：Node 回快照但不回 command.ack，
     outbox 对该行持续退避重发（观测到 attempts 10+）。功能无损，但属噪声，
     建议探针纳入 ack 或走非 outbox 通道。
  5. **webServer 进程包装泄漏**：`pnpm exec tsx` 双层包装令 playwright 只杀到
     外层，孤儿 serve 占死 18080/5173 并互相覆盖环境清单（本轮多轮失败根因）。
     已改 `node --import tsx` 单进程直启 + serve 启动自愈（comm/argv 精确判据；
     第一版 `pkill -f` 会误杀携带同样路径字样的父 shell，自伤教训）。
  6. **崩溃时机砸进「派发在途」窗口的歧义形态（立账 #90·问题2，观察项）**（R8 早期配方实测一次）：Hub 在
     run.start 已投递、ack 未落库的毫秒窗被 SIGKILL 后，重启重发在 Node 侧呈现
     「commandStore 有记录但无处理日志、零事件、attempts 快速爬升」并最终走
     duplicate→lost 分支。属 G7-03 禁复活语义的安全侧（宁可 lost 不重放），但
     首投递为何无处理日志未成完全定论；R8 改用确定性窗口（拔线+崩溃），该形态
     保留为观察项。
  7. **Docker 端口发布竞态（合入门禁期抓到并已修复）**：评审在最终 HEAD 前置的
     Q5 x20 第 8 轮环境启动失败——`docker run -d` 返回后立即 `docker port`，撞
     Docker 网络编程滞后窗报 "no public port '5432' published"（容器报「已启动」
     而映射未发布；证据 artifacts/q5/run-8.log）。修复：
     `scripts/lib/ephemeral-postgres.mts` 的 `waitPublishedPort` 有界轮询
     （10s 上限 / 200ms 间隔，同 waitReady 模式），超期抛错并附
     `docker logs --tail 20` 现场（区分「发布滞后」与「容器即死」）；空输出/端口
     0 按未发布重试不误报成功。`scripts/tests/ephemeral-postgres.spec.ts` 4 例
     确定性测试（注入假 docker/时钟）钉死两形态。该 lib 为 Q2 与 Q5 共用：
     修复后 auth.integration 10/10 + 1 轮冷启 E2E 无回归。
     **同一竞态在门禁期又抓两形态，逐层修到根**：第 19 轮（HEAD dadcc82）「10s
     不够」——容器日志显示 initdb 已完成、本身健康，映射仍不可见，遂把上限对齐
     READY 同级 60s（`aad11ce`）；第 18 轮（HEAD aad11ce）「60s 死等仍不发布」且
     容器仍活着 ⟹ 病态绑在单个 endpoint 上，**延长等待无效**，遂改为「20s/次 ×
     3 次删容器重建」（退避 1s/2s，总预算留在 playwright webServer 180s 内；每次
     失败删僵尸容器并写 attempt 计数 WARN 供归因；测试扩至 7 例，按容器序号精确
     断供，钉死重建成功/上限用尽逐个清干净/WARN 可见，`f50049c`）。
     **最终 20 连（HEAD bdff8b1，13 场景版）：20/20 全绿**，逐轮日志留
     `artifacts/q5/`；本轮 0 次触发重建——churn 条件未复现，兜底路径由单测钉住。

## 归因速查

- 环境起不来 → `scripts/e2e-serve.mts` stderr（含提前退出的子进程日志尾）。
- Run 不动 → `/control/db/run/:id`（状态 + outbox attempts/acked）→ Node 日志
  component=node.*，再 Runtime（runtime.* 经 node 转发段）。
- UI 不更新 → 先分清「聚合 stale（需 reload，见发现 1）」vs realtime 键（面板）。

## 取证与复跑

```bash
corepack enable && pnpm install --frozen-lockfile && pnpm -r --if-present build
pnpm test:e2e                                             # 整门全量（两项目各自冷启：
                                          # 同一 Hub 只容一次 Setup，单 invocation 双 project 必 409）
bash scripts/q5-loop.sh 20                                  # Q5 门（20 连冷启；轮次日志 artifacts/q5/）
pnpm check && pnpm test:integration                         # Q0/Q2
bash scripts/secret-scan.sh apps/web scripts docs/agent     # Q7 片段
```

Q5 轮次日志落 `artifacts/q5/run-<i>.log`（gitignored）；失败证据自动落
`artifacts/evidence/e2e/`（gitignored）；trace 走
`pnpm exec playwright show-trace test-results/**/trace.zip`。
