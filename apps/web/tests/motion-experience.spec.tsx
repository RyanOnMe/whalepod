import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ALICE,
  devicesHandler,
  loggedInHandlers,
  makeArtifact,
  makeDevice,
  makeRun,
  makeTask,
  ok,
  pairingCodeHandler,
  taskRoomHandler,
} from './fixtures.js'
import { renderApp } from './render.js'
import { showWorkspace } from './workspace.js'

function artifactRoom() {
  const artifact = makeArtifact({ status: 'published', mediaType: 'text/markdown' })
  const task = makeTask()
  const view = renderApp(
    `/tasks/${task.id}`,
    loggedInHandlers(ALICE, [
      taskRoomHandler(task, { artifacts: [artifact] }),
      {
        method: 'GET',
        url: new RegExp(`/artifacts/${artifact.id}/content$`),
        respond: () => new Response('# 已核对\n<script>plain text</script>', { status: 200 }),
      },
    ]),
  )
  return { artifact, view }
}

describe('ReactBits motion experience: host state survives presentation transitions', () => {
  it('preview closes and reopens without downloading the same immutable artifact again', async () => {
    const user = userEvent.setup()
    const { artifact, view } = artifactRoom()
    await showWorkspace('artifacts')
    await user.click(screen.getByRole('button', { name: '预览' }))
    const preview = await screen.findByTestId('artifact-preview')
    expect(preview).toHaveTextContent('<script>plain text</script>')
    expect(preview.querySelector('script')).toBeNull()
    await user.click(screen.getByRole('button', { name: '收起预览' }))
    await user.click(screen.getByRole('button', { name: '预览' }))
    expect(screen.getByTestId('artifact-preview')).toHaveTextContent('已核对')
    expect(
      view.fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith(`/artifacts/${artifact.id}/content`),
      ),
    ).toHaveLength(1)
    expect(view.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  it('closing an inspector retains its exit surface inert, and reopening cancels stale dismissal', async () => {
    artifactRoom()
    await showWorkspace('artifacts')
    const inspector = screen.getByRole('region', { name: '工作区详情' })
    fireEvent.click(screen.getByRole('button', { name: '关闭工作区详情' }))
    expect(inspector).toHaveAttribute('data-closing')
    expect(inspector).toHaveAttribute('inert')
    expect(inspector).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(screen.getByRole('button', { name: '交付与复核' }))
    await waitFor(() => expect(inspector).not.toHaveAttribute('data-closing'))
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(screen.getByRole('region', { name: '工作区详情' })).toBe(inspector)
    expect(inspector).not.toHaveAttribute('inert')
  })

  it('an existing online device cannot complete a newly issued pairing journey', async () => {
    const user = userEvent.setup()
    renderApp(
      '/devices',
      loggedInHandlers(ALICE, [
        devicesHandler([makeDevice({ status: 'online' })]),
        pairingCodeHandler({
          pairingCodeId: 'c0c0c0c0-0000-4000-8000-000000000001',
          code: 'MFRG-G4TJ-NRWU-6Y3D-QZBA-5LCE',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
      ]),
    )
    await user.click(await screen.findByRole('button', { name: '生成配对码' }))
    await screen.findByTestId('pairing-code')
    const journey = screen.getByRole('list', { name: '配对步骤' })
    expect(journey.querySelector('[aria-current="step"]')).toHaveTextContent('电脑配对')
    expect(within(journey).getByText('确认在线').closest('li')).not.toHaveAttribute('data-done')
  })

  it('run record collapse removes its controls from interaction without mutating the run', async () => {
    const user = userEvent.setup()
    const task = makeTask()
    const run = makeRun({ status: 'completed' })
    const view = renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(ALICE, [
        taskRoomHandler(task, { runs: [run] }),
        { method: 'GET', url: new RegExp(`/runs/${run.id}$`), respond: () => ok(run) },
        {
          method: 'GET',
          url: new RegExp(`/runs/${run.id}/events`),
          respond: () => ok({ events: [] }),
        },
      ]),
    )
    const summary = await screen.findByText('工具与运行记录', { selector: 'summary' })
    await user.click(summary)
    await user.click(summary)
    const records = screen.getByTestId('run-records')
    expect(records.querySelector('[aria-hidden="true"][inert]')).not.toBeNull()
    expect(view.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })
})
