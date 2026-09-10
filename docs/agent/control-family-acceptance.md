# 控件族视觉一致性验收（#168：自研表单控件对齐 DSH 族）

- 对应场景/门禁：Q0 静态门（源码文本判据）+ Q5 浏览器门（computed style 判据）
- 对应 Issue：#168（P1-168）
- 上次验证：2026-09-11 · `feat/p1-168-control-family` · Q0 PASS（6 条新用例全绿 + 15 条变异验证全红）；
  **Q5 未跑**（本机同一时刻只允许一套 e2e 栈，调度未放行，见「边界与未覆盖」）
- 独立评审（同日）提出两条阻断，已整改，复现与修法见下节「评审整改」

## 验的是哪条用户路径

不是"某个函数对不对"，而是**用户在同一屏里看到的控件是不是同一族**：

- 成员页：角色下拉（#158/#161 之后是 vendored `Menu` 触发器）+ 「生成邀请链接」按钮；
- 项目页：项目名称/描述输入框 + 「新建项目」「创建项目」按钮；
- 项目页创建任务表单：任务标题输入框 + 任务描述 textarea + 责任人下拉 + 「创建任务」「取消」按钮；
- Task Room：留言 textarea + 「发送留言」按钮。

#168 之前这些控件分属两族：下拉触发器吃 DSH 族（0.5px `--dsw-alias-border-l4` 描边 / 8px 圆角），
输入框与按钮吃自研旧族（1px `--color-line` / 6px 圆角 / 应用层 `--color-*`）。本次把后一族落到
同一族，**高度轴不动**（40px `--touch-min`，不是 vendored `Input` 的 32px 桌面密度）。

## 驱动（怎么触发）

### 一、源码文本判据（Q0，本机可跑）

```bash
pnpm exec vitest run --project web tests/control-family.spec.tsx
```

判据文件里**没有任何 `0.5px` / `8px` 字面量**：度量从
`apps/web/src/vendor/dsh-ui/Input.module.css` 的 `.wrap` 现场读（`readVendorMetrics`）。
上游改度量而应用层不同步 → 判据红；把数字抄进测试就永远验不出这件事。

### 二、真实浏览器判据（Q5）

```bash
pnpm exec playwright test --project=p1-07    # 项目页创建任务表单：input / textarea / 两个按钮变体
pnpm exec playwright test --project=p1-142   # 成员页 390 档：主按钮
```

采集函数 `assertControlTokens` 在 `apps/web/tests/e2e/helpers.ts`；**判定函数与 token 常量**在
零运行时依赖的纯模块 `apps/web/src/shared/control-style-tokens.ts`，单测与 e2e 取同一份
（两边各写一份必然漂移成"单测管 A、浏览器管 B"）。

## 观测（看什么）

| 通道 | 观测物 | 判定位置 |
|---|---|---|
| CSS 源码文本 | 规则的声明值（`border` / `border-radius` / `background` / `color` / `min-height`）与 `var()` 指向的 token 名 | `tests/control-family.spec.tsx` 的 `assertControlFamily` |
| 真实浏览器 | `getComputedStyle` 的 `borderTopWidth` / `borderTopColor` / `backgroundColor` / `color` / `borderTopLeftRadius` / `minHeight`，外加**该元素上各 token 的解析值**（`getPropertyValue('--dsw-…')`，沿继承链解 `var()`），以及同浏览器里 vendored 声明的参照实测值 | `helpers.ts` 的 `assertControlTokens` → 共用 `checkControlTokens` |

为什么两条通道都要：「规则里写的是哪个 token」**只有源码文本能证**——`getComputedStyle` 的
自定义属性在 computed-value 阶段就完成了 `var()` 代换，读到的是解析值而不是声明原文
（评审 BLOCK-1 实测：`rgb(255, 255, 255)`、`rgba(0, 0, 0, 0.16)`），所以浏览器侧根本分不出
`--dsw-alias-bg-layer-1` 与 `-2`（浅色下**都**是 `rgb(255, 255, 255)`）。
「层叠之后浏览器算出来的还是不是这套值」则只有真实浏览器能证（`@media`、后置规则、深色覆盖）。

**`border: 0.5px` 在 Chrome 计为 1px**：computed/used 宽度都是 `1px`（DPR=1 与 DPR=2 相同）。
所以浏览器侧不能拿 `'0.5px'` 当期望值，改为给 vendored 声明建参照元素实测、**元素对元素**比较；
源码文本侧仍然是 `0.5px`（那里比的是声明值）。

## 判定（成功长什么样）

源码文本侧（`tests/control-family.spec.tsx`）四条，全部可证伪：

1. **描边与圆角逐值等于 vendored `Input`**：期望值由 `parseVendorInputMetrics` 从
   `vendor/dsh-ui/Input.module.css` 现场读出（当前实测：`0.5px solid var(--dsw-alias-border-l4)`、`8px`），
   覆盖 `.field input` / `.field textarea` / `.button` / `.button-primary` / `.button-quiet` /
   `.button-danger` 六条，外加 5 条交互变体（见下）；**变体不登记度量就必须确实没声明度量**
   （谁在变体里复制一份描边/圆角会被抓出来）。`.button-quiet` 是唯一无边例外，且**显式登记**
   为 `${vendor.borderWidth} solid transparent`（宽度不写死）。
2. **颜色只引用 L1 `--dsw-*`，且登记了期望 token 的属性必须是那一个**：
   `color` / `background` / `background-color` / `border` / `border-color` 逐属性判；
   裸色值（`#fff`）、`color-mix()`、应用层 `--color-*` 一律红；**声明了却没登记期望值的属性
   也红**（挡住"以后加了条新颜色没人管"）。期望表逐条钉死：主按钮底
   `--dsw-alias-button-primary-fill`（不是 `brand-primary`）、hover 底 `--dsw-alias-button-primary-hover`、
   危险底 `--dsw-alias-bg-layer-2`（不是错误色：红底 + red-900 字仅 **3.19:1**）、
   危险字 `--dsw-static-red-900`（不是别名 red-500：白底 **4.4976:1**，差 0.0023 不到 AA 的 4.5）、
   hover 面/描边 `--dsw-alias-interactive-bg-hover` / `--dsw-alias-border-l3`。
3. **`min-height` 与 `var(--touch-min)` 同值且 `--touch-min ≥ 40px`**：高度轴不跟着 vendored
   `Input` 降到 32px，由判据承担，不靠注释。
4. **变异验证（15 条）**：描边回 1px / 圆角回 6px / 描边换 `border-l3` / 背景换应用层
   `--color-surface`（**同值**：两者浅色下都是 `rgb(255,255,255)`）/ 高度回 32px / 主按钮写 `#fff` /
   主按钮底换 `brand-primary` / 危险底换错误色 / 危险字回红-500 / 危险描边回 1px /
   quiet 无边被改松 / hover 面换应用层变量 / `:disabled` 里塞裸色值 / 焦点描边换应用层变量 /
   危险底写 `color-mix`——每条必须红，且失败信息指到那条规则。

浏览器侧（Q5，`assertControlTokens`）四项：背景/描边色/文字色等于同 token 在**该元素上**的解析值；
描边宽度与圆角等于**同一浏览器里 vendored `Input` 声明的实测值**（元素对元素）；
`min-height` 等于 `--touch-min`。

**两层分工为什么不是重复**：浏览器读不到"声明原文"（见下方 BLOCK-1），所以
「这条规则用的是哪个 token」只能在源码文本这一层判；反过来"层叠之后浏览器算出来的值"
只能在浏览器里判。两层各判各的那一半。

### 评审整改（2026-09-11，独立评审两条阻断）

| 项 | 复现 | 修法 |
|---|---|---|
| **BLOCK-1** Q5 对 6/6 控件必红 | ① `getComputedStyle(el).getPropertyValue('--dsw-…')` 拿到的是**解析值**（`rgb(255,255,255)`），不是声明原文——自定义属性是继承属性、且 computed-value 阶段就完成 `var()` 代换。早先的注释与判据都写反了 ② Chrome 对 `border: 0.5px` 的 computed/used 宽度就是 **1px** | 浏览器侧改为**解析值对解析值**（沿继承链 `resolveTokenValue`，认局部重绑与深色主题）+ **元素对元素**（用 vendored 的 `border`/`border-radius` 声明建参照元素实测）；"用了哪个 token"整条移到源码文本判据。两处错误注释已改对 |
| **BLOCK-2** 源码判据对 `@media` 内嵌规则静默失明 | 往 `global.css` 追加 `@media (max-width: 390px) { .field input { border: 1px …; border-radius: 6px } }` → 全绿通过（选择器文本里带着 `@media (…) { ` 前缀，`.field input` 永远匹配不上，那条规则**根本没被看到**） | 扫描器改为按配对花括号切「前导 + 体」，**at-rule 前导剥在选择器之外**；`@media` 用例进常驻变异集（`BLOCK-2` 用例：既断言内层规则被扫到，又断言同名规则命中两条时报"定位不唯一"） |

## 归因（失败先看哪层）

| 现象 | 层 | 去哪看 |
|---|---|---|
| 判据报"找不到规则" | 判据自身的选择器定位 | `scanRules` 的注释（两种实测踩过的错法：漏 `@import` 的 `;` 边界、`@media` 前导没剥在选择器之外） |
| 判据报"命中 N 条规则" | 同一选择器在别处（常是 `@media` 内）又声明了一次 | 去看那条重复规则——判据故意**不取第一条**，因为"窄屏单独改松"正是它的目标 |
| 描边/圆角不符 | 应用层 CSS | `apps/web/src/styles/global.css` 的 `#168` 段 |
| 颜色不符 | token 层 | `apps/web/src/styles/dsw-tokens.css`（L1 白名单）与 `tokens.css`（应用层映射） |
| 浏览器侧与源码侧结论不一致 | 层叠 | 产物 CSS 顺序（`global.css` 头块记了实测顺序）与 `@media` 覆盖 |

### 整改时的实测（本机 Chrome，独立小页面，不进 e2e 栈）

| 断言 | 实测 |
|---|---|
| 元素上 `getPropertyValue('--tok-a')`（`:root` 里 `--tok-a: var(--tok-b)`） | `"rgb(15, 17, 21)"` —— **解析值，不是 `var(--tok-b)`**（BLOCK-1 成因 A 逐字复现） |
| 控件 `borderTopWidth`（`border: 0.5px solid …`） | `1px` |
| 参照元素同声明的 `borderTopWidth` | `1px`（DPR=1 与 DPR=2 都相同）→ 元素对元素比较成立 |
| 参照元素 `borderTopLeftRadius` | `8px`（与控件一致） |
| Playwright 把 `CSSStyleDeclaration[]` 序列化回 Node 后 | `typeof getPropertyValue === 'function'`（三个元素全过）→ `resolveTokenValue` 在 Node 侧可用 |
| 参照元素在**没定义** `--dsw-alias-border-l4` 的页面上 | `borderTopWidth = 0px`（整条 `border` 在 computed-value 阶段失效，回落到初值）→ 所以 `assertControlTokens` 显式断言参照非 0，防"两边都是 0"的假绿 |

### 为什么参照元素是合成元素而不是页面上的 vendored `Input`

本仓目前只有 `DevicesPage` 用了 vendored 原语（`StateDot` / `Tag`），**`Input` 虽然导出了但一个页面都没渲染**
（`grep` 实测：`apps/web/src` 里除 vendored 子树自身外，只有 `DevicesPage.tsx` 引了 `vendor/dsh-ui`）。
所以"元素对元素"只能用 vendored 的 `border` / `border-radius` **声明**合成一个参照元素来量——
量到的仍然是"这个浏览器怎么渲染 vendored 那份度量"，这正是要比较的东西。

## 取证

- Q0：`pnpm check` 输出（本文件「上次验证」那一行记的是当次结果）。
- 变异验证的逐条失败信息：用例内会 `console.log('[变异] …')`，即"红→绿摘要"的原始出处；
  提交说明里贴的就是这段。
- Q5：`artifacts/evidence/e2e/<attempt>/`（失败自动产包，见 `helpers.ts` 的
  `collectEvidenceOnFailure`）。

## 视觉变化（人眼可见，逐条）

迁移前后**同值**的：控件背景、控件文字色、主按钮底/字、危险按钮字（`--color-danger-strong`
本来就 = `--dsw-static-red-900`）、控件高度（都 40px）。

迁移后**确实变了**的（写清以免"没变"被当成"没做"）：

| 控件 | 变化 | 取自 |
|---|---|---|
| `.field input` / `.field textarea` / `.button` | 描边 1px→**0.5px**、颜色 `--color-line`→`border-l4`、圆角 6px→**8px** | #168 的裁决（对齐 DSH 族） |
| `.button` / `.button-quiet` hover | 从"描边染蓝"改为**面变**（浅灰底）+ 描边档加深一档 | `--dsw-alias-interactive-bg-hover` / `--dsw-alias-border-l3` |
| `.button-primary` 底 | `--color-signal`（blue-600，`rgb(37,99,235)`）→ **近黑** `rgb(15,17,21)` | vendored `Button.module.css` 的 `.primary` 同 token |
| `.button-primary` 字 | `#fff` 裸值 → `--dsw-alias-label-primary-foreground`（同值，只是改了来源） | 同上 |
| `.button-quiet` 字 | `--color-signal`（蓝）→ **近黑**（= `--dsw-alias-brand-primary`） | 与主按钮同族的前景语义 |
| `.button-danger` 描边 | `--color-danger`（red-900，**红**）→ 中性 hairline `border-l4` | 见下"已知取舍" |

**已知取舍**（登记，不在本 PR 内解决）：`.button-danger` 的红色可供性现在只由**文字**承担；
同屏的红字徽标（`.badge-*`，描边是 `color-mix(--color-danger 35%)`）仍是红边，两者并排时
"红边"的含义不再统一。要恢复危险按钮的红描边，需要一个新的 L1 危险描边档（当前 L1 里没有），
属下一次裁决。

## 边界与未覆盖

1. **Q5 未跑**：本机同一时刻只允许一套 e2e 栈（`scripts/e2e-serve.mts` 占 5173/18080），
   调度未放行。浏览器侧 `assertControlTokens` 的**接线已写好**（p1-07 项目页四处、p1-142 成员页
   390 档一处），但**在真实页面上的采集没有实测过**。其中三件关键依赖已在整改时用**独立小页面**
   实测（见上表）：自定义属性读到的是解析值、`0.5px→1px` 且参照同值、序列化后方法可用。
   仍未实测的是：这些行为**在本仓真实页面（含全部 CSS 与 token）上的落点**、
   参照自检（token 缺失时的报错路径）、以及 390 档下的取值。
2. **两档截图自审未做**：1280×720 / 390×844 的成员页、项目页、Task Room 三处截图依赖同一套
   e2e 栈，一并等放行。**本次没有"看着没问题"的结论**。
3. **深色一套未验**：`body[data-ds-dark-theme]` 下 L1 换了一套值（`border-l3`/`l4` 也不同值），
   判据只在浅色跑；浏览器侧探针已经按"沿继承链取值"写，理论上能覆盖，但没有实测。
4. **未迁移的控件仍在旧族**（本次刻意不收口，登记以免被当成漏改）：
   - `.comment-composer textarea`（Task Room 留言框）：独立的 1px `--color-line` / 6px 圆角规则；
   - 原生 `<select>`：`global.css` 里只有 `select { font: inherit; color: inherit }`，没有描边/圆角规则
     ——`#task-assignee-*`、`#invite-role` 在 #158/#161 落地前仍是浏览器默认外观；
   - `.card`（10px 圆角）/ `.inline-form` / `.error-banner` 等容器面（1px `--color-line`）：
     那是"面"不是"控件"，与 DSH 族的关系要单独裁决；
   - `.badge-*`（`border-radius: 999px`）与 `.agent-card`。
   所以"控件一致收口"这句话**只覆盖本次点名的三族**，不是全站。
5. **focus 环**：`:focus-visible` 的通用规则里写了 `border-radius: var(--radius-sm)`。
   实测对这三条控件**无实际影响**（`box-shadow` 跟随元素自身的 8px 圆角），是"6px"这个旧值的
   残留但不是风险；本次不动。
6. **间距未对齐**：只对了描边/圆角/颜色/高度四项，padding 与 DSH 族（`Input` 的 `0 8px`）不同。
7. **按钮的 `border-radius` 与 vendored `Button.module.css` 无关**：那条是 18px 胶囊，本次按 #168
   的裁决只对齐 `Input` 族的 8px。两族度量不一致这件事本身未被裁决，只是本次不扩大范围。
8. **焦点环颜色仍吃应用层 token**：通用 `:focus-visible` 的 `box-shadow: var(--focus-ring)`，
   而 `--focus-ring` 里是 `var(--color-signal)`（应用层）。本 PR 只把**控件自己的**焦点描边
   （`.button:focus-visible`）钉进判据，环本身归 #164 的改动范围，未在本 PR 登记为已完成。

## 复跑

```bash
# Q0 单跑判据（最快）
pnpm exec vitest run --project web tests/control-family.spec.tsx

# Q0 全量
pnpm check

# Q5（需先确认本机没有别的 e2e 栈在占 5173/18080）
pnpm exec playwright test --project=p1-07
pnpm exec playwright test --project=p1-142
```
