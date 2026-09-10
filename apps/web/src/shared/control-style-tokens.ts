/**
 * #168 自研表单控件（`.field input` / `.field textarea` / `.button` 族）与 DSH 族之间的
 * **契约常量与判定函数**。
 *
 * 为什么单独一个文件、而且必须是**纯运行时依赖为零**的模块：
 * 1. 这条契约有两个消费者，分居两侧——单测（`tests/control-family.spec.tsx`）在 CSS 文本上
 *    钉「描边/圆角逐值等于 vendored `Input.module.css`、颜色只吃 L1 `--dsw-*`」，Q5
 *    （`tests/e2e/helpers.ts` 的 `assertControlTokens`）在真实浏览器里钉「computed style
 *    等于 token 解析值」。两边各写一份字面量就会漂移成「单测管 A、浏览器管 B」。
 * 2. 浏览器侧不能从 `.tsx` 反向 import（那条链上有 CSS modules）；Playwright 的 e2e 进程
 *    要能直接 load 这个模块。所以常量落在无依赖的独立模块。这条理由与 #158 的
 *    `shared/select-trigger-tokens.ts` 同源（那条分支尚未合入 main，故此处各自独立成文；
 *    两份的 token 名与 DSH 族取值一致，合流时可直接合并）。
 *
 * **8px / 0.5px 不写在这里，也不写在测试里**：DSH 族的度量一律从
 * `vendor/dsh-ui/Input.module.css` 现场读，且**解析只有一份实现**
 * （`parseVendorInputMetrics`，两侧各自 `readFileSync` 后调用它）。早先单测与 e2e 各写了
 * 一份解析器（连正则严格度都不同），正是"两边各写一份必漂移"的同一个坑（评审 S8）。
 */

/**
 * 控件背景所用的 L1 token。
 *
 * 取值说明：`.button` 与 `.field input` 迁移前用的是应用层 `--color-surface`，
 * 它本身 `var(--dsw-alias-bg-layer-2)`（tokens.css）。这里直接落到 L1 的 layer-2——
 * **不是**为了改名而同值换名：`.card` / `.inline-form` 这些容器面用的就是 layer-2，
 * 控件留在 layer-2 才与所在卡片同面，看得见的是那道描边。
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
 * 危险按钮底色：与普通控件同面（`--dsw-alias-bg-layer-2`），**不是**错误色。
 *
 * 为什么要单独命名（评审 S2）：危险意图由**文字色**表达。若底色也吃错误色（例如换成
 * `--dsw-alias-state-error-primary` = red-500），红底 + red-900 字实测只有 **3.19:1**，
 * AA 不过。判据把这个 token 钉死，挡住"顺手把 danger 做成红底"。
 */
export const CONTROL_DANGER_FILL_TOKEN = '--dsw-alias-bg-layer-2'

/**
 * 危险按钮文字所用的 L1 token。
 *
 * 取**静态档 red-900** 而不是别名 `--dsw-alias-state-error-primary`（= red-500）：
 * 白底实测 red-900 = **14.35:1**、red-500 = **4.4976:1**（差 0.0023 不到 AA 的 4.5）。
 * 这与 tokens.css 头块记的「文字色取 900 阶而非 500 阶」是同一条纪律，#151 就是亮阶当
 * 文字色的回归现场。
 *
 * 与迁移前的 `--color-danger-strong` **逐值相同**（那个应用层别名本身就指向 red-900），
 * 所以这一条是"把应用层别名内联到 L1"，不是换色（评审 S5）。
 */
export const CONTROL_DANGER_LABEL_TOKEN = '--dsw-static-red-900'

/** 控件 hover 时的面（vendored `Button.module.css` 的 `.ghost:hover` / `.outline:hover` 同 token）。 */
export const CONTROL_HOVER_BACKGROUND_TOKEN = '--dsw-alias-interactive-bg-hover'

/**
 * 控件 hover 时的描边色。
 *
 * 用**描边档** `--dsw-alias-border-l3` 而不是 `--dsw-alias-label-tertiary`：后者是**文字色**
 * token，拿来当描边在浅色下看不出问题（两值都偏灰），但深色下 label-tertiary 是
 * `rgb(173,178,184)`、border-l3 是 `rgba(255,255,255,0.16)`，差得很明显（评审观察项）。
 */
export const CONTROL_HOVER_BORDER_TOKEN = '--dsw-alias-border-l3'

/** 高度下限所用的应用层 token；判据会断言它与 `--touch-min` 同值且 ≥40px。 */
export const CONTROL_TOUCH_TOKEN = '--touch-min'

/** 触屏可达下限（px）。单测与 Q5 共用同一个数字（评审 S8：早先两边各写一个 40）。 */
export const TOUCH_MIN_PX = 40

// ---------- vendored 度量的解析（两侧共用同一份实现） ----------

export interface VendorInputMetrics {
  /** `border` 简写的宽度项，如 `0.5px`。 */
  borderWidth: string
  /** `border` 简写的样式项，如 `solid`。 */
  borderStyle: string
  /** `border` 简写的颜色项里的 token 名，如 `--dsw-alias-border-l4`。 */
  borderToken: string
  /** 完整 `border` 简写值，供浏览器侧做**元素对元素**比较用。 */
  borderDeclaration: string
  /** `border-radius` 的值，如 `8px`。 */
  radius: string
}

/** 取某选择器的首个规则体（传去注释后的文本）。 */
function ruleBody(cssText: string, selectorPattern: string): string {
  const body = new RegExp(`(?:^|[},])\\s*${selectorPattern}\\s*\\{([^}]*)\\}`).exec(cssText)?.[1]
  if (body === undefined) throw new Error(`CSS 里找不到规则：${selectorPattern}`)
  return body
}

/**
 * 从 vendored `Input.module.css` 的**文本**解出 DSH 族的真实度量。
 *
 * 收文本而不是路径：单测（vitest）与 Q5（Playwright）都能自己 `readFileSync`，
 * 但**解析必须只有一份**——解析器写两份，正则严格度迟早不同，判据随之漂移。
 */
export function parseVendorInputMetrics(cssText: string): VendorInputMetrics {
  const plain = cssText.replaceAll(/\/\*[\s\S]*?\*\//g, '')
  const wrap = ruleBody(plain, '\\.wrap')
  const border = /(?:^|;)\s*border\s*:\s*([^;]+)/i.exec(wrap)?.[1]?.trim()
  const radius = /(?:^|;)\s*border-radius\s*:\s*([^;]+)/i.exec(wrap)?.[1]?.trim()
  if (border === undefined || radius === undefined) {
    throw new Error('vendored Input.module.css 的 .wrap 缺 border 或 border-radius 声明')
  }
  const parsed = /^([\d.]+(?:px|rem|em))\s+(solid|dashed|dotted)\s+var\(\s*(--[\w-]+)\s*\)$/.exec(
    border.replaceAll(/\s+/g, ' '),
  )
  if (parsed === null) {
    throw new Error(`vendored Input 的 border 形态变了（判据依赖它）：${border}`)
  }
  return {
    borderWidth: parsed[1] ?? '',
    borderStyle: parsed[2] ?? '',
    borderToken: parsed[3] ?? '',
    borderDeclaration: border.replaceAll(/\s+/g, ' '),
    radius,
  }
}

/** 归一化颜色文本：同一颜色在 `getComputedStyle` 与 token 原文里的空格形态不同。 */
export function normalizeColor(value: string): string {
  return value.replaceAll(/\s+/g, '').toLowerCase()
}

// ---------- 浏览器侧：探针与判定 ----------

/** `getComputedStyle` 的最小子集（纯函数不碰 DOM；真实 style 对象与测试替身都满足它）。 */
export interface ComputedStyleLike {
  getPropertyValue(property: string): string
  backgroundColor: string
  borderTopColor: string
  borderTopWidth: string
  borderTopLeftRadius: string
  color: string
  minHeight: string
}

/**
 * 沿继承链解出一个自定义属性的**解析值**。
 *
 * 为什么不能只读元素自身：自定义属性是**继承属性**，元素上的值是继承来的；而"只在
 * `:root` 上读"会漏掉局部重绑（本仓真实存在：`.device-status-revoked` 把
 * `--dsw-alias-state-error-primary` 重绑到 red-900）与 `body[data-ds-dark-theme]` 那一套。
 * 从元素自身往祖先走，既拿到最近的重绑，也顺带把深色主题算进去。
 *
 * @param style 取值的入口：源码/单测侧传一个普通对象，浏览器侧传一个
 *   `{ getPropertyValue }` 适配器（**它自己负责沿元素→祖先链找最近的非空声明**）。
 *   为什么是"一个对象 + 适配器"而不是"一个 CSSStyleDeclaration 数组"：数组要塞进
 *   Playwright 的 `evaluate` 参数，而带原型方法的对象跨进程会被序列化成 `{}`
 *   （实测报 `getPropertyValue is not a function`）——改成适配器后边界上只过字符串。
 */
export function resolveTokenValue(style: ComputedStyleLike, name: string): string {
  const read = (property: string): string => style.getPropertyValue(property).trim()
  let current = name
  for (let hop = 0; hop < 8; hop += 1) {
    const value = read(current)
    const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)
    if (ref?.[1] === undefined) return value
    current = ref[1]
  }
  throw new Error(`自定义属性 ${name} 的 var() 链超过 8 跳（循环引用？）`)
}

/**
 * 一条控件上被判据覆盖的浏览器实测值。
 *
 * 注意这里**只有解析值，没有"声明原文"**：自定义属性在 computed-value 阶段就完成了
 * `var()` 代换，`getComputedStyle(el).getPropertyValue('--dsw-…')` 拿到的**永远**是解析值
 * （实测输出：`rgb(255, 255, 255)`、`rgba(0, 0, 0, 0.16)`），根本不以 `var(` 开头。
 * 所以「这条规则用的是哪个 token」**浏览器侧判不了**——那一条留在源码文本判据里
 * （`tests/control-family.spec.tsx` 的 `assertL1Color`）。早先这里写成"拿到的是声明原文"
 * 是反的，会让 Q5 对每个控件必红（评审 BLOCK-1 成因 A）。
 */
export interface ControlProbe {
  /** `getComputedStyle(el).backgroundColor`：最终解析值。 */
  background: string
  /** `getComputedStyle(el).borderTopColor`：同上。 */
  borderColor: string
  /** `getComputedStyle(el).borderTopWidth`：如 '1px'。 */
  borderWidth: string
  /** `getComputedStyle(el).borderTopLeftRadius`：如 '8px'。 */
  radius: string
  /** `getComputedStyle(el).color`：文字色最终解析值。 */
  color: string
  /** `getComputedStyle(el).minHeight`：如 '40px'。 */
  minHeight: string
  /**
   * 采样那一刻该控件是不是 `document.activeElement`。
   *
   * **状态口径**（评审提醒的同类坑，#161 在 390 档踩过）：`:focus-visible` 按设计会把描边
   * 改成品牌色（`.button:focus-visible { border-color: var(--dsw-alias-brand-primary) }`，
   * 与 vendored `Input` 的 `.wrap:focus-within` 同语义），hover 会改面与描边档。
   * 所以判据**必须声明自己判的是哪个状态**——否则调用点紧挨 `click()` / `fill()` 时，
   * 控件正好带着焦点或 hover，判据就假红。这里记下状态，由 `checkControlTokens` 决定
   * 放开哪几项（见该函数注释）。
   */
  focused: boolean
  /** 采样那一刻指针是否悬停在该控件上（`el.matches(':hover')`）。 */
  hovered: boolean
  /**
   * **同一浏览器里**用 vendored `Input` 的 `border` 声明渲染出来的实测宽度。
   *
   * 为什么是元素对元素而不是"期望 0.5px"：Chrome 对 `border: 0.5px` 的 computed/used 宽度
   * 就是 **1px**（评审 BLOCK-1 实测，DPR=1 与 DPR=2 都是；截图像素解码也是 1 CSS px）。
   * 与同浏览器渲染的 vendored 声明比较，既吸收这种取整，又真实反映上游度量变化。
   */
  referenceBorderWidth: string
  /** 同上，用 vendored 的 `border-radius` 渲染出来的实测半径。 */
  referenceRadius: string
  /**
   * 参照元素的描边色（`getComputedStyle(参照).borderTopColor`）。
   *
   * 为什么单独采它：用来做**参照自检**——如果页面加载的 token 与 `global.css` 里写的
   * vendored 度量已经对不上（例如 token 缺失导致整条 `border` 在 computed-value 阶段失效），
   * 参照会按 `0px`/初值计算，"控件 == 参照"就可能两边都是 0 而**假绿**。
   */
  referenceBorderColor: string
  /**
   * 控件上各 token 的解析值（`resolveTokenValue` 求解）。
   *
   * 三个特殊值：`'unresolved'` = 期望是 `--token` 但没取到值（判红）；`'n/a'` = 该控件在
   * 静止态**没有**这个期望（例如 `.button-quiet` 的底/描边按设计是 `transparent`）；
   * 其余原样带回（可能是 `rgba(0, 0, 0, 0)` 这类设计值）。
   */

  resolved: {
    background: string
    border: string
    label: string
    touch: string
  }
}

/**
 * 视觉判据的**判定函数**（纯函数，不碰 DOM）。四组：
 * ① 浏览器算出来的背景/描边/文字色等于该 token 在**同一元素上**的解析值（解析值对解析值）；
 * ② 描边宽度与圆角等于**同浏览器里 vendored `Input` 的实测度量**（元素对元素）；
 * ③ `min-height` 与 `--touch-min` 同值且不小于触屏下限；
 * ④ token 解析值非空（取不到值时报"未解析"，不静默通过）。
 *
 * 为什么不在这里判 token 名：见 `ControlProbe` 的注释——浏览器读不到声明原文。
 * "同一个值换了另一个 token"这类漂移由源码文本判据负责（两层分工，不是重复）。
 *
 * @returns 违反判据的说明列表；空数组 = 全过
 */
export function checkControlTokens(
  probe: ControlProbe,
  expect: {
    backgroundToken: string
    borderToken: string
    labelToken: string
    /** 高度下限（px）。 */
    minTouchPx: number
    /** 该控件在非聚焦/非 hover 态下的面（默认取 `backgroundToken`）。 */
    restBackgroundToken?: string
    /** 该控件在非聚焦/非 hover 态下的描边（默认取 `borderToken`）。 */
    restBorderToken?: string
  },
  label = '控件',
): string[] {
  const failures: string[] = []
  // 状态口径（评审提醒；#161 在 390 档踩过同一个坑）：判据只对**静止态**写死期望值。
  //  - `:focus-visible` 按设计把描边改成品牌色、hover 按设计改面与描边档；
  //  - 所以这三项在**聚焦/hover 态**下只能与"交互态的变体 token"比对，而在**没有给**
  //    变体 token 时，检查项**仅限"没有设计变化"的那些**（背景/文字在聚焦时不该变），
  //    描边项直接跳过——避免调用点紧挨 click()/fill() 时按设计变化的样子被判成漂移。
  const restBackground = expect.restBackgroundToken ?? expect.backgroundToken
  const restBorder = expect.restBorderToken ?? expect.borderToken
  const interactive = probe.focused || probe.hovered
  const pairs: Array<[string, string, string, string]> = [
    ['背景', probe.background, probe.resolved.background, restBackground],
    ['文字', probe.color, probe.resolved.label, expect.labelToken],
  ]
  if (!interactive) {
    pairs.splice(1, 0, ['描边', probe.borderColor, probe.resolved.border, restBorder])
  }
  for (const [what, actual, expected, expectedToken] of pairs) {
    // `unresolved` = 期望的是一个 `--token`，但元素与祖先都没取到值（真问题，必须红）；
    // `n/a` = 该控件在静止态**没有**这个期望（例如 `.button-quiet` 的底与描边按设计是
    // `transparent`），此时不判——把"没有期望"与"期望没解析出来"区分开，避免后者被静默放过。
    if (expected === 'unresolved') {
      failures.push(`${label} 的${what} token ${expectedToken} 未解析（元素与祖先都取到空串）`)
      continue
    }
    if (expected === 'n/a') continue
    if (normalizeColor(actual) !== normalizeColor(expected)) {
      failures.push(
        `${label} 的${what}取值为 ${actual}，与 token ${expectedToken} 的解析值 ${expected} 不符`,
      )
    }
  }
  if (probe.borderWidth !== probe.referenceBorderWidth) {
    failures.push(
      `${label} 的描边宽度为 ${probe.borderWidth}，与同浏览器里 vendored Input 的实测值 ${probe.referenceBorderWidth} 不符`,
    )
  }
  if (probe.radius !== probe.referenceRadius) {
    failures.push(
      `${label} 的圆角为 ${probe.radius}，与同浏览器里 vendored Input 的实测值 ${probe.referenceRadius} 不符`,
    )
  }
  if (probe.minHeight !== probe.resolved.touch) {
    failures.push(
      `${label} 的 min-height=${probe.minHeight} 与 ${CONTROL_TOUCH_TOKEN}（${probe.resolved.touch}）不同值`,
    )
  }
  const touchPx = Number.parseFloat(probe.resolved.touch)
  if (!Number.isFinite(touchPx) || touchPx < expect.minTouchPx) {
    failures.push(
      `${label} 的 ${CONTROL_TOUCH_TOKEN}=${probe.resolved.touch} 小于触屏下限 ${expect.minTouchPx}px`,
    )
  }
  return failures
}
