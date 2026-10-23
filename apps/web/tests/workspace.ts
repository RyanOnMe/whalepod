import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect } from 'vitest'

/**
 * 在执行区输入框里写一句话（P1-393）。
 *
 * ADR-0019 起默认模式可能是「续聊最近一次业务运行」——来源的运行详情/配置版本要
 * 读出来之前输入框是禁用的（真人也要等这一下）。直接 type 会在禁用窗口里静默落空，
 * 所以这里显式等可用（不掩盖真实阻塞：一直不可用会以超时报红）。
 */
export async function typeInstruction(
  text: string,
  user = userEvent.setup(),
): Promise<HTMLTextAreaElement> {
  const box = (await screen.findByLabelText('指令')) as HTMLTextAreaElement
  await waitFor(() => expect(box).toBeEnabled())
  await user.type(box, text)
  return box
}

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

/** Open the file's explicit action menu before choosing a low-frequency action. */
export async function chooseFileAction(name: string, user = userEvent.setup()) {
  await user.click(await screen.findByRole('button', { name: '更多文件操作' }))
  await user.click(await screen.findByRole('menuitem', { name }))
}

export async function showExecutionOptions(user = userEvent.setup()) {
  const summary = await screen.findByLabelText('执行设置')
  if (!summary.closest('details')?.open) await user.click(summary)
}

export async function showTaskMenu(user = userEvent.setup()) {
  const summary = await screen.findByLabelText('任务详情')
  if (!summary.closest('details')?.open) await user.click(summary)
}

export async function showHelp(label: string, user = userEvent.setup()) {
  const summaries = await screen.findAllByText(label, { selector: 'summary' })
  for (const summary of summaries) {
    if (!summary.closest('details')?.open) await user.click(summary)
  }
}
