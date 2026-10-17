/**
 * 探针 —— cancel 竞态与 followup 中断边界（#353，Q3 契约门）。
 *
 * 断链背景：`agent-control.contract.spec.ts` 的取消判据**有 idle 收敛屏障**（等 idle
 * 之后再断言无 run.completed），但缺三件：数量不变量与 fatal 检查（迟到结算/多出来的
 * 终态帧不会被等出来）、撞车窗口的判据、以及内容帧同步点（它等的是
 * `agent.status: running`，那时模型流可能还没到挂起点）。而 turn 被中断时**已在途的
 * followup** 在契约门里零判据（Hub 的 `instruction-queue` 判的是队列语义，不是运行时
 * 边界）。
 *
 * 四条判据（全部走与 Node 相同的命令入口；负向优先，带正控）：
 * 1. 取消落在流式中间：等 hang 前缀**内容帧**再取消，收敛屏障后清总账——多出来的
 *    终态帧、第二串 turn、fatal 一个都不许有；
 * 2. **取消与收尾撞车**（turn/end 已提交、settle 在途时送 cancel；窗口存在性由现场
 *    自检断言）：**Runtime 层**结果唯一（completed 胜出、不得补出 cancelled、不得
 *    fatal），且这次取消不毒化会话（随后的 followup 照常起第二个 turn：正控）；
 * 3. **中断边界的 followup**：运行中入队的 followup 被中断吞掉——零第二串 turn、零
 *    fatal、恰 1 aborted；并以 `agent/inbox/spliced` 钉住两件持久事实：followup 以
 *    `next-turn` 入队（不是 `next-step` 插话），以及取消**在会话日志里留下移除记录**
 *    （`outcome: canceled`）——后者是「续跑不会把已取消的指令复活」的防线；
 * 4. **审批悬置时取消**（用户最常见的取消时刻，独立代码路径）：`approval.requested`
 *    之后取消 → 该次工具调用不得执行（零 `artifact.candidate`）、终态唯一、收敛到
 *    idle；取消后才到的 `approval.decide` 必须被静默丢弃（零执行 + 归因日志）。
 *
 * 语义边界（如实）：② 钉的是 Runtime 层的终态唯一性；这条交错在完整产品链路上的
 * 用户可见结局由 Hub 的域表决定（取消请求先落 `cancel_requested` 时，完成的 Run 以
 * `failed(INVALID_RUN_TRANSITION)` 收敛）——见 cancel-race-acceptance.md 与既有的
 * `apps/hub/tests/run-transition-violation.integration.spec.ts`。
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeOutput } from '@whalepod/protocol'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
  type ProbeRuntime,
} from './helpers/replay-runtime.js'

interface SessionEventView {
  readonly type: string
  readonly data?: unknown
  readonly reason?: unknown
  readonly seq?: number
}

/** 收窄 session.event 的载荷（协议里是 unknown；探针内自己钉形状）。 */
function eventOf(frame: Extract<RuntimeOutput, { type: 'session.event' }>): SessionEventView {
  return frame.payload.event as SessionEventView
}

/** 从 session.event 帧里取 DSH SessionEvent（unknown 载荷，探针内收窄）。 */
function sessionEventsOf(outputs: readonly RuntimeOutput[]): SessionEventView[] {
  return outputs.filter((frame) => frame.type === 'session.event').map((frame) => eventOf(frame))
}

function countOf(outputs: readonly RuntimeOutput[], type: RuntimeOutput['type']): number {
  return outputs.filter((frame) => frame.type === type).length
}

/** 入队/移除的 spliced 记录（副作用形状见 vendor Inbox；探针内只取判据要的键）。 */
function splicedRecords(
  outputs: readonly RuntimeOutput[],
): { seq: number | undefined; target: string | undefined; record: Record<string, unknown> }[] {
  return sessionEventsOf(outputs)
    .filter((event) => event.type === 'agent/inbox/spliced')
    .map((event) => ({
      seq: event.seq,
      target: (event.data as { target?: string } | undefined)?.target,
      record: (event.data ?? {}) as Record<string, unknown>,
    }))
}

/** 等同类第 n 帧出现（`until` 只认首个匹配帧；第 n 帧只能按数量有界等）。 */
async function waitForCount(
  runtime: { readonly outputs: readonly RuntimeOutput[] },
  type: RuntimeOutput['type'],
  n: number,
): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (countOf(runtime.outputs, type) >= n) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`probe: timed out waiting for ${n}× ${type}`)
}

/** 等 hang 前缀内容帧（流真到挂起点；比 `agent.status: running` 强）。 */
async function untilStreamingPrefix(runtime: ProbeRuntime): Promise<void> {
  await runtime.until(
    'session.event',
    (frame) =>
      eventOf(frame).type === 'assistant/chunk' &&
      JSON.stringify(eventOf(frame)).includes('partial'),
  )
}

function lastStatus(outputs: readonly RuntimeOutput[]): string | undefined {
  const statuses = outputs.filter((frame) => frame.type === 'agent.status')
  return statuses.at(-1)?.payload.status
}

function assertSingleAbortedTurn(runtime: ProbeRuntime): void {
  const events = sessionEventsOf(runtime.outputs)
  const starts = events.filter((event) => event.type === 'turn/start')
  const ends = events.filter((event) => event.type === 'turn/end')
  expect(starts, '取消后不得有第二串 turn/start').toHaveLength(1)
  expect(ends, '取消后不得有第二串 turn/end').toHaveLength(1)
  expect(JSON.stringify(ends[0]), 'turn/end 的归因必须是 aborted').toContain('"aborted"')
}

/**
 * 静默窗（有界）：收敛信号（终态帧/idle）之后的**迟到帧**只有在这段采样窗里现形。
 * 它不是时序依赖——一切等待都由内容帧/收敛帧决定；窗口只负责把「迟到的多出来的
 * 帧」等出来（同族先例：single-run-isolation 的 waitForCount 屏障）。按当前实现，
 * settle 之后没有已知的帧源（追加事件/状态迁移/审批/产出全为静默），所以它是兜底
 * 采样，不是判据的主承力面。
 */
async function quietWindow(ms = 200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('probe: cancel race & followup at the interrupt boundary (#353)', () => {
  it('取消落在流式中间：等 hang 前缀内容帧再取消，收敛后总账唯一（无迟到结算/无第二串 turn）', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('cancel', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hang please' }))
      await untilStreamingPrefix(runtime)
      await runtime.send(commandFrame('run.cancel', { runId: spec.runId, cause: 'user' }))

      const cancelled = await runtime.until('run.cancelled')
      expect(cancelled.payload.runId).toBe(spec.runId)
      // 收敛屏障：idle 状态帧出现才算这次中断结算完毕。
      await runtime.until('agent.status', (frame) => frame.payload.status === 'idle')
      await quietWindow()

      assertSingleAbortedTurn(runtime)
      expect(countOf(runtime.outputs, 'run.cancelled')).toBe(1)
      expect(countOf(runtime.outputs, 'run.completed'), '取消后不得再出 run.completed').toBe(0)
      expect(countOf(runtime.outputs, 'runtime.fatal')).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('取消与收尾撞车（turn/end 已提交、settle 在途）：Runtime 层 completed 胜出、不得再出 cancelled，且取消不毒化会话（正控）', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hello' }))

      // 撞车点：turn/end 已出（收尾已提交），settle 链（await whenIdle + flush）
      // 必在飞——此刻送 cancel。窗口由构造保证（本帧到 settle 完成之间至少一次
      // await），不靠 sleep 凑。
      await runtime.until(
        'session.event',
        (frame) =>
          eventOf(frame).type === 'turn/end' &&
          JSON.stringify(eventOf(frame)).includes('"completed"'),
      )
      // 窗口存在性**当场自检**（评审 A）：若将来命令链路多一个 await，cancel 会滑到
      // 终态之后，本用例就会静默退化成「终态后的取消是 no-op」而全绿——这两条断言
      // 把那种退化变成红。
      expect(countOf(runtime.outputs, 'run.completed'), '送出 cancel 前不得已有终态帧').toBe(0)
      expect(lastStatus(runtime.outputs), '送出 cancel 前会话仍在 running').toBe('running')

      await runtime.send(commandFrame('run.cancel', { runId: spec.runId, cause: 'user' }))

      const completed = await runtime.until('run.completed')
      expect(completed.payload.runId).toBe(spec.runId)
      await runtime.until('agent.status', (frame) => frame.payload.status === 'idle')
      await quietWindow()

      // Runtime 层结果唯一：已完成的那一轮成立，取消**不得**补出一条 run.cancelled，
      // 也不得把会话打成 fatal（协议没有「取消无回执」的帧，唯一允许的形态是沉默）。
      const events = sessionEventsOf(runtime.outputs)
      expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(1)
      expect(JSON.stringify(events.find((event) => event.type === 'turn/end'))).toContain(
        '"completed"',
      )
      expect(countOf(runtime.outputs, 'run.completed')).toBe(1)
      expect(countOf(runtime.outputs, 'run.cancelled')).toBe(0)
      expect(countOf(runtime.outputs, 'runtime.fatal')).toBe(0)

      // 正控：这次取消不得给后续工作上闩（vendor 口径「无活跃活动时的取消是 no-op」）。
      // 它在产品链路上的意义是「为**续跑**保留可继续的会话」（终态 Run 的追问会被 Hub
      // 当场拒绝；见 cancel-race-acceptance.md）。同 runId 的第二条 run.completed 在
      // 产品里不会造成双终态：Node 在首个终态帧即 finalize，之后的 stdout 行被丢弃。
      await runtime.send(commandFrame('run.followup', { runId: spec.runId, text: 'second' }))
      await runtime.until('session.event', (frame) =>
        JSON.stringify(eventOf(frame)).includes('Second turn answer.'),
      )
      await waitForCount(runtime, 'run.completed', 2)
      expect(countOf(runtime.outputs, 'run.completed')).toBe(2)
      expect(countOf(runtime.outputs, 'run.cancelled')).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('中断边界：运行中入队的 followup 被取消吞掉——零第二串 turn、零 fatal、且会话日志留下移除记录', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('cancel', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hang please' }))
      await untilStreamingPrefix(runtime)

      // 中断前入队一条 followup（send 返回 = 命令已派发进 bridge，vendor 侧已入队）。
      await runtime.send(
        commandFrame('run.followup', { runId: spec.runId, text: 'followup must not survive' }),
      )
      // 入队语义判据：followup 必须进 `next-turn`（排队成一次 follow-up turn，03 §6.3），
      // 不是插进当前步的 `next-step`（那是 steer/插话的语义）。实现若把 followup 改成
      // steer，本断言红（「无人值守的执行者被中途插话」正是要拦的形态）。
      const enqueued = splicedRecords(runtime.outputs).find(
        (record) =>
          record.target === 'next-turn' &&
          JSON.stringify(record.record).includes('followup must not survive'),
      )
      expect(enqueued, 'followup 必须以 next-turn 入队（带指令原文的 spliced 事件）').toBeDefined()
      expect(
        splicedRecords(runtime.outputs).some((record) => record.target === 'next-step'),
        'followup 不得以 next-step（steer/插话）语义进当前步',
      ).toBe(false)

      await runtime.send(commandFrame('run.cancel', { runId: spec.runId, cause: 'user' }))

      const cancelled = await runtime.until('run.cancelled')
      expect(cancelled.payload.runId).toBe(spec.runId)
      await runtime.until('agent.status', (frame) => frame.payload.status === 'idle')
      await quietWindow()

      // 在途 followup 不得被执行：第二串 turn 一个都不能有。若实现改成「取消后仍
      // 跑排队项」，第二 turn 会启动 —— 本 fixture 只有一个脚本条目，replay 会以
      // `script exhausted` 硬失败成 runtime.fatal，下面几条断言都会红。
      assertSingleAbortedTurn(runtime)
      expect(countOf(runtime.outputs, 'run.cancelled')).toBe(1)
      expect(countOf(runtime.outputs, 'run.completed')).toBe(0)
      expect(countOf(runtime.outputs, 'runtime.fatal')).toBe(0)

      // 持久事实：取消把这条**已入队**的指令从队列里移除，且会话日志留下了移除记录
      // （`outcome: canceled`）。这条是「续跑不会把已取消的指令复活」的防线——Inbox
      // 在 persisted load 时重放全部 splice，若取消只清内存队列而不落这条记录
      // （例如改走 keepInbox），续跑的第一轮就会把它执行掉。
      const records = splicedRecords(runtime.outputs)
      const removed = records.find(
        (record) =>
          record.seq !== undefined &&
          enqueued?.seq !== undefined &&
          record.seq > enqueued.seq &&
          record.record['outcome'] === 'canceled' &&
          record.record['removedCount'] === 1 &&
          // 只认「纯移除」：`replace()` 形态（inserted 非空）也会带 outcome=canceled，
          // 但会把别的东西放回队列——不是本例要钉的形态。
          record.record['start'] === 0 &&
          Array.isArray(record.record['inserted']) &&
          record.record['inserted'].length === 0,
      )
      expect(
        removed,
        '取消必须在 followup 入队之后留一条 outcome=canceled 的移除记录（防续跑复活）',
      ).toBeDefined()
      expect(removed?.target).toBe('next-turn')
    } finally {
      await runtime.dispose()
    }
  })

  it('审批悬置时取消：工具不得执行、终态唯一、迟到的 approval.decide 被静默丢弃', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('tool-approval', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(
        commandFrame('run.prompt', { runId: spec.runId, text: 'publish the report' }),
      )
      // 悬置点：工具调用已发起审批（此刻是用户最可能按取消的时刻）。
      const requested = await runtime.until('approval.requested')
      expect(requested.payload.runId).toBe(spec.runId)
      expect(requested.payload.callId).toBe('call-artifact-1')

      await runtime.send(commandFrame('run.cancel', { runId: spec.runId, cause: 'user' }))
      const cancelled = await runtime.until('run.cancelled')
      expect(cancelled.payload.runId).toBe(spec.runId)
      await runtime.until('agent.status', (frame) => frame.payload.status === 'idle')

      // 取消后才到的决定：必须被静默丢弃（既不执行工具、也不成帧），并留下归因。
      const logsBefore = runtime.logs.length
      await runtime.send(
        commandFrame('approval.decide', {
          runId: spec.runId,
          callId: requested.payload.callId,
          decision: 'allowed_once',
        }),
      )
      await quietWindow()

      assertSingleAbortedTurn(runtime)
      expect(countOf(runtime.outputs, 'run.cancelled')).toBe(1)
      expect(countOf(runtime.outputs, 'run.completed')).toBe(0)
      expect(countOf(runtime.outputs, 'runtime.fatal')).toBe(0)
      expect(countOf(runtime.outputs, 'artifact.candidate'), '取消后的放行不得执行工具').toBe(0)
      expect(
        runtime.logs
          .slice(logsBefore)
          .some(
            (entry) =>
              String(entry['msg'] ?? '').startsWith('approval decide ignored') &&
              entry['callId'] === requested.payload.callId,
          ),
        '迟到的 approval.decide 必须留归因（component/callId 结构化字段，非文本爬取）',
      ).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})
