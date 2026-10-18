import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'

/** Drive the same explicit view/detail controls that users see. */
export async function showWorkspace(view: 'discussion' | 'artifacts' | 'agreement' | 'run') {
  const label = {
    discussion: '团队讨论',
    artifacts: '交付与复核',
    agreement: /^任务约定/,
    run: '运行详情',
  }[view]
  const button = await screen.findByRole('button', { name: label })
  if (button.getAttribute(view === 'discussion' ? 'aria-pressed' : 'aria-expanded') !== 'true') {
    await userEvent.setup().click(button)
  }
}

export function workspaceDetails() {
  return within(screen.getByRole('region', { name: '工作区详情' }))
}

export async function showExecutionOptions() {
  const summary = await screen.findByText('执行方式与草稿')
  if (!(summary.parentElement as HTMLDetailsElement).open) await userEvent.setup().click(summary)
}
