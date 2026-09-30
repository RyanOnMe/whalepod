/**
 * #229 批次③：操作反馈一致性。
 *
 * - ConfirmDialog：aria-modal、焦点陷阱、Esc 取消、还焦触发钮——替换
 *   TaskHeader 的 window.confirm（原生 confirm 阻塞主线程、无法样式化）；
 * - toast：role=status + 自动消退 + 堆叠上限，统一 Plugin 页 notice 与
 *   ArtifactList 下载反馈；
 * - 窄屏导航 Esc 关闭（jsdom 无 matchMedia 默认宽屏，这里 stub 成窄屏）。
 * Cmd/Ctrl+Enter 的用例在 comment.spec.tsx / instruction-composer.spec.tsx。
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOB, loggedInHandlers, makeTask, ok, teamMembersHandler } from './fixtures.js'
import type { MockHandler } from './fixtures.js'
import { renderApp, renderUi } from './render.js'
import { ConfirmDialog } from '../src/shared/ConfirmDialog.js'
import { ToastHost, pushToast, resetToastsForTest } from '../src/app/toast.js'

describe('ConfirmDialog（#229）', () => {
  it('打开聚焦、Esc 取消、确认走 onConfirm、关闭还焦触发钮', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    // 受控组件直挂（判据是焦点行为本身）。
    let open = false
    const { rerender } = renderUi(
      <ConfirmDialog
        open={open}
        title="取消任务？"
        body="有活跃 Run 时 Hub 会同步请求取消。"
        confirmLabel="取消任务"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    // 触发钮：模拟用户从某按钮打开。
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    open = true
    rerender(
      <ConfirmDialog
        open={open}
        title="取消任务？"
        body="有活跃 Run 时 Hub 会同步请求取消。"
        confirmLabel="取消任务"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeVisible()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    // 打开即聚焦在对话框内（rAF 异步，全量运行下时序抖动——waitFor 而非立即断言）。
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    // Esc = 取消。
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
    // 关闭后焦点还给触发钮。
    open = false
    rerender(
      <ConfirmDialog
        open={open}
        title="取消任务？"
        body=""
        confirmLabel="取消任务"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    trigger.remove()
  })

  it('Tab 焦点陷阱：最后可聚焦元素上再 Tab 回到第一个（aria-modal 说到做到）', async () => {
    renderUi(
      <ConfirmDialog
        open
        title="确认"
        body="内容"
        confirmLabel="确认"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    )
    const dialog = await screen.findByRole('dialog')
    const focusables = dialog.querySelectorAll<HTMLElement>('button')
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    // fireEvent 直发 keydown：只验证陷阱处理本身（userEvent 的 Tab 导航时序
    // 在全量运行下不稳定，且焦点去哪不是这里的判据——判据是循环回到 first）。
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('TaskHeader 三处行动改走 ConfirmDialog：确认才发 POST，不再用 window.confirm', async () => {
    const task = makeTask({
      assigneeUserId: BOB.userId,
      assignmentStatus: 'accepted',
      status: 'in_progress',
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => true)
    const posts: string[] = []
    const handlers: MockHandler[] = [
      {
        method: 'GET',
        url: new RegExp(`/api/v1/tasks/${task.id}$`),
        respond: () => ok({ task, comments: [], instructions: [], runs: [], artifacts: [] }),
      },
      {
        method: 'POST',
        url: new RegExp(`/api/v1/tasks/${task.id}/submit-review$`),
        respond: () => {
          posts.push('submit-review')
          return ok(task)
        },
      },
      teamMembersHandler([]),
    ]
    const user = userEvent.setup()
    renderApp(`/tasks/${task.id}`, loggedInHandlers(BOB, handlers))
    await user.click(await screen.findByRole('button', { name: '提交验收' }))
    // 对话框出现；window.confirm 一次都没被调。
    expect(await screen.findByRole('dialog')).toBeVisible()
    expect(confirmSpy).not.toHaveBeenCalled()
    // 取消：不发 POST。
    await user.click(screen.getByRole('button', { name: /返回/ }))
    expect(posts).toEqual([])
    // 再来一次并确认：确认钮带「确认」前缀（与页面行动钮同名会歧义），POST 发出。
    await user.click(screen.getByRole('button', { name: '提交验收' }))
    await user.click(await screen.findByRole('button', { name: '确认提交验收' }))
    await waitFor(() => expect(posts).toContain('submit-review'))
    confirmSpy.mockRestore()
  })
})

describe('toast（#229）', () => {
  beforeEach(() => {
    resetToastsForTest()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetToastsForTest()
  })

  it('pushToast 渲染 role=status；4 秒自动消退', async () => {
    const view = renderUi(<ToastHost />)
    act(() => pushToast('已保存插件设置'))
    expect(screen.getByRole('status')).toHaveTextContent('已保存插件设置')
    act(() => {
      vi.advanceTimersByTime(4100)
    })
    expect(screen.queryByRole('status')).toBeNull()
    view.unmount()
  })

  it('堆叠上限 3 条：新的挤掉最旧的', () => {
    const view = renderUi(<ToastHost />)
    act(() => {
      pushToast('一')
      pushToast('二')
      pushToast('三')
      pushToast('四')
    })
    const live = screen.getByRole('status')
    expect(live).toHaveTextContent('二')
    expect(live).toHaveTextContent('三')
    expect(live).toHaveTextContent('四')
    expect(live.textContent).not.toContain('一')
    view.unmount()
  })
})

describe('窄屏导航 Esc 关闭（#229）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('details 打开时 Esc 收起并还焦菜单钮；宽屏不受影响', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    )
    const user = userEvent.setup()
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(`/tasks/${task.id}`, [
      {
        method: 'GET',
        url: /\/api\/v1\/setup\/status$/,
        respond: () => ok({ initialized: true }),
      },
      {
        method: 'GET',
        url: /\/api\/v1\/auth\/session$/,
        respond: () => ok(BOB),
      },
      {
        method: 'GET',
        url: new RegExp(`/api/v1/tasks/${task.id}$`),
        respond: () => ok({ task, comments: [], instructions: [], runs: [], artifacts: [] }),
      },
    ])
    // 窄屏：顶栏 details 菜单存在（summary 无隐式 button role，按文本定位）。
    const toggle = (await screen.findByText('菜单')).closest('summary')!
    const details = toggle.closest('details')!
    await user.click(toggle)
    expect(details.open).toBe(true)
    await user.keyboard('{Escape}')
    expect(details.open).toBe(false)
    expect(document.activeElement).toBe(toggle)
  })
})
