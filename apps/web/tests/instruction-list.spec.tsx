/**
 * 执行区指令流（切片⑥a）：四种状态 + 拒绝理由 + 排队态 + 运行入口。
 *
 * 重点是**判定**这一列要如实回答的问题：这句话现在到底怎么了（待受理/已受理/已排队/已拒绝），
 * 以及被拒时**理由必须画出来**（③b 的理由落库就是为了这一刻）。
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InstructionList } from '../src/features/task/InstructionList.js'
import type { InstructionView } from '../src/shared/api/types.js'

function instruction(over: Partial<InstructionView> = {}): InstructionView {
  return {
    id: 'i-1',
    taskId: 't-1',
    authorUserId: 'u-1',
    body: '跑一遍回归',
    createdAt: new Date().toISOString(),
    kind: 'instruction',
    targetAgentId: 'a-1',
    runId: 'r-1',
    instructionState: 'pending',
    instructionErrorCode: null,
    instructionErrorMessage: null,
    ...over,
  }
}

describe('instruction list', () => {
  it('空态：说明下一步怎么驱动，而不是留一片空白', () => {
    render(<InstructionList instructions={[]} session={null} />)
    expect(screen.getByText(/还没有人驱动过这个任务/)).toBeTruthy()
  })

  it('四种状态各自的文案：待受理 / 已受理 / 已排队 / 已拒绝', () => {
    render(
      <InstructionList
        instructions={[
          instruction({ id: 'p', instructionState: 'pending' }),
          instruction({ id: 'a', instructionState: 'accepted' }),
          instruction({ id: 'q', instructionState: 'pending' }),
          instruction({
            id: 'r',
            instructionState: 'rejected',
            instructionErrorCode: 'RUN_TERMINAL',
            instructionErrorMessage: '该运行已进入终态',
          }),
        ]}
        session={null}
        queuedIds={new Set(['q'])}
      />,
    )
    const states = screen.getAllByTestId('instruction-state').map((el) => el.textContent)
    expect(states).toEqual(['待受理', '已受理', '已排队', '已拒绝'])
  })

  it('被拒的指令**必须画出理由**（错误码 + 文案）', () => {
    render(
      <InstructionList
        instructions={[
          instruction({
            instructionState: 'rejected',
            instructionErrorCode: 'DEVICE_OFFLINE',
            instructionErrorMessage: '设备未上报 node.hello',
          }),
        ]}
        session={null}
      />,
    )
    const error = screen.getByTestId('instruction-error')
    expect(error.textContent).toContain('DEVICE_OFFLINE')
    expect(error.textContent).toContain('设备未上报 node.hello')
  })

  it('有 Run 时给出运行入口并可点开 Console；没有 Run（待受理）时不画入口', () => {
    const onOpenRun = vi.fn()
    render(
      <InstructionList
        instructions={[
          instruction({ id: 'with-run', runId: 'run-abcdef12' }),
          instruction({ id: 'no-run', runId: null }),
        ]}
        session={null}
        onOpenRun={onOpenRun}
      />,
    )
    const buttons = screen.getAllByTestId('instruction-run')
    expect(buttons).toHaveLength(1) // 只有一条挂在 Run 上
    buttons[0]?.click()
    expect(onOpenRun).toHaveBeenCalledWith('run-abcdef12')
  })

  it('自己发的写「你」，他人发的写人名（不是半截 UUID）', () => {
    render(
      <InstructionList
        instructions={[instruction({ id: 'mine', authorUserId: 'me' })]}
        session={{ userId: 'me' }}
      />,
    )
    expect(screen.getByTestId('instruction-author').textContent).toBe('你')
  })
})
