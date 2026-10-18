/**
 * 连续对话读模型（P1-393；ADR-0019）。
 *
 * 判据只认读模型本身（不依赖 React）：段序、段内插入序、事件身份去重、
 * 末尾相同回复合并、20 段窗口与无所属运行指令的保留、文件按 runId 归属、
 * 底部键只随对话末尾变化（加载更早不得抢走滚动跟随的判据）。
 */
import { describe, expect, it } from 'vitest'
import { makeArtifact, makeInstruction, makeRun } from './fixtures.js'
import {
  CONVERSATION_WINDOW,
  buildConversation,
  conversationBottomKey,
  conversationReadOrder,
  runReplies,
  segmentItems,
} from '../src/features/task/conversation.js'
import type { RunEventItem } from '../src/shared/api/types.js'

function runEvent(
  runId: string,
  seq: number,
  audience: 'owner' | 'project',
  event: Record<string, unknown>,
  occurredAt: string,
): RunEventItem {
  return {
    runId,
    seq,
    type: String(event['type']),
    audience,
    event,
    occurredAt,
    receivedAt: occurredAt,
  }
}

const RUN_1 = '11111111-0000-4000-8000-000000000001'
const RUN_2 = '11111111-0000-4000-8000-000000000002'

function textItems(items: ReturnType<typeof segmentItems>): string[] {
  return items.map((item) =>
    item.kind === 'instruction' ? `#${item.instruction.body}` : item.text,
  )
}

describe('连续对话读模型（ADR-0019）', () => {
  it('段序沿用服务端运行顺序，段内事件保持 seq 顺序、指令按创建时间插入', () => {
    const runs = [
      makeRun({ id: RUN_1, status: 'completed', createdAt: '2026-08-25T02:00:00.000Z' }),
      makeRun({ id: RUN_2, status: 'running', createdAt: '2026-08-25T03:00:00.000Z' }),
    ]
    const instructions = [
      makeInstruction({
        id: 'i-1',
        runId: RUN_1,
        body: '第一句',
        createdAt: '2026-08-25T02:00:30.000Z',
      }),
      makeInstruction({
        id: 'i-2',
        runId: RUN_1,
        body: '接着聊',
        kind: 'followup',
        createdAt: '2026-08-25T02:01:30.000Z',
      }),
      makeInstruction({
        id: 'i-3',
        runId: RUN_2,
        body: '第二段',
        createdAt: '2026-08-25T03:00:10.000Z',
      }),
    ]
    const model = buildConversation({
      runs,
      instructions,
      artifacts: [],
      eventsByRun: new Map([
        [
          RUN_1,
          [
            runEvent(
              RUN_1,
              1,
              'owner',
              { type: 'assistant.message', text: '答案一' },
              '2026-08-25T02:00:40.000Z',
            ),
            runEvent(
              RUN_1,
              2,
              'owner',
              { type: 'run.completed', finalText: '答案一' },
              '2026-08-25T02:02:00.000Z',
            ),
            runEvent(
              RUN_1,
              3,
              'project',
              { type: 'run.completed', finalText: '答案一' },
              '2026-08-25T02:02:00.000Z',
            ),
          ],
        ],
        [
          RUN_2,
          [
            runEvent(
              RUN_2,
              1,
              'owner',
              { type: 'assistant.message', text: '答案二' },
              '2026-08-25T03:00:20.000Z',
            ),
          ],
        ],
      ]),
      window: CONVERSATION_WINDOW,
    })

    expect(model.entries.map((entry) => entry.kind)).toEqual(['run', 'run'])
    const first = model.entries[0]!
    const second = model.entries[1]!
    if (first.kind !== 'run' || second.kind !== 'run') throw new Error('unreachable')
    expect(first.segment.run.id).toBe(RUN_1)
    expect(second.segment.run.id).toBe(RUN_2)
    expect(first.segment.label).toBe('第 1 次运行')
    expect(second.segment.label).toBe('第 2 次运行')
    // 追问在第一条回复之后（按服务端创建时间插入），末尾相同的最终回复合并成一条。
    expect(textItems(first.segment.items)).toEqual(['#第一句', '答案一', '#接着聊'])
  })

  it('按事件身份去重：同一 (runId, audience, seq) 的重复帧只呈现一次', () => {
    const duplicate = runEvent(
      RUN_1,
      7,
      'owner',
      { type: 'assistant.message', text: '只此一条' },
      '2026-08-25T02:00:40.000Z',
    )
    const replies = runReplies([duplicate, { ...duplicate }, { ...duplicate }], RUN_1)
    expect(replies).toHaveLength(1)
    expect(replies[0]!.text).toBe('只此一条')
  })

  it('只合并同一运行末尾相同的最终回复，不跨运行按文本去重，也不合并中间重复', () => {
    const finalSame = runReplies(
      [
        runEvent(
          RUN_1,
          1,
          'owner',
          { type: 'assistant.message', text: '同一句' },
          '2026-08-25T02:00:40.000Z',
        ),
        runEvent(
          RUN_1,
          2,
          'owner',
          { type: 'run.completed', finalText: '同一句' },
          '2026-08-25T02:01:00.000Z',
        ),
      ],
      RUN_1,
    )
    expect(finalSame.map((reply) => reply.text)).toEqual(['同一句'])

    const midRunRepeat = runReplies(
      [
        runEvent(
          RUN_1,
          1,
          'owner',
          { type: 'assistant.message', text: '重复' },
          '2026-08-25T02:00:40.000Z',
        ),
        runEvent(
          RUN_1,
          2,
          'owner',
          { type: 'assistant.message', text: '重复' },
          '2026-08-25T02:00:50.000Z',
        ),
        runEvent(
          RUN_1,
          3,
          'owner',
          { type: 'run.completed', finalText: '收尾' },
          '2026-08-25T02:01:00.000Z',
        ),
      ],
      RUN_1,
    )
    // 中间两句文本相同但都不是「末尾相同的最终回复」：不合并。
    expect(midRunRepeat.map((reply) => reply.text)).toEqual(['重复', '重复', '收尾'])

    const twoRuns = buildConversation({
      runs: [
        makeRun({ id: RUN_1, status: 'completed', createdAt: '2026-08-25T02:00:00.000Z' }),
        makeRun({ id: RUN_2, status: 'completed', createdAt: '2026-08-25T03:00:00.000Z' }),
      ],
      instructions: [],
      artifacts: [],
      eventsByRun: new Map([
        [
          RUN_1,
          [
            runEvent(
              RUN_1,
              1,
              'project',
              { type: 'run.completed', finalText: '一样的话' },
              '2026-08-25T02:01:00.000Z',
            ),
          ],
        ],
        [
          RUN_2,
          [
            runEvent(
              RUN_2,
              1,
              'project',
              { type: 'run.completed', finalText: '一样的话' },
              '2026-08-25T03:01:00.000Z',
            ),
          ],
        ],
      ]),
      window: CONVERSATION_WINDOW,
    })
    const replies = twoRuns.entries.map((entry) =>
      entry.kind === 'run' ? entry.segment.replies.map((reply) => reply.text) : [],
    )
    expect(replies).toEqual([['一样的话'], ['一样的话']])
  })

  it('首屏只给最近 20 次运行，标签仍按服务端全序，加载更早不改变底部键', () => {
    const runs = Array.from({ length: 25 }, (_, index) =>
      makeRun({
        id: `run-${String(index + 1).padStart(2, '0')}`,
        status: 'completed',
        createdAt: `2026-08-25T02:${String(index).padStart(2, '0')}:00.000Z`,
      }),
    )
    const firstScreen = buildConversation({
      runs,
      instructions: [],
      artifacts: [],
      eventsByRun: new Map(),
      window: CONVERSATION_WINDOW,
    })
    expect(firstScreen.visibleRuns).toBe(20)
    expect(firstScreen.hiddenRuns).toBe(5)
    const head = firstScreen.entries[0]!
    if (head.kind !== 'run') throw new Error('unreachable')
    expect(head.segment.run.id).toBe('run-06')
    expect(head.segment.label).toBe('第 6 次运行')

    const loaded = buildConversation({
      runs,
      instructions: [],
      artifacts: [],
      eventsByRun: new Map(),
      window: 40,
    })
    expect(loaded.hiddenRuns).toBe(0)
    expect(loaded.entries).toHaveLength(25)
    expect(conversationBottomKey(loaded)).toBe(conversationBottomKey(firstScreen))

    const appended = buildConversation({
      runs: [
        ...runs,
        makeRun({ id: 'run-26', status: 'running', createdAt: '2026-08-25T04:00:00.000Z' }),
      ],
      instructions: [],
      artifacts: [],
      eventsByRun: new Map(),
      window: CONVERSATION_WINDOW,
    })
    expect(conversationBottomKey(appended)).not.toBe(conversationBottomKey(firstScreen))
  })

  it('无所属运行的拒绝指令按时间保留；隐藏运行上的指令不进对话', () => {
    const runs = [
      makeRun({ id: 'run-old', status: 'completed', createdAt: '2026-08-25T01:00:00.000Z' }),
      makeRun({ id: RUN_1, status: 'running', createdAt: '2026-08-25T02:00:00.000Z' }),
      makeRun({ id: RUN_2, status: 'completed', createdAt: '2026-08-25T03:00:00.000Z' }),
    ]
    const instructions = [
      makeInstruction({
        id: 'orphan',
        runId: null,
        instructionState: 'rejected',
        instructionErrorCode: 'RUN_TERMINAL',
        instructionErrorMessage: '运行已结束',
        body: '这句没有所属运行',
        createdAt: '2026-08-25T02:30:00.000Z',
      }),
      makeInstruction({
        id: 'hidden',
        runId: 'run-old',
        body: '更早历史上的话',
        createdAt: '2026-08-25T01:00:10.000Z',
      }),
    ]
    const model = buildConversation({
      runs,
      instructions,
      artifacts: [],
      eventsByRun: new Map(),
      window: 2,
    })
    expect(model.hiddenRuns).toBe(1)
    expect(model.entries.map((entry) => entry.kind)).toEqual(['run', 'instruction', 'run'])
    const middle = model.entries[1]!
    if (middle.kind !== 'instruction') throw new Error('unreachable')
    expect(middle.instruction.id).toBe('orphan')
    expect(model.entries.some((entry) => entry.key.includes('hidden'))).toBe(false)
  })

  it('交付物按 runId 归到对应段；不可见段与未知运行的交付物不冒充', () => {
    const runs = [
      makeRun({ id: 'run-old', status: 'completed', createdAt: '2026-08-25T01:00:00.000Z' }),
      makeRun({ id: RUN_1, status: 'completed', createdAt: '2026-08-25T02:00:00.000Z' }),
    ]
    const model = buildConversation({
      runs,
      instructions: [],
      artifacts: [
        makeArtifact({ id: 'a-1', runId: RUN_1, title: '报告.md' }),
        makeArtifact({ id: 'a-hidden', runId: 'run-old', title: '更早产出.md' }),
        makeArtifact({ id: 'a-unknown', runId: 'run-missing', title: '来源不明.md' }),
      ],
      eventsByRun: new Map(),
      window: 1,
    })
    expect(model.entries).toHaveLength(1)
    const segment = model.entries[0]!
    if (segment.kind !== 'run') throw new Error('unreachable')
    expect(segment.segment.artifacts.map((artifact) => artifact.id)).toEqual(['a-1'])
  })

  it('读取顺序优先活跃运行，其余最新在前', () => {
    const runs = [
      makeRun({ id: 'run-1', status: 'completed' }),
      makeRun({ id: 'run-2', status: 'completed' }),
      makeRun({ id: 'run-3', status: 'waiting_approval' }),
      makeRun({ id: 'run-4', status: 'completed' }),
    ]
    expect(conversationReadOrder(runs)).toEqual(['run-3', 'run-4', 'run-2', 'run-1'])
  })
})
