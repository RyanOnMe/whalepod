/**
 * Run Console 覆盖层（切片⑥d）。
 *
 * 判据分两层，因为这一片有两个独立的失败面：
 *   ① **筛选判定**（纯函数，直接喂事件）：四个口径必须各归各类——尤其"工具失败"不能落在
 *      「工具」里被当成正常步骤、"错误"要包含工具失败面；
 *   ② **覆盖层行为**：打开/关闭（按钮 / Esc / 遮罩）、只读页脚、以及**筛选真的过滤了列表**。
 *
 * 取数留在页面层的 `RunConsoleHost`，所以这里不必搭请求夹具（判定与展示各自可测）。
 */
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RunConsole, componentLayer, matchesFilter } from '../src/features/task/RunConsole.js'
import type { RunEventItem } from '../src/shared/api/types.js'

function event(over: Partial<RunEventItem> & { event: Record<string, unknown> }): RunEventItem {
  return {
    runId: 'r-1',
    seq: 1,
    type: 'run.event',
    audience: 'owner',
    occurredAt: '2026-09-16T02:00:00.000Z',
    receivedAt: '2026-09-16T02:00:00.000Z',
    ...over,
  }
}

describe('Console 筛选判定（纯函数）', () => {
  it('四个口径各归各类：工具 / 审批 / 错误 / 全部', () => {
    const toolStarted = event({ event: { type: 'tool.started', toolName: 'read_file' } })
    const toolFailed = event({ event: { type: 'tool.finished', outcome: 'failed' } })
    const toolOk = event({ event: { type: 'tool.finished', outcome: 'succeeded' } })
    const approval = event({ event: { type: 'approval.requested' } })
    const runFailed = event({ event: { type: 'run.failed', code: 'X' } })
    const phase = event({ event: { type: 'run.phase', phase: 'thinking' } })

    expect(matchesFilter('all', phase)).toBe(true)
    expect(matchesFilter('tool', toolStarted)).toBe(true)
    expect(matchesFilter('tool', toolOk)).toBe(true)
    expect(matchesFilter('approval', approval)).toBe(true)
    // 工具失败同时属于"工具"与"错误"：排障时两个口径都该看得到它
    expect(matchesFilter('tool', toolFailed)).toBe(true)
    expect(matchesFilter('error', toolFailed)).toBe(true)
    // 但成功结束的工具**不该**出现在"错误"里（否则错误面被噪声淹没）
    expect(matchesFilter('error', toolOk)).toBe(false)
    expect(matchesFilter('error', runFailed)).toBe(true)
    // 阶段事件既不是工具也不是审批也不是错误
    expect(matchesFilter('tool', phase)).toBe(false)
    expect(matchesFilter('approval', phase)).toBe(false)
    expect(matchesFilter('error', phase)).toBe(false)
  })

  it('component 分层取前缀（hub.http → hub）；没带 component 归 other', () => {
    expect(componentLayer(event({ event: { component: 'hub.http' } }))).toBe('hub')
    expect(componentLayer(event({ event: { component: 'dsh.agent' } }))).toBe('dsh')
    expect(componentLayer(event({ event: {} }))).toBe('other')
  })
})

describe('Console 覆盖层', () => {
  const events = [
    event({ seq: 1, event: { type: 'run.phase', phase: 'thinking', component: 'dsh.agent' } }),
    event({
      seq: 2,
      event: { type: 'tool.started', toolName: 'read_file', component: 'dsh.agent' },
    }),
    event({ seq: 3, event: { type: 'approval.requested', component: 'hub.approval' } }),
    event({ seq: 4, event: { type: 'run.failed', code: 'RUNTIME_LOST', component: 'hub.run' } }),
  ]

  it('默认显示全部事件，并按 component 给出分层清单', () => {
    render(
      <RunConsole
        runId="r-12345678"
        runLabel="第 1 次运行"
        events={events}
        eventsPending={false}
        onClose={() => {}}
      />,
    )
    expect(screen.getAllByTestId('console-event')).toHaveLength(4)
    expect(screen.getByTestId('console-count').textContent).toContain('4 / 4')
    expect(screen.getByTestId('console-layers').textContent).toContain('dsh')
    expect(screen.getByTestId('console-layers').textContent).toContain('hub')
  })

  it('筛选真的过滤列表（不是只换个高亮）', async () => {
    const user = userEvent.setup()
    render(
      <RunConsole
        runId="r-1"
        runLabel="第 1 次运行"
        events={events}
        eventsPending={false}
        onClose={() => {}}
      />,
    )
    await user.click(screen.getByTestId('console-filter-approval'))
    expect(screen.getAllByTestId('console-event')).toHaveLength(1)
    expect(screen.getByTestId('console-count').textContent).toContain('1 / 4')
    await user.click(screen.getByTestId('console-filter-error'))
    expect(screen.getAllByTestId('console-event')).toHaveLength(1) // run.failed
    await user.click(screen.getByTestId('console-filter-tool'))
    expect(screen.getAllByTestId('console-event')).toHaveLength(1) // tool.started
  })

  it('筛选后没有事件时给出空态，而不是一片空白', async () => {
    const user = userEvent.setup()
    render(
      <RunConsole
        runId="r-1"
        runLabel="第 1 次运行"
        events={[event({ event: { type: 'run.phase', phase: 'thinking' } })]}
        eventsPending={false}
        onClose={() => {}}
      />,
    )
    await user.click(screen.getByTestId('console-filter-approval'))
    expect(screen.getByTestId('console-empty')).toBeVisible()
  })

  it('只读页脚：说清这里不是入口（重跑/取消在运行卡上）', () => {
    render(
      <RunConsole
        runId="r-1"
        runLabel="第 1 次运行"
        events={events}
        eventsPending={false}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('console-readonly').textContent).toContain('只读视图')
  })

  it('三种关闭方式：关闭按钮、Esc、点遮罩', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <RunConsole
        runId="r-1"
        runLabel="第 1 次运行"
        events={events}
        eventsPending={false}
        onClose={onClose}
      />,
    )
    await user.click(screen.getByTestId('console-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
    await user.click(screen.getByTestId('console-scrim'))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('对话框语义：role=dialog + aria-modal（读屏用户要能知道这是覆盖层）', () => {
    render(
      <RunConsole
        runId="r-1"
        runLabel="第 1 次运行"
        events={events}
        eventsPending={false}
        onClose={() => {}}
      />,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName(/第 1 次运行/)
  })

  it('事件还在加载时**不**说"没有事件"（加载失败与空列表必须分得开）', () => {
    render(
      <RunConsole
        runId="r-1"
        runLabel="第 1 次运行"
        events={[]}
        eventsPending
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('正在加载事件…')).toBeVisible()
    expect(screen.queryByTestId('console-empty')).toBeNull()
  })
})
