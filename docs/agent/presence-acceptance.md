# 在场与退场验收（P1-UX-18 / #273，父账 #243 四期刀二）

- 对应场景/门禁：Q0（`pnpm check`）、Q1（web 面）
- 对应 Issue：#273（依赖 #271 的动效 token 底座）
- 上次验证：2026-09-29 · `feat/p1-273-presence`（PR 待合） · 结果 PASS

## 验的是哪条用户路径

用户打开 Run Console 又关掉、看到一条 toast 到点消失、断线横幅出现又收起时，
**屏幕上不该有"凭空出现 / 凭空消失"**：该退的东西先把退场演完再卸载，
横幅出现/消失不该把整页内容瞬间顶下去再弹回来。

## 驱动（怎么触发）

| 面 | 驱动 |
|---|---|
| Console 进出 | 任务房 → 点运行行 → 点「打开 Console」→ 点「关闭」（页面级 spec 走真实 router + QueryClient） |
| toast 进出 | `pushToast()`（4 秒 TTL；第 4 条进来时挤掉最旧一条） |
| 断线横幅 | `connection-store` 的 `setConnectionStatus('reconnecting' → 'open')` |

```bash
npx vitest run --project web apps/web/tests/presence.spec.tsx
npx vitest run --project web apps/web/tests/connection-banner.spec.tsx
npx vitest run --project web apps/web/tests/feedback-consistency.spec.tsx
```

## 观测（看什么）

- **在场原语**（`apps/web/src/shared/usePresence.ts`）：值变 `null` 后仍返回上一次的值
  并把 `leaving` 置真，退场时长到点才卸载；退场**可打断**（中途值回来取消这次卸载）。
- **两端一致的时长**：JS 计时器（`shared/motion.ts` 的 `EXIT_PRESENCE_MS`）与 CSS 过渡
  （`--duration-base`）必须是同一个数——判据**从 `tokens.css` 现场解析**，不硬编码 160。
- **组件状态**：Console 关闭后同一次提交里带 `.leaving` 与 `data-leaving="true"`；toast
  被挤掉时先 `.leaving` 再消失；横幅收起时槽位带 `.leaving`，期间**仍是 `role=status`**
  （内容还在屏幕上，语义不该先没）。
- **CSS 源文本**：三处浮层/提示各有 `@starting-style`（进场）与 `.leaving`（退场）规则；
  reduced-motion 下 `--presence-transform: none` / `--expand-duration: 0s`，且
  `--duration-base` **不**被清零（清零会让退场窗口白等）。

## 判定（成功长什么样）

- `presence.spec.tsx` 9 例、`connection-banner.spec.tsx` 3 例、`feedback-consistency.spec.tsx`
  6 例全绿；全量 web 面 41 文件 / 410 通过 / 7 预期失败（#214 既有深色债）。
- **变异必须红（3 例，逐个确认"变异已生效"后判红）**：
  1. `RunConsole` 不再挂 `leaving` 类 → 页面级用例红（`toHaveClass('leaving')`）；
  2. `usePresence` 不再保留退场窗口（立即卸载）→ 3 例红（含"同一次提交里就带着 leaving"）；
  3. 删掉 `.console` 的 `@starting-style` 块 → CSS 判据红（`.console 缺进场`）。
- 既有判据的两处**加强**（不是放宽）：横幅"恢复后消失"从"同步断言消失"变成
  「先仍在场且槽位 `leaving` → 退场后卸载」；toast"挤掉最旧的"从"同步断言不在了"变成
  「先 `.leaving` 仍在 DOM → 退场后消失」。

### 变异自测抓到的一处判据缺口（值得记）

第一版页面级用例**只断言 `data-leaving`**，于是"把 `className` 里的 `leaving` 删掉"这个变异
**存活**——属性还在、真正驱动 CSS 的类名没了，动画没了而门看不见。补上
`toHaveClass('leaving')` 后变异立刻变红。教训与 #263 那条同族：**断言要打在真正生效的那一端**
（CSS 认类名，不认 data 属性）。

## 归因（失败先看哪层）

- 「退场没演完就被摘掉」→ 看 `EXIT_PRESENCE_MS` 与 `--duration-base` 是否还相等（判据会先红）。
- 「进场不生效」→ `@starting-style` 块在不在；浏览器不支持该 at-rule 时**只会退化成"直接出现"**
  （不会坏），这是刻意的降级口径。
- 「退场途中又打开另一个 Run，新的被旧的定时器摘掉」→ 在场原语的清理逻辑（有专门用例）。
- 「横幅收起后整页还留着高度」→ 槽位子项的 `min-height: 0`（grid 子项默认 `min-height: auto`
  会拿内容高度顶住，行谷为 0 也压不下去）。

## 取证

```bash
npx vitest run --project web apps/web/tests/presence.spec.tsx          # 9 passed
npx vitest run --project web                                             # 41 files / 410 passed / 7 expected fail
npx oxfmt --check apps/web/src/styles/
pnpm check                                                               # Q0 全绿
```

## 边界与未覆盖

- **vendored `Modal`/`Menu` 不动**：`open=false` 直接 `return null`，应用层既改不了它的卸载时机、
  也够不着它 portal 出来的遮罩（选择器不在我们手里）。只动卡片会变成"遮罩硬弹 + 卡片缩放"的
  半截动画，所以 ⌘K 浮层 / `?` 速查 / 确认对话框**本切片保持瞬时进出**。要做要么换掉这个原语、
  要么放宽 `vendor/dsh-ui` 的 sha256 保真门——两者都不属于打磨切片。
- **toast 栈内重排仍是瞬时的**：让兄弟节点平滑让位要 FLIP（先测量、再用 transform 补偿），
  量级与风险都不是这一刀的事，登记为后续。
- **⌘K 结果行、键盘面一律不加动效**（#271 已定口径）。
- **真实浏览器观感仍没验**：本地无 Playwright 浏览器（Q5 挂 #243 既有 e2e 债）。
  另需注意：`contrast-sweep.ts` 会把祖先 `opacity` 乘进对比度——本切片给三处浮层/提示加了
  160ms 的透明度过渡，**下一轮跑 Q5 时要留意测量是否撞上动画窗口**（Console 需要交互才出现，
  风险主要在 toast/banner 场景）。
- 深色主题档（`body[data-ds-dark-theme]`）休眠中：本切片不新增颜色取值，随 L1 一起翻。

## 复跑

```bash
git switch feat/p1-273-presence      # 合并后：main
npx vitest run --project web apps/web/tests/presence.spec.tsx
npx vitest run --project web
pnpm check
```
