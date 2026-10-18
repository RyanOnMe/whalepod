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
    await readRunEventsToEnd(async () => (call++ === 0 ? first : [pageEvent(RUN, 501)]), {
      onProgress: (events) => tails.push(events.length),
    })
    expect(tails).toEqual([RUN_EVENT_PAGE_LIMIT, RUN_EVENT_PAGE_LIMIT + 1])
  })

  it('resumeAfter：从已有游标续读，只取游标之后的事件（活跃运行每帧失效的续读路径）', async () => {
    const afters: Array<number | undefined> = []
    const result = await readRunEventsToEnd(
      async (after) => {
        afters.push(after)
        // 服务端语义：after 之后的可见流；这一页不足 500 条 = 到末尾。
        return after === undefined ? [] : [pageEvent(RUN, after + 1)]
      },
      { resumeAfter: 900 },
    )
    expect(afters).toEqual([900])
    expect(result.complete).toBe(true)
    expect(result.events.map((item) => item.seq)).toEqual([901])
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

  it('窗口滑出的段必须让出名额：名额是"还在这一屏里的在途"，不是"历史准入总数"', () => {
    // 真实房间的形态（首屏 20 段、每来一段新运行就挤掉最老一段）：被挤出的段已经不在
    // order 里、读取查询也撤下了。旧实现按 admitted 总量算在途，于是窗口每滑动一次就永久
    // 漏掉一个名额——第 4 次之后 free 恒为 0，新段再也读不到（静默停在 pending）。
    const order = ['run-8', 'run-9']
    const admitted = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5', 'run-8']
    expect(admitRuns(order, admitted, [], RUN_EVENT_FETCH_CONCURRENCY)).toEqual(['run-9'])
    // 窗口内的那个还没读完 → 只按它算在途，仍有 3 个名额，但不能重复准入它。
    expect(admitRuns(order, admitted, ['run-8'], RUN_EVENT_FETCH_CONCURRENCY)).toEqual(['run-9'])
    // 窗口外的不占名额、也不许被重新拉进来：只按 order 顺序补窗口内的段。
    expect(admitRuns(['run-8', 'run-9'], ['run-1'], [], 1)).toEqual(['run-8'])
    // 上限照旧生效：窗口内还有一个在读时，唯一的名额不给出（补位不等于突破并发）。
    expect(admitRuns(['run-8', 'run-9'], ['run-1', 'run-8'], [], 1)).toEqual([])
    expect(admitRuns(['run-8', 'run-9'], ['run-1', 'run-8'], ['run-8'], 1)).toEqual(['run-9'])
  })
})
