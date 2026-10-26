import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DeliveryBasisPanel } from '../src/features/task/DeliveryBasisPanel.js'
import { installFetch, ok } from './fixtures.js'
import { renderUi } from './render.js'

const ID = '00000000-0000-4000-8000-000000000001'
const TASK = '00000000-0000-4000-8000-000000000002'
const view = {
  artifactId: ID, taskId: TASK,
  sourceRun: { id: ID, createdAt: '2026-10-26T01:00:00.000Z', status: 'completed' },
  agreement: { status: 'unbound', revision: null },
  taskInputs: { status: 'recorded', complete: true, artifacts: [] },
  handoffInputs: { status: 'not_selected', complete: true, artifacts: [] },
  handoffs: [],
}
function mount() {
  return renderUi(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <DeliveryBasisPanel artifactId={ID} taskId={TASK} />
  </QueryClientProvider>)
}

describe('delivery basis panel (#440)', () => {
  it('shows explicit missing history and an actually empty input set differently', async () => {
    installFetch([{ method: 'GET', url: /\/delivery-basis$/, respond: () => ok(view) }])
    mount()
    expect(await screen.findByText('该次执行未绑定任务约定。')).toBeVisible()
    expect(screen.getByText('该次执行明确未选择本任务交付物。')).toBeVisible()
    expect(screen.getByText('尚未找到与这份成果明确对应的已发布交接说明。')).toBeVisible()
  })
  it('does not treat a read failure as no records and retries without writes', async () => {
    let reads = 0
    const fetchMock = installFetch([{ method: 'GET', url: /\/delivery-basis$/, respond: () => {
      reads += 1
      return reads === 1
        ? { status: 503, body: { ok: false, error: { code: 'INTERNAL_ERROR', message: '暂不可用', requestId: 'test' } } }
        : ok(view)
    } }])
    mount()
    expect(await screen.findByRole('button', { name: '重试读取依据' })).toBeVisible()
    expect(screen.queryByText('尚未找到与这份成果明确对应的已发布交接说明。')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '重试读取依据' }))
    await waitFor(() => expect(screen.getByText('该次执行未绑定任务约定。')).toBeVisible())
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true)
  })
  it('rejects another artifact response instead of displaying its basis', async () => {
    installFetch([{ method: 'GET', url: /\/delivery-basis$/, respond: () => ok({ ...view, artifactId: TASK }) }])
    mount()
    expect(await screen.findByRole('button', { name: '重试读取依据' })).toBeVisible()
    expect(screen.queryByText('该次执行未绑定任务约定。')).not.toBeInTheDocument()
  })
})
