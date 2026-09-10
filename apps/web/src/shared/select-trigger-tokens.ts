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
 *    （对外 API 不变，`apps/web/tests/e2e/*` 同链路上的既有引用也不用改）。
 */

/** 触发器背景所用的 L1 token（`--dsw-*` 白名单见 `styles/dsw-tokens.css`）。 */
export const SELECT_TRIGGER_BACKGROUND_TOKEN = '--dsw-alias-bg-layer-1'
/** 触发器描边所用的 L1 token：与 vendored `Input.module.css` 同值，同族控件同描边。 */
export const SELECT_TRIGGER_BORDER_TOKEN = '--dsw-alias-border-l4'

/** 归一化颜色文本：同一颜色在 `getComputedStyle` 与 token 原文里的空格形态不同。 */
export function normalizeColor(value: string): string {
  return value.replaceAll(/\s+/g, '').toLowerCase()
}

/** 触发器上被判据覆盖的 computed style + 判据要用到的 token 原始值/解析值。 */
export interface MenuTriggerProbe {
  /** `getComputedStyle(trigger).backgroundColor`：**最终解析值**（rgb(...)）。 */
  background: string
  /** `getComputedStyle(trigger).borderTopColor`：同上。 */
  borderColor: string
  /** `getComputedStyle(trigger).borderTopLeftRadius`：如 '8px'。 */
  radius: string
  /**
   * `getComputedStyle(trigger).getPropertyValue(<token>)`：**这条规则自己声明的原文**，
   * 即 `var(--dsw-alias-…)`。实测：`getComputedStyle` 的自定义属性拿到的是声明原文而不是
   * 解析值（真正的解析值要靠 `backgroundColor` 那三个属性读）——正好用来钉"用的哪个 token"。
   */
  rawBackground: string
  /** 同上，用于描边 token。 */
  rawBorder: string
  /** `:root` 上 token 的解析值（浅色一套）。 */
  resolvedBackgroundToken: string
  resolvedBorderToken: string
}

/**
 * 视觉判据的**判定函数**（纯函数，不碰 DOM）。check 三条：
 * ① 规则声明的就是约定的那两个 token（`rawBackground`/`rawBorder` 指向它们）；
 * ② 浏览器算出来的最终值与 token 解析值相等；
 * ③ 圆角是约定的 8px（与 vendored `Input.module.css` 同半径）。
 *
 * 为什么必须查 ①（而不是只比对最终颜色）：实测 `--dsw-alias-bg-layer-1` 与 `-2` 在浅色下
 * 都是 `rgb(255,255,255)`——只比最终值的判据在"换了个同值 token"时静默通过，等于没判。
 *
 * @returns 违反判据的说明列表；空数组 = 全过
 */
export function checkMenuTriggerTokens(
  probe: MenuTriggerProbe,
  expectBackgroundToken: string,
  expectBorderToken: string,
): string[] {
  const failures: string[] = []
  const tokenResolved = (name: string): string | null => {
    if (name === expectBackgroundToken) return probe.resolvedBackgroundToken
    if (name === expectBorderToken) return probe.resolvedBorderToken
    return null
  }
  for (const [label, raw, actual, expectedToken] of [
    ['背景', probe.rawBackground, probe.background, expectBackgroundToken],
    ['描边', probe.rawBorder, probe.borderColor, expectBorderToken],
  ] as const) {
    const declared = /var\(\s*(--[\w-]+)\s*\)/.exec(raw)?.[1]
    if (declared !== expectedToken) {
      failures.push(
        `${label}声明的是 ${declared ?? `（不是 var()：${raw}）`}，约定应是 ${expectedToken}`,
      )
      continue
    }
    const expected = tokenResolved(expectedToken)
    if (expected === null || expected === '') {
      failures.push(`L1 token ${expectedToken} 未解析（:root 取到空串）`)
      continue
    }
    if (normalizeColor(actual) !== normalizeColor(expected)) {
      failures.push(
        `${label}取值与 ${expectedToken} 的解析值不符：computed=${actual} token=${expected}`,
      )
    }
  }
  if (probe.radius !== '8px') {
    failures.push(`圆角应为 8px（与 vendored Input 同半径），实测 ${probe.radius}`)
  }
  return failures
}
