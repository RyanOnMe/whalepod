# 控件族视觉一致性验收（#168：自研表单控件对齐 DSH 族）

- 对应场景/门禁：Q0 静态门（源码文本判据）+ Q5 浏览器门（computed style 判据）
- 对应 Issue：#168（P1-168）
- 上次验证：2026-09-11 · `feat/p1-168-control-family` · Q0 PASS（4 条新用例全绿 + 9 条变异验证全红）；
  **Q5 未跑**（本机同一时刻只允许一套 e2e 栈，调度未放行，见「边界与未覆盖」）

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
| 真实浏览器 | `getComputedStyle` 的 `borderTopWidth` / `borderTopColor` / `backgroundColor` / `color` / `borderTopLeftRadius` / `minHeight`，外加**本元素上 token 的声明原文**（`getPropertyValue('--dsw-…')`） | `helpers.ts` 的 `assertControlTokens` → 共用 `checkControlTokens` |

为什么两条通道都要：「规则里写的是哪个 token」只有源码文本能证（浏览器只知道算出来的颜色，
而 `--dsw-alias-border-l3` 与 `-l4` 在浅色下**同值**：实测都是 `rgba(0, 0, 0, 0.16)`）；
「层叠之后浏览器算出来的还是不是这套值」只有真实浏览器能证（`@media`、后置规则、深色覆盖）。

## 判定（成功长什么样）

四条，全部可证伪：

1. **描边与圆角逐值等于 vendored `Input`**：`.field input` / `.field textarea` / `.button` /
   `.button-primary` / `.button-quiet` / `.button-danger` 六条规则的 `border` 与 `border-radius`
   等于从 vendored CSS 读出的期望值（本仓当前实测：`0.5px solid var(--dsw-alias-border-l4)`、`8px`）；
   `.button-quiet` 是唯一例外且**显式登记**为 `0.5px solid transparent`（自绘无边形态）。
2. **颜色只引用 L1 `--dsw-*`**：`color` / `background` / `background-color` / `border` /
   `border-color` 逐属性判；出现裸色值（`#fff`）、`color-mix()`、应用层 `--color-*` 一律红。
   两个变体额外钉**具体 token 名**（`--dsw-static-red-900` 而非别名 red-500：白底 15.9:1 vs 4.50:1）。
3. **`min-height` 与 `var(--touch-min)` 同值且 `--touch-min ≥ 40px`**：高度轴不跟着 vendored
   `Input` 降到 32px，由判据承担，不靠注释。
4. **变异验证**：按「规则 + 属性」改坏一处（描边回 1px / 圆角回 6px / 同值换 token /
   颜色回应用层 token / 高度回 32px / 变体写裸色值 / 无边形态被改松 / 危险色回亮阶），
   同一条判据必须红，且失败信息带坐标（哪条规则、期望值、实测值）。

## 归因（失败先看哪层）

| 现象 | 层 | 去哪看 |
|---|---|---|
| 判据报"找不到规则" | 判据自身的选择器定位 | `findRules` 的注释（两种实测踩过的错法：漏 `@import` 的 `;` 边界、漏花括号记账） |
| 描边/圆角不符 | 应用层 CSS | `apps/web/src/styles/global.css` 的 `#168` 段 |
| 颜色不符 | token 层 | `apps/web/src/styles/dsw-tokens.css`（L1 白名单）与 `tokens.css`（应用层映射） |
| 浏览器侧与源码侧结论不一致 | 层叠 | 产物 CSS 顺序（`global.css` 头块记了实测顺序）与 `@media` 覆盖 |

## 取证

- Q0：`pnpm check` 输出（本文件「上次验证」那一行记的是当次结果）。
- 变异验证的逐条失败信息：用例内会 `console.log('[变异] …')`，即"红→绿摘要"的原始出处；
  提交说明里贴的就是这段。
- Q5：`artifacts/evidence/e2e/<attempt>/`（失败自动产包，见 `helpers.ts` 的
  `collectEvidenceOnFailure`）。

## 边界与未覆盖

1. **Q5 未跑**：本机同一时刻只允许一套 e2e 栈（`scripts/e2e-serve.mts` 占 5173/18080），
   调度未放行。浏览器侧 `assertControlTokens` 的**接线已写好**（p1-07 项目页四处、p1-142 成员页
   390 档一处），但**采集本身没有实测过**——包含"`getComputedStyle` 的自定义属性读到的是声明
   原文"这条依赖（该行为移植自 #158/#161 的 `assertMenuTriggerTokens`，同样未经本次实测）。
2. **两档截图自审未做**：1280×720 / 390×844 的成员页、项目页、Task Room 三处截图依赖同一套
   e2e 栈，一并等放行。**本次没有"看着没问题"的结论**。
3. **深色一套未验**：`body[data-ds-dark-theme]` 下 L1 换了一套值，判据只在浅色跑。
4. **未迁移的控件仍在旧族**（本次刻意不收口，登记以免被当成漏改）：
   - `.comment-composer textarea`（Task Room 留言框）：独立的 1px `--color-line` / 6px 圆角规则；
   - 原生 `<select>`：`global.css` 里只有 `select { font: inherit; color: inherit }`，没有描边/圆角规则
     ——`#task-assignee-*`、`#invite-role` 在 #158/#161 落地前仍是浏览器默认外观；
   - `.card` / `.inline-form` / `.error-banner` 等容器面（1px `--color-line`）：那是"面"不是"控件"，
     与 DSH 族的关系要单独裁决；
   - `.badge-*`（`border-radius: 999px`）与 `.agent-card`。
5. **focus 环**：`:focus-visible` 的通用规则里写了 `border-radius: var(--radius-sm)`，对已经声明
   圆角的控件无实际影响（box-shadow 跟随元素自身圆角），但它是"6px"这个旧值的最后一处残留。
   本次不动（改它会让环在无圆角元素上变形，属另一个话题），登记在此。
6. **间距未对齐**：只对了描边/圆角/颜色/高度四项，padding 与 DSH 族（`Input` 的 `0 8px`）不同。
7. **按钮的 `border-radius` 与 vendored `Button.module.css` 无关**：那条是 18px 胶囊，本次按 #168
   的裁决只对齐 `Input` 族的 8px。两族度量不一致这件事本身未被裁决，只是本次不扩大范围。

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
