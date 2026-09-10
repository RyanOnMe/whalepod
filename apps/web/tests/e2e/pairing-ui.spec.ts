/**
 * #142 设备配对 UI 真人路径（Q5 用例草稿）。
 *
 * 调度：已注册为 playwright project `p1-142` 并挂在根 `test:e2e` 串行链末位
 * （一个 Hub 实例只容一个团队，必须独立成套冷启；不能与其它 project 并行跑）。
 *
 * 判据（Issue #142「怎样算修好」第 3 条）：一个浏览器里点「生成配对码」拿到码 →
 * 真 node 进程用同一码 claim（scripts/e2e-node.mts，与 `whalepod-node pair` 同一
 * claimDevice 路径）→ 页面**不刷新**出现该设备（device.changed → ['devices'] 收敛）。
 * 另核验同一码二次使用由 Hub/node 侧拒绝（409），页面不需要呈现裸错误码。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, fillAndEnter, hubApi, sessionCookie, startNode } from './helpers.js'
import {
  WHITE,
  compositeOver,
  contrastRatio,
  parseCssColor,
  readTokenValue,
  readToneTintPercent,
  round2,
} from '../contrast.js'

// #138 判据要从源码取「token 值」与「Tag 的浅底混合比例」：cwd = 仓库根是本套 e2e 的既有
// 约定（helpers.ts 的取证路径也这么用），路径不对就在这里当场炸，不静默跳过。
const repoRoot = process.cwd()
const tokensCss = readFileSync(join(repoRoot, 'apps/web/src/styles/dsw-tokens.css'), 'utf8')
const tagCss = readFileSync(join(repoRoot, 'apps/web/src/vendor/dsh-ui/Tag.module.css'), 'utf8')
/** 在线设备走 Tag 的 success 色调；混合比例从 vendored CSS 读，不抄死在测试里。 */
const tintPercent = readToneTintPercent(tagCss, 'success') * 100

const PASSWORD = 'correct horse battery staple'
/** 团队/账号带唯一后缀：复用环境或漂移时不与既有团队互踩（全局 username 唯一）。 */
const TAG = randomUUID().slice(0, 8)
const OWNER_NAME = `owner-${TAG}`
/** 六组 base32（03 §2.4）：120bit → 24 字符。 */
const PAIRING_CODE_PATTERN = /^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/

test.describe.configure({ mode: 'serial' })

let context: BrowserContext
let page: Page

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext()
  page = await context.newPage()
})

test.afterAll(async () => {
  await context.close()
})

test('生成配对码 → 真 node CLI 消费 → 页面不刷新出现该设备', async () => {
  test.setTimeout(180_000) // 承载一次性 Setup 与 Node 冷启动。

  // Setup：Owner 与团队（本文件独立成套，一次 Setup 一个团队）。
  await page.goto('/setup')
  await page.fill('#setup-token', env().setupToken)
  await page.fill('#team-name', `配对 UI 验收团队 ${TAG}`)
  await page.fill('#setup-username', OWNER_NAME)
  await page.fill('#setup-display-name', 'Owner')
  await fillAndEnter(page, '#setup-password', PASSWORD)
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible()

  // 设备页：#142 的断头点——空态指引之外，签发控件必须就在本页。
  await page.goto('/devices')
  await expect(page.getByRole('heading', { name: '设备', exact: true })).toBeVisible()
  await expect(page.getByText(/还没有设备/)).toBeVisible()

  await page.getByRole('button', { name: '生成配对码' }).click()
  const code = (await page.getByTestId('pairing-code').innerText()).trim()
  expect(code).toMatch(PAIRING_CODE_PATTERN)
  await expect(page.getByText('此码只显示一次')).toBeVisible()
  await expect(page.getByText(/有效期剩余 \d{2}:\d{2}/)).toBeVisible()

  // 「不刷新」判据的机器证据：页面一旦 reload，这个标记就消失。
  await page.evaluate(() => {
    Reflect.set(window, '__pairingUiNoReload', true)
  })

  // 真 node 进程消费同一码（与 CLI pair 同一条 claimDevice）。
  const node = await startNode({ pairingCode: code })

  // 不 reload、不重新导航：device.changed 失效 ['devices'] → 列表自己长出设备。
  await expect(page.getByText('e2e-node')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('在线')).toBeVisible()
  expect(await page.evaluate(() => Reflect.get(window, '__pairingUiNoReload') === true)).toBe(true)

  // ---- #138：vendored DSH 原语「真的生效」的机器判据（不是「看着像」） ----
  // 四条一起才有意义：①组件确实是 vendored 的（data-vendored）；②它解析到的语义 token
  // 等于 L1 白名单里的值，且设备页那条 AA 重映射真的接上了（不是 :root 的默认亮色）；
  // ③页面上存在一条命中它类名的活动 CSS 规则（样式来自 vendored 的 .module.css，而不是
  // 别处的全局类恰好长得像）；④文字与色块的对比度按 WCAG 2.1 在浏览器实测值上算出来
  // ≥4.5:1 / ≥3:1——颜色「对」但不达标同样是坏的（#138 审查回归）。
  const statusWrap = page.getByTestId('device-status').first()
  const statusTag = statusWrap.locator('[data-vendored="tag"]').first()
  await expect(statusTag).toBeVisible()

  const probe = await statusWrap.evaluate((wrap, tintPercent) => {
    const tag = wrap.querySelector('[data-vendored="tag"]')
    const dot = wrap.querySelector('[data-vendored="state-dot"]')
    if (tag === null || dot === null) throw new Error('vendored 锚点缺失：tag/state-dot 未找到')
    const tagStyle = getComputedStyle(tag)
    // token 从**被重映射的那个元素**上读（--dsw-* 是可继承自定义属性）：这里拿到的应当
    // 是设备页 AA 重映射后的深色，而不是 :root 的默认亮色。
    const token = tagStyle.getPropertyValue('--dsw-alias-state-success-primary').trim()
    // 用浏览器自己的解析把 token 落到具体颜色（token 可能是 var(...) 间接，也可能是字面量）。
    // 注意 setProperty 只认 CSS 名（kebab-case）：写成 backgroundColor 会被静默忽略，
    // 参照元素就会停在 transparent 上——这不是「背景不对」，是探针自己没生效。
    const resolve = (
      value: string,
      cssProperty: string,
      computed: 'color' | 'backgroundColor',
    ): string => {
      const el = document.createElement('span')
      el.style.setProperty(cssProperty, value)
      document.body.appendChild(el)
      const out = getComputedStyle(el)[computed]
      el.remove()
      return out
    }
    // 参照元素：同一个 token + 同一个混合比例在浏览器里再解一遍，用来核对「背景确实来自
    // 这条 token 的浅底」（走浏览器同一条解析路径，不做字符串猜测）。
    const expectedBackground = resolve(
      `color-mix(in srgb, ${token} ${tintPercent}%, transparent)`,
      'background-color',
      'backgroundColor',
    )
    const classes = (tag.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
    const hasRule = [...document.styleSheets].some((sheet) => {
      try {
        return [...sheet.cssRules].some((rule) => {
          const selector = (rule as CSSStyleRule).selectorText
          return selector !== undefined && classes.some((c) => selector.includes(`.${c}`))
        })
      } catch {
        return false // 跨域样式表读不到，跳过
      }
    })
    return {
      tone: tag.getAttribute('data-tone'),
      className: tag.getAttribute('class') ?? '',
      token,
      resolvedToken: resolve(token, 'color', 'color'),
      color: tagStyle.color,
      backgroundColor: tagStyle.backgroundColor,
      expectedBackground,
      dotColor: getComputedStyle(dot).color,
      hasRule,
    }
  }, tintPercent)
  // 在线设备 → success 色调（DevicesPage 里显式映射，不靠组件默认值）
  expect(probe.tone).toBe('success')
  // L1 token 真被加载并解析：值 = dsw-tokens.css 的 --dsw-static-green-900（逐字照抄上游
  // 静态色阶），且**不是** :root 的默认亮色——重映射没接上就会退回到亮绿。
  expect(probe.resolvedToken).toBe(readTokenValue(tokensCss, '--dsw-static-green-900'))
  expect(probe.resolvedToken).not.toBe(
    readTokenValue(tokensCss, '--dsw-alias-state-success-primary'),
  )
  // 组件颜色 = token 解析值（文字与色块各一处）：若 vendored CSS 没生效，这里会是被继承的默认色
  expect(probe.color).toBe(probe.resolvedToken)
  expect(probe.dotColor).toBe(probe.resolvedToken)
  // 带 CSS Modules 类名，且文档里有活动规则命中它
  expect(probe.className.length).toBeGreaterThan(0)
  expect(probe.hasRule).toBe(true)
  // 背景确实来自同一个 token 的同一混合比例（浏览器解同一表达式 → 与元素实际背景一致）
  expect(probe.backgroundColor).toBe(probe.expectedBackground)

  // 对比度：文字 vs 自身浅底 ≥4.5:1、色块 vs 白底 ≥3:1（算法见 apps/web/tests/contrast.ts，
  // 与单测同一套；这里喂进去的是浏览器实测的 computed color）。
  const textColor = parseCssColor(probe.color)
  const textBackground = compositeOver(parseCssColor(probe.backgroundColor), WHITE)
  // 浅底还要与「按 token 手算的同色 10% 叠白」一致（±1/255：浏览器合成取整差异）。
  const expectedTint = compositeOver({ ...textColor, a: tintPercent / 100 }, WHITE)
  for (const channel of ['r', 'g', 'b'] as const) {
    expect(
      Math.abs(textBackground[channel] - expectedTint[channel]),
      `背景 ${channel} 通道与手算浅底不符：实测 ${textBackground[channel].toFixed(1)} vs ` +
        `手算 ${expectedTint[channel].toFixed(1)}`,
    ).toBeLessThanOrEqual(1)
  }
  const textContrast = round2(contrastRatio(textColor, textBackground))
  const dotContrast = round2(contrastRatio(parseCssColor(probe.dotColor), WHITE))
  expect(
    textContrast,
    `在线设备状态文字对比度 ${textContrast}:1 不足 4.5:1`,
  ).toBeGreaterThanOrEqual(4.5)
  expect(dotContrast, `在线设备状态色块对比度 ${dotContrast}:1 不足 3:1`).toBeGreaterThanOrEqual(3)

  const cookie = await sessionCookie(context)

  // 同一码二次使用：由 Hub/node 侧拒绝（页面不负责这条错误，只核验 409 可读）。
  const reuse = await hubApi(cookie, 'POST', '/devices/pairing-claims', {
    code,
    name: `reuse-${TAG}`,
    platform: 'darwin',
    architecture: 'arm64',
    nodeVersion: 'v24.0.0',
    nodeAppVersion: '0.1.0',
  })
  expect(reuse.status).toBe(409)

  // 列表事实与 node 侧回执一致（不拿「界面看起来对」当判据）。
  const listed = await hubApi(cookie, 'GET', '/devices')
  const devices = listed.data as Array<{ id: string; name: string; status: string }>
  expect(devices.some((d) => d.id === node.deviceId && d.name === 'e2e-node')).toBe(true)
})
