/**
 * P1-19 E2E 共享助手（Q5 浏览器门）。
 *
 * 三条通道，职责分明（六原语·驱动）：
 * 1. 浏览器通道：产品 UI（Playwright locators）——一切用户可见行为必须走这里；
 * 2. Hub HTTP 通道：真人同一 API（登录 Cookie + Origin + Idempotency-Key），
 *    仅用于 UI 尚未覆盖的动作（邀请开通、配对码生成——成员管理/设备配对 UI
 *    属后续版本，P1-07 既有惯例）；
 * 3. e2e-serve 控制面通道（127.0.0.1 + 一次性 Token）：**只做故障注入与取证**
 *    （Node/Hub 进程生命周期、脱敏后的 DB 事实快照、日志尾），不承载产品行为。
 *
 * 控制面 Token 只存在于 0600 临时清单与本进程内存，不进 git、不进证据包。
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  BUTTON_BACKGROUND_TOKEN,
  BUTTON_BORDER_TOKEN,
  CONTROL_BACKGROUND_TOKEN,
  CONTROL_BORDER_TOKEN,
  CONTROL_LABEL_TOKEN,
  CONTROL_TOUCH_TOKEN,
  TOUCH_MIN_PX,
  checkControlTokens,
  normalizeColor,
  parseVendorButtonMetrics,
  parseVendorInputMetrics,
  resolveTokenValue,
  type ComputedStyleLike,
  type ControlProbe,
} from '../../src/shared/control-style-tokens.js'
import {
  SELECT_TRIGGER_BACKGROUND_TOKEN,
  SELECT_TRIGGER_BORDER_TOKEN,
  checkMenuTriggerTokens,
} from '../../src/shared/select-trigger-tokens.js'
import { expect } from '@playwright/test'
import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test'

export interface E2eEnv {
  hubOrigin: string
  webOrigin: string
  setupTokenPath: string
  setupToken: string
  controlPort: number
  controlToken: string
}

let envCache: E2eEnv | undefined

export function env(): E2eEnv {
  if (envCache === undefined) {
    envCache = JSON.parse(readFileSync(join(tmpdir(), 'whalepod-e2e-env.json'), 'utf8')) as E2eEnv
  }
  if (envCache.controlPort === undefined || envCache.controlToken === undefined) {
    throw new Error('环境清单缺控制面字段（e2e-serve 版本过旧？）')
  }
  return envCache
}

/** 以某个已登录会话的 Cookie 直调 Hub HTTP API（账号开通/配对码等非 UI 覆盖动作）。 */
export async function hubApi(
  cookie: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${env().hubOrigin}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      // Origin 与 Idempotency-Key 与浏览器同形（03 §4：非安全方法双闸门）。
      origin: env().webOrigin,
      'idempotency-key': randomUUID(),
      cookie,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json()) as { ok: boolean; data?: unknown }
  return { status: res.status, data: json.data }
}

export async function sessionCookie(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(env().webOrigin)
  const session = cookies.find((c) => c.name === 'whalepod_session')
  if (session === undefined) throw new Error('会话 Cookie 不存在')
  return `${session.name}=${session.value}`
}

/** 控制面调用（故障注入/取证专用；Token 绝不进任何落盘证据）。 */
export async function controlApi<T = unknown>(
  path: string,
  body?: unknown,
  method: 'GET' | 'POST' = 'POST',
): Promise<T> {
  const e = env()
  const res = await fetch(`http://127.0.0.1:${e.controlPort}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-e2e-control': e.controlToken,
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`控制面 ${path} 失败：${res.status} ${text.slice(0, 500)}`)
  }
  return (await res.json()) as T
}

/** Node 子进程控制面（e2e-serve 代理转发；同样只注入故障/读观测）。 */
export async function nodeControl<T = unknown>(path: string, body?: unknown): Promise<T> {
  return controlApi<T>(`/control/node/proxy`, { path, body })
}

// ---------- 脱敏后的 DB 事实（判定/归因用；列白名单在 e2e-serve 侧） ----------

export interface RunFact {
  run: {
    id: string
    status: string
    failureCode: string | null
    failureSummary: string | null
    ownerUserId: string
    rerunOfRunId: string | null
    startedAt: string | null
    finishedAt: string | null
  }
  runEvents: Array<{ seq: number; type: string; audience: string }>
  approvals: Array<{ id: string; status: string; toolName: string; decidedBy: string | null }>
  artifacts: Array<{
    id: string
    status: string
    sha256: string
    title: string
    ownerUserId: string
  }>
  outbox: Array<{ type: string; attempts: number; acked: boolean; failed: boolean }>
}

export function getRunFact(runId: string): Promise<RunFact> {
  return controlApi<RunFact>(`/control/db/run/${runId}`, undefined, 'GET')
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'lost'])

/** 轮询到 Run 目标状态（终态之外的跃迁判定，如 waiting_approval）。 */
export async function waitForRunStatus(
  runId: string,
  status: string,
  timeoutMs = 90_000,
): Promise<RunFact> {
  const deadline = Date.now() + timeoutMs
  let last = 'missing'
  for (;;) {
    const fact = await getRunFact(runId)
    last = `${fact?.run.status ?? '-'}/${fact?.run.failureCode ?? '-'}`
    if (fact !== null && fact.run.status === status) return fact
    if (fact !== null && TERMINAL.has(fact.run.status)) {
      throw new Error(
        `Run ${runId.slice(0, 8)} 提前进终态 ${fact.run.status}（期望 ${status}，failure=${fact.run.failureCode ?? '-'} ${fact.run.failureSummary ?? ''}）`,
      )
    }
    if (Date.now() > deadline) {
      throw new Error(`Run ${runId.slice(0, 8)} 未在 ${timeoutMs}ms 内到 ${status}（当前 ${last}）`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------- UI 通用步骤（键盘可达纪律与 P1-07 一致） ----------

/** 键盘路径：填输入框后 Enter（表单隐式提交）。 */
export async function fillAndEnter(page: Page, selector: string, value: string): Promise<void> {
  await page.fill(selector, value)
  await page.press(selector, 'Enter')
}

// ---------- #168：自研表单控件（.field input / .field textarea / .button）的浏览器侧判据 ----------

/**
 * #168 视觉判据（真实浏览器实测）：控件的**背景 / 描边色 / 文字色**必须等于同名 token 的
 * **解析值**；**描边宽度与圆角**必须等于**同一浏览器里 vendored `Input` 声明的实测值**；
 * `min-height` 必须等于 `--touch-min`。
 *
 * 两条口径是被实测逼出来的（评审 BLOCK-1，两条都会让 Q5 对每个控件必红）：
 * 1. `getComputedStyle(el).getPropertyValue('--dsw-…')` 拿到的是**解析值**而不是声明原文
 *    ——自定义属性是继承属性，且 computed-value 阶段就完成了 `var()` 代换。所以浏览器侧
 *    **判不了"用的哪个 token"**，那一条由源码文本判据负责；这里只做解析值对解析值。
 * 2. Chrome 对 `border: 0.5px` 的 computed/used 宽度就是 **1px**（本机实测：DPR=1 与 DPR=2
 *    都是 `1px`）。所以期望值不能写 `'0.5px'`，改为在**同一个浏览器**里给 vendored 的
 *    `border` / `border-radius` 声明建一个参照元素实测——元素对元素比较，取整与上游度量
 *    变化都自动吸收（实测：控件与参照都在 DPR=1/2 下报 `1px`，圆角都报 `8px`）。
 *
 * 判定交给与单测共用的 `checkControlTokens`（`src/shared/control-style-tokens.ts`）。
 *
 * **状态口径**（评审提醒 #161 的同类坑）：判据只对**静止态**写死期望值。`:focus-visible`
 * 按设计把描边改成品牌色、hover 按设计改面与描边档——所以探针把
 * `focused`（`document.activeElement === el`）与 `hovered`（`el.matches(':hover')`）一起采回，
 * 由判定函数在交互态**只放开描边项**（背景/文字照判）。调用点因此不必依赖"控件当前一定
 * 没焦点"这种脆弱前提（我的调用点里有一个紧跟在 `click()` 之后，实测正是这个风险）。
 *
 * 参照元素的**自检**不能省：如果设计 token 没进页面（例如判据跑在没加载 `dsw-tokens.css`
 * 的页面上），`border: 0.5px solid var(--dsw-alias-border-l4)` 会在 computed-value 阶段整条失效、
 * 参照按 `border-width` 初值 `0px` 计算——实测确实如此（`ref: "0px"`）。那种情况下
 * "控件 == 参照" 可能两边都是 0 而**假绿**。所以下面显式断言参照非 0，并断言参照的描边色
 * 等于 vendored CSS 里那个 token 的解析值。
 */
export async function assertControlTokens(
  control: Locator,
  label: string,
  /**
   * 该控件**自己**期望的 token。不给就用 `.field input` / `.button` 那一族的默认值。
   *
   * 为什么要这个参数（第一次跑 Q5 就红出来的）：`.button-primary` 的底与文字**按设计**
   * 不是基类那两个 token（底是 `--dsw-alias-button-primary-fill`、字是
   * `--dsw-alias-label-primary-foreground`）。判据不能拿基类的期望去套变体，
   * 否则"设计如此"会被判成漂移。
   */
  options: {
    backgroundToken?: string
    labelToken?: string
    borderToken?: string
    /** 该控件在非聚焦/非 hover 态的底（默认 = `backgroundToken`）。 */
    restBackgroundToken?: string
    /** 该控件在非聚焦/非 hover 态的描边（默认 = `borderToken`）。 */
    restBorderToken?: string
    /**
     * #173 控件族分轴：`'input'`（默认）对照 vendored `Input.module.css`（0.5px l4 / r8）；
     * `'button'` 对照 vendored `Button.module.css` 的胶囊族（`.outline` 描边 0.5px l3 /
     * `.button` 圆角 18px），且默认的底/描边期望 token 换成按钮族的两个
     * （elevated-fill / l3）。
     */
    family?: 'input' | 'button'
  } = {},
): Promise<void> {
  // cwd = 仓库根是本套 e2e 的既有约定（pairing-ui.spec.ts 也这么用）；路径不对就当场炸，
  // 不静默跳过——静默跳过的判据等于没有判据。
  const metrics =
    options.family === 'button'
      ? parseVendorButtonMetrics(
          readFileSync(join(process.cwd(), 'apps/web/src/vendor/dsh-ui/Button.module.css'), 'utf8'),
        )
      : parseVendorInputMetrics(
          readFileSync(join(process.cwd(), 'apps/web/src/vendor/dsh-ui/Input.module.css'), 'utf8'),
        )
  const defaultBackground =
    options.family === 'button' ? BUTTON_BACKGROUND_TOKEN : CONTROL_BACKGROUND_TOKEN
  const defaultBorder = options.family === 'button' ? BUTTON_BORDER_TOKEN : CONTROL_BORDER_TOKEN
  const probe = (await control.evaluate(
    (
      el: HTMLElement,
      input: {
        borderDeclaration: string
        radius: string
        tokens: {
          backgroundToken: string
          borderToken: string
          labelToken: string
          touchToken: string
        }
      },
    ) => {
      const tokens = input.tokens
      // 从元素自身往 documentElement 走：继承属性 + 局部重绑都算对（深色主题也在 body 上）。
      //
      // 为什么在**页内**就把它算成字符串、而不是把 CSSStyleDeclaration 数组带回 Node：
      // 跨进程序列化会把 `getPropertyValue` 这种原型方法整个丢掉，回到 Node 只剩
      // `{}`——实测（第一次 Q5 跑）报 `style.getPropertyValue is not a function`。
      // （我上一轮用 `typeof` 在**同一个**页内对象上验过"方法还在"，那个测法本身是错的：
      // 它没走序列化这一趟。这次是真实 e2e 跑出来的。）
      const readToken = (property: string): string => {
        for (let node: Element | null = el; node !== null; node = node.parentElement) {
          const value = getComputedStyle(node).getPropertyValue(property).trim()
          // 属性被声明成空值（`--x: ;`）时按"未设置"处理，继续往上找
          if (value !== '') return value
        }
        return ''
      }
      // 页内的 var() 链解析：与 `src/shared/control-style-tokens.ts` 的 `resolveTokenValue`
      // 同一套算法（见下方注释说明为什么不能直接复用那个函数）。
      const resolveInPage = (name: string): string => {
        let current = name
        for (let hop = 0; hop < 8; hop += 1) {
          const value = readToken(current)
          const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)
          if (ref?.[1] === undefined) return value
          current = ref[1]
        }
        return ''
      }
      /**
       * 期望值 → 对照值。三种情况要分开（三者混起来会让"没有期望"与"期望没解析出来"
       * 长得一样）：
       *  - `transparent`：该属性**按设计**就是透明的（`.button-quiet` 的底与描边）→ `n/a`；
       *  - 以 `--` 开头：真 token，解析不出值就是 `unresolved`（判红）；
       *  - 其他字符串：原样带回（例如浏览器把 `transparent` 算成 `rgba(0, 0, 0, 0)` 的值）。
       */
      const expected = (name: string): string => {
        if (name === 'transparent') return 'n/a'
        if (!name.startsWith('--')) return name
        return resolveInPage(name) === '' ? 'unresolved' : resolveInPage(name)
      }
      // 参照元素：插进 DOM 再量。为什么不是 `display: none`——那种元素根本不进渲染树，
      // Chrome 不会解析出计算值；这里用 fixed + 移出视口，元素正常参与布局与计算。
      const reference = document.createElement('div')
      reference.setAttribute('data-control-family-reference', 'true')
      reference.style.cssText = `position: fixed; top: 0; left: -9999px; width: 10px; height: 10px; border: ${input.borderDeclaration}; border-radius: ${input.radius};`
      document.body.append(reference)
      try {
        const referenceStyle = getComputedStyle(reference)
        const style = getComputedStyle(el)
        return {
          // 状态口径（评审提醒）：把"采样那一刻是不是聚焦/hover"一起采回来，
          // 由共用判定函数决定放开哪几项——详见 checkControlTokens 的注释。
          focused: document.activeElement === el,
          hovered: el.matches(':hover'),
          background: style.backgroundColor,
          borderColor: style.borderTopColor,
          borderWidth: style.borderTopWidth,
          radius: style.borderTopLeftRadius,
          color: style.color,
          minHeight: style.minHeight,
          referenceBorderWidth: referenceStyle.borderTopWidth,
          referenceRadius: referenceStyle.borderTopLeftRadius,
          referenceBorderColor: referenceStyle.borderTopColor,
          // 解析值（字符串）——判定函数与单测吃同一份结构。
          // var() 链的跟法**与 `resolveTokenValue` 同算法**（每一跳都重新问 `readToken`，
          // 所以局部重绑与深色主题都算对）；为什么这里内联而不是调用共享函数：
          // Playwright 的 `evaluate` 类型只收 `(element, arg)` 两个参数，且函数放在 arg 里
          // 会被序列化丢掉（都是实测踩到的），所以页内只能自带这段 8 行纯逻辑。
          // 它的行为由单测 `页内 var() 链跟法` 钉住（含"局部重绑优先"）。
          resolved: {
            background: expected(tokens.backgroundToken),
            border: expected(tokens.borderToken),
            label: expected(tokens.labelToken),
            touch: resolveInPage(tokens.touchToken),
          },
        }
      } finally {
        reference.remove()
      }
    },
    {
      borderDeclaration: metrics.borderDeclaration,
      radius: metrics.radius,
      tokens: {
        backgroundToken: options.backgroundToken ?? defaultBackground,
        borderToken: options.borderToken ?? defaultBorder,
        labelToken: options.labelToken ?? CONTROL_LABEL_TOKEN,
        touchToken: CONTROL_TOUCH_TOKEN,
      },
    },
  )) as ControlProbe
  // 参照自检（理由见函数头注释）：token 没进页面时整条 `border` 会在 computed-value 阶段失效，
  // 参照按 0px 计算，"两边都是 0"会假绿。
  const referenceBorderPx = Number.parseFloat(probe.referenceBorderWidth)
  if (!Number.isFinite(referenceBorderPx) || referenceBorderPx <= 0) {
    throw new Error(
      `${label} 的参照元素量到 ${probe.referenceBorderWidth}：vendored 的 \`${metrics.borderDeclaration}\` 在这张页面上没生效（设计 token 缺失？）——判据不能就这样通过`,
    )
  }
  if (Number.parseFloat(probe.referenceRadius) <= 0) {
    throw new Error(`${label} 的参照元素圆角量到 ${probe.referenceRadius}（vendored 度量没生效）`)
  }
  const resolvedBorderToken = probe.resolved.border
  if (
    resolvedBorderToken !== 'n/a' &&
    normalizeColor(probe.referenceBorderColor) !== normalizeColor(resolvedBorderToken)
  ) {
    throw new Error(
      `${label} 的参照元素描边色 ${probe.referenceBorderColor} 与页面 token ${options.borderToken ?? defaultBorder}=${resolvedBorderToken} 不符：源码里的 vendored 度量与页面加载的 token 已经对不上了`,
    )
  }
  const failures = checkControlTokens(
    probe,
    {
      backgroundToken: options.backgroundToken ?? defaultBackground,
      borderToken: options.borderToken ?? defaultBorder,
      labelToken: options.labelToken ?? CONTROL_LABEL_TOKEN,
      minTouchPx: TOUCH_MIN_PX,
      ...(options.restBackgroundToken === undefined
        ? {}
        : { restBackgroundToken: options.restBackgroundToken }),
      ...(options.restBorderToken === undefined
        ? {}
        : { restBorderToken: options.restBorderToken }),
    },
    label,
  )
  if (failures.length > 0) throw new Error(`${label} 样式判据未过：\n- ${failures.join('\n- ')}`)
}

// ---------- #158：vendored Menu 下拉的真人路径与机器判据 ----------

/**
 * #158 真人路径：点开下拉 → 点选项。
 *
 * 为什么不是 `selectOption()`：那套 API 只对**原生 `<select>`** 成立。#158 把 7 处下拉
 * 迁到 vendored Menu 后浏览器里根本没有 select 可控，继续用 `selectOption` 会直接报错；
 * 而"点开再点选项"既与真人一致，又把 `aria-expanded` 的翻转钉住（与 #152 折叠入口同一套
 * 语义）。
 *
 * @param trigger 触发器 locator（如 `page.getByLabel('选择 Agent')` 或 `page.locator('#invite-role')`）
 * @param optionText 选项文案（按可访问名匹配）
 */
export async function selectFromMenu(trigger: Locator, optionText: string | RegExp): Promise<void> {
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  // 列表贴着触发器渲染（portal=false），一行一个 role=menuitem 的按钮
  const option = trigger.page().getByRole('menuitem', { name: optionText })
  await expect(option).toBeVisible()
  await option.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
}

/**
 * #158 反面钉（浏览器侧）：这个控件确实不再是原生 `<select>`。
 *
 * 两层判据缺一不可——只查「菜单能开」是假绿：原生 select 套一层自绘皮肤同样能点开列表。
 * 必须同时钉住「元素本身不是 select 标签」与「作用域里没有 select 元素」。另外三条
 * （role / aria-haspopup / 可访问名）钉的是迁移没有把契约面改薄：id 与可访问名不变、
 * Tab 仍能到达。
 *
 * @param control 目标控件 locator（如 `page.locator('#invite-role')`）
 * @param scope 反面扫描的作用域（如某个 form）；调用方拿不到容器时可传 page
 * @param name 期望的可访问名（迁移前是 `<select aria-label="…">` 的那个名字）
 */
export async function assertNotNativeSelect(
  control: Locator,
  scope: { locator(selector: string): Locator },
  name: string | RegExp,
): Promise<void> {
  const html = await control.evaluate((el) => el.outerHTML)
  if ((await control.evaluate((el) => el.tagName)) === 'SELECT') {
    throw new Error(`仍是原生 <select>：${html.slice(0, 200)}`)
  }
  await expect(control).toHaveRole('button')
  await expect(control).toHaveAttribute('aria-haspopup', 'menu')
  await expect(control).toHaveAccessibleName(name)
  // 作用域里**一个 select 都不许有**（评审追出：早先只查带 id/aria-label/name 的，
  // 裸 `<select>` 能溜过去；"DevTools 自己的 UI"那个理由也不成立——DevTools 的 DOM
  // 不在页面里，扫描范围内不可能混进它）。
  await expect(scope.locator('select')).toHaveCount(0)
}

/**
 * #158 视觉判据（浏览器实测）：触发器的背景 / 描边最终值必须等于 L1 token 在 `:root` 上的
 * 解析值，圆角必须是 8px。
 *
 * **这条判据的能力边界（评审用真实 Chrome 证伪过一次）**：它证不了"用了哪个 token"。
 * `getComputedStyle(el).getPropertyValue('--dsw-…')` 拿到的是**解析后的值**而不是声明原文
 * ——自定义属性是继承属性且在 computed-value 阶段就完成 `var()` 代换，所以元素上永远读不到
 * `var(--dsw-…)` 这种形态（实测 DPR=1/2 都是 `"rgb(255, 255, 255)"`）。"用了哪个 token"
 * 由 `tests/select-menu.spec.tsx` 的 CSS 文本断言钉；描边宽度 0.5px 同理（Chrome 的
 * computed `border-top-width` 是 **1px**），也留在源码文本判据里。
 *
 * **判的是"静止态"**：`background` / `border-color` / `border-radius` 三条都按未被聚焦、
 * 未被 hover 的形态取期望值。若取样的那一刻触发器是聚焦的，`:focus-visible` 规则会把描边
 * 改成品牌色（设计如此），此时本判据只判背景与圆角（见函数内的分支）——**不把静止态的期望
 * 硬套到焦点瞬间**，也不靠"先把焦点移开"来回避（那会让判据依赖调用顺序）。
 */
export async function assertMenuTriggerTokens(trigger: Locator): Promise<void> {
  // 评审 A-2：token 名**从常量传进页面函数**（`evaluate(fn, arg)` 的第二个参数在页面侧可读），
  // 不在回调里再写一遍字面量。早先回调里硬编码 `'--dsw-alias-bg-layer-1'` / `'-l4'`，等于
  // token 名在读路径上有**第三份副本**——把常量与 CSS 一起换成浅色同值 token（如 `-2`）时，
  // 源码判据会绿，而这里仍去读旧 token 的解析值，**在深色档误红**（假红比假绿更费时间）。
  const tokenNames = {
    background: SELECT_TRIGGER_BACKGROUND_TOKEN,
    border: SELECT_TRIGGER_BORDER_TOKEN,
  }
  const probe = await trigger.evaluate((el, names) => {
    const style = getComputedStyle(el)
    const root = getComputedStyle(document.documentElement)
    return {
      background: style.backgroundColor,
      borderColor: style.borderTopColor,
      radius: style.borderTopLeftRadius,
      // 两边都是**解析值**（不是声明原文，见上面注释）；读 :root 是为了让判据跟着 token 走，
      // 而不是把 rgb 字面量抄进测试里
      resolvedBackgroundToken: root.getPropertyValue(names.background).trim(),
      resolvedBorderToken: root.getPropertyValue(names.border).trim(),
      // 焦点态由 `:focus-visible` 规则单独改**描边色**（品牌色），所以"描边来自哪个 token"
      // 这件事**必须声明判的是哪个状态**。实测踩到：本轮把本判据补进 390 档循环后，
      // 调用点紧挨着 `click()`，那一刻触发器是聚焦的 → computed 描边是品牌色
      // rgb(15,17,21)，判据报"描边取值与 --dsw-alias-border-l4 不符"（**是判据没写清状态，
      // 不是样式错了**）。这里把状态读出来，交给下面按态判定。
      focused: document.activeElement === el,
    }
  }, tokenNames)
  // 顺手在真实浏览器里回读一次描边宽度：CSS 里声明的是 0.5px，Chrome 的 computed 值是
  // **1px**（DPR=1/2 都一样，本机实测）。这不是产品判据，是"别再拿 computed 宽度去和
  // vendored 的 0.5px 比"的活证据——写在这里，跑一次 Q5 就复核一次。
  const borderWidth = await trigger.evaluate((el) => getComputedStyle(el).borderTopWidth)
  if (borderWidth === '0.5px') {
    throw new Error(
      '实测到 computed border-top-width = 0.5px：本机 Chrome 此前给的是 1px（0.5px 会被取整）。' +
        '若浏览器行为变了，select-trigger-tokens.ts 里那条"浏览器侧不判宽度"的理由要一并复核。',
    )
  }
  if (probe.focused) {
    // 焦点态：背景/圆角不变，描边按设计转品牌色（`Input.module.css` 的 `.wrap:focus-within`
    // 同款语义）——所以这一档**只判背景与圆角**，描边的期望值在这里明确为品牌 token，
    // 而不是把"描边=border-l4"硬套到聚焦瞬间。
    const { focused, ...idle } = probe
    void focused
    const idleFailures = checkMenuTriggerTokens(
      idle,
      SELECT_TRIGGER_BACKGROUND_TOKEN,
      SELECT_TRIGGER_BORDER_TOKEN,
    ).filter((failure) => !failure.startsWith('描边'))
    if (idleFailures.length > 0)
      throw new Error(`触发器样式判据未过（焦点态）：\n- ${idleFailures.join('\n- ')}`)
    return
  }
  const failures = checkMenuTriggerTokens(
    probe,
    SELECT_TRIGGER_BACKGROUND_TOKEN,
    SELECT_TRIGGER_BORDER_TOKEN,
  )
  if (failures.length > 0) throw new Error(`触发器样式判据未过：\n- ${failures.join('\n- ')}`)
}

/** run_event 全表 seq 连续性判定（R1/R6 补发无缺无重）。 */
export function assertSeqContiguous(fact: RunFact): void {
  const seqs = [...new Set(fact.runEvents.map((e) => e.seq))].sort((a, b) => a - b)
  const contiguous = seqs.every((seq, index) => seq === index + 1)
  if (!contiguous) {
    throw new Error(`run_event seq 不连续（缺序或重复）：${JSON.stringify(seqs)}`)
  }
  if (fact.runEvents.length !== seqs.length) {
    throw new Error(`run_event 出现重复 (runId,seq) 行：${JSON.stringify(fact.runEvents)}`)
  }
}

// ---------- Node/Hub 生命周期（故障注入面；只在 e2e-serve 有真进程可操作） ----------

export interface NodeStartResult {
  deviceId: string
  workspaceDir: string
  workspaceId: string
}

export function startNode(input: {
  pairingCode: string
  workspaceFiles?: Record<string, string>
}): Promise<NodeStartResult> {
  return controlApi<NodeStartResult>('/control/node/start', input)
}

export function stopNode(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<{ stopped: boolean }> {
  return controlApi('/control/node/stop', { signal })
}

export function restartNode(): Promise<NodeStartResult> {
  return controlApi<NodeStartResult>('/control/node/restart', {})
}

export interface HubRestartResult {
  downMs: number
  hubOrigin: string
}

export function restartHub(input: {
  signal: 'SIGTERM' | 'SIGKILL'
  stayDownMs?: number
}): Promise<HubRestartResult> {
  return controlApi<HubRestartResult>('/control/hub/restart', input)
}

export function setRuntimeFixture(
  name: 'approval' | 'basic' | 'secrets' | 'rejection',
): Promise<unknown> {
  return nodeControl('/fixture', { name })
}

/** Builder workspace 真实目录（G6-07 负断言数据源；只在测试进程内存活）。 */
export async function workspaceCanonicalPath(): Promise<string> {
  const res = await nodeControl<{ canonicalPath: string }>('/workspace-path', {})
  return res.canonicalPath
}

export function dropNodeConnection(offlineMs: number): Promise<unknown> {
  return nodeControl('/drop', { offlineMs })
}

export function dropAckCount(count: number): Promise<unknown> {
  return nodeControl('/ack-drop', { count })
}

/**
 * #88：终态 Run 的 Runtime 必须由产品路径自动回收（Node 终态即发
 * runtime.shutdown；Hub 见心跳把终态 Run 报 active 会补 admin run.cancel）。
 * 本断言只做观测：轮询 /runtimes 直到该 Run 不在管（进程已退、容量已释放）。
 * 超时即产品回归——不允许测试代为回收（旧 /release 缝已随 #88 删除）。
 */
export async function waitForRuntimeReleased(runId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { runtimes } = await activeRuntimes()
    if (!runtimes.some((r) => r.runId === runId)) return
    if (Date.now() > deadline) {
      throw new Error(`Runtime 未在 ${timeoutMs}ms 内被产品路径回收（runId=${runId}）`)
    }
    await sleep(500)
  }
}

export interface RuntimeInfo {
  runId: string
  pid: number
}

export function activeRuntimes(): Promise<{
  runtimes: RuntimeInfo[]
  spawnCounts: Record<string, number>
}> {
  return nodeControl('/runtimes')
}

/** 直接 OS 级探活（取证红线：不猜，kill 0 说了算）。 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export interface InputManifestFact {
  runId: string
  manifest: unknown
  copiedFiles: string[]
  manifestText: string
}

export function inputManifestForRun(runId: string): Promise<InputManifestFact> {
  return nodeControl('/input-manifest', { runId })
}

export function seedPluginPack(ownerUserId: string): Promise<{ pluginPackId: string }> {
  return controlApi('/control/plugin-pack/seed', { ownerUserId })
}

// ---------- 失败证据（Q5/六原语·取证；复用 P1-18 redact + artifacts/evidence 目录） ----------

interface ControlTails {
  hubTail: string
  nodeTail: string
  viteTail: string
}

/** 证据文本兜底归约（与 P1-18 redactText 同占位符；控制面日志尾已先行归约）。 */
function scrubLocalPaths(text: string): string {
  const home = process.env['HOME'] ?? tmpdir()
  return text
    .replace(/\u001b\[[0-9;]*m/g, '') // 证据纯文本：去 ANSI 装饰。
    .replaceAll(home, '<home>')
    .replaceAll(tmpdir(), '<tmp>')
    .replaceAll(process.cwd(), '<repo>')
}

/**
 * 测试失败时打包证据到 artifacts/evidence/e2e/<attempt>/：
 * manifest（git/版本/时间）、脱敏后的 Hub/Node/vite 日志尾、trace/截图路径索引。
 * 文本一律先 redactText（repo/tmpdir/home 归约，#73 模式），密码与 Token 不进包。
 */
export async function collectEvidenceOnFailure(
  testInfo: TestInfo,
  facts: { traceId: string; runIds: string[] },
): Promise<void> {
  if (testInfo.status === undefined || testInfo.status === testInfo.expectedStatus) return
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const attemptId = `${new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\..+$/, 'Z')}-${testInfo.testId}`
  const dir = join(process.cwd(), 'artifacts', 'evidence', 'e2e', attemptId)
  mkdirSync(dir, { recursive: true })
  // 绝对路径归约（#73 红线）：控制面返回的日志尾已在 e2e-serve 侧过 P1-18
  // 同一 redactText（repo/tmp/home → 占位符）；这里只兜底处理测试错误文本。
  let tails: ControlTails = { hubTail: '', nodeTail: '', viteTail: '' }
  try {
    tails = await controlApi<ControlTails>('/control/tails', undefined, 'GET')
  } catch {
    // 控制面已不可用：留空，不影响其余证据。
  }
  writeFileSync(join(dir, 'hub.log.txt'), tails.hubTail)
  writeFileSync(join(dir, 'node.log.txt'), tails.nodeTail)
  writeFileSync(join(dir, 'vite.log.txt'), tails.viteTail)
  for (const runId of facts.runIds) {
    try {
      const fact = await getRunFact(runId)
      writeFileSync(join(dir, `run-${runId.slice(0, 8)}.json`), JSON.stringify(fact, null, 2))
    } catch {
      // Run 都不存在时没取证价值。
    }
  }
  const files = ['hub.log.txt', 'node.log.txt', 'vite.log.txt']
  for (const attachment of testInfo.attachments) {
    if (attachment.path !== undefined) {
      files.push(scrubLocalPaths(attachment.path)) // N1：绝对路径不进包（Q7 红线）
    }
  }
  const manifest = {
    traceId: facts.traceId,
    attemptId,
    test: testInfo.titlePath.join(' / '),
    status: testInfo.status,
    error: scrubLocalPaths(String(testInfo.error?.message ?? testInfo.error ?? '')).slice(0, 4000),
    startedAt: new Date(Date.now() - (testInfo.duration ?? 0)).toISOString(),
    endedAt: new Date().toISOString(),
    runIds: facts.runIds,
    files,
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.error(`[e2e-evidence] 失败证据：${scrubLocalPaths(dir)}`)
}
