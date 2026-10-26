import { describe, expect, it } from 'vitest'
import type { RunEventItem, RunStatus } from '../src/shared/api/types.js'
import type { ConnectionStatus } from '../src/shared/realtime/connection-store.js'
import { deriveRunActivity } from '../src/features/task/run-activity-state.js'

const RUN_ID = '33333333-3333-4333-8333-333333333333'
function phase(seq: number, value: unknown, over: Partial<RunEventItem> = {}): RunEventItem {
  return {
    runId: RUN_ID,
    seq,
    type: 'run.phase',
    audience: 'project',
    event: { type: 'run.phase', phase: value },
    occurredAt: '2026-10-24T01:00:00.000Z',
    receivedAt: '2026-10-24T01:00:00.000Z',
    ...over,
  }
}
interface ActivityInput {
  runId: string
  status: RunStatus
  events: readonly RunEventItem[]
  pending: boolean
  failed: boolean
  connection: ConnectionStatus
  visible: boolean
}
function input(over: Partial<ActivityInput> = {}): ActivityInput {
  return {
    runId: RUN_ID,
    status: 'running',
    events: [phase(1, 'thinking')],
    pending: false,
    failed: false,
    connection: 'open',
    visible: true,
    ...over,
  }
}

describe('P1-437 truthful Agent state presentation', () => {
  it.each([
    ['thinking', '思考中'],
    ['tool', '工具执行中'],
    ['finalizing', '收尾中'],
  ] as const)('exposes a distinct %s visual state only for a public phase', (state, label) => {
    expect(deriveRunActivity(input({ events: [phase(1, state)] }))).toEqual({
      state,
      label,
      working: true,
    })
  })

  it.each([
    ['queued', 'queued', '排队中，等待运行'],
    ['dispatching', 'dispatching', '派发中，等待运行时就绪'],
    ['waiting_approval', 'approval', '等待责任人审批'],
    ['cancel_requested', 'cancelling', '正在取消'],
    ['completed', 'completed', '本次运行已完成'],
    ['failed', 'failed', '本次运行失败'],
    ['cancelled', 'cancelled', '本次运行已取消'],
    ['lost', 'unknown', '运行已丢失，结果未知'],
  ] as const)('%s overrides old phases, connectivity and read failures', (status, state, label) => {
    expect(
      deriveRunActivity(input({ status, connection: 'reconnecting', failed: true, pending: true })),
    ).toEqual({ state, label, working: false })
  })

  it('orders and deduplicates events without mutating input or taking another audience/run', () => {
    const events = Object.freeze([
      phase(4, 'tool'),
      phase(2, 'thinking'),
      phase(4, 'finalizing'),
      phase(30, 'finalizing', { audience: 'owner' }),
      phase(40, 'finalizing', { audience: 'admin' }),
      phase(50, 'finalizing', { runId: 'another-run' }),
    ])
    expect(deriveRunActivity(input({ events }))).toEqual({
      state: 'tool',
      label: '工具执行中',
      working: true,
    })
    expect(events.map((event) => event.seq)).toEqual([4, 2, 4, 30, 40, 50])
  })

  it.each([
    [],
    [phase(1, 'thinking', { audience: 'owner' })],
    [phase(1, 'thinking', { audience: 'admin' })],
    [phase(1, 'thinking', { runId: 'another-run' })],
    [phase(1, 'thinking'), phase(2, 'unrecognized')],
    [phase(1, 'thinking'), phase(2, '__proto__')],
    [phase(1, 'thinking'), phase(2, null)],
  ])(
    'missing/private/unknown latest phases stop activity rather than replay an older phase',
    (...events) => {
      expect(deriveRunActivity(input({ events: events as RunEventItem[] }))).toEqual({
        state: 'unknown',
        label: '运行中，等待活动更新',
        working: false,
      })
    },
  )

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid sequence %s before considering a phase',
    (seq) => {
      expect(deriveRunActivity(input({ events: [phase(seq, 'thinking')] })).working).toBe(false)
    },
  )

  it.each([
    ['connecting', '连接建立中，等待活动更新'],
    ['reconnecting', '连接中断，活动信息待同步'],
  ] as const)('stops known phase work while %s', (connection, label) => {
    expect(deriveRunActivity(input({ connection }))).toEqual({
      state: 'syncing',
      label,
      working: false,
    })
  })

  it('prioritizes a failed read over pending and old phase data', () => {
    expect(deriveRunActivity(input({ failed: true, pending: true }))).toEqual({
      state: 'unknown',
      label: '活动信息读取失败，请稍后重试',
      working: false,
    })
  })

  it('does not infer a phase while the first read is pending', () => {
    expect(deriveRunActivity(input({ pending: true }))).toEqual({
      state: 'syncing',
      label: '正在读取活动信息…',
      working: false,
    })
  })

  it('preserves the truthful phase but pauses a hidden document', () => {
    expect(deriveRunActivity(input({ visible: false }))).toEqual({
      state: 'thinking',
      label: '思考中',
      working: false,
    })
  })

  it('treats an unrecognized status as unknown rather than activating from a phase', () => {
    expect(deriveRunActivity(input({ status: '__proto__' as RunStatus }))).toEqual({
      state: 'unknown',
      label: '运行状态未知',
      working: false,
    })
  })
})
