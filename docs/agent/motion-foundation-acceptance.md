# 动效底座与交互态过渡验收（P1-UX-17 / #271，父账 #243 四期刀一）

- 对应场景/门禁：Q0（`pnpm check`）、Q1（web 面）
- 对应 Issue：#271
- 上次验证：2026-09-29 · `feat/p1-271-motion-foundation`（PR 待合） · 结果 PASS

## 验的是哪条用户路径

用户把指针移过侧栏导航 / 最近任务行 / 按钮 / Agent 卡 / 运行行 / Console 筛选 chip
时，**状态变化不发生时间上的断裂**；按下按钮时有一次可见的按压反馈；打开
「减少动效」系统偏好的用户拿到的仍是"更少"而不是"没有"反馈。

参照物是 ChatGPT 侧栏/会话行的 hover 与 Claude 的控件反馈：它们看起来不像"有动画"，
只是没有硬切。

## 驱动（怎么触发）

本切片是纯样式改动，没有可驱动的新端点/事件。判据走 CSS 源码口径（与 #231 骨架门同款，
因为 jsdom 不做层叠，本地也没有 Playwright 浏览器）：

```bash
npx vitest run --project web apps/web/tests/motion-foundation.spec.tsx
```

## 观测（看什么）

`apps/web/tests/motion-foundation.spec.tsx` 里的契约函数 `checkMotionContract(css, tokens)`
返回**失败清单**（空 = 成立），对真文件与变异副本走同一个函数：

1. `tokens.css` 的顶层 `:root` 定义了 `--ease-out` / `--ease-in-out` / `--duration-quick` /
   `--duration-base` / `--press-scale`；两条曲线**逐值**是强曲线
   （`cubic-bezier(0.23, 1, 0.32, 1)` / `cubic-bezier(0.77, 0, 0.175, 1)`）。
2. 10 个具名交互面的规则体里带 `transition`：`.app-nav a`、`.sidebar-recent-link`、
   `.app-nav-toggle`、`.button`、`.select-menu .select-menu-trigger`、`.ref-chip`、
   `.app-sidebar-search`、`.agent-card`、`.run-item-button`、`.cf`。
3. `.button:active:not(:disabled)` 的按下反馈走 `transform: scale(var(--press-scale))`。
4. `@media (prefers-reduced-motion: reduce)` 里把 `--press-scale` 改写成 `1`。
5. 反向：`global.css` / `tokens.css`（去注释后）没有 `transition: all`、没有 `ease-in`
   （`ease-in-out` 不算）。
6. 定位唯一性：同名规则被复制到别处（含 `@media` 内）时报「判据定位不唯一」，
   不静默取第一条。

配套：`apps/web/tests/control-family.spec.tsx` 的期望表登记了新增的
`.button:active:not(:disabled)`（`mustDeclare: transform`，颜色三条沿链继承 `.button`）——
**未登记的控件族规则会被该门直接拦下**（本切片实现时它确实红了，见下）。

## 判定（成功长什么样）

- 契约函数对真文件返回 `[]`；
- **变异必须红**（同一次运行内 5 例 + 真实文件 3 例）：
  - 拆掉 `.app-nav a` 的 `transition` → `['.app-nav a 的规则体里没有 transition']`；
  - 把 reduced-motion 里的 `--press-scale: 1` 改回 `0.97` → `['reduced-motion 下必须把 --press-scale 改写为 1（位移关掉）']`；
  - 把 `--ease-out` 换成内置 `ease-out` → `['--ease-out 必须是强曲线 cubic-bezier(0.23, 1, 0.32, 1)']`；
  - 混进 `ease-in` / `transition: all` → 各自命中反向判据；
  - 复制一份 `.app-nav a` 规则 → 命中「定位不唯一」。

## 归因（失败先看哪层）

- 「某个面的过渡没生效」→ 先看它是不是**被 oxfmt 折成多行**（多值 `transition` 会折行，
  单行正则改不动它）。本切片实测踩到一次：变异正则没匹配上、测试照样绿——**变异不生效的绿
  比不跑更危险**，所以脚本里加 `assert n == 1`。
- 「过渡被别处覆盖」→ 查同名规则是否出现两块（契约会报定位不唯一）。
- 「reduced-motion 没关掉位移」→ 看 `tokens.css` 末尾的媒体查询是否还在（别与 `global.css`
  里骨架屏那条 `animation: none` 合并）。

## 取证

```bash
npx vitest run --project web apps/web/tests/motion-foundation.spec.tsx   # 6 passed
npx vitest run --project web                                             # 40 files / 401 passed / 7 expected fail（深色 it.fails 既有债）
npx oxfmt --check apps/web/src/styles/                                   # All matched files use the correct format.
pnpm check                                                               # Q0 全绿
```

## 边界与未覆盖

- **真实浏览器观感没验**：本地无 Playwright 浏览器（Q5 面挂 #243 既有 e2e 债）。
  `contrast-sweep.ts` 会把祖先 `opacity` 累乘进对比度，本切片**没有给控件加 opacity 过渡**
  （`:disabled` 的 0.55 是既有的、静态的），所以不新增 e2e 脆弱面；但 `@starting-style`
  与进场过渡属下一刀（#272），届时需要重跑 Q5。
- **vendor 侧不能动**：`vendor/dsh-ui/**` 有 sha256 逐文件保真门 + ≥11 条保真下限，
  vendored `Button/Menu/Modal` 自身仍是硬切；应用层只能覆盖自己的选择器
  （仓库既有先例 `.device-status-*`）。
- **`.global-search-item` 刻意不加过渡**：⌘K 结果行 100+/天，键盘面按 Raycast 约定不加动效。
- **`.task-link` 不在列**：hover 只加下划线，没有可过渡的属性（`text-decoration-color`
  动不了下划线的有无）。
- **深色主题档**（`body[data-ds-dark-theme]`）休眠中，本切片没有为它单独取值——
  过渡本身与主题无关，颜色仍走 L1 token，深色启用时随 L1 一起翻。

## 复跑

```bash
git switch feat/p1-271-motion-foundation     # 合并后：main
npx vitest run --project web apps/web/tests/motion-foundation.spec.tsx
npx vitest run --project web
pnpm check
```
