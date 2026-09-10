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
import { env, fillAndEnter, hubApi, sessionCookie, startNode } from './helpers.js'

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

/**
 * #152（布局与响应式一致）：390×844 下没有横向溢出，顶栏单行且 ≤64px，
 * 折叠后的导航入口键盘可达。三页都量：项目页 / 设备页 / 成员页。
 *
 * 判据取自 Issue #152 第三节：此前 390px 顶栏折成 3 行（占屏高约 25%），
 * 导航链接占一整行；现在收进 <details> 折叠入口，顶栏恒定 64px。
 */
test('390×844：无横向溢出、顶栏单行 ≤64px、折叠菜单键盘可达', async () => {
  await page.setViewportSize({ width: 390, height: 844 })

  for (const path of ['/', '/devices', '/members']) {
    await page.goto(path)
    await expect(page.locator('.app-header')).toBeVisible()
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      headerHeight: document.querySelector('.app-header')?.getBoundingClientRect().height ?? 0,
    }))
    expect(metrics.innerWidth).toBe(390)
    // 判定用真实滚动宽度，而不是「看起来没露出来」：+1 容忍亚像素舍入
    expect(
      metrics.scrollWidth,
      `${path} 在 390px 下横向溢出（scrollWidth=${metrics.scrollWidth}）`,
    ).toBeLessThanOrEqual(metrics.innerWidth + 1)
    expect(
      metrics.headerHeight,
      `${path} 顶栏高度 ${metrics.headerHeight}px 超过 64px（折行？）`,
    ).toBeLessThanOrEqual(64)
  }

  // 导航入口：键盘（focus + Enter）打开折叠菜单 → 链接可达且能完成跳转
  await page.goto('/')
  const toggle = page.locator('.app-nav-menu > summary')
  await expect(toggle).toHaveAttribute('aria-label', '主导航菜单')
  await toggle.focus()
  await page.keyboard.press('Enter')
  const nav = page.getByRole('navigation', { name: '主导航' })
  await expect(nav.getByRole('link', { name: '成员' })).toBeVisible()
  await nav.getByRole('link', { name: '成员' }).click()
  await page.waitForURL(/\/members$/)
  await expect(page.getByRole('heading', { name: '成员', exact: true })).toBeVisible()
  // 展开导航也不许把顶栏顶高（面板绝对定位）
  const openHeaderHeight = await page
    .locator('.app-header')
    .evaluate((el) => el.getBoundingClientRect().height)
  expect(openHeaderHeight).toBeLessThanOrEqual(64)
})
