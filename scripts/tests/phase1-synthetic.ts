/**
 * P1-18 harness 自证的合成证据生成器（从 phase1-harness.integration.spec.ts 抽出，
 * #73 起与取证面卫生 spec 共用）。
 *
 * 写一套「绿链 minimal」合成证据（完全满足 verify 的绿断言），再按 opts 注入
 * 探活序列/事件剔除——用于不跑真链路就能钉死归因树与观测纪律的回归。
 * `rawEventLine` 在 #73 用于把「未归约的绝对路径」原样钉进 events.jsonl，
 * 验证「证据目录无绝对路径」判定确实会红。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SyntheticOptions {
  runId: string
  /** hub.probe 探活序列（ok 值，按时间序写入 layer-facts.jsonl）。 */
  probes: boolean[]
  /** 剔除 events.jsonl 里全部 hub.* 事件（观测覆盖红线：harness.* 不得充数）。 */
  stripHubEvents?: boolean
  /** 原样追加到 events.jsonl 末尾的一行（不经任何脱敏——注入违例文本用）。 */
  rawEventLine?: string
}

export function writeSyntheticGreenEvidence(dir: string, opts: SyntheticOptions): void {
  mkdirSync(dir, { recursive: true })
  const runId = opts.runId
  const traceId = `phase1-synthetic-${runId.slice(0, 8)}`
  const t = '2026-01-01T00:00:00.000Z'
  const e = (component: string, kind: string, data: Record<string, unknown>): string =>
    JSON.stringify({ ts: t, component, kind, traceId, runId, data })

  const events = [
    e('harness.drive', 'drive.started', { scenario: 'minimal' }),
    ...(['hub.http', 'hub.db'] as const).map((c) => e(c, 'synthetic.hub', {})),
    e('node.gateway', 'node.frame.received', { type: 'run.start' }),
    e('node.gateway', 'node.uplink', { type: 'run.event' }),
    e('runtime.bridge', 'runtime.stdout', { type: 'runtime.ready' }),
    e('browser', 'browser.frame', { who: 'alice' }),
    e('harness.drive', 'milestone', { name: 'browsers.settled' }),
  ]
  const kept =
    opts.stripHubEvents === true
      ? events.filter((line) => !line.includes('"component":"hub.'))
      : events
  const lines = opts.rawEventLine === undefined ? kept : [...kept, opts.rawEventLine]
  writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`)

  writeFileSync(
    join(dir, 'layer-facts.jsonl'),
    `${opts.probes
      .map((ok) => JSON.stringify({ ts: t, component: 'hub.http', kind: 'hub.probe', traceId, ok }))
      .join('\n')}\n`,
  )
  writeFileSync(
    join(dir, 'node-events.jsonl'),
    `${JSON.stringify({
      type: 'run.event',
      payload: { runId, seq: 9, audience: 'owner', event: { type: 'run.completed' } },
    })}\n`,
  )
  writeFileSync(
    join(dir, 'runtime-summary.jsonl'),
    `${JSON.stringify({ ts: t, type: 'runtime.ready', byteLength: 64 })}\n${JSON.stringify({ ts: t, type: 'run.completed', byteLength: 32 })}\n`,
  )
  const runEvent = (seq: number, type: string, audience: string): Record<string, unknown> => ({
    runId,
    seq,
    type,
    audience,
    payload: { event: { type } },
  })
  writeFileSync(
    join(dir, 'browser-alice.jsonl'),
    [
      JSON.stringify({
        kind: 'persistent',
        event: {
          type: 'run.event',
          payload: { runId, seq: 2, audience: 'owner', event: { type: 'assistant.message' } },
        },
      }),
      JSON.stringify({
        kind: 'live',
        runId,
        audience: 'owner',
        deltaSeq: 1,
        delta: { text: 'Hello from replay.' },
      }),
      JSON.stringify({
        kind: 'persistent',
        event: {
          type: 'run.event',
          payload: { runId, seq: 9, audience: 'owner', event: { type: 'run.completed' } },
        },
      }),
    ].join('\n') + '\n',
  )
  writeFileSync(
    join(dir, 'browser-bob.jsonl'),
    `${JSON.stringify({
      kind: 'persistent',
      event: {
        type: 'run.event',
        payload: { runId, seq: 9, audience: 'project', event: { type: 'run.completed' } },
      },
    })}\n`,
  )
  writeFileSync(
    join(dir, 'db-snapshot.json'),
    JSON.stringify({
      runIds: [runId],
      runs: [{ id: runId, status: 'completed', failureCode: null }],
      runEvents: [
        runEvent(2, 'assistant.message', 'owner'),
        runEvent(9, 'run.completed', 'owner'),
        runEvent(9, 'run.completed', 'project'),
      ],
      approvals: [],
      artifacts: [],
      artifactBlobs: [],
      outbox: [
        {
          id: 'cmd-1',
          type: 'run.start',
          payload: { runId },
          attempts: 1,
          ackedAt: t,
          failedAt: null,
        },
      ],
      devices: [],
    }),
  )
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      traceId,
      generatedAt: t,
      scenario: 'minimal',
      fault: 'none',
      runs: {
        [runId]: {
          firstSeenAt: t,
          lastSeenAt: t,
          layers: {
            runtime: { events: 1, files: ['runtime-summary.jsonl'] },
            node: { events: 2, files: ['node-events.jsonl'] },
            hub: { events: 3, files: ['db-snapshot.json'] },
            browser: { events: 4, files: ['browser-alice.jsonl'] },
          },
        },
      },
      commands: { 'cmd-1': { type: 'run.start', dispatched: 1, ackedAt: t } },
    }),
  )
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      traceId,
      attemptId: 'synthetic',
      scenario: 'minimal',
      fault: 'none',
      startedAt: t,
      endedAt: t,
      captured: true,
      runIds: [runId],
      gitCommit: 'synthetic',
      dshVersion: 'synthetic',
      protocolVersion: 1,
      platform: 'test',
      nodeVersion: 'test',
    }),
  )
}
