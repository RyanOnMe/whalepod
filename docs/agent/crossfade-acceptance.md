# 内容形态切换连续性验收（P1-UX-20 / #277，父账 #243 四期刀四）

- 对应场景/门禁：Q0（`pnpm check`）、Q1（web 面）
- 对应 Issue：#277（依赖 #271 动效 token、#273 在场原语）
- 上次验证：2026-09-29 · `feat/p1-277-crossfade`（PR 待合） · 结果 PASS

## 验的是哪条用户路径

用户打开任务房 / 项目页、等数据回来的那一下：骨架**不是"啪"地消失**，而是叠在内容之上
淡出，内容同时淡入——两者在过渡窗口内**同时存在**。同理，空态与列表之间的替换、状态徽标
的就地换态（运行中→已完成）也不再是整块跳。

## 驱动（怎么触发）

```bash
npx vitest run --project web apps/web/tests/crossfade.spec.tsx
```

页面级：真实 router + QueryClient，取数应答由测试**控制放行时机**（`deferredRoomHandlers`）——
只有这样才看得到"数据刚回来的那一帧"。CSS 口径部分走 `global.css` 源文本（与 #231 骨架门、
#271 动效门同款；jsdom 不做层叠，读不到 computed style）。

## 观测（看什么）

| 判据 | 观测点 |
|---|---|
| **交叉**（核心） | 内容出现的那一帧 `room-skeleton` 仍在 DOM 且带 `.leaving`；`.task-room` 带 `.crossfade-in`；`EXIT_PRESENCE_MS` 后骨架才卸载 |
| 项目页一致 | `projects-skeleton` 与空态/列表同一窗口共存 |
| CSS 口径 | `.crossfade-stack` 绝对定位叠加、`.room-skeleton` 的 opacity 过渡、`.crossfade-in` 的 `@starting-style`、`.empty-state`/列表容器的入场块、`.badge` 的颜色过渡、`.execution-activity-hint` 的 hover/按下 |

「两者同时在 DOM」是**可证伪**的交叉判据：硬切时骨架在内容出现的那一刻就没了，
两者不可能同时存在——所以它比"看起来柔和了"硬。

## 判定（成功长什么样）

- `crossfade.spec.tsx` 7 例全绿；全量 web 面 42 文件 / 417 通过 / 7 预期失败（#214 既有深色债）。
- **变异必须红（2 例，均确认"变异已生效"）**：
  1. 内容分支不再保留骨架（回到硬切）→ "两者同时在 DOM" 判据红；
  2. 删掉 `.badge` 的颜色过渡 → CSS 口径判据红。

### 实现里踩到的两处（写下来免得重踩）

1. **`usePresence` 返回的是对象、不是 `value | null`**：项目页第一版写成
   `projectsSkeleton === null ? …`（永远为假），于是骨架**永不卸载**——判据以
   "退出窗口后骨架仍在"报出来。
2. **`blockOf` 的行首锚定**：`indexOf('.room-skeleton {')` 会命中
   `.crossfade-stack > .room-skeleton {` 里的那一段，判据误报"命中 2 条"。
   取规则体必须按行首锚定（带缩进的是 `@media`/`@starting-style` 里的嵌套规则，不算顶层）。

## 归因（失败先看哪层）

- 「骨架不消失」→ 先看是不是把在场对象当成了 `value | null`（见上）。
- 「内容还是硬切」→ `fromSkeleton` 是否为真、`.crossfade-in` 有没有挂上、`@starting-style` 块在不在。
- 「实时插入的行也在动」→ 不该发生：入场只在**容器挂载**时演；若发现行级动画，说明把
  `@starting-style` 加到行元素上了。

## 取证

```bash
npx vitest run --project web apps/web/tests/crossfade.spec.tsx   # 7 passed
npx vitest run --project web                                     # 42 files / 417 passed / 7 expected fail
npx oxfmt --check apps/web/src/styles/
pnpm check                                                       # Q0 全绿
```

## 边界与未覆盖

- **不做 `.hash-focus`（⌘K 落点高亮）的淡入淡出**：描边的"有/无"没有可过渡的起点值，
  硬做会出现从文字色渐变的怪相；收益（LOW）不抵这个风险。
- **不做列表重排的 FLIP**（#273 已登记同一条）。
- **不给实时插入的行加动效**（高频面，口径见 #271）。
- **不动 vendored `Modal`/`Menu`**（#273 边界同款）。
- **真实浏览器观感没验**：本地无 Playwright 浏览器（Q5 挂 #243 既有 e2e 债）。
  注意 `contrast-sweep.ts` 会把祖先 `opacity` 乘进对比度——本切片在骨架/内容/空态/列表上
  引入 160ms 的透明度窗口，**下一轮 Q5 要留意测量是否撞上动画窗口**（尤其在页面首屏）。
- 深色主题档（`body[data-ds-dark-theme]`）休眠中：本切片不新增颜色取值。

## 复跑

```bash
git switch feat/p1-277-crossfade      # 合并后：main
npx vitest run --project web apps/web/tests/crossfade.spec.tsx
npx vitest run --project web
pnpm check
```
