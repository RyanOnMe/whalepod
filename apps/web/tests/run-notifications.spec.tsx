/**
 * 运行完成通知（P1-UX-13 / #259）。
 *
 * 判据（Issue 的「怎样算修好」）：
 * 1. 终态 run.changed（completed/failed/cancelled/lost）→ document.title 徽标计数；
 *    同一 Run 不重复计（终态→终态也只算一次）；非终态不计数；
 * 2. 已读水位落 localStorage——CursorStore 是纯内存（刷新从 0 重放 24h 窗口），
 *    不持久化就会每次刷新把历史终态再数一遍；
 * 3. 系统通知只在「当场发生」（帧 occurredAt ≥ 挂载 − 60s）且授权后弹；重放不弹；
 *    点击通知 → 进任务房 + 该任务未读清零；
 * 4. 任务名从最近任务缓存解析（零新请求），取不到用「任务」占位；
 * 5. 浏览器不支持 → 不渲染开关（不做死控件），徽标照常；权限被拒 → 说明 + 不弹。
 *
 * 驱动方式与 connection-banner.spec.tsx 同款：替换 socket 工厂捕获 RealtimeBridge
 * 组装的回调，手推真实帧——走的是浏览器同一条帧处理路径，不开测试专用近道。
 * **工厂必须在 render 之前装**：bridge 的连接只在挂载时建一次。
 */
import { act, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALICE,
  loggedInHandlers,
  makeTask,
  ok,
  projectsHandler,
  taskRoomHandler,
  teamMembersHandler,
} from './fixtures.js'
import type { MockHandler, RecentTaskView } from './fixtures.js'
import { renderApp } from './render.jsx'
import { OCCURRED_AT, persistentFrame } from './frames.js'
import type { PersistentClientFrame } from './frames.js'
import { setRealtimeSocketFactoryForTest } from '../src/app/realtime.js'
import { resetNotificationStoreForTest } from '../src/shared/notifications/store.js'
import type { TeamEventSocketCallbacks } from '../src/shared/realtime/socket.js'

const TASK_A = '11111111-1111-4111-8111-111111111111'
const TASK_B = '22222222-2222-4222-8222-222222222222'

/** jsdom 没有 Notification：最小替身，只记实例与权限，不碰真实系统弹窗。 */
class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static instances: FakeNotification[] = []
  static requestPermission = vi.fn(
    async (): Promise<NotificationPermission> => FakeNotification.permission,
  )
  readonly options: { body?: string } | undefined
  onclick: (() => void) | null = null

  constructor(
    readonly title: string,
    options?: { body?: string },
  ) {
    this.options = options
    FakeNotification.instances.push(this)
  }

  close(): void {}
}

function liveNow(): string {
  return new Date().toISOString()
}

function recentItem(over: Partial<RecentTaskView> = {}): RecentTaskView {
  return {
    id: TASK_A,
    projectId: 'p-1',
    projectName: 'proj-one',
    title: '修登录页',
    status: 'in_progress',
    lastActiveAt: '2026-10-01T02:00:00.000Z',
    ...over,
  }
}

function recentHandler(items: RecentTaskView[]): MockHandler {
  return { method: 'GET', url: /\/api\/v1\/tasks\/recent$/, respond: () => ok(items) }
}

/** 手推一条 run.changed 持久帧（runId/taskId/status 与 Hub 投影同形）。 */
function runChanged(
  runId: string,
  taskId: string,
  status: string,
  occurredAt: string,
): PersistentClientFrame {
  return persistentFrame('run.changed', { runId, taskId, status }, '7', occurredAt)
}

/**
 * 装帧捕获工厂（**render 前**调用）：返回一个代理，读取回调时若 bridge 还没挂载
 * 就抛错——用例不会静默推给空气。
 */
function installFrameSink(): TeamEventSocketCallbacks {
  let captured: TeamEventSocketCallbacks | undefined
  setRealtimeSocketFactoryForTest((_url, _cursorStore, callbacks) => {
    captured = callbacks
    return { connect: () => undefined, close: () => undefined }
  })
  return new Proxy({} as TeamEventSocketCallbacks, {
    get: (_target, prop: string) => {
      const sink = captured
      if (sink === undefined) throw new Error('RealtimeBridge 尚未挂载，没有回调可推')
      return sink[prop as keyof TeamEventSocketCallbacks]
    },
  })
}

const taskA = makeTask({ id: TASK_A, title: '修登录页', status: 'in_progress' })

function handlers(): MockHandler[] {
  return [
    ...loggedInHandlers(ALICE, [
      projectsHandler([]),
      recentHandler([recentItem()]),
      taskRoomHandler(taskA),
    ]),
    teamMembersHandler([]),
  ]
}

/** 挂载整壳（真实 router + 真实 query client），返回帧推手。 */
async function mountApp(
  extra: readonly MockHandler[] = [],
): Promise<{ view: ReturnType<typeof renderApp>; sink: TeamEventSocketCallbacks }> {
  const sink = installFrameSink()
  const view = renderApp('/', [...handlers(), ...extra])
  // 等壳与侧栏数据落地（帧要推给已挂载的 bridge）。
  await screen.findByRole('link', { name: /修登录页/ })
  return { view, sink }
}

beforeEach(() => {
  window.localStorage.clear()
  resetNotificationStoreForTest()
  document.title = 'WhalePod'
  FakeNotification.permission = 'granted'
  FakeNotification.instances = []
  FakeNotification.requestPermission.mockClear()
  vi.stubGlobal('Notification', FakeNotification)
})

describe('运行完成通知（#259）', () => {
  it('终态进标题徽标；同一 Run 不重复计数；非终态不算', async () => {
    const { view, sink } = await mountApp()
    expect(document.title).toBe('WhalePod')
    act(() => sink.onFrame(runChanged('r1', TASK_A, 'completed', liveNow())))
    expect(document.title).toBe('(1) WhalePod')
    // 重放/重复的同一 Run：不再计数。
    act(() => sink.onFrame(runChanged('r1', TASK_A, 'completed', OCCURRED_AT)))
    expect(document.title).toBe('(1) WhalePod')
    // 非终态不计数。
    act(() => sink.onFrame(runChanged('r2', TASK_A, 'running', liveNow())))
    expect(document.title).toBe('(1) WhalePod')
    // 另一个 Run 失败 → 计数增长。
    act(() => sink.onFrame(runChanged('r3', TASK_A, 'failed', liveNow())))
    expect(document.title).toBe('(2) WhalePod')
    view.unmount()
  })

  it('进任务房间即已读：该任务计数清零、标题还原；事后重放不补记', async () => {
    const user = userEvent.setup()
    const { view, sink } = await mountApp()
    act(() => sink.onFrame(runChanged('r1', TASK_A, 'completed', OCCURRED_AT)))
    act(() => sink.onFrame(runChanged('r2', TASK_A, 'cancelled', OCCURRED_AT)))
    act(() => sink.onFrame(runChanged('r3', TASK_B, 'lost', OCCURRED_AT)))
    expect(document.title).toBe('(3) WhalePod')
    // 点侧栏最近任务进房（真人路径）。
    await user.click(screen.getByRole('link', { name: /修登录页/ }))
    expect(await screen.findByRole('heading', { name: '修登录页' })).toBeVisible()
    await waitFor(() => expect(document.title).toBe('(1) WhalePod'))
    // 已读的任务再收到重放帧：known 去重，未读不回升。
    act(() => sink.onFrame(runChanged('r1', TASK_A, 'completed', OCCURRED_AT)))
    expect(document.title).toBe('(1) WhalePod')
    // 正开着的房间新跑完一个 Run：不积未读（人就在现场）；B 任务的未读不受影响。
    act(() => sink.onFrame(runChanged('r4', TASK_A, 'completed', liveNow())))
    expect(document.title).toBe('(1) WhalePod')
    view.unmount()
  })

  it('系统通知：重放不弹、默认关不弹；授权且当场发生才弹；点击跳任务房并已读', async () => {
    const user = userEvent.setup()
    const { view, sink } = await mountApp()
    // 重放（发生在打开页面之前）：只记徽标，不弹。
    act(() => sink.onFrame(runChanged('r1', TASK_A, 'completed', OCCURRED_AT)))
    expect(document.title).toBe('(1) WhalePod')
    expect(FakeNotification.instances).toHaveLength(0)
    // 当场发生、但用户没开提醒（默认关）：也不弹——granted ≠ 用户想要。
    act(() => sink.onFrame(runChanged('r2', TASK_A, 'completed', liveNow())))
    expect(document.title).toBe('(2) WhalePod')
    expect(FakeNotification.instances).toHaveLength(0)
    // 点击铃铛请求权限（授权）。
    await user.click(screen.getByRole('button', { name: /完成提醒/ }))
    await waitFor(() => expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1))
    // 开关已开时，重放的历史帧仍不弹——旧事不该当场弹脸（新 runId，排除去重以外的解释）。
    act(() => sink.onFrame(runChanged('r0', TASK_A, 'completed', OCCURRED_AT)))
    expect(FakeNotification.instances).toHaveLength(0)
    // 当场发生的终态 → 弹一次，任务名来自最近任务缓存。
    act(() => sink.onFrame(runChanged('r3', TASK_A, 'failed', liveNow())))
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toContain('修登录页')
    // 点击通知 → 进任务房 + 该任务未读清零（r1/r2/r0/r3 都算已读）。
    act(() => FakeNotification.instances[0]?.onclick?.())
    expect(await screen.findByRole('heading', { name: '修登录页' })).toBeVisible()
    await waitFor(() => expect(document.title).toBe('WhalePod'))
    view.unmount()
  })

  it('刷新重放：已读水位与未读都持久（内存态丢弃、localStorage 保留），不重复计数', async () => {
    const first = await mountApp()
    act(() => first.sink.onFrame(runChanged('r1', TASK_A, 'completed', OCCURRED_AT)))
    expect(document.title).toBe('(1) WhalePod')
    first.view.unmount()
    // 模拟刷新：模块内存态归零（下次读从 localStorage 重建），存储不清。
    resetNotificationStoreForTest()
    document.title = 'WhalePod'
    const second = await mountApp()
    // 未读跨刷新存活——徽标是「你不在的时候欠你的」，不是靠这次重放重建的。
    // （只断言「重放不再加」是盲的：从零重建也会数成 (1)。）
    expect(document.title).toBe('(1) WhalePod')
    // 重放同一窗口（24h 内同一 runId）：去重，不叠加。
    act(() => second.sink.onFrame(runChanged('r1', TASK_A, 'completed', OCCURRED_AT)))
    expect(document.title).toBe('(1) WhalePod')
    // 新 Run 照常计。
    act(() => second.sink.onFrame(runChanged('r2', TASK_A, 'failed', OCCURRED_AT)))
    expect(document.title).toBe('(2) WhalePod')
    second.view.unmount()
  })

  it('任务名取不到时用「任务」占位（不发额外请求）', async () => {
    const user = userEvent.setup()
    // 最近任务列表里没有 TASK_B。
    const { view, sink } = await mountApp()
    await user.click(screen.getByRole('button', { name: /完成提醒/ }))
    await waitFor(() => expect(FakeNotification.requestPermission).toHaveBeenCalled())
    act(() => sink.onFrame(runChanged('r9', TASK_B, 'completed', liveNow())))
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe('任务')
    view.unmount()
  })

  it('浏览器不支持通知：不渲染开关，徽标照常工作', async () => {
    vi.stubGlobal('Notification', undefined)
    const { view, sink } = await mountApp()
    expect(screen.queryByRole('button', { name: /完成提醒/ })).toBeNull()
    act(() => sink.onFrame(runChanged('r1', TASK_A, 'completed', OCCURRED_AT)))
    expect(document.title).toBe('(1) WhalePod')
    view.unmount()
  })

  it('权限被拒：说明可见、不弹通知、徽标照常计数', async () => {
    const user = userEvent.setup()
    // 挂载时权限未决（按钮在），用户点击时浏览器拒绝——这是真实路径。
    FakeNotification.permission = 'default'
    const { view, sink } = await mountApp()
    FakeNotification.permission = 'denied'
    await user.click(screen.getByRole('button', { name: /完成提醒/ }))
    expect(await screen.findByText(/浏览器已拒绝通知/)).toBeVisible()
    act(() => sink.onFrame(runChanged('r1', TASK_A, 'completed', liveNow())))
    expect(document.title).toBe('(1) WhalePod')
    expect(FakeNotification.instances).toHaveLength(0)
    view.unmount()
  })
})

/**
 * #308：铃铛从「文本按钮」变成真开关（Bell Toggle 应用内适配）。
 *
 * 判据（Issue 的「怎样算修好」第 3 条）：
 * 1. 响铃是**事件回执**，不是装饰：只有真实授权且启用之后才响一次；未授权/被拒
 *    一次也不响（图形不许替代授权结果）；
 * 2. 徽标只显示真实未读运行数，与 `document.title` 同源；进房即已读两边一起归零；
 * 3. 减少动态下关掉响铃动画——但「开关真的开了」这件事不能靠动画表达。
 */
const toggleOf = (): HTMLElement =>
  screen.getByRole('button', { name: /完成提醒/ }).closest('.bell-toggle') as HTMLElement

describe('#308 完成提醒开关（Micro 铃铛）', () => {
  it('未授权就不响铃：默认关、响铃计数为 0', async () => {
    const { view } = await mountApp()
    const toggle = toggleOf()
    expect(toggle).toHaveAttribute('data-on', 'false')
    expect(toggle).toHaveAttribute('data-ring', '0')
    expect(screen.getByRole('button', { name: /完成提醒/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    view.unmount()
  })

  it('真实授权并启用后才响一次；偏好写入本地;再点关闭不再响', async () => {
    const user = userEvent.setup()
    FakeNotification.permission = 'default'
    const { view } = await mountApp()
    FakeNotification.permission = 'granted'
    await user.click(screen.getByRole('button', { name: /完成提醒/ }))
    await waitFor(() => expect(toggleOf()).toHaveAttribute('data-on', 'true'))
    expect(toggleOf()).toHaveAttribute('data-ring', '1')
    expect(window.localStorage.getItem('whalepod.notifications.system')).toBe('on')
    // 关闭：不响（关掉不是可庆祝的事件），状态如实回落。
    await user.click(screen.getByRole('button', { name: /完成提醒/ }))
    expect(toggleOf()).toHaveAttribute('data-on', 'false')
    expect(toggleOf()).toHaveAttribute('data-ring', '1')
    expect(window.localStorage.getItem('whalepod.notifications.system')).toBe('off')
    view.unmount()
  })

  it('权限被拒：不响铃、不写偏好、状态不进入已开', async () => {
    const user = userEvent.setup()
    FakeNotification.permission = 'default'
    const { view } = await mountApp()
    FakeNotification.permission = 'denied'
    await user.click(screen.getByRole('button', { name: /完成提醒/ }))
    expect(await screen.findByText(/浏览器已拒绝通知/)).toBeVisible()
    expect(window.localStorage.getItem('whalepod.notifications.system')).not.toBe('on')
    // 拒绝后只读：不再有可点的开关（DOM 里连开关都不该在）。
    expect(screen.queryByRole('button', { name: /完成提醒/ })).toBeNull()
    view.unmount()
  })

  it('徽标显示真实未读运行数：与标题同源，进房一起归零', async () => {
    const user = userEvent.setup()
    const { view, sink } = await mountApp()
    expect(screen.queryByTestId('bell-badge')).toBeNull()
    act(() => sink.onFrame(runChanged('r1', TASK_A, 'completed', liveNow())))
    act(() => sink.onFrame(runChanged('r2', TASK_A, 'failed', liveNow())))
    expect(screen.getByTestId('bell-badge')).toHaveTextContent('2')
    expect(document.title).toBe('(2) WhalePod')
    await user.click(screen.getByRole('link', { name: /修登录页/ }))
    expect(await screen.findByRole('heading', { name: '修登录页' })).toBeVisible()
    await waitFor(() => expect(screen.queryByTestId('bell-badge')).toBeNull())
    expect(document.title).toBe('WhalePod')
    view.unmount()
  })

  it('样式契约：响铃是 CSS 动画，减少动态下必须关掉', () => {
    const bellCss = readFileSync(
      resolve(process.cwd(), 'apps/web/src/vendor/react-bits-micro/BellToggle.css'),
      'utf8',
    )
    expect(bellCss).toMatch(/\.bell-toggle\s*\{/)
    expect(bellCss).toMatch(/\.bell-toggle__glyph/)
    // 响铃动画真的挂在「已响过」的条件上，而不是无条件播放。
    expect(bellCss).toMatch(/data-ring='0'[\s\S]*?animation/)
    const reduced = bellCss.split('@media (prefers-reduced-motion: reduce)').slice(1).join('')
    expect(reduced).toContain('.bell-toggle__glyph')
  })
})
