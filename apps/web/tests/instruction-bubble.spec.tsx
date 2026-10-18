/**
 * 执行区的单条指令气泡（P1-393：从「指令流列表」拆成按时间插入对话的一条）。
 *
 * 重点是**判定**这一列要如实回答的问题：这句话现在到底怎么了（待受理/已受理/已排队/已拒绝），
 * 被拒时**理由必须画出来**（③b 的理由落库就是为了这一刻），运行入口与工具轨迹 chip 可达。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InstructionBubble } from '../src/features/task/InstructionBubble.js'
import { renderUi } from './render.js'
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

describe('instruction bubble', () => {
  it('四种状态各自的文案：待受理 / 已受理 / 已排队 / 已拒绝', () => {
    renderUi(
      <ul>
        <InstructionBubble instruction={instruction({ id: 'p' })} session={null} />
        <InstructionBubble
          instruction={instruction({ id: 'a', instructionState: 'accepted' })}
          session={null}
        />
        <InstructionBubble instruction={instruction({ id: 'q' })} session={null} queued />
        <InstructionBubble
          instruction={instruction({
            id: 'r',
            instructionState: 'rejected',
            instructionErrorCode: 'RUN_TERMINAL',
            instructionErrorMessage: '该运行已进入终态',
          })}
          session={null}
        />
      </ul>,
    )
    const states = screen.getAllByTestId('instruction-state').map((el) => el.textContent)
    expect(states).toEqual(['待受理', '已受理', '已排队', '已拒绝'])
  })

  it('被拒的指令**必须画出理由**（错误码 + 文案）', () => {
    renderUi(
      <ul>
        <InstructionBubble
          instruction={instruction({
            instructionState: 'rejected',
            instructionErrorCode: 'DEVICE_OFFLINE',
            instructionErrorMessage: '设备未上报 node.hello',
          })}
          session={null}
        />
      </ul>,
    )
    const error = screen.getByTestId('instruction-error')
    expect(error.textContent).toContain('DEVICE_OFFLINE')
    expect(error.textContent).toContain('设备未上报 node.hello')
  })

  it('有 Run 时给出运行入口并可点开 Console；没有 Run 时不画入口', () => {
    const onOpenRun = vi.fn()
    renderUi(
      <ul>
        <InstructionBubble
          instruction={instruction({ id: 'with-run', runId: 'run-abcdef12' })}
          session={null}
          onOpenRun={onOpenRun}
        />
        <InstructionBubble
          instruction={instruction({ id: 'no-run', runId: null })}
          session={null}
          onOpenRun={onOpenRun}
        />
      </ul>,
    )
    const buttons = screen.getAllByTestId('instruction-run')
    expect(buttons).toHaveLength(1) // 只有一条挂在 Run 上
    buttons[0]?.click()
    expect(onOpenRun).toHaveBeenCalledWith('run-abcdef12')
  })

  it('追问的执行区呈现：kind=followup 写「追问」，普通指令写「指令」（ADR-0010 决策 2）', () => {
    renderUi(
      <ul>
        <InstructionBubble
          instruction={instruction({ id: 'f', kind: 'followup' })}
          session={null}
        />
        <InstructionBubble instruction={instruction({ id: 'i' })} session={null} />
      </ul>,
    )
    const kinds = screen.getAllByText(/^(追问|指令)$/).map((el) => el.textContent)
    expect(kinds).toEqual(['追问', '指令'])
  })

  it('runId 为空串时不画运行入口（判空不能写成 !runId）', () => {
    renderUi(
      <ul>
        <InstructionBubble
          instruction={instruction({ id: 'empty-run', runId: '' })}
          session={null}
        />
      </ul>,
    )
    expect(screen.queryByTestId('instruction-run')).toBeNull()
  })

  it('自己发的写「你」，他人发的写人名（不是半截 UUID）', () => {
    renderUi(
      <ul>
        <InstructionBubble
          instruction={instruction({ id: 'mine', authorUserId: 'me' })}
          session={{ userId: 'me' }}
        />
      </ul>,
    )
    expect(screen.getByTestId('instruction-author').textContent).toBe('你')
  })

  it('instructionState=null 的指令画"未知状态"而不是崩（#210 收敛暴露的可空面）', () => {
    renderUi(
      <ul>
        <InstructionBubble
          instruction={instruction({ id: 'u', instructionState: null })}
          session={null}
        />
      </ul>,
    )
    expect(screen.getByTestId('instruction-state')).toHaveTextContent('未知状态')
  })

  it('#246 工具轨迹 chip：有工具调用时渲染，点击打开该 Run 的 Console，与运行号入口并存', () => {
    const onOpenRun = vi.fn()
    renderUi(
      <ul>
        <InstructionBubble
          instruction={instruction({ runId: 'r-1' })}
          session={null}
          lastToolCall={{ tool: 'bash', at: '2026-10-01T00:00:00.000Z' }}
          onOpenRun={onOpenRun}
        />
      </ul>,
    )
    const chip = screen.getByTestId('instruction-tool-chip')
    expect(chip.textContent).toContain('bash')
    expect(chip.textContent).toContain('已用工具')
    chip.click()
    expect(onOpenRun).toHaveBeenCalledWith('r-1')
    screen.getByTestId('instruction-run').click()
    expect(onOpenRun).toHaveBeenCalledTimes(2)
  })

  it('Run 没有工具调用时不画 chip——没有就不假装有', () => {
    renderUi(
      <ul>
        <InstructionBubble instruction={instruction({ runId: 'r-bare' })} session={null} />
      </ul>,
    )
    expect(screen.queryByTestId('instruction-tool-chip')).not.toBeInTheDocument()
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
})
