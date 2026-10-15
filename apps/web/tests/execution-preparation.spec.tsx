import { useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ExecutionPreparation } from '../src/features/task/ExecutionPreparation.js'
import { makeQueryClient } from '../src/app/query-client.js'
import { renderUi } from './render.js'
import { deferredResponse, installFetch, ok } from './fixtures.js'
const taskId = '00000000-0000-4000-8000-000000000001'
const initial = {
  agentId: '00000000-0000-4000-8000-000000000002',
  profileRevisionId: '00000000-0000-4000-8000-000000000003',
  deviceId: '00000000-0000-4000-8000-000000000004',
  workspaceId: '00000000-0000-4000-8000-000000000005',
}
const nextWorkspace = '00000000-0000-4000-8000-000000000006'
function reply(credential: string = 'configured', extra = {}) {
  return {
    checkedAt: new Date().toISOString(),
    profileRevisionId: initial.profileRevisionId,
    deviceId: initial.deviceId,
    workspaceId: initial.workspaceId,
    deviceName: '自己的电脑',
    workspaceName: '工作目录',
    workspace: 'available',
    credential,
    modelCall: 'not_tested',
    ...extra,
  }
}
function Harness({ draft: original = '' }: { draft?: string }) {
  const [client] = useState(() => makeQueryClient({ retry: false }))
  const [selection, setSelection] = useState(initial)
  const [draft, setDraft] = useState(original)
  const [blocked, setBlocked] = useState(false)
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ExecutionPreparation
          taskId={taskId}
          selection={selection}
          provider="fixture-provider"
          credentialSlot="default"
          draft={draft}
          onTrialDraft={setDraft}
          onTarget={(target) => setSelection({ ...selection, ...target })}
          onBlocked={setBlocked}
        />
        <textarea aria-label="保留草稿" value={draft} readOnly />
        <p data-testid="blocked">{String(blocked)}</p>
        <button onClick={() => setSelection({ ...selection, workspaceId: nextWorkspace })}>
          更换工作目录
        </button>
      </MemoryRouter>
    </QueryClientProvider>
  )
}
describe('执行准备（#320）', () => {
  it('检查不调用模型，区分配置和真实调用；试运行只填草稿', async () => {
    const fetchMock = installFetch([
      { method: 'POST', url: /preparation-check$/, respond: () => ok(reply()) },
    ])
    const user = userEvent.setup()
    renderUi(<Harness />)
    await user.click(screen.getByRole('button', { name: '检查本次准备条件' }))
    expect(
      await screen.findByText('模型调用：尚未验证。准备检查不证明模型额度、网络或插件可用。'),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: '填入试运行指令' }))
    expect(screen.getByLabelText('保留草稿')).toHaveValue(
      '请用一句话确认你已收到这条试运行指令，不需要调用工具或修改文件。',
    )
    expect(fetchMock.mock.calls).toHaveLength(1)
  })
  it('已有草稿不被覆盖，未配置结果阻塞', async () => {
    installFetch([
      { method: 'POST', url: /preparation-check$/, respond: () => ok(reply('unconfigured')) },
    ])
    const user = userEvent.setup()
    renderUi(<Harness draft="我的工作草稿" />)
    await user.click(screen.getByRole('button', { name: '检查本次准备条件' }))
    expect(await screen.findByText(/模型凭据：尚未配置/)).toBeVisible()
    await waitFor(() => expect(screen.getByTestId('blocked')).toHaveTextContent('true'))
    expect(screen.getByRole('button', { name: '填入试运行指令' })).toBeDisabled()
    expect(screen.getByLabelText('保留草稿')).toHaveValue('我的工作草稿')
  })
  it('检查期间更换目标，迟到结果不能改回旧目标', async () => {
    const delayed = deferredResponse()
    installFetch([{ method: 'POST', url: /preparation-check$/, respond: () => delayed.promise }])
    const user = userEvent.setup()
    renderUi(<Harness />)
    await user.click(screen.getByRole('button', { name: '检查本次准备条件' }))
    await user.click(screen.getByRole('button', { name: '更换工作目录' }))
    delayed.resolve(ok(reply()))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '检查本次准备条件' })).toBeEnabled(),
    )
    expect(screen.getByTestId('preparation-status')).toHaveTextContent('尚未确认')
    expect(screen.queryByText(/本次检查截至/)).not.toBeInTheDocument()
  })
  it('不同版本结果不能冒充所选版本检查', async () => {
    installFetch([
      {
        method: 'POST',
        url: /preparation-check$/,
        respond: () => ok(reply('configured', { profileRevisionId: nextWorkspace })),
      },
    ])
    const user = userEvent.setup()
    renderUi(<Harness />)
    await user.click(screen.getByRole('button', { name: '检查本次准备条件' }))
    expect(await screen.findByText('暂时无法确认本次准备条件，请重新检查。')).toBeVisible()
    expect(screen.getByTestId('preparation-status')).toHaveTextContent('尚未确认')
  })
  it('过期响应不能重新获得30秒有效期', async () => {
    installFetch([
      {
        method: 'POST',
        url: /preparation-check$/,
        respond: () =>
          ok(
            reply('configured', {
              checkedAt: new Date(Date.now() - 31_000).toISOString(),
            }),
          ),
      },
    ])
    const user = userEvent.setup()
    renderUi(<Harness />)
    await user.click(screen.getByRole('button', { name: '检查本次准备条件' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '检查本次准备条件' })).toBeEnabled(),
    )
    expect(screen.getByTestId('preparation-status')).toHaveTextContent('尚未确认')
    expect(screen.getByRole('button', { name: '填入试运行指令' })).toBeDisabled()
  })
  it('临近到期的响应只保留剩余有效时间', async () => {
    installFetch([
      {
        method: 'POST',
        url: /preparation-check$/,
        respond: () =>
          ok(
            reply('configured', {
              checkedAt: new Date(Date.now() - 29_500).toISOString(),
            }),
          ),
      },
    ])
    const user = userEvent.setup()
    renderUi(<Harness />)
    await user.click(screen.getByRole('button', { name: '检查本次准备条件' }))
    expect(await screen.findByText(/本次检查截至/)).toBeVisible()
    await waitFor(
      () => expect(screen.getByTestId('preparation-status')).toHaveTextContent('已过期'),
      { timeout: 2_000 },
    )
    expect(screen.getByRole('button', { name: '填入试运行指令' })).toBeDisabled()
  })
})
