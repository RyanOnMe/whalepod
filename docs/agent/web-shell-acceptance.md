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
