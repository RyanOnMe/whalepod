/**
 * Admin Plugin Settings（02 Task 17 Step 7）：
 * - catalog 渲染全要素（精确 version / integrity 短摘要 + title 全值 / license /
 *   review commit 短 sha / declared capabilities / capabilityClass）；
 * - Member 只读（无安装按钮、无创建 Pack 表单），Owner/Admin 可操作；
 * - 安装成功提示「不影响已有 Agent Revision」语义（只对新建 Pack/Revision 生效）；
 * - legacy_unrestricted 视觉警示与 local-development 整卡标红；
 * - PackEditor：勾选 → POST 体与 PluginPackCreateRequest schema 对齐；
 *   空选择禁止提交；digest 短摘要 + 可复制全值；
 * - Pack 卡展示 Pack ID 与 Pack Digest（短码 + title 全值 + 一键复制，复制失败如实报错）；
 *   #167 起摘要不再把 64 位十六进制铺在正文里（原来「Pack Digest」与「完整 Digest」两行）；
 * - API 错误（403/409）有可读错误展示（message + requestId）。
 *
 * mock 层与断言风格与 agent-settings 相同：仅替换全局 fetch（HTTP 层），
 * 走真实 router + QueryClient，从用户视角断言。
 */
import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PluginInstallRequestSchema, PluginPackCreateRequestSchema } from '@whalepod/protocol'
import type {
  PluginCatalogEntryView,
  PluginInstallationView,
  PluginPackView,
} from '@whalepod/protocol'
import { ALICE, BOB, created, initOf, loggedInHandlers, ok, packsHandler } from './fixtures.js'
import type { MockHandler, MockResponse } from './fixtures.js'
import { findInternalTerms } from './copy-criteria.js'
import { renderApp } from './render.jsx'

/**
 * 把渲染出来的**可见文本**喂给 #167 的判据（不是"不许有英文"：领域词不在词表里）。
 *
 * 为什么在组件测试里也要查一遍：e2e 的词表判据跑在真实站点上，而插件页的空态只有
 * 目录为空时才渲染——本次实现的第一版把空闲态写成「（curated）」带原词的形态，
 * e2e 在「有目录项」的形态下照样全绿，是截图自审里才撞见。这一条把判据搬到组件层，
 * 让**每一种可渲染形态**都在 Q0 里被扫，而不是只扫 e2e 恰好走到的那个。
 *
 * 为什么不用 `container.textContent`：它把不渲染的文字（闭合 `<details>` 里的导航
 * 链接、隐藏元素）也算进来，比 e2e 的 `innerText` 口径宽——宽口径会把没上屏的文字
 * 判成泄漏（假红）。这里按与 e2e 同一口径取文本：
 * - 排除 `display:none` / `visibility:hidden`（自身与祖先链）；
 * - 排除闭合 `<details>` 的内容（`<summary>` 除外）；
 * - `title` 属性天然不在其中（属性不是文本节点）。
 *
 * jsdom **不实现** `HTMLElement.innerText`（取到 undefined）也不实现
 * `getClientRects`（恒为空列表，用它判可见会把所有文本都滤掉，实测踩过），
 * 所以这里走 computed style。
 */
function visibleText(root: HTMLElement): string {
  const isRendered = (element: Element): boolean => {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const style = window.getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      const details = node.closest('details')
      if (
        details !== null &&
        !details.hasAttribute('open') &&
        node.tagName !== 'SUMMARY' &&
        !(details.querySelector(':scope > summary')?.contains(node) ?? false)
      ) {
        return false
      }
    }
    return true
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const parts: string[] = []
  let node = walker.nextNode()
  while (node !== null) {
    const parent = node.parentElement
    if (parent !== null && isRendered(parent)) parts.push(node.textContent ?? '')
    node = walker.nextNode()
  }
  return parts.join('\n')
}

function expectNoInternalTerm(container: HTMLElement, label: string): void {
  const hits = findInternalTerms(visibleText(container))
  expect(
    hits.map((hit) => hit.text),
    `${label} 的可见文本命中了内部词表`,
  ).toEqual([])
}

const INTEGRITY = `sha256-${'X'.repeat(43)}=`
const INTEGRITY_SHORT = `${INTEGRITY.slice(0, 12)}…`
const LOCK_DIGEST = 'c'.repeat(64)
const PACK_DIGEST = 'd'.repeat(64)
const CONFIG_DIGEST = 'e'.repeat(64)
const REVIEW_COMMIT = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0'

const reviewedEntry: PluginCatalogEntryView = {
  schemaVersion: 1,
  name: 'wp-fixed-time',
  version: '0.1.0',
  tarballUrl: 'https://registry.npmjs.org/wp-fixed-time/-/wp-fixed-time-0.1.0.tgz',
  integrity: INTEGRITY,
  dependencyLockDigest: LOCK_DIGEST,
  dshCompatibility: '0.1.0',
  entrypoint: 'dist/index.js',
  capabilities: ['workspace.read', 'network.egress'],
  capabilityClass: 'declared',
  license: 'MIT',
  review: { status: 'reviewed', commit: REVIEW_COMMIT, at: '2026-08-20T08:00:00.000Z' },
}

const legacyEntry: PluginCatalogEntryView = {
  ...reviewedEntry,
  name: 'legacy-echo',
  version: '1.2.3',
  capabilities: [],
  capabilityClass: 'legacy_unrestricted',
  license: 'Apache-2.0',
}

const localDevEntry: PluginCatalogEntryView = {
  ...reviewedEntry,
  name: 'local-dev-probe',
  version: '0.0.1',
  review: { status: 'local-development', commit: REVIEW_COMMIT, at: '2026-08-20T08:00:00.000Z' },
}

const installation: PluginInstallationView = {
  id: 'eeeeeeee-0000-4000-8000-000000000001',
  packageName: 'wp-fixed-time',
  packageVersion: '0.1.0',
  integrity: INTEGRITY,
  dependencyLockDigest: LOCK_DIGEST,
  trust: 'curated',
  capabilityClass: 'declared',
  capabilities: ['workspace.read', 'network.egress'],
  status: 'installed',
  installedBy: ALICE.userId,
  createdAt: '2026-08-21T09:30:00.000Z',
}

const pack: PluginPackView = {
  id: 'dddddddd-0000-4000-8000-000000000001',
  name: 'review-pack',
  packDigest: PACK_DIGEST,
  installations: [installation.id],
  entries: [
    {
      entry: {
        name: installation.packageName,
        version: installation.packageVersion,
        integrity: INTEGRITY,
        dependencyLockDigest: LOCK_DIGEST,
        entrypoint: 'dist/index.js',
        configDigest: CONFIG_DIGEST,
      },
      installation,
    },
  ],
  createdBy: ALICE.userId,
  createdAt: '2026-08-22T10:00:00.000Z',
}

function catalogHandler(entries: PluginCatalogEntryView[]): MockHandler {
  return { method: 'GET', url: /\/api\/v1\/plugins\/catalog$/, respond: () => ok(entries) }
}

function installationsHandler(rows: PluginInstallationView[]): MockHandler {
  return { method: 'GET', url: /\/api\/v1\/plugins\/installations$/, respond: () => ok(rows) }
}

function failureOf(status: number, code: string, message: string, requestId: string): MockResponse {
  return { status, body: { ok: false, error: { code, message, requestId } } }
}

/** jsdom 没有 navigator.clipboard：临时注入并在用例结束恢复。reject 时模拟写入被拒。 */
function stubClipboardWriteText(options: { reject?: boolean } = {}): {
  writeText: ReturnType<typeof vi.fn>
  restore: () => void
} {
  const writeText = vi.fn(async (_text: string) => {
    if (options.reject) throw new Error('NotAllowedError: clipboard denied')
  })
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
  return {
    writeText,
    restore: () => {
      delete (window.navigator as { clipboard?: unknown }).clipboard
    },
  }
}

describe('plugin-settings', () => {
  it('catalog 渲染全要素：精确 version / integrity 短摘要 / license / review commit / capabilities', async () => {
    renderApp(
      '/plugins',
      loggedInHandlers(ALICE, [
        catalogHandler([reviewedEntry]),
        installationsHandler([]),
        packsHandler([]),
      ]),
    )
    expect(await screen.findByRole('heading', { name: '插件管理' })).toBeVisible()
    // 导航入口
    expect(screen.getByRole('link', { name: '插件' })).toHaveAttribute('href', '/plugins')

    const card = await screen.findByRole('article', { name: 'wp-fixed-time 0.1.0' })
    expect(card).toBeVisible()
    expect(screen.getByText('0.1.0')).toBeVisible() // 精确 version
    expect(screen.getByText(INTEGRITY_SHORT)).toBeVisible() // 短摘要（前 12 字符 + …）
    expect(screen.getByText(INTEGRITY_SHORT)).toHaveAttribute('title', INTEGRITY) // title 全值
    expect(screen.getByText('MIT')).toBeVisible() // license
    expect(screen.getByText(REVIEW_COMMIT.slice(0, 8))).toBeVisible() // review commit 短 sha
    expect(screen.getByText('workspace.read')).toBeVisible() // declared capabilities
    expect(screen.getByText('network.egress')).toBeVisible()
    expect(screen.getByText('declared（能力已声明）')).toBeVisible() // capabilityClass
    expect(screen.getByText('reviewed（已审核）')).toBeVisible() // review.status
  })

  it('legacy_unrestricted 有视觉警示，local-development 整卡标红', async () => {
    renderApp(
      '/plugins',
      loggedInHandlers(ALICE, [
        catalogHandler([reviewedEntry, legacyEntry, localDevEntry]),
        installationsHandler([]),
        packsHandler([]),
      ]),
    )
    expect(await screen.findByRole('article', { name: 'legacy-echo 1.2.3' })).toBeVisible()
    const legacyBadge = screen.getByText(/legacy_unrestricted：未声明能力/)
    expect(legacyBadge).toBeVisible()
    expect(legacyBadge).toHaveClass('badge-plugin-legacy')

    const localCard = screen.getByRole('article', { name: 'local-dev-probe 0.0.1' })
    expect(localCard).toHaveClass('plugin-card-local')
    expect(screen.getByText(/本地开发包（local-development）/)).toBeVisible()
    // reviewed 卡不标红
    expect(screen.getByRole('article', { name: 'wp-fixed-time 0.1.0' })).not.toHaveClass(
      'plugin-card-local',
    )
  })

  it('Member 只读：无安装按钮与创建 Pack 表单，仍可看目录/安装列表/Pack 列表', async () => {
    renderApp(
      '/plugins',
      loggedInHandlers(BOB, [
        catalogHandler([reviewedEntry]),
        installationsHandler([installation]),
        packsHandler([pack]),
      ]),
    )
    expect(await screen.findByRole('article', { name: 'wp-fixed-time 0.1.0' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /^安装/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '创建 Pack' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'wp-fixed-time@0.1.0' })).not.toBeInTheDocument()
    expect(screen.getByText(/插件目录只读/)).toBeVisible()
    // #152：角色名统一中文（此前这里直接印内部枚举值 `member` 与 `Owner/Admin`）
    expect(
      screen.getByText('你是成员，插件目录只读；仅所有者或管理员可安装插件或创建 Pack。'),
    ).toBeVisible()
    expect(screen.getByRole('heading', { name: '已安装插件' })).toBeVisible()
    // #167：标题语言统一。此前这里写 `Plugin Packs`，同页其它标题（插件目录 / 已安装插件）
    // 都是中文，一页两种语言。
    expect(screen.getByRole('heading', { name: '插件组合（Plugin Pack）' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Plugin Packs' })).not.toBeInTheDocument()
    // #167：`curated` 是上游目录标识，不再当正文——徽标走 formatTrust 的中文名。
    expect(screen.getByText('精选')).toBeVisible()
    expect(screen.queryByText('curated')).not.toBeInTheDocument()
  })

  it('#167 内部词表：目录为空的形态，可见文本不得命中（空态是本次改过的文案）', async () => {
    // 一个 renderApp 一次：testing-library 的 screen 查询挂在同一个 document 上，
    // 同一用例里渲染两次会让后面的按名查询撞上两份 DOM（strict 失败）。
    const { container } = renderApp(
      '/plugins',
      loggedInHandlers(ALICE, [catalogHandler([]), installationsHandler([]), packsHandler([])]),
    )
    // 等空态文案自己渲染出来：等壳（标题）会拿到「正在加载…」的中间态，
    // 那时页面上还没有本次要检的文案（#159 一审抓过的同一类假绿）。
    // 等空态文案自己渲染出来：等壳（标题）会拿到「正在加载…」的中间态，那时页面上
    // 还没有本次要检的文案（#159 一审抓过的同一类假绿）。
    expect(await screen.findByText(/精选目录暂无插件/)).toBeVisible()
    expectNoInternalTerm(container, '插件目录空态')
  })

  it('#167 内部词表：有目录项/安装行/Pack 的形态，可见文本不得命中', async () => {
    const { container } = renderApp(
      '/plugins',
      loggedInHandlers(ALICE, [
        catalogHandler([reviewedEntry, legacyEntry, localDevEntry]),
        installationsHandler([installation]),
        packsHandler([pack]),
      ]),
    )
    await screen.findByRole('article', { name: 'wp-fixed-time 0.1.0' })
    expectNoInternalTerm(container, '插件页有数据形态')
  })

  it('Owner 安装成功：请求体与 PluginInstallRequest 对齐，提示不影响已有 Revision', async () => {
    const user = userEvent.setup()
    const { fetchMock } = renderApp(
      '/plugins',
      loggedInHandlers(ALICE, [
        catalogHandler([reviewedEntry]),
        installationsHandler([]),
        packsHandler([]),
        {
          method: 'POST',
          url: /\/api\/v1\/plugins\/installations$/,
          respond: () => created(installation),
        },
      ]),
    )
    await screen.findByRole('article', { name: 'wp-fixed-time 0.1.0' })
    await user.click(screen.getByRole('button', { name: '安装 wp-fixed-time' }))

    // 安装成功不自动修改任何 Agent Revision：语义文案明确「对新 Pack/Revision 生效」。
    expect(await screen.findByText(/安装成功/)).toBeVisible()
    expect(screen.getByText(/不影响已有 Agent Revision/)).toBeVisible()
    expect(screen.getByText(/只对之后新建的 Pack \/ Revision 生效/)).toBeVisible()

    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        (init?.method ?? 'GET') === 'POST' && String(input).endsWith('/plugins/installations'),
    ) as [RequestInfo | URL, RequestInit?] | undefined
    expect(postCall).toBeDefined()
    const init = initOf(postCall as [RequestInfo | URL, RequestInit?])
    expect(new Headers(init.headers).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
    const parsed = PluginInstallRequestSchema.parse(JSON.parse(String(init.body ?? '')))
    expect(parsed).toEqual({ name: 'wp-fixed-time', version: '0.1.0' })
  })

  it('安装失败 403：错误横幅展示 message 与 requestId', async () => {
    const user = userEvent.setup()
    renderApp(
      '/plugins',
      loggedInHandlers(ALICE, [
        catalogHandler([reviewedEntry]),
        installationsHandler([]),
        packsHandler([]),
        {
          method: 'POST',
          url: /\/api\/v1\/plugins\/installations$/,
          respond: () => failureOf(403, 'FORBIDDEN', '仅 Owner/Admin 可安装插件', 'req-403'),
        },
      ]),
    )
    await screen.findByRole('article', { name: 'wp-fixed-time 0.1.0' })
    await user.click(screen.getByRole('button', { name: '安装 wp-fixed-time' }))
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('仅 Owner/Admin 可安装插件')
    expect(banner).toHaveTextContent('req-403')
  })

  it('PackEditor：空选择禁止提交；勾选后 POST 体与 PluginPackCreateRequest 对齐且提示不改 Revision', async () => {
    const user = userEvent.setup()
    const { fetchMock } = renderApp(
      '/plugins',
      loggedInHandlers(ALICE, [
        catalogHandler([]),
        installationsHandler([installation]),
        packsHandler([]),
        { method: 'POST', url: /\/api\/v1\/plugin-packs$/, respond: () => created(pack) },
      ]),
    )
    const createButton = await screen.findByRole('button', { name: '创建 Pack' })
    await user.type(screen.getByLabelText('Pack 名称'), 'review-pack')
    // 空选择禁止提交
    expect(createButton).toBeDisabled()
    expect(screen.getByText('至少勾选一个已安装插件。')).toBeVisible()
    await user.click(await screen.findByRole('checkbox', { name: 'wp-fixed-time@0.1.0' }))
    expect(createButton).toBeEnabled()
    await user.click(createButton)

    // Pack 创建不修改任何已有 Agent Revision：指引去 Agent 管理详情新建 Revision 并选 Pack。
    expect(await screen.findByText(/Pack「review-pack」已创建/)).toBeVisible()
    expect(screen.getByText(/不影响已有 Agent Revision/)).toBeVisible()
    expect(screen.getByText(/点「新建 Revision」，并在表单中选择该 Pack/)).toBeVisible()
    expect(screen.getByRole('link', { name: '去 Agent 管理新建 Revision' })).toHaveAttribute(
      'href',
      '/agents',
    )

    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        (init?.method ?? 'GET') === 'POST' && String(input).endsWith('/plugin-packs'),
    ) as [RequestInfo | URL, RequestInit?] | undefined
    expect(postCall).toBeDefined()
    const init = initOf(postCall as [RequestInfo | URL, RequestInit?])
    expect(new Headers(init.headers).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
    const parsed = PluginPackCreateRequestSchema.parse(JSON.parse(String(init.body ?? '')))
    expect(parsed.name).toBe('review-pack')
    expect(parsed.installationIds).toEqual([installation.id])
  })

  it('Pack 列表：摘要只给短码，全值走 title 与一键复制（正文不铺 64 位十六进制）', async () => {
    const user = userEvent.setup()
    const clipboard = stubClipboardWriteText()
    try {
      renderApp(
        '/plugins',
        loggedInHandlers(ALICE, [
          catalogHandler([]),
          installationsHandler([installation]),
          packsHandler([pack]),
        ]),
      )
      const packCard = await screen.findByRole('article', { name: 'Pack review-pack' })
      const short = within(packCard).getByText(`${PACK_DIGEST.slice(0, 12)}…`)
      expect(short).toBeVisible()
      expect(short).toHaveAttribute('title', PACK_DIGEST) // 全值走 title
      // 反例（#167 的现状证据）：改前这里是第二行「完整 Digest」，整串 64 位十六进制
      // 当正文铺在卡里。现在正文不得再出现全值——只能出现在 title（上面那条已钉）。
      expect(within(packCard).queryByText(PACK_DIGEST)).not.toBeInTheDocument()
      // 成员插件（entries）展示（限定在 Pack 卡内：表单勾选行有同名文本）
      expect(within(packCard).getByText('wp-fixed-time@0.1.0')).toBeVisible()

      // 全值仍要拿得到：一键复制（写进剪贴板的是全值，不是屏上的短码）
      await user.click(
        within(packCard).getByRole('button', { name: '复制 review-pack 插件组合摘要' }),
      )
      expect(await within(packCard).findByText('已复制')).toBeVisible()
      expect(clipboard.writeText).toHaveBeenCalledWith(PACK_DIGEST)
    } finally {
      clipboard.restore()
    }
  })

  it('Pack 卡：Pack ID 短码 + title 全值 + 一键复制', async () => {
    const user = userEvent.setup()
    const clipboard = stubClipboardWriteText()
    try {
      renderApp(
        '/plugins',
        loggedInHandlers(ALICE, [
          catalogHandler([]),
          installationsHandler([installation]),
          packsHandler([pack]),
        ]),
      )
      const packCard = await screen.findByRole('article', { name: 'Pack review-pack' })
      // 短码（前 8 字符）+ title 全值
      expect(within(packCard).getByText(pack.id.slice(0, 8))).toHaveAttribute('title', pack.id)
      await user.click(within(packCard).getByRole('button', { name: '复制 review-pack Pack ID' }))
      expect(await within(packCard).findByText('已复制')).toBeVisible()
      expect(clipboard.writeText).toHaveBeenCalledWith(pack.id)
    } finally {
      clipboard.restore()
    }
  })

  it('Pack ID 复制失败：如实报错（不伪造「已复制」）', async () => {
    const user = userEvent.setup()
    const clipboard = stubClipboardWriteText({ reject: true })
    try {
      renderApp(
        '/plugins',
        loggedInHandlers(ALICE, [
          catalogHandler([]),
          installationsHandler([installation]),
          packsHandler([pack]),
        ]),
      )
      const packCard = await screen.findByRole('article', { name: 'Pack review-pack' })
      await user.click(within(packCard).getByRole('button', { name: '复制 review-pack Pack ID' }))
      expect(await within(packCard).findByText('复制失败，请手动复制Pack ID')).toBeVisible()
      expect(within(packCard).queryByText('已复制')).not.toBeInTheDocument()
    } finally {
      clipboard.restore()
    }
  })

  it('创建 Pack 失败 409：错误横幅展示 message 与 requestId', async () => {
    const user = userEvent.setup()
    renderApp(
      '/plugins',
      loggedInHandlers(ALICE, [
        catalogHandler([]),
        installationsHandler([installation]),
        packsHandler([]),
        {
          method: 'POST',
          url: /\/api\/v1\/plugin-packs$/,
          respond: () =>
            failureOf(409, 'PLUGIN_UNREVIEWED', 'unreviewed 包不能进入普通 Pack', 'req-409'),
        },
      ]),
    )
    const checkbox = await screen.findByRole('checkbox', { name: 'wp-fixed-time@0.1.0' })
    await user.type(screen.getByLabelText('Pack 名称'), 'review-pack')
    await user.click(checkbox)
    await user.click(screen.getByRole('button', { name: '创建 Pack' }))
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('unreviewed 包不能进入普通 Pack')
    expect(banner).toHaveTextContent('req-409')
  })
})
