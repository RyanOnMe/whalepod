/**
 * #168 自研表单控件（`.field input` / `.field textarea` / `.button` 族）与 DSH 族之间的
 * **契约常量与判定函数**。
 *
 * 为什么单独一个文件、而且必须是**纯运行时依赖为零**的模块：
 * 1. 这条契约有两个消费者，分居两侧——单测（`tests/control-family.spec.tsx`）在 CSS 文本上
 *    钉「描边/圆角逐值等于 vendored `Input.module.css`、颜色只吃 L1 `--dsw-*`」，Q5
 *    （`tests/e2e/helpers.ts` 的 `assertControlTokens`）在真实浏览器里钉「computed style
 *    等于这些 token 的解析值」。两边各写一份字面量就会漂移成「单测管 A、浏览器管 B」。
 * 2. 浏览器侧不能从 `.tsx` 反向 import（那条链上有 CSS modules）；Playwright 的 e2e 进程
 *    要能直接 load 这个模块。所以常量落在无依赖的独立模块。这条理由与 #158 的
 *    `shared/select-trigger-tokens.ts` 同源（那条分支尚未合入 main，故此处各自独立成文；
 *    两份的 token 名与 DSH 族取值一致，合流时可直接合并）。
 *
 * **8px / 0.5px 不写在这里，也不写在测试里**：DSH 族的度量一律从
 * `vendor/dsh-ui/Input.module.css` 现场读（见 `tests/control-family.spec.tsx` 的
 * `readVendorMetrics`）。把数字抄进判据，上游改度量时判据不会红——那等于没判。
 */

/**
 * 控件背景所用的 L1 token。
 *
 * 取值说明：`.button` 与 `.field input` 迁移前用的是应用层 `--color-surface`，
 * 它本身 `var(--dsw-alias-bg-layer-2)`（tokens.css）。这里直接落到 L1 的 layer-2——
 * **不是**为了改名而同值换名：`.card` / `.inline-form` 这些容器面用的就是 layer-2，
 * 控件留在 layer-2 才与所在卡片同面，看得见的是 0.5px `border-l4` 那道描边。
 */
export const CONTROL_BACKGROUND_TOKEN = '--dsw-alias-bg-layer-2'

/**
 * 控件描边所用的 L1 token：与 vendored `Input.module.css` 的 `.wrap` 同 token、同宽度，
 * 同族控件同描边。**具体宽度由判据从 vendored CSS 读**，这里只钉 token 名。
 */
export const CONTROL_BORDER_TOKEN = '--dsw-alias-border-l4'

/** 控件主文字所用的 L1 token。 */
export const CONTROL_LABEL_TOKEN = '--dsw-alias-label-primary'

/** 主按钮文字（深底上的前景色，vendored `Button.module.css` 的 `.primary` 同 token）。 */
export const CONTROL_PRIMARY_LABEL_TOKEN = '--dsw-alias-label-primary-foreground'

/** 主按钮底色（vendored `.primary` 同 token）。 */
export const CONTROL_PRIMARY_FILL_TOKEN = '--dsw-alias-button-primary-fill'

/** 主按钮 hover 底色（vendored `.primary:hover` 同 token）。 */
export const CONTROL_PRIMARY_HOVER_TOKEN = '--dsw-alias-button-primary-hover'

/**
 * 危险按钮文字所用的 L1 token。
 *
 * 取**静态档 red-900** 而不是别名 `--dsw-alias-state-error-primary`（= red-500）：白底实测
 * red-900 约 15.9:1，red-500 只有 4.50:1（正好压在 WCAG AA 的 4.5 上）。这与 tokens.css
 * 头块记的「文字色取 900 阶而非 500 阶」是同一条纪律，#151 就是亮阶当文字色的回归现场。
 */
export const CONTROL_DANGER_LABEL_TOKEN = '--dsw-static-red-900'

/** 高度下限所用的应用层 token；判据会断言它与 `--touch-min` 同值且 ≥40px。 */
export const CONTROL_TOUCH_TOKEN = '--touch-min'

/** 归一化颜色文本：同一颜色在 `getComputedStyle` 与 token 原文里的空格形态不同。 */
export function normalizeColor(value: string): string {
  return value.replaceAll(/\s+/g, '').toLowerCase()
}

/** 一条控件上被判据覆盖的 computed style + 判据要用到的 token 原始值/解析值。 */
export interface ControlProbe {
  /** `getComputedStyle(el).backgroundColor`：**最终解析值**（rgb(...)）。 */
  background: string
  /** `getComputedStyle(el).borderTopColor`：同上。 */
  borderColor: string
  /** `getComputedStyle(el).borderTopWidth`：如 '0.5px'（判据断言等于 vendored 的宽度）。 */
  borderWidth: string
  /** `getComputedStyle(el).borderTopLeftRadius`：如 '8px'。 */
  radius: string
  /** `getComputedStyle(el).color`：文字色最终解析值。 */
  color: string
  /** `getComputedStyle(el).minHeight`：如 '40px'。 */
  minHeight: string
  /**
   * `getComputedStyle(el).getPropertyValue(<token>)`：**这条规则自己声明的原文**，
   * 即 `var(--dsw-…)`。实测：`getComputedStyle` 的自定义属性拿到的是声明原文而不是解析值
   * （真正的解析值要靠 `backgroundColor` 那几个属性读）——正好用来钉"用的哪个 token"。
   */
  rawBackground: string
  /** 同上，用于描边 token。 */
  rawBorder: string
  /** 同上，用于文字色 token。 */
  rawColor: string
  /** `:root` 上 token 的解析值（浅色一套）。 */
  resolvedBackgroundToken: string
  resolvedBorderToken: string
  resolvedLabelToken: string
  /** `:root` 上 `--touch-min` 的解析值，如 '40px'。 */
  resolvedTouchToken: string
}

/**
 * 视觉判据的**判定函数**（纯函数，不碰 DOM）。对上图每个探针查五条：
 * ① 规则声明的就是约定的那几个 token（`rawBackground`/`rawBorder`/`rawColor` 指向它们）；
 * ② 浏览器算出来的最终颜色与 token 解析值相等；
 * ③ 描边**宽度**与圆角等于 vendored `Input` 的度量（由调用方从 vendored CSS 读出后传入，
 *    本函数不内置 8px / 0.5px）；
 * ④ `min-height` 与 `--touch-min` 同值且不小于调用方给出的下限。
 *
 * 为什么必须查 ①（而不是只比对最终颜色）：实测 `--dsw-alias-bg-layer-1` 与 `-2` 在浅色下
 * 都是 `rgb(255,255,255)`、`--dsw-alias-border-l3` 与 `-l4` 又都是 `rgba(0,0,0,0.16)`
 * 形态相近——只比最终值的判据在"换了个同值 token"时静默通过，等于没判。
 *
 * @param probe 浏览器实测探针
 * @param expect 期望值：三个 token 名 + 从 vendored CSS 读出的度量 + 高度下限
 * @param label 控件标识（失败信息里定位用，如 '.field input')
 * @returns 违反判据的说明列表；空数组 = 全过
 */
export function checkControlTokens(
  probe: ControlProbe,
  expect: {
    backgroundToken: string
    borderToken: string
    labelToken: string
    /** 从 vendored `Input.module.css` 读出的描边宽度，如 '0.5px'。 */
    vendorBorderWidth: string
    /** 从 vendored `Input.module.css` 读出的圆角，如 '8px'。 */
    vendorRadius: string
    /** 高度下限（px）。 */
    minTouchPx: number
  },
  label = '控件',
): string[] {
  const failures: string[] = []
  const resolved: Record<string, string> = {
    [expect.backgroundToken]: probe.resolvedBackgroundToken,
    [expect.borderToken]: probe.resolvedBorderToken,
    [expect.labelToken]: probe.resolvedLabelToken,
  }
  for (const [what, raw, actual, expectedToken] of [
    ['背景', probe.rawBackground, probe.background, expect.backgroundToken],
    ['描边', probe.rawBorder, probe.borderColor, expect.borderToken],
    ['文字', probe.rawColor, probe.color, expect.labelToken],
  ] as const) {
    const declared = /var\(\s*(--[\w-]+)\s*\)/.exec(raw)?.[1]
    if (declared !== expectedToken) {
      failures.push(
        `${label} ${what}声明的是 ${declared ?? `（不是 var()：${raw}）`}，约定应是 ${expectedToken}`,
      )
      continue
    }
    const expected = resolved[expectedToken]
    if (expected === undefined || expected === '') {
      failures.push(`L1 token ${expectedToken} 未解析（:root 取到空串）`)
      continue
    }
    if (normalizeColor(actual) !== normalizeColor(expected)) {
      failures.push(
        `${label} ${what}取值与 ${expectedToken} 的解析值不符：computed=${actual} token=${expected}`,
      )
    }
  }
  if (probe.borderWidth !== expect.vendorBorderWidth) {
    failures.push(
      `${label} 描边宽度应为 ${expect.vendorBorderWidth}（与 vendored Input 同度量），实测 ${probe.borderWidth}`,
    )
  }
  if (probe.radius !== expect.vendorRadius) {
    failures.push(
      `${label} 圆角应为 ${expect.vendorRadius}（与 vendored Input 同半径），实测 ${probe.radius}`,
    )
  }
  if (probe.minHeight !== probe.resolvedTouchToken) {
    failures.push(
      `${label} min-height=${probe.minHeight} 与 ${CONTROL_TOUCH_TOKEN}（${probe.resolvedTouchToken}）不同值`,
    )
  }
  const touchPx = Number.parseFloat(probe.resolvedTouchToken)
  if (!Number.isFinite(touchPx) || touchPx < expect.minTouchPx) {
    failures.push(
      `${label} ${CONTROL_TOUCH_TOKEN}=${probe.resolvedTouchToken} 小于触屏下限 ${expect.minTouchPx}px`,
    )
  }
  return failures
}
