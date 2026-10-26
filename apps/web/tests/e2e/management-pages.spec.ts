import { expect, test, type Page, type Request } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  env,
  fillAndEnter,
  selectFromMenu,
  showAgentCreation,
  startNode,
  stopNode,
} from './helpers.js'

const tag = randomUUID().slice(0, 8)
const evidence = join(process.cwd(), 'artifacts/evidence/management-pages', tag)
const password = 'correct horse battery staple'
async function measure(page: Page, selector: string) {
  const root = page.locator(selector)
  await expect(root).toBeVisible()
  return root.evaluate((element) => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    surfaces: [
      ...element.querySelectorAll(
        '.cu-admin-panel,.cu-admin-member,.cu-admin-integration,.cu-admin-choice,.cu-admin-device,.agent-detail',
      ),
    ]
      .filter((node) => node.getBoundingClientRect().width > 0)
      .map((node) => {
        const box = node.getBoundingClientRect()
        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          client: node.clientWidth,
          scroll: node.scrollWidth,
        }
      }),
  }))
}

async function capture(page: Page, options: Parameters<Page['screenshot']>[0]) {
  await expect
    .poll(() =>
      page
        .locator('.cu-page-enter:visible')
        .evaluateAll((nodes) => nodes.every((node) => node.getAnimations().length === 0)),
    )
    .toBe(true)
  await page.screenshot(options)
}

test('四个管理页：真实邀请、插件安装组合、Agent 详情与设备配对', async ({ browser }) => {
  test.setTimeout(180_000)
  const ownerContext = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  const owner = await ownerContext.newPage(),
    member = await memberContext.newPage()
  const browserErrors: string[] = []
  owner.on('pageerror', (e) => browserErrors.push(e.name))
  member.on('pageerror', (e) => browserErrors.push(e.name))
  await mkdir(evidence, { recursive: true })
  let nodeStarted = false
  try {
    await owner.goto('/setup')
    await owner.fill('#setup-token', env().setupToken)
    await owner.fill('#team-name', '管理页面验收')
    await owner.fill('#setup-username', `management-owner-${tag}`)
    await owner.fill('#setup-display-name', 'Alice')
    await fillAndEnter(owner, '#setup-password', password)
    await expect(owner.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await owner.goto('/members')
    const inviteTrigger = owner.getByRole('button', { name: '邀请成员', exact: true })
    await expect(owner.locator('#invite-role')).not.toBeVisible()
    await inviteTrigger.click()
    await owner.getByRole('button', { name: '生成邀请链接', exact: true }).click()
    const link = owner.locator('code.invite-link')
    await expect(link).toBeVisible()
    const inviteUrl = await link.innerText()
    await inviteTrigger.click()
    await inviteTrigger.click()
    await expect(link).toHaveText(inviteUrl)
    await owner.getByRole('button', { name: '复制成员邀请链接', exact: true }).click()
    await expect(owner.getByText('已复制', { exact: true })).toBeVisible()
    await member.goto(inviteUrl)
    await member.fill('#invite-signup-username', `management-member-${tag}`)
    await member.fill('#invite-signup-display-name', 'Bob')
    await fillAndEnter(member, '#invite-signup-password', password)
    await expect(member.getByRole('heading', { name: '项目', exact: true })).toBeVisible()
    await expect(owner.locator('.member-list')).toContainText('Bob')

    await owner.goto('/plugins')
    const install = owner.getByRole('button', { name: '安装 whalepod-fixed-time', exact: true })
    await expect(install).toBeVisible()
    await install.click()
    await expect(install).toHaveText('已安装')
    await expect(install).toBeDisabled()
    await expect(owner.getByRole('status')).toContainText('不影响已有 Agent Revision')
    await owner.getByRole('button', { name: '新建插件组合', exact: true }).click()
    const packForm = owner.getByRole('form', { name: '新建 Plugin Pack', exact: true })
    await packForm.getByRole('checkbox', { name: 'whalepod-fixed-time@0.1.0', exact: true }).check()
    await packForm.locator('#plugin-pack-name').fill('产品检查')
    await packForm.getByRole('button', { name: '创建 Pack', exact: true }).click()
    await expect(owner.getByRole('article', { name: 'Pack 产品检查', exact: true })).toBeVisible()

    await owner.goto('/agents')
    await showAgentCreation(owner)
    await owner.locator('#agent-name').fill('产品助理')
    await owner.locator('#agent-persona').fill('整理资料、检查交付结果，并清晰报告。')
    await selectFromMenu(owner.locator('#agent-plugin-pack'), '产品检查')
    await owner.getByRole('button', { name: '创建 Agent', exact: true }).click()
    await expect(owner.getByRole('button', { name: /产品助理/ })).toBeVisible()

    await owner.goto('/devices')
    await expect(owner.getByRole('heading', { name: '配对码', exact: true })).toHaveCount(0)
    await expect(
      owner.getByRole('list', { name: '配对步骤' }).locator('[aria-current=step]'),
    ).toHaveText(/生成配对码/)
    const generatePairing = owner.getByRole('button', { name: '生成配对码', exact: true })
    await generatePairing.focus()
    await owner.keyboard.press('Shift+Tab')
    await owner.keyboard.press('Tab')
    await expect(generatePairing).toBeFocused()
    await owner.keyboard.press('Enter')
    await expect(owner.getByTestId('pairing-code')).toBeVisible()
    await expect(
      owner.getByRole('list', { name: '配对步骤' }).locator('[aria-current=step]'),
    ).toHaveText(/电脑配对/)
    const pairingKeyboard = await owner
      .getByRole('list', { name: '配对步骤' })
      .evaluate((node) => ({
        durations: [...node.querySelectorAll('.cu-step-indicator,i>b')].map(
          (part) => getComputedStyle(part).transitionDuration,
        ),
        animations: node.getAnimations({ subtree: true }).length,
      }))
    expect(pairingKeyboard.durations).toEqual(Array(5).fill('0s'))
    expect(pairingKeyboard.animations).toBe(0)
    await owner.getByRole('button', { name: '复制配对码', exact: true }).click()
    await expect(owner.getByText('已复制', { exact: true })).toBeVisible()
    const code = await owner.getByTestId('pairing-code').innerText()
    await owner.setViewportSize({ width: 320, height: 960 })
    await capture(owner, {
      path: join(evidence, 'management-pairing-320.png'),
      mask: [owner.getByTestId('pairing-code')],
    })
    await startNode({ pairingCode: code })
    nodeStarted = true
    await expect(owner.getByText('e2e-node', { exact: true })).toBeVisible()
    await expect(owner.getByTestId('device-status')).toHaveText('在线')
    // No pairing-code/device correlation is exposed; even a new online row is not proof of this code's consumption.
    await expect(
      owner.getByRole('list', { name: '配对步骤' }).locator('[aria-current=step]'),
    ).toHaveText(/电脑配对/)

    let readOnlyPosts = 0
    const observe = (request: Request) => {
      if (request.method() === 'POST') readOnlyPosts++
    }
    owner.on('request', observe)
    const rows = []
    for (const width of [1440, 390, 320]) {
      await owner.setViewportSize({ width, height: 960 })
      await owner.goto('/members')
      await expect(owner.locator('.member-list')).toContainText('Bob')
      await expect(owner.locator('#invite-role')).not.toBeVisible()
      await owner.locator('.page-header').scrollIntoViewIfNeeded()
      await capture(owner, { path: join(evidence, `management-members-${width}.png`) })
      const members = await measure(owner, '.members-page')
      await inviteTrigger.focus()
      await inviteTrigger.press('Enter')
      await selectFromMenu(owner.locator('#invite-role'), '管理员（可管理插件与邀请）')
      await inviteTrigger.click()
      await inviteTrigger.click()
      await expect(owner.locator('#invite-role')).toContainText('管理员')
      await capture(owner, { path: join(evidence, `management-invite-${width}.png`) })
      await owner.goto('/plugins')
      await expect(owner.getByRole('article', { name: 'Pack 产品检查', exact: true })).toBeVisible()
      await owner.locator('.page-header').scrollIntoViewIfNeeded()
      await capture(owner, { path: join(evidence, `management-plugins-${width}.png`) })
      const plugins = await measure(owner, '.plugins-page')
      await owner
        .getByRole('heading', { name: '插件组合（Plugin Pack）', exact: true })
        .scrollIntoViewIfNeeded()
      await capture(owner, { path: join(evidence, `management-packs-${width}.png`) })
      await owner.goto('/agents')
      const card = owner.getByRole('button', { name: /产品助理/ })
      await card.click()
      const detail = owner.getByRole('region', { name: 'Agent 详情 产品助理', exact: true })
      await expect(detail.locator('.agent-current')).toContainText('#1')
      await detail.getByRole('button', { name: '关闭 Agent 详情', exact: true }).click()
      await expect(card).toBeFocused()
      await card.click()
      await owner.locator('.page-header').scrollIntoViewIfNeeded()
      await capture(owner, { path: join(evidence, `management-agents-${width}.png`) })
      const agents = await measure(owner, '.agents-layout')
      await detail.getByRole('button', { name: '新建 Revision', exact: true }).click()
      await expect(detail.locator('#revision-persona')).toHaveValue(
        '整理资料、检查交付结果，并清晰报告。',
      )
      await capture(owner, { path: join(evidence, `management-revision-${width}.png`) })
      await owner.goto('/devices')
      await expect(owner.getByTestId('device-status')).toHaveText('在线')
      await expect(owner.getByRole('button', { name: '生成配对码', exact: true })).toHaveCount(1)
      await owner.locator('.page-header').scrollIntoViewIfNeeded()
      await capture(owner, { path: join(evidence, `management-devices-${width}.png`) })
      const devices = await measure(owner, '.devices-page')
      await owner.emulateMedia({ reducedMotion: 'reduce' })
      const reduced = await owner
        .locator('.cu-page-enter')
        .evaluateAll(
          (nodes) =>
            nodes.length > 0 &&
            nodes.every((node) => getComputedStyle(node).transitionDuration === '0s'),
        )
      expect(reduced).toBe(true)
      await owner.emulateMedia({ reducedMotion: 'no-preference' })
      rows.push({
        width,
        members,
        plugins,
        agents,
        devices,
        inviteCollapsed: true,
        inviteRoleRetained: true,
        closeRestoresFocus: true,
        revisionPrefill: true,
        onePairingAction: true,
        reduced,
      })
    }
    owner.off('request', observe)
    expect(readOnlyPosts).toBe(0)
    await member.goto('/members')
    await expect(member.getByRole('button', { name: '邀请成员', exact: true })).toHaveCount(0)
    await member.goto('/plugins')
    await expect(member.getByRole('button', { name: /^安装 / })).toHaveCount(0)
    await expect(member.getByRole('button', { name: '新建插件组合', exact: true })).toHaveCount(0)
    await member.goto('/agents')
    await expect(member.getByRole('button', { name: '新建 Agent', exact: true })).toHaveCount(0)
    const memberCard = member.getByRole('button', { name: /产品助理/ })
    await memberCard.click()
    const memberDetail = member.getByRole('region', { name: 'Agent 详情 产品助理', exact: true })
    await expect(
      memberDetail.getByRole('button', { name: '新建 Revision', exact: true }),
    ).toHaveCount(0)
    await memberDetail.getByRole('button', { name: '关闭 Agent 详情', exact: true }).click()
    await expect(memberCard).toBeFocused()
    expect(browserErrors).toEqual([])
    await writeFile(
      join(evidence, 'facts.json'),
      JSON.stringify(
        {
          ok: true,
          browserErrors,
          component: 'web.management',
          rows,
          readOnlyPosts,
          inviteRetained: true,
          inviteCopied: true,
          memberJoined: true,
          pluginInstalled: true,
          packCreated: true,
          agentCreated: true,
          paired: true,
          pairingCopied: true,
          pairingKeyboard,
          memberReadOnly: true,
        },
        null,
        2,
      ) + '\n',
    )
  } finally {
    if (nodeStarted) await stopNode()
    await ownerContext.close()
    await memberContext.close()
  }
})
