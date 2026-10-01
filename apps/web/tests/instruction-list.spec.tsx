/**
 * 执行区指令流（切片⑥a）：四种状态 + 拒绝理由 + 排队态 + 运行入口。
 *
 * 重点是**判定**这一列要如实回答的问题：这句话现在到底怎么了（待受理/已受理/已排队/已拒绝），
 * 以及被拒时**理由必须画出来**（③b 的理由落库就是为了这一刻）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    origin: 'human',
    targetAgentId: 'a-1',
    runId: 'r-1',
    instructionState: 'pending',
    instructionErrorCode: null,
    instructionErrorMessage: null,
    editedAt: null,
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

  it('追问的执行区呈现：kind=followup 写「追问」，普通指令写「指令」（ADR-0010 决策 2）', () => {
    // 复核 R4：这条此前零覆盖——把三元恒写成 '指令' 时全部判据仍绿
    // （`instruction-composer.spec.tsx` 里的 `outcome:'followup'` 是**发送响应**的 outcome，
    // 不是 `InstructionView.kind`，两回事）。
    render(
      <InstructionList
        instructions={[
          instruction({ id: 'f', kind: 'followup' }),
          instruction({ id: 'i', kind: 'instruction' }),
        ]}
        session={null}
      />,
    )
    const kinds = screen.getAllByText(/^(追问|指令)$/).map((el) => el.textContent)
    expect(kinds).toEqual(['追问', '指令'])
  })

  it('runId 为空串时不画运行入口（判空不能写成 !runId）', () => {
    // 复核 R4 的另一条活变异：`runId === null` 改成 `!runId` 时全绿。
    // 空串在契约里不该出现，但"不该出现"不等于"可以不判"——判据要能把它挡住。
    render(
      <InstructionList
        instructions={[instruction({ id: 'empty-run', runId: '' })]}
        session={null}
      />,
    )
    expect(screen.queryByTestId('instruction-run')).toBeNull()
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

describe('视图类型收敛（#210）：不许再手写第二份', () => {
  it('types.ts 里没有手写的 InstructionView / CommentView 字段块（唯一真源在 protocol）', async () => {
    // 反面钉：此前 drift 的根因就是"两边各手写一份 interface"。现在两边都是派生
    // （`export type X = ...TaskMessageView...`），谁加回 `export interface` 手写块就红。
    const source = readFileSync(join(import.meta.dirname, '../src/shared/api/types.ts'), 'utf-8')
    expect(source).not.toMatch(/export interface (Comment|Instruction)View/)
    // 派生还在（不是把类型删了绕过上一条），且 InstructionView 必须是**精确交集**——
    // `TaskMessageView & { 手写… }` 能同时通过上面两条（评审 O1 指出的窄缝），这里堵上：
    // 该行只能以精确的 kind 收窄结尾，不含第二对花括号。
    expect(source).toMatch(/export type CommentView = TaskMessageView/)
    const instructionLine = source
      .split('\n')
      .find((line) => line.startsWith('export type InstructionView'))
    expect(instructionLine).toBe(
      "export type InstructionView = TaskMessageView & { kind: 'instruction' | 'followup' }",
    )
  })

  it('instructionState=null 的指令画"未知状态"而不是崩（#210 收敛暴露的可空面）', () => {
    // 收敛前手写类型说"非空"，组件拿它当 Record 索引；收敛后类型如实说"可空"。
    // 服务端执行流今天永远发非空所以这条**不可达**，但类型允许的值组件必须能处理——
    // 否则就是"类型说可以、运行起来崩"。
    render(
      <InstructionList
        instructions={[instruction({ id: 'u', instructionState: null })]}
        session={null}
      />,
    )
    expect(screen.getByTestId('instruction-state')).toHaveTextContent('未知状态')
  })
})

/**
 * #246（#243 第 2 条）工具轨迹内联：指令条目回答「它最近在用什么工具」，
 * 点 chip 直达该 Run 的 Console——「说了什么」与「做了什么」同一条流渐进展开，
 * 不再为扫一眼工具把人赶进排障覆盖层。
 */
describe('#246 工具轨迹 chip（渐进展开）', () => {
  it('Run 有工具调用时渲染 chip：工具名可见，点击打开该 Run 的 Console', () => {
    const onOpenRun = vi.fn()
    render(
      <InstructionList
        instructions={[instruction({ runId: 'r-1' })]}
        session={null}
        lastToolCallByRun={new Map([['r-1', { tool: 'bash', at: '2026-10-01T00:00:00.000Z' }]])}
        onOpenRun={onOpenRun}
      />,
    )
    const chip = screen.getByTestId('instruction-tool-chip')
    expect(chip.textContent).toContain('bash')
    expect(chip.textContent).toContain('已用工具')
    chip.click()
    expect(onOpenRun).toHaveBeenCalledWith('r-1')
  })

  it('Run 没有工具调用（或指令未绑定 Run）时不画 chip——没有就不假装有', () => {
    render(
      <InstructionList
        instructions={[
          instruction({ id: 'i-no-tool', runId: 'r-bare' }),
          instruction({ id: 'i-no-run', runId: null }),
        ]}
        session={null}
        lastToolCallByRun={new Map()}
      />,
    )
    expect(screen.queryByTestId('instruction-tool-chip')).not.toBeInTheDocument()
  })

  it('chip 与运行号入口并存：两个入口都能到 Console，互不替代', () => {
    const onOpenRun = vi.fn()
    render(
      <InstructionList
        instructions={[instruction({ runId: 'r-1' })]}
        session={null}
        lastToolCallByRun={new Map([['r-1', { tool: 'edit', at: '2026-10-01T00:00:00.000Z' }]])}
        onOpenRun={onOpenRun}
      />,
    )
    screen.getByTestId('instruction-run').click()
    screen.getByTestId('instruction-tool-chip').click()
    expect(onOpenRun).toHaveBeenCalledTimes(2)
    expect(onOpenRun).toHaveBeenNthCalledWith(1, 'r-1')
    expect(onOpenRun).toHaveBeenNthCalledWith(2, 'r-1')
  })
})
