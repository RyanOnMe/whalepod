import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { emptyHandoffNarrative } from '@whalepod/protocol'
import { act, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DeliveryBasisPanel } from '../src/features/task/DeliveryBasisPanel.js'
import { installFetch, ok } from './fixtures.js'
import { renderUi } from './render.js'
import { applyClientFrame } from '../src/shared/realtime/event-router.js'
import { CursorStore } from '../src/shared/realtime/cursor-store.js'
import { persistentFrame } from './frames.js'

const ID = '00000000-0000-4000-8000-000000000001'
const TASK = '00000000-0000-4000-8000-000000000002'
const view = {
  artifactId: ID,
  taskId: TASK,
  sourceRun: { id: ID, createdAt: '2026-10-26T01:00:00.000Z', status: 'completed' },
  agreement: { status: 'unbound', revision: null },
  taskInputs: { status: 'recorded', complete: true, artifacts: [] },
  handoffInputs: { status: 'not_selected', complete: true, artifacts: [] },
  handoffs: [],
}
function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return renderUi(
    <QueryClientProvider client={client}>
      <DeliveryBasisPanel artifactId={ID} taskId={TASK} />
    </QueryClientProvider>,
  )
}

describe('delivery basis panel (#440)', () => {
  it('shows explicit missing history and an actually empty input set differently', async () => {
    installFetch([{ method: 'GET', url: /\/delivery-basis$/, respond: () => ok(view) }])
    mount()
    expect(await screen.findByText('该次执行未绑定任务约定。')).toBeVisible()
    await userEvent.click(screen.getByText('执行时固定的材料'))
    expect(screen.getByText('该次执行记录的本任务文件输入为空。')).toBeVisible()
    expect(screen.getByText('尚未找到与这份成果明确对应的已发布交接说明。')).toBeVisible()
  })
  it('does not treat a read failure as no records and retries without writes', async () => {
    let reads = 0
    const fetchMock = installFetch([
      {
        method: 'GET',
        url: /\/delivery-basis$/,
        respond: () => {
          reads += 1
          return reads === 1
            ? {
                status: 503,
                body: {
                  ok: false,
                  error: { code: 'INTERNAL_ERROR', message: '暂不可用', requestId: 'test' },
                },
              }
            : ok(view)
        },
      },
    ])
    mount()
    expect(await screen.findByRole('button', { name: '重试读取依据' })).toBeVisible()
    expect(
      screen.queryByText('尚未找到与这份成果明确对应的已发布交接说明。'),
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '重试读取依据' }))
    await waitFor(() => expect(screen.getByText('该次执行未绑定任务约定。')).toBeVisible())
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true)
  })
  it('keeps model claims unverified and incomplete records explicit', async () => {
    const narrative = emptyHandoffNarrative()
    narrative.completed = [{ text: '模型认为已完成', verified: false, refs: [] }]
    narrative.evidence = [{ text: '发布者核对了样本，未验证全量', verified: true, refs: [] }]
    installFetch([
      {
        method: 'GET',
        url: /\/delivery-basis$/,
        respond: () =>
          ok({
            ...view,
            taskInputs: { status: 'unknown', complete: false, artifacts: [] },
            handoffInputs: { status: 'recorded', complete: false, artifacts: [] },
            handoffs: [
              {
                id: ID,
                revisionNumber: 1,
                publishedByUserId: ID,
                publishedAt: '2026-10-26T01:00:00.000Z',
                narrative,
                referencesComplete: false,
              },
            ],
          }),
      },
    ])
    mount()
    await screen.findByText('执行时固定的材料')
    await userEvent.click(screen.getByText('执行时固定的材料'))
    expect(screen.getByText('历史输入记录未知，不能据此认定没有使用材料。')).toBeVisible()
    expect(screen.getByText('部分固定材料当前不可读取，以下清单不完整。')).toBeVisible()
    await userEvent.click(screen.getByText('对应的最近发布交接说明 · 第 1 版'))
    expect(screen.getByText('待核实')).toBeVisible()
    expect(screen.getByText('发布者已核实')).toBeVisible()
    expect(screen.getByText('发布者核对了样本，未验证全量')).toBeVisible()
    expect(screen.getByText('核实标记由发布者确认；引用存在不等于检查充分。')).toBeVisible()
    expect(screen.getByText('部分引用当前不可读取，未展示不可见材料的身份。')).toBeVisible()
    expect(screen.queryByText('验证通过')).not.toBeInTheDocument()
  })
  it('refetches matching task, run and artifact changes through the existing event router', async () => {
    let reads = 0
    installFetch([
      {
        method: 'GET',
        url: /\/delivery-basis$/,
        respond: () => {
          reads += 1
          return ok(view)
        },
      },
    ])
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    mount(client)
    await screen.findByText('该次执行未绑定任务约定。')
    const deps = { cursorStore: new CursorStore(), resync: vi.fn() }
    for (const type of ['task.changed', 'run.changed', 'artifact.changed']) {
      const before = reads
      await act(async () => {
        await applyClientFrame(
          client,
          persistentFrame(type, { taskId: TASK, artifactId: ID, runId: ID }, String(before + 1)),
          deps,
        )
      })
      await waitFor(() => expect(reads).toBeGreaterThan(before))
    }
    const before = reads
    await act(async () => {
      await applyClientFrame(client, persistentFrame('task.changed', { taskId: ID }, '99'), deps)
    })
    expect(reads).toBe(before)
  })
  it('rejects another artifact response instead of displaying its basis', async () => {
    installFetch([
      { method: 'GET', url: /\/delivery-basis$/, respond: () => ok({ ...view, artifactId: TASK }) },
    ])
    mount()
    expect(await screen.findByRole('button', { name: '重试读取依据' })).toBeVisible()
    expect(screen.queryByText('该次执行未绑定任务约定。')).not.toBeInTheDocument()
  })
})
