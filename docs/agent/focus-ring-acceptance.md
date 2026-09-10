# 焦点环对比度验收（#164）

- 对应场景/门禁：Q0 静态门新增用例族 `apps/web/tests/focus-ring.spec.ts`（unit project）；
  判据口径 SC 1.4.11 非文字对比度（AA，3:1）与 SC 2.4.13 焦点外观（AAA，≥2px 周长厚度）
- 对应 Issue：#164（同族：#159 文字对比度浏览器扫描、#152 主题 AA 门）
- 上次验证：2026-09-11 · fix/p1-164-focus-ring · 结果 **PASS**（门 8/8 绿；红→绿实测双向做过，
  日志在 `artifacts/evidence/focus-ring/`，gitignored）；Q0 `pnpm check` 全绿（1022/1022）

## 验的是哪条用户路径

键盘用户按 Tab 走到任意可聚焦元素时，**看得见焦点落在哪**。焦点指示是
`global.css`（**应用层**）里唯一的全局焦点样式——注意口径：vendored 原语另有自己的焦点
指示，见文末未覆盖第 6 条：

```css
:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
```

所以这一条覆盖所有键盘可达路径（P1-07「键盘可完成主链」、P1-142 折叠导航键盘可达等）——
那些场景判的是"能不能操作"，本条判的是"操作时看不看得见"。

## 驱动（怎么触发）

```bash
pnpm exec vitest run --project unit apps/web/tests/focus-ring.spec.ts
```

驱动路径是**读 CSS 文本**（`readFileSync` + 解析），不依赖浏览器、不改交互逻辑：
门把 `--focus-ring` 的每一层拆出来（层数、spread、颜色），沿
`tokens.css` → `dsw-tokens.css` 的 `var()` 链解析取值（深色一套取
`body[data-ds-dark-theme]` 段），再用 `apps/web/tests/contrast.ts` 既有函数
（`parseCssColor` / `compositeOver` / `contrastRatio`）算 WCAG 对比度。

## 观测（看什么）

门绿时也打印整张表（层 × 底色 × 实测比值），一眼能看到"哪一层在哪个底色上扛事"。

改动后的实测（`--focus-ring: 0 0 0 2px var(--color-surface), 0 0 0 4px var(--color-ink)`）：

| 底色 | 内环 `--color-surface`（2px） | 外环 `--color-ink`（2px） | 结论 |
|---|---|---|---|
| 页面底 `--color-paper` | 1.08:1 ✗ | **17.46:1 ✓** | 外环扛 |
| 卡片面 `--color-surface` | 1:1 ✗ | **18.9:1 ✓** | 外环扛 |
| 顶栏底 `--color-ink` | **18.9:1 ✓** | 1:1 ✗ | 内环扛 |
| 主按钮底 `--color-signal`（元素自身底色） | **5.17:1 ✓** | **3.66:1 ✓** | 两层都扛 |

深色一套（`body[data-ds-dark-theme]`，L1 把 ink/surface 翻转成 `rgb(249,250,251)` /
`rgb(44,44,46)`，环跟着自动翻）：

| 底色 | 内环（2px） | 外环（2px） | 结论 |
|---|---|---|---|
| 页面底 paper（深色 `rgb(53,54,56)`） | 1.15:1 ✗ | **11.57:1 ✓** | 外环扛 |
| 卡片面 surface（深色 `rgb(44,44,46)`） | 1:1 ✗ | **13.34:1 ✓** | 外环扛 |
| 顶栏底 ink（深色 `rgb(249,250,251)`） | **13.34:1 ✓** | 1:1 ✗ | 内环扛 |
| 主按钮底 signal（`--color-signal` 深色不翻） | 2.7:1 ✗ | **4.95:1 ✓** | 外环扛 |

改动前（旧值 `0 0 0 3px color-mix(in srgb, var(--color-signal) 40%, transparent)`）：
paper **1.77:1** / surface **1.81:1** / ink **1.53:1** / signal 1:1，四处都不达标；
深色一套下更差：1.36 / 1.43 / 1.79 / 1:1。

## 判定（成功长什么样）

`apps/web/tests/focus-ring.spec.ts` 八条用例，全绿才算过：

1. **浅色**：paper / surface / ink / signal 每个底色上**至少一层** ≥3:1，且该层可见环带 ≥2px；
2. **深色一套**：同样判据再算一遍（用 `body[data-ds-dark-theme]` 段取值）；
3. **深色段确实重定义了 ink / surface**（双层环"跟着翻"的取证；真去掉了这条会红）；
4. **环带粗细**：整体厚度（最外层 spread）≥2px，且同心环按"内层在前"升序声明
   （box-shadow 先声明的画在上面，顺序一换外层会盖住内层）；
5. **每一层颜色都是对应用层语义 token 的 `var()` 引用**（不写裸色值，深色一套才能自动翻）；
6. **焦点环只挂在 `:focus-visible` 上**：`global.css` 里承载 `var(--focus-ring)` 的规则只允许
   `:focus-visible` 与显式登记的 `.agent-card-selected`；裸 `:focus` 不得承载（鼠标点击不出环）；
7. **反向用例**：旧值（40% 单层环）必须被本门判红（红→绿的红侧常驻在用例里）；
8. **反向用例**：单色 signal 环在 signal 自身底（`.button-primary`）上只有 1:1——
   这就是"为什么不用更显然的写法（把蓝色加深成单色）"的机器证据：
   100% blue-600 单层环确实压得住三个底色（paper 4.78 / surface 5.17 / ink 3.66:1），
   但焦点元素自身底色就可能是蓝的，环与它 1:1 等于没有指示。

## 红→绿实测（门不是恒真的证据）

| 步骤 | 命令 | 结果 |
|---|---|---|
| ① 先写门，token 仍是旧值 | `pnpm exec vitest run --project unit apps/web/tests/focus-ring.spec.ts` | **红**：8 例中 2 例失败，报"没有一层同时满足 ≥3:1 与环带 ≥2px（实测 1.77 / 1.81 / 1.53 / 1:1）"（日志 `artifacts/evidence/focus-ring/red-before-fix.log`） |
| ② 改 `--focus-ring` 为双层环 | 同上 | **绿**：8/8（`green-after-fix.log`） |
| ③ 把 `--focus-ring` 临时改回旧值 | 同上 | **红**：同两条用例失败；浅色 1.77 / 1.81 / 1.53 / 1:1，深色 1.36 / 1.43 / 1.79 / 1:1（`red-revert-cycle.log`） |
| ④ 改回双层环 | 同上 | **绿**：8/8（`green-restored.log`） |

## 归因（失败先看哪层）

- 门红先看**打印出来的表**：哪一层、哪个底色、比值多少，行里直接写着。
- 解析不出层/颜色 → `--focus-ring` 的写法变了（门只认 `0 0 0 Npx 颜色` 与
  `var(--color-*)` / `color-mix(in srgb, <token> N%, transparent)` 两种颜色形态），先看
  `apps/web/src/styles/tokens.css` 末尾那条声明。
- 比值对了但门仍红 → 看是"层不够粗"（环带 <2px）还是"token 不是 `var()` 引用"，
  两条断言各自的报错文案不同。
- 深色一套的判定不对 → 看 `apps/web/src/styles/dsw-tokens.css` 的
  `body[data-ds-dark-theme]` 段（L1 深色只重写与浅色不同的变量，取不到就回落浅色）。

## 取证

```bash
pnpm exec vitest run --project unit apps/web/tests/focus-ring.spec.ts   # 门本身（含整张表）
pnpm check                                                             # Q0 全绿（本次含 lint/typecheck/单测）
bash scripts/secret-scan.sh apps/web docs/agent                        # 提交前扫描
```

红→绿四个日志落 `artifacts/evidence/focus-ring/`（gitignored，含本机绝对路径，**不入 git**）。

## 边界与未覆盖（诚实清单）

1. **没在真实浏览器里验过（本切片按约定不起 e2e）**：`scripts/e2e-serve.mts` 会占 5173/18080，
   同一时刻全机只允许一套栈，本次由放行方统一安排 Q5 与视觉确认。所以"环在渲染态看起来对不对"
   （尤其下面第 2、4 条）仍是未验证项，不得引用本门当渲染证据。
2. **环从 3px 外扩变成 4px，是否被 `overflow: hidden` 祖先裁剪未验**：静态检索到的相关点——
   `global.css` 的三处 `overflow: hidden` 都是文字裁剪类（`.visually-hidden` / 省略号行），
   `.run-live-text` 是 `overflow-y: auto` 但有 12px 内边距。
   **一审更正（本条第 2 项原先的描述不准，已改写）**：vendored `Modal.module.css` 的 `.dialog`
   确实是 `overflow: hidden`，但它的内层**每个可聚焦容器都自带 24px 水平内边距**
   （`.header` `padding: 22px 14px 12px 24px`、`.body`/`.description`/`.footer` `padding: 0 24px`），
   所以 4px 环在水平方向根本贴不到裁切线；真正零内边距的只有**上边缘**，而贴顶的 `.header`
   自带 22px。**且 `Modal` 在 `apps/web/src`（除 vendor）当前零引用、零渲染点**——所以
   "裁掉 1px"在当前形态下不会发生，无需为它补内边距。将来有人真的用上 Modal 且把可聚焦元素
   贴到裁切边时再验。
3. **深色一套只在文本层算过，没在真实界面验过**：本仓当前**没有深色切换入口**
   （`index.html` 不设 `data-ds-dark-theme`），所以上面深色那张表是"备好但没用过"。
   L3 接主题切换时必须补一次渲染验证（本门会随 L1 取值自动跟着算，但不能替代渲染核对）。
4. **选中态复用同一 token 的视觉变化未验**：`.agent-card-selected` 用
   `box-shadow: var(--focus-ring)` 当"选中"标记（#164 之前就有），改双层环后它会从 3px 单层
   变成 4px 双层、观感更重。已在本门的登记清单里显式列出（不许静默新增第二处消费）；
   要不要把"选中"和"焦点"拆成两种视觉语言属另一个 Issue。
5. **鼠标点击不出焦点环只做了源码断言**：门断言"承载环的规则必须是 `:focus-visible`"，没做
   "真鼠标点击后页面上没有环"的渲染断言（属 Q5 范畴）。
6. **非文字对比度的浏览器侧扫描仍缺**：本门判的是 `--focus-ring` 这条声明算出来的数字；
   `.run-item-button.selected` 的 `outline: 2px solid var(--color-accent)` 等其它非文字指示，
   以及"颜色由继承/color-mix 得出的非文字对比度"仍没有机器门（#159 扫的是文字）。
   **另有三处 vendored 原语自带的焦点指示不归本门管**（一审 S3 指出"global.css 唯一"是
   应用层口径，不能扩大成"全站唯一"）：`vendor/dsh-ui/Switch.module.css:38`
   （`outline: 2px solid var(--dsw-alias-brand-primary)`）、
   `ConnectionIndicator.module.css:40`（warn 色 outline）、`Input.module.css:18`
   （`.wrap:focus-within` 改描边色）。三者在 `apps/web/src`（除 vendor）当前**零使用点**，
   故不是线上回归；但等它们落页（#168 一带）时必须逐个补判据。
7. **强制色彩模式（forced-colors）未验**：该模式下 `box-shadow` 会被 UA 丢弃，焦点可见性
   靠 UA 默认 `outline`。无回归证据，也无验证。

## 发现（本轮实测登记）

1. **#164 正文的标准编号要更正**：正文把 3:1 记在「SC 2.4.11 Focus Appearance」名下。
   WCAG 2.2 里 **2.4.11 是 Focus Not Obscured (Minimum)**（焦点不被遮挡，AA），
   **Focus Appearance 是 2.4.13**（AAA，含"≥2 CSS px 周长厚度"的面积口径），而焦点指示的
   3:1 相邻色对比度落在 **SC 1.4.11 非文字对比度（AA）**。判据不变，编号按标准写清楚。
2. **旧值在深色一套下更差**（1.36 / 1.43 / 1.79:1）——旧值是蓝 40% 叠在**深底**上，合成色
   更暗更糊；这条也说明"深色将来接上时同一判据要跟着过"不是空话。
3. **一审 B1 纠正：不能把"单色加深压得住三个底色"当通用结论**（2026-09-11）。首版在
   `tokens.css` 注释、本 spec 两处注释、PR 正文与提交说明里写了"100% blue-600 单色环压得住
   paper/surface/ink 三个底色（4.78 / 5.17 / 3.66:1）"——那是**浅色侧**的数字，而这条注释
   会随 L1 深色段一起翻转被读成通用结论。一审复算：深色 paper `rgb(53,54,56)` **2.34:1**、
   深色 surface `rgb(44,44,46)` **2.7:1**，只有深色 ink 过。**换成更强的论据**：单色 blue-600
   在**浅色全调色板** 30 个"可能当元素自身底色"的取值里有 **16 个**不达标（`.button-danger`
   的 red-900 2.78:1、`--color-signal-soft` 蓝底 1:1、ghost-active 1.86:1…），深色侧还有
   paper/surface；双层环在浅深两套全调色板（30+31 色）**0 处失败**——任何底色都必然与
   ink 或 surface 之一拉开。
4. **一审 S1 实测到门会失明，已修**：`readTokenValue` 取正则首个匹配，门只读 `tokens.css`；
   在 `global.css` 末尾追加 `.app-header { --focus-ring: … }` 后门仍 8/8 全绿。现已加断言
   「`--focus-ring` 在 `styles/**` 里只声明一次且落在 `tokens.css :root`」，并做变异实测：
   追加局部覆盖 → 门红（`expected [ 'global.css .app-header', …(1) ] to deeply equal
   [ 'tokens.css :root' ]`）→ 还原 → 10 passed。
5. **一审 S2**：判据原先只查"有没有 `var()`"、不查"有没有裸色值"，`var(--color-x, #ff00ff)`
   这种带 fallback 的形态会放行（仓库里这类写法有 3 处）。已加反向断言（环的每一层里不得
   出现裸 `#hex` / `rgb()`）。
6. **`theme-contrast.spec.ts` 的 12 对 AA 清单里没有焦点环**：它判的是"声明出来的文字/背景
   配对"，非文字对比度不在口径内（#159 也只判文字）。本门补的正是这个缺口，
   但**只覆盖 `--focus-ring` 这一条**（见边界第 6 条）。
4. **两处关于焦点环的注释会随本改动过期**，已在本次一并更正：`tokens.css` 文件头
   "亮蓝留给非文字强调（焦点环等）"与 `--color-accent` 的行内注释（环已不再用 signal 蓝）。

## 复跑

```bash
corepack enable && pnpm install --frozen-lockfile
pnpm exec vitest run --project unit apps/web/tests/focus-ring.spec.ts   # 本条门（秒级，无浏览器）
pnpm check                                                             # Q0（含本条门）
```

红→绿复现：把 `apps/web/src/styles/tokens.css` 末尾的 `--focus-ring` 换回
`0 0 0 3px color-mix(in srgb, var(--color-signal) 40%, transparent)` → 门必红；
换回双层环 → 必绿。
