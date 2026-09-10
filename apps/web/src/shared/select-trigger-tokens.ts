/**
 * #158 下拉触发器（`shared/SelectMenu.tsx`）与 L1 token 之间的**契约常量与判定函数**。
 *
 * 为什么单独一个文件、而且必须是**纯运行时依赖为零**的模块：
 * 1. 这条契约有两个消费者，分居两侧——单测（`tests/select-menu.spec.tsx`）在 CSS 文本上
 *    钉「规则只吃这些 token」，Q5（`tests/e2e/helpers.ts`）在真实浏览器里钉「computed
 *    style 等于这些 token 的解析值」。两边各写一份字面量就会漂移成「单测管 A、浏览器管
 *    B」：把 `--dsw-alias-bg-layer-1` 换成 `-2` 这种**浅色下同值**的改动会全绿漏过
 *    （实测：两者都是 `rgb(255,255,255)`）。
 * 2. 浏览器侧不能从 `SelectMenu.tsx` 反向 import：那条链上有 `Menu.js` → `Menu.module.css`
 *    与 `icons.js`，Playwright 的 e2e 进程要能直接 load 这个模块，带不进 CSS 模块。
 *    所以常量落在无依赖的独立模块，`SelectMenu.tsx` 从**这里** import 后原样再导出
 *    （对外 API 不变）。
 *
 * **能力边界（评审用真实 Chrome 证伪过一次，写死在这里免得后人再想当然）**：
 * - 浏览器侧**只能**判「computed 值 == `:root` 上该 token 的解析值」，**判不了**「用了哪个
 *   token」。本文件初版想让浏览器读"声明原文"（`getComputedStyle(el).getPropertyValue
 *   ('--dsw-…')` 期望拿到 `var(--dsw-…)`）——**那条在真实浏览器里必然红**：自定义属性是
 *   继承属性，且在 computed-value 阶段就完成了 `var()` 代换，元素上读到的就是最终值，
 *   永远不可能以 `var(` 开头。实测（本机 Chrome，DPR=1 与 DPR=2 都是）：
 *   `getPropertyValue('--tok-bg')` → `"rgb(255, 255, 255)"`（连 `var()` 间接链
 *   `--alias: var(--tok-bg)` 也一并代换完）。
 * - 「到底用了哪个 token」这件事**只能**在源码文本上判，那是 `select-menu.spec.tsx` 的
 *   CSS 断言；M3 那种"同值 token 互换"的变异也只有在**那里**才有意义。
 */

/** 触发器背景所用的 L1 token（`--dsw-*` 白名单见 `styles/dsw-tokens.css`）。 */
export const SELECT_TRIGGER_BACKGROUND_TOKEN = '--dsw-alias-bg-layer-1'
/** 触发器描边所用的 L1 token：与 vendored `Input.module.css` 同值，同族控件同描边。 */
export const SELECT_TRIGGER_BORDER_TOKEN = '--dsw-alias-border-l4'

/** 归一化颜色文本：同一颜色在 `getComputedStyle` 与 token 原文里的空格形态不同。 */
export function normalizeColor(value: string): string {
  return value.replaceAll(/\s+/g, '').toLowerCase()
}

/** 触发器上被判据覆盖的 computed style + 判据要用到的 token 解析值（**全是解析值**）。 */
export interface MenuTriggerProbe {
  /** `getComputedStyle(trigger).backgroundColor`。 */
  background: string
  /** `getComputedStyle(trigger).borderTopColor`。 */
  borderColor: string
  /** `getComputedStyle(trigger).borderTopLeftRadius`：如 '8px'。 */
  radius: string
  /** `getComputedStyle(document.documentElement).getPropertyValue(<背景 token>)`。 */
  resolvedBackgroundToken: string
  /** 同上，用于描边 token。 */
  resolvedBorderToken: string
}

/**
 * 视觉判据的**判定函数**（纯函数，不碰 DOM）。check 两条：
 * ① 浏览器算出来的背景 / 描边最终值与该 token 在 `:root` 上的解析值相等；
 * ② 圆角是约定的 8px（与 vendored `Input.module.css` 同半径）。
 *
 * **刻意不 check** 的两件事（连同"为什么"写死，免得后人补回来）：
 * - 「用了哪个 token」：见文件头的能力边界——浏览器读不到声明原文。所以**同值 token 互换**
 *   （`--dsw-alias-bg-layer-1` → `-2`）这个变异在浏览器侧**抓不到**，别指望它；那条判据在
 *   `select-menu.spec.tsx` 的 CSS 文本断言里。
 * - **描边宽度**：真实 Chrome 把 `border: 0.5px` 的 used/computed 宽度算成 **1px**
 *   （DPR=1 与 DPR=2 实测都是 1px），任何"与 vendored 的 0.5px 逐值相等"的浏览器断言都
 *   不可能成立；0.5px 这个**声明**由 CSS 文本断言钉，浏览器侧只判颜色。
 *
 * @returns 违反判据的说明列表；空数组 = 全过
 */
export function checkMenuTriggerTokens(
  probe: MenuTriggerProbe,
  expectBackgroundToken: string,
  expectBorderToken: string,
): string[] {
  const failures: string[] = []
  for (const [label, actual, expected, tokenName] of [
    ['背景', probe.background, probe.resolvedBackgroundToken, expectBackgroundToken],
    ['描边', probe.borderColor, probe.resolvedBorderToken, expectBorderToken],
  ] as const) {
    if (expected === '') {
      failures.push(`L1 token ${tokenName} 未解析（:root 取到空串）`)
      continue
    }
    if (normalizeColor(actual) !== normalizeColor(expected)) {
      failures.push(
        `${label}取值与 ${tokenName} 的解析值不符：computed=${actual} token=${expected}`,
      )
    }
  }
  if (probe.radius !== '8px') {
    failures.push(`圆角应为 8px（与 vendored Input 同半径），实测 ${probe.radius}`)
  }
  return failures
}
