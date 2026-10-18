/**
 * 共享事件分页读取（P1-393；ADR-0019 决定 5）。
 *
 * 每页 500 条，使用本页最大 seq 作为 after 续读，读到不足一页为止；
 * 受众过滤造成的序号空隙不是丢帧；重复帧按事件身份去重；
 * 分页失败保留已读内容并显式标记不完整（不误报为空记录）；
 * 并发读取最多 4 个运行，优先活跃运行。
 */
import { describe, expect, it } from 'vitest'
import {
  RUN_EVENT_FETCH_CONCURRENCY,
  RUN_EVENT_PAGE_LIMIT,
  admitRuns,
  readRunEventsToEnd,
} from '../src/shared/realtime/run-event-pages.js'
import type { RunEventItem } from '../src/shared/api/types.js'

function pageEvent(runId: string, seq: number): RunEventItem {
  return {
    runId,
    seq,
    type: 'run.phase',
    audience: 'project',
    event: { type: 'run.phase', phase: 'thinking' },
    occurredAt: '2026-08-25T02:00:00.000Z',
    receivedAt: '2026-08-25T02:00:00.000Z',
  }
}

const RUN = '11111111-0000-4000-8000-000000000001'

describe('事件分页读到末尾（ADR-0019 决定 5）', () => {
  it('每页 500 条、以最大 seq 作为 after 续读至不足一页', async () => {
    const afters: Array<number | undefined> = []
    const pages = [
      Array.from({ length: RUN_EVENT_PAGE_LIMIT }, (_, index) => pageEvent(RUN, index + 1)),
      Array.from({ length: RUN_EVENT_PAGE_LIMIT }, (_, index) => pageEvent(RUN, 501 + index)),
      [pageEvent(RUN, 1001), pageEvent(RUN, 1003)],
    ]
    const result = await readRunEventsToEnd(async (after) => {
      afters.push(after)
      return pages[afters.length - 1] ?? []
    })
    expect(afters).toEqual([undefined, 500, 1000])
    expect(result.complete).toBe(true)
    expect(result.events).toHaveLength(1002)
    // 受众过滤造成的序号空隙（1002 不可见）不算丢帧，末尾事件仍然读到。
    expect(result.events.at(-1)!.seq).toBe(1003)
  })

  it('超过 500 条事件时末尾的最终回复仍然读得到', async () => {
    const first = Array.from({ length: RUN_EVENT_PAGE_LIMIT }, (_, index) =>
      pageEvent(RUN, index + 1),
    )
    const tail: RunEventItem[] = [
      {
        ...pageEvent(RUN, 501),
        type: 'run.completed',
        event: { type: 'run.completed', finalText: '末尾回复' },
      },
    ]
    let call = 0
    const result = await readRunEventsToEnd(async () => (call++ === 0 ? first : tail))
    expect(result.complete).toBe(true)
    const reply = result.events.at(-1)!
    expect(reply.event['finalText']).toBe('末尾回复')
  })

  it('跨页重复帧按事件身份去重', async () => {
    // 一个 500 条整页 + 重叠重发的一页（真实重连可能重复收到边界帧）。
    const first = Array.from({ length: RUN_EVENT_PAGE_LIMIT }, (_, index) =>
      pageEvent(RUN, index + 1),
    )
    const overlap = [pageEvent(RUN, 500), pageEvent(RUN, 501)]
    let call = 0
    const result = await readRunEventsToEnd(async () => (call++ === 0 ? first : overlap))
    expect(result.events).toHaveLength(RUN_EVENT_PAGE_LIMIT + 1)
    expect(result.events.at(-1)!.seq).toBe(501)
  })

  it('分页失败保留已读内容并标记不完整（不当成空记录）', async () => {
    const first = Array.from({ length: RUN_EVENT_PAGE_LIMIT }, (_, index) =>
      pageEvent(RUN, index + 1),
    )
    let call = 0
    const result = await readRunEventsToEnd(async () => {
      if (call++ === 0) return first
      throw new Error('page failed')
    })
    expect(result.complete).toBe(false)
    expect(result.events).toHaveLength(RUN_EVENT_PAGE_LIMIT)

    const failedFirst = await readRunEventsToEnd(async () => {
      throw new Error('page failed')
    })
    expect(failedFirst.complete).toBe(false)
    expect(failedFirst.events).toEqual([])
  })

  it('无进展的整页（seq 不前进）停止续读，不空转', async () => {
    let calls = 0
    const stuck = Array.from({ length: RUN_EVENT_PAGE_LIMIT }, (_, index) =>
      pageEvent(RUN, index + 1),
    )
    const result = await readRunEventsToEnd(async () => {
      calls += 1
      return stuck
    })
    expect(calls).toBe(2)
    expect(result.complete).toBe(false)
  })

  it('读取过程把已读内容交给回调用（进度可见，不等到全部读完）', async () => {
    const first = Array.from({ length: RUN_EVENT_PAGE_LIMIT }, (_, index) =>
      pageEvent(RUN, index + 1),
    )
    const tails: number[] = []
    let call = 0
    await readRunEventsToEnd(
      async () => (call++ === 0 ? first : [pageEvent(RUN, 501)]),
      (events) => tails.push(events.length),
    )
    expect(tails).toEqual([RUN_EVENT_PAGE_LIMIT, RUN_EVENT_PAGE_LIMIT + 1])
  })
})

describe('运行读取并发与优先级（ADR-0019 决定 5）', () => {
  it('并发上限 4：空闲名额按优先级补位，已满不提新', () => {
    const order = ['run-3', 'run-4', 'run-2', 'run-1', 'run-0']
    expect(admitRuns(order, [], [], RUN_EVENT_FETCH_CONCURRENCY)).toEqual([
      'run-3',
      'run-4',
      'run-2',
      'run-1',
    ])
    expect(admitRuns(order, ['run-3', 'run-4'], [], RUN_EVENT_FETCH_CONCURRENCY)).toEqual([
      'run-2',
      'run-1',
    ])
    expect(
      admitRuns(
        order,
        ['run-3', 'run-4', 'run-2', 'run-1'],
        ['run-3'],
        RUN_EVENT_FETCH_CONCURRENCY,
      ),
    ).toEqual(['run-0'])
    expect(
      admitRuns(order, ['run-3', 'run-4', 'run-2', 'run-1'], [], RUN_EVENT_FETCH_CONCURRENCY),
    ).toEqual([])
  })

  it('已读到的运行不重复入队；队列走完不产生新请求', () => {
    const order = ['run-1', 'run-2']
    expect(admitRuns(order, ['run-1', 'run-2'], ['run-1', 'run-2'], 4)).toEqual([])
  })
})
