/**
 * #142 设备页配对 UI（用户视角：role/label/text 断言，mock 只在 HTTP 层）。
 *
 * A. 生成配对码：POST /devices/pairing-codes → 明文（六组 base32）+ 10 分钟倒计时
 *    + 一键复制 + 「只显示一次」提示（与 CLI 的 shown once 同语义）；
 * B. 设备列表：GET /devices 渲染名称/在线状态/最后在线，空态给下一步指引；
 * C. 收敛：device.changed 帧经真实 RealtimeBridge → event-router 失效 ['devices'] →
 *    页面不刷新出现新设备（失效链路不 mock，只把手推帧的 socket 装进来）；
 * D. 过期/失败：倒计时归零给出过期态与重新生成入口；失败一律走统一 ErrorBanner
 *    （只给 Hub 的 message + requestId，不把裸错误码搬上屏）。
 *
 * #152：平台名映射（darwin→macOS）与「最后在线」文案、相对时间 + title 绝对时刻
 * 都在本文件立机器判据（实测截图里的「平台 darwin」「最后心跳」）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { ClientFrame } from '@whalepod/protocol'
import { renderApp } from './render.js'
import { persistentFrame } from './frames.js'
import { setRealtimeSocketFactoryForTest } from '../src/app/realtime.js'
import {
  ALICE,
  apiFailure,
  created,
  deferredResponse,
  devicesHandler,
  initOf,
  loggedInHandlers,
  makeDevice,
  pairingCodeHandler,
  statefulDevices,
  type MockHandler,
} from './fixtures.js'
import type { PairingCodeView } from '../src/shared/api/types.js'

/** 六组 base32（03 §2.4）：120bit → 24 字符，RFC4648 大写。 */
const CODE = 'MFRG-G4TJ-NRWU-6Y3D-QZBA-5LCE'
const CODE_PATTERN = /^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/
const PAIRING_CODE_ID = 'c0c0c0c0-0000-4000-8000-000000000001'
const DEVICE_ID = 'd1d1d1d1-0000-4000-8000-00000000000c'
/** 配对码有效期：10 分钟（apps/hub/src/modules/device/pairing.ts 的 PAIRING_CODE_TTL_MS）。 */
const TTL_MS = 10 * 60 * 1000

function pairingCode(expiresAt: string, code = CODE): PairingCodeView {
  return { pairingCodeId: PAIRING_CODE_ID, code, expiresAt }
}

function inTenMinutes(): string {
  return new Date(Date.now() + TTL_MS).toISOString()
}

/** jsdom 没有 navigator.clipboard：临时注入并在用例结束恢复（与插件页用例同法）。 */
function stubClipboard(options: { reject?: boolean } = {}): {
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

/** 可手推帧的 socket：帧仍走真实 RealtimeBridge → event-router 失效链路。 */
function installFramePump(): { push: (frame: ClientFrame) => Promise<void> } {
  let onFrame: ((frame: ClientFrame) => void | Promise<void>) | undefined
  setRealtimeSocketFactoryForTest((_url, _cursorStore, callbacks) => {
    onFrame = callbacks.onFrame
    return { connect: () => {}, close: () => {} }
  })
  return {
    push: async (frame) => {
      if (onFrame === undefined) throw new Error('RealtimeBridge 未挂载：帧无去处')
      await onFrame(frame)
    },
  }
}

afterEach(() => {
  // tests/setup.ts 只在文件级装了一次 no-op socket；本文件用例各自换过，收尾还原。
  setRealtimeSocketFactoryForTest(() => ({ connect: () => {}, close: () => {} }))
})

describe('DevicesPage 生成配对码（#142 A/D）', () => {
  it('点「生成配对码」：明文格式 + 只显示一次提示 + 倒计时，一键复制写剪贴板', async () => {
    const user = userEvent.setup()
    const clipboard = stubClipboard()
    try {
      const { fetchMock } = renderApp(
        '/devices',
        loggedInHandlers(ALICE, [
          devicesHandler([]),
          pairingCodeHandler(pairingCode(inTenMinutes())),
        ]),
      )

      await user.click(await screen.findByRole('button', { name: '生成配对码' }))

      const code = await screen.findByTestId('pairing-code')
      // 断言的是**上屏的明文**：六组 base32（XXXX-XXXX-…）且原样来自响应。
      expect(code.textContent?.trim()).toBe(CODE)
      expect(code.textContent?.trim()).toMatch(CODE_PATTERN)
      expect(screen.getByText(/此码只显示一次/)).toBeVisible()
      expect(screen.getByText(/有效期剩余 (10:00|09:59)/)).toBeVisible()

      await user.click(screen.getByRole('button', { name: '复制配对码' }))
      expect(await screen.findByText('已复制')).toBeVisible()
      expect(clipboard.writeText).toHaveBeenCalledWith(CODE)

      // 请求形状：POST /api/v1/devices/pairing-codes + 幂等键（浏览器真人同一条 API）。
      const call = fetchMock.mock.calls.find((c) =>
        String(c[0]).endsWith('/api/v1/devices/pairing-codes'),
      ) as [RequestInfo | URL, RequestInit?] | undefined
      expect(call).toBeDefined()
      expect(initOf(call!).method).toBe('POST')
      expect(new Headers(initOf(call!).headers).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      clipboard.restore()
    }
  })

  it('生成中：按钮禁用并给出进行中文案（不重复提交）', async () => {
    const user = userEvent.setup()
    const deferred = deferredResponse()
    const slow: MockHandler = {
      method: 'POST',
      url: /\/api\/v1\/devices\/pairing-codes$/,
      respond: () => deferred.promise,
    }
    renderApp('/devices', loggedInHandlers(ALICE, [devicesHandler([]), slow]))

    await user.click(await screen.findByRole('button', { name: '生成配对码' }))
    expect(await screen.findByRole('button', { name: '生成中…' })).toBeDisabled()

    await act(async () => {
      deferred.resolve(created(pairingCode(inTenMinutes())))
    })
    expect(await screen.findByTestId('pairing-code')).toBeVisible()
  })

  it('倒计时真的在走：有效期极短的码到点自己转过期态（无需刷新/重交互）', async () => {
    const user = userEvent.setup()
    // 2.5 秒后过期：首帧必须是「有效码 + 倒计时」，随后翻转只能来自每秒 tick。
    const shortLived: MockHandler = {
      method: 'POST',
      url: /\/api\/v1\/devices\/pairing-codes$/,
      respond: () => created(pairingCode(new Date(Date.now() + 2500).toISOString())),
    }
    renderApp('/devices', loggedInHandlers(ALICE, [devicesHandler([]), shortLived]))

    await user.click(await screen.findByRole('button', { name: '生成配对码' }))
    expect(await screen.findByTestId('pairing-code')).toBeVisible()
    expect(screen.getByText(/有效期剩余 00:0[123]/)).toBeVisible()

    expect(
      await screen.findByText('配对码已过期，请重新生成。', undefined, { timeout: 6000 }),
    ).toBeVisible()
    expect(screen.queryByText(CODE)).not.toBeInTheDocument()
  })

  it('过期：倒计时归零给出过期态与重新生成入口，明文撤下；重新生成拿到新码', async () => {
    const user = userEvent.setup()
    const freshCode = 'QH2V-W7NB-3KMT-XZ4G-J5DR-A6PU'
    let issued = 0
    const rotating: MockHandler = {
      method: 'POST',
      url: /\/api\/v1\/devices\/pairing-codes$/,
      respond: () =>
        created(
          issued++ === 0
            ? pairingCode(new Date(Date.now() - 1000).toISOString())
            : pairingCode(inTenMinutes(), freshCode),
        ),
    }
    renderApp('/devices', loggedInHandlers(ALICE, [devicesHandler([]), rotating]))

    await user.click(await screen.findByRole('button', { name: '生成配对码' }))
    expect(await screen.findByText('配对码已过期，请重新生成。')).toBeVisible()
    // 过期明文不再上屏：一个用不了的码不该继续看着像可用。
    expect(screen.queryByText(CODE)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复制配对码' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重新生成配对码' }))
    expect(await screen.findByText(freshCode)).toBeVisible()
    expect(screen.getByText(/有效期剩余 (10:00|09:59)/)).toBeVisible()
    expect(screen.queryByText('配对码已过期，请重新生成。')).not.toBeInTheDocument()
  })

  it('生成失败：统一 ErrorBanner（message + requestId），不露裸错误码、不出码、可重试', async () => {
    const user = userEvent.setup()
    const failing: MockHandler = {
      method: 'POST',
      url: /\/api\/v1\/devices\/pairing-codes$/,
      respond: () => apiFailure('INTERNAL_ERROR', '配对码签发失败，请稍后重试', 'req-pair-0001'),
    }
    renderApp('/devices', loggedInHandlers(ALICE, [devicesHandler([]), failing]))

    await user.click(await screen.findByRole('button', { name: '生成配对码' }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('配对码签发失败，请稍后重试')
    expect(banner).toHaveTextContent('requestId: req-pair-0001')
    expect(banner).not.toHaveTextContent('INTERNAL_ERROR')
    expect(screen.queryByTestId('pairing-code')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成配对码' })).toBeEnabled()
  })

  it('剪贴板不可用：如实报「复制失败」并保留明文供手动复制（不伪造已复制）', async () => {
    const user = userEvent.setup()
    // user-event.setup 会给 navigator.clipboard 装桩：这里显式抹掉，模拟没有
    // Clipboard API 的浏览器——该分支必须如实报失败，不能假装已复制。
    Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true })
    try {
      renderApp(
        '/devices',
        loggedInHandlers(ALICE, [
          devicesHandler([]),
          pairingCodeHandler(pairingCode(inTenMinutes())),
        ]),
      )

      await user.click(await screen.findByRole('button', { name: '生成配对码' }))
      await screen.findByTestId('pairing-code')
      await user.click(screen.getByRole('button', { name: '复制配对码' }))

      expect(await screen.findByText('复制失败，请手动复制配对码')).toBeVisible()
      expect(screen.queryByText('已复制')).not.toBeInTheDocument()
      expect(screen.getByText(CODE)).toBeVisible()
    } finally {
      delete (window.navigator as { clipboard?: unknown }).clipboard
    }
  })
})

describe('DevicesPage 设备列表（#142 B/C）', () => {
  it('列表渲染：名称 / 在线状态 / 最后在线（从未在线显示占位符，不伪造时间）', async () => {
    const online = makeDevice({
      id: DEVICE_ID,
      name: 'm4-mini',
      platform: 'darwin',
      status: 'online',
      lastSeenAt: '2026-09-10T00:05:00.000Z',
    })
    const offline = makeDevice({
      id: 'd2d2d2d2-0000-4000-8000-00000000000d',
      name: 'linux-box',
      platform: 'linux',
      status: 'offline',
      lastSeenAt: null,
    })
    renderApp('/devices', loggedInHandlers(ALICE, [devicesHandler([online, offline])]))

    expect(await screen.findByText('m4-mini')).toBeVisible()
    expect(screen.getByText('linux-box')).toBeVisible()
    expect(screen.getByText('在线')).toBeVisible()
    expect(screen.getByText('离线')).toBeVisible()
    expect(screen.getAllByText('最后在线')).toHaveLength(2)
    expect(screen.getByText('—')).toBeVisible()
    expect(screen.queryByText(/还没有设备/)).not.toBeInTheDocument()
  })

  it('#152 平台名是人话：darwin→macOS、linux→Linux，页面不出现内部标识', async () => {
    const mac = makeDevice({ id: DEVICE_ID, name: 'm4-mini', platform: 'darwin' })
    const box = makeDevice({
      id: 'd2d2d2d2-0000-4000-8000-00000000000d',
      name: 'linux-box',
      platform: 'linux',
    })
    const unknown = makeDevice({
      id: 'd3d3d3d3-0000-4000-8000-00000000000e',
      name: 'bsd-box',
      platform: 'freebsd',
    })
    renderApp('/devices', loggedInHandlers(ALICE, [devicesHandler([mac, box, unknown])]))

    expect(await screen.findByText('macOS')).toBeVisible()
    expect(screen.getByText('Linux')).toBeVisible()
    // 未知平台原样保留但显式标注，不假装认识
    expect(screen.getByText('freebsd（未知平台）')).toBeVisible()
    expect(document.body.textContent).not.toContain('darwin')
    expect(document.body.textContent).not.toContain('心跳')
  })

  it('#152 时间给相对文案，title 里保留绝对时刻可核对', async () => {
    const device = makeDevice({
      id: DEVICE_ID,
      name: 'm4-mini',
      lastSeenAt: '2026-09-10T00:05:00.000Z',
    })
    renderApp('/devices', loggedInHandlers(ALICE, [devicesHandler([device])]))

    const row = (await screen.findByText('m4-mini')).closest('li') as HTMLElement
    const relative = row.querySelector('time')
    expect(relative).not.toBeNull()
    // 相对文案（刚刚/N 分钟前/N 小时前/昨天 HH:mm/日期）——不写死具体值（跑在不同
    // 日期都成立），但必须是相对档位之一，且绝对长串只出现在 title 里。
    expect(relative?.textContent ?? '').toMatch(
      /^(刚刚|\d+ 分钟前|\d+ 小时前|昨天 \d{2}:\d{2}|\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日)$/,
    )
    expect(relative?.getAttribute('title')).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
    expect(relative?.getAttribute('dateTime')).toBe('2026-09-10T00:05:00.000Z')
  })

  it('空态：给出下一步（先生成码、再按 CLI 步骤配对），CLI 三步教学仍在', async () => {
    renderApp('/devices', loggedInHandlers(ALICE, [devicesHandler([])]))

    expect(await screen.findByText(/还没有设备/)).toBeVisible()
    // 第二步不再写「后续版本提供」：控件就在本页。
    expect(screen.queryByText(/后续版本提供/)).not.toBeInTheDocument()
    expect(screen.getByText(/whalepod-node pair/)).toBeVisible()
    expect(screen.getByText(/whalepod-node start/)).toBeVisible()
    expect(screen.getByRole('button', { name: '生成配对码' })).toBeEnabled()
  })

  it('配对成功收敛：device.changed 帧失效 [devices] → 页面不刷新出现新设备', async () => {
    const list = statefulDevices([])
    const pump = installFramePump()
    renderApp('/devices', loggedInHandlers(ALICE, [list.handler]))
    expect(await screen.findByText(/还没有设备/)).toBeVisible()
    const callsBefore = list.calls()

    // Node 侧 claim 成功 → Hub 扇出 device.changed（payload 带 deviceId）。
    list.add(makeDevice({ id: DEVICE_ID, name: 'm4-mini', status: 'online' }))
    await act(async () => {
      await pump.push(persistentFrame('device.changed', { deviceId: DEVICE_ID }))
    })

    // 没有 reload、没有手工失效：列表自己长出新设备（refetch 有据可查）。
    expect(await screen.findByText('m4-mini')).toBeVisible()
    expect(list.calls()).toBeGreaterThan(callsBefore)
    expect(screen.queryByText(/还没有设备/)).not.toBeInTheDocument()
  })

  it('列表加载失败：ErrorBanner 呈现，不静默也不伪装成空态', async () => {
    const failing: MockHandler = {
      method: 'GET',
      url: /\/api\/v1\/devices$/,
      respond: () => apiFailure('INTERNAL_ERROR', '设备列表读取失败', 'req-devices-0001'),
    }
    renderApp('/devices', loggedInHandlers(ALICE, [failing]))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('设备列表读取失败')
    expect(screen.queryByText(/还没有设备/)).not.toBeInTheDocument()
  })
})
