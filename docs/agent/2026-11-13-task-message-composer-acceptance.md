# 任务页消息框：接收方、独立草稿与发送受阻恢复 验收

- 对应场景/门禁：P1-07 任务房主链 · Q0/Q5；ADR-0018 决定 1 的修订（#548）
- 对应 Issue：[#548](https://github.com/RyanOnMe/whalepod/issues/548)（产品切片代号 P1-07，与里程碑 P1-07 不同编号体系）
- 上次验证：2026-11-14 · 分支 `feat/p1-548-task-message-composer`（起点 20bf1df；复核修复 5d6ddb1、fff9869、ae2db33、5b471e3、be5d13d）· 结果 PASS（工程门）；真人可用性 not_run

## 验的是哪条用户路径

成员打开一条普通任务链接，底部输入默认「发给团队」；写一条现场补充，只产生一条团队评论；
切到「请助手处理」后看到真实接收者，正常接续不需要打开执行设置；原电脑离线时文字仍可编辑、
提交被阻止，团队留言照常，重新连上后必须由人再点发送；没有交办权限的成员只看到业务级说明
与「发给团队」入口，看不到别人的设备与私有结果。

## 驱动（怎么触发）

组件级：真实 router + 真实 HTTP mock，从页面角色与标签驱动（不直插 store）。

```bash
pnpm exec vitest run --project web apps/web/tests/task-message-composer.spec.tsx
```

生产浏览器（真 Hub / PostgreSQL / 打包 Node / 真 Runtime replay）：

```bash
pnpm exec playwright test --project=p1-07
pnpm exec playwright test --project=p1-393
pnpm exec playwright test --project=p1-315
pnpm exec playwright test --project=p1-19
pnpm exec tsx scripts/run-conversation-acceptance.mts
pnpm exec tsx scripts/run-handoff-loop.mts
pnpm exec tsx scripts/run-create-to-recovery.mts
pnpm exec playwright test --config=playwright.workspace.config.ts
pnpm exec playwright test --config=playwright.micro.config.ts
```

## 观测（看什么）

- web：`task-message-composer.spec.tsx` 的 `message-recipient-*`、`assistant-receiver`、
  `team-composer`、`comment-sent-status`、`execution-blocker`、`check-connection`、
  `restart-assistant`、`assistant-uncertain`、`instruction-outcome`；所有请求按 URL 与
  `Idempotency-Key` 断言，不读组件内部 state。
- hub.run：`p1-393` 的 `result.json` 记录 `instructionPosts`、离线期间新增 Run 数、
  团队评论、来源/意图与设备在线事实；独立判定器重判 128 项。
- 生产浏览器：p1-07 双上下文主链；p1-19 的 15 条、p1-345/381 的 evidence 判定器
  分别 PASS（p1-19 R8 证据独立重判 PASS）；p1-315 以用例内断言为准，没有独立判定器。

## 判定（成功长什么样）

- 普通链接默认团队：`aria-pressed=true` 落在「发给团队」，讨论区文案只说「团队成员可见」，
  不再出现「团队成员之间 · 不触发 Agent」；发一条团队留言只产生 1 条 `POST /comments`、
  0 条 `POST /instructions`。
- 双草稿：切换接收方、离线、去设备页再返回都不串字；成功只清对应草稿；未确认请求重试
  沿用同一 `Idempotency-Key`（团队留言与助手指令各自一份，网络失败时按钮变为「重试发送」，
  改正文或发送安排后回到普通发送）。
- 助手接收者：有活跃/最近业务来源时显示真实 Agent 名（`发给：Builder`）；没有可沿用对象时
  显示「还没为这项任务选助手」，选择入口零提交、零改派。
- 受阻与恢复：离线时指令 textarea 仍可编辑、提交禁用、团队留言照常；「检查连接」只刷新
  读面不发送；重新上线后按钮恢复但 `POST /instructions` 计数不变，必须由人再点。
  无可用环境时不承诺「重新开始」，给出「重新检查」与「设置执行电脑」。
- 权限与竞态：无交办权限显示「这项任务由 X 负责交办。你仍然可以给团队留言。」且不展示
  别人的接收助手/选择入口；权限撤回后已有草稿保留并可继续编辑，提交禁用；编辑中旧来源结束显示
  「刚才的对话已经结束…」，文字不改投，明确「重新开始」后才按新执行发送；来源 Run 的
  `resumeContext=blocked`（受限私有执行）只给重新开始，不当作可接续会话。
- 事实反馈：新请求提交但尚未开始显示「已提交，等助手开始」，Run 一旦开始（running/审批/
  终态）就不再保留这句；排队显示「已排队」；拒绝连理由显示；无证据时不显示「助手已读」「已采用」。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| 默认落在执行区 / 团队留言按钮找不到 | `TaskRoomPage` 的 `channel` 初始值与 `message-recipient-*` 切换；组件判据 `task-message-composer.spec.tsx` |
| 切换后草稿丢失或串到另一边 | `execution-drafts.tsx` 的 task+user store 与 `CommentComposer` 本地 state 是否仍挂载；检查 `team-composer`/`assistant-composer` 是否被卸载 |
| 离线仍能发出 / 上线自动发出 | `execution-blocker` 的 reason 链与 `POST /instructions` 计数；再看 `devices` 读面与 `device.changed` 失效 |
| 请求被拒但页面说已送达 | `instruction-outcome` / `run-outcome` 与 Hub `outcome`；201 不代表受理 |
| 团队留言没有进入既有订阅/发现承接 | 先确认留言只走 `/comments`，再看 `hub.work_entry` 与订阅读面；页面不猜快慢路径 |

## 取证

- 组件：`apps/web/tests/task-message-composer.spec.tsx`（20 条）。
- 生产浏览器：`artifacts/evidence/conversation-flow/result.json`（p1-393 + 独立判定器 128 项）、
  `artifacts/evidence/r8-window/result.json`（p1-19 R8：held → 重启 → 5 次派发后 ack/completed）、
  p1-19 本轮 15/15 运行结果（无失败包）、`artifacts/evidence/handoff-loop/`、
  `artifacts/evidence/create-recovery/`、`artifacts/evidence/focused-workspace/<tag>/`、
  `artifacts/evidence/run-micro/<tag>/`。
- 出包/入 git 前跑 `scripts/secret-scan.sh <路径>`；证据目录不提交。

## 边界与未覆盖

- 真人可用性验收 **not_run**：尚未找未看过演示的成员按计划第 6 节做「先补充、再交办、
  再遇离线」的观察；自动化通过不当作好用或提效。
- 模型/助手均为确定性回放；没有付费模型调用，也没有验证真实模型质量。
- 深色主题的已知对比度缺口（#236）不在本切片扩张；micro 审计的 chip 严格配对只按浅色判。
- 项目级默认助手、任务改派、Router/派工/计费/外部接入均未改；发现生成的受限私有执行
  仍不可被这里重开或续接。
- 整页刷新/退出/换身份后草稿不承诺保留（沿用 ADR-0019 页面内存边界）；接收方视图会在
  同一页面会话内按任务恢复。

## 复跑

```bash
pnpm exec vitest run --project web apps/web/tests/task-message-composer.spec.tsx
pnpm exec playwright test --project=p1-07
pnpm exec tsx scripts/run-conversation-acceptance.mts
pnpm check
```

干净环境另需 Docker（Q2/Q5 的一次性 PostgreSQL），并按 `scripts/install-hooks.sh` 启用本地 hooks。
