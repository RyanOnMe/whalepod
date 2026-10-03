# 直播产出区连续性验收（P1-UX-19 / #275，父账 #243 四期刀三）

- 对应场景/门禁：Q0（`pnpm check`）、Q1（web 面）
- 对应 Issue：#275（依赖 #271 的动效 token 底座）
- 上次验证：2026-09-29 · `feat/p1-275-live-stream`（PR 待合） · 结果 PASS

## 验的是哪条用户路径

责任人盯着一个正在跑的 Run：

1. 输出在流的时候，末尾有一个"正在写"的标记（ChatGPT/Claude 的流式光标）；
2. 他往上翻去读前面的输出时，**新的 token 不再把他拽回底部**，并出现「回到最新」；
3. 点「回到最新」回到跟随态；
4. 全程面板的头部/失败提示/动作区/事件列表**不因为多了一个 token 而重渲染**。

## 驱动（怎么触发）

```bash
npx vitest run --project web apps/web/tests/run-live-stream.spec.tsx
```

页面级：真实 router + QueryClient 进任务房 → 选运行 → 直播区；delta 经
`appendLiveDelta`（真帧路径的生产者）进缓冲，不在测试里伪造订阅。

## 观测（看什么）

| 判据 | 观测点 |
|---|---|
| 光标 | `run-live-text` 内有 `.run-live-caret`（`aria-hidden`），终态 Run 没有 |
| 跟随 | 注入滚动度量后的 `scrollTop` 是否被写 |
| 接管 | 滚上去后 `run-live-jump` 是否出现；点击后是否恢复 |
| 重渲染 | `RunActions` 计数桩的渲染次数（一个 delta 前后不变，且**确实渲染过**） |

**为什么度量要注入**：jsdom 没有布局，`scrollHeight`/`clientHeight`/`scrollTop` 恒为 0。
不注入的话，"跟随"与"被接管"两条分支里永远只有一条会被真正执行（另一条是空的）。
所以：判定拆成纯函数 `isNearBottom(metrics)`（两条分支各有断言），组件侧用带
getter/setter 的 `scrollTop` 桩验"有没有真的去写滚动位置"。

## 判定（成功长什么样）

- `run-live-stream.spec.tsx` 5 例全绿；全量 web 面 42 文件 / 415 通过 / 7 预期失败
  （#214 既有深色债）。
- **变异必须红（3 例，逐个确认"变异已生效"后判红）**：
  1. 把直播订阅搬回面板（旧写法）→ 重渲染计数 10→11，判据红；
  2. 去掉"只在底部才跟随"的闸门 → `scrollTop` 1000≠100，判据红；
  3. 删掉流式光标 → 光标判据红。
- **防空转**：重渲染判据先断言计数桩**确实渲染过**（`toBeGreaterThan(0)`）。这不是形式主义——
  第一版载荷把 `ownerUserId` 写错时，面板照常渲染但没有直播区，那条判据会"因为压根没画而通过"，
  实测就是这么被后面的断言（找不到 `run-live-text`）才逮住的。

## 归因（失败先看哪层）

- 「往上翻还是被拽」→ `useStickToBottom` 的闸门（`enabled && following`）与 scroll 监听是否挂上；
  容器是空态 `<p>` ↔ 有内容 `<pre>` 互换的，用 `useRef` 的话监听会永远挂不上（本切片用回调 ref）。
- 「光标一直闪到跑完」→ `isActive` 的来源是 `run.status`（终态不画）。
- 「面板还是每帧重渲染」→ 查是不是有人在面板里又订阅了直播缓冲（判据就是钉这个的）。

## 取证

```bash
npx vitest run --project web apps/web/tests/run-live-stream.spec.tsx   # 5 passed
npx vitest run --project web                                            # 42 files / 415 passed / 7 expected fail
npx oxfmt --check apps/web/src/styles/
pnpm check                                                              # Q0 全绿
```

## 边界与未覆盖

- **不做打字机效果**：文本真流到哪就显示到哪，人为放慢是撒谎。
- **不做虚拟滚动**：事件列表规模不构成问题。
- 跟随的容差写死 24px，不做速度/惯性判断（手势级平滑属另一档）。
- **真实浏览器里的滚动行为没验**：本地无 Playwright 浏览器（Q5 挂 #243 既有 e2e 债）。
  本切片的滚动判据是**度量注入**口径——它钉住了"逻辑分支"，但"真浏览器里 `scrollHeight`
  的取值时机（是否在字体加载后才稳定）"没有机器证据，登记为 Q5 面待补。
- 光标是 `steps(1)` 硬闪（不做缓入缓出）；reduced-motion 下不闪（保留字形——它是信息不是装饰）。

## 复跑

```bash
git switch feat/p1-275-live-stream      # 合并后：main
npx vitest run --project web apps/web/tests/run-live-stream.spec.tsx
npx vitest run --project web
pnpm check
```
