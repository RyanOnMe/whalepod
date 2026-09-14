import { describe, expect, it } from 'vitest'
import { parseNodeFrame } from '@whalepod/protocol'
import { FakeClock } from '../src/fake-clock.js'
import { FakeDeviceGateway, FakeDeviceOfflineError } from '../src/fake-device-gateway.js'

// packages/testkit 的 P1-10 交付物：驱动 G4/R7/R8 的内存 Node 替身。
// 语义对齐 03-领域模型与运行协议.md §6：Node 对 commandId 幂等（本地 spool），
// ack 丢失时 Hub 重发不产生第二份副作用（R7 的失败判据是「启动第二 Runtime」）。
describe('FakeClock', () => {
  it('starts at a deterministic instant and advances monotonically', () => {
    const clock = new FakeClock(new Date('2026-08-25T00:00:00.000Z'))
    expect(clock.now().toISOString()).toBe('2026-08-25T00:00:00.000Z')
    clock.advance(30_000)
    expect(clock.now().toISOString()).toBe('2026-08-25T00:00:30.000Z')
  })
})

describe('FakeDeviceGateway', () => {
  const deviceId = '00000000-0000-4000-8000-0000000de1ce'
  const runStartFrame = (commandId: string, runId: string) =>
    parseNodeFrame(
      {
        protocolVersion: 1,
        messageId: '00000000-0000-4000-8000-00000000f1a1',
        sentAt: '2026-08-25T00:00:00.000Z',
        type: 'run.start',
        payload: {
          commandId,
          runId,
          taskId: '00000000-0000-4000-8000-000000007a5c',
          ownerUserId: '00000000-0000-4000-8000-000000005e12',
          agent: {
            id: '00000000-0000-4000-8000-00000000a6e7',
            profileRevisionId: '00000000-0000-4000-8000-00000000e1b1',
            persona: 'You are a helpful agent.',
            provider: 'deepseek',
            model: 'deepseek-chat',
            credentialSlot: 'default',
          },
          workspaceId: '00000000-0000-4000-8000-00000000cafe',
          expectedProfileDigest: 'b'.repeat(64),
          expectedPluginPackDigest: 'a'.repeat(64),
          prompt: 'do the thing',
        },
      },
      'downstream',
    )

  it('records sent frames and auto-acks new commands', async () => {
    const gateway = new FakeDeviceGateway()
    const frame = runStartFrame(
      '00000000-0000-4000-8000-00000000c0d1',
      '00000000-0000-4000-8000-00000000beef',
    )
    await gateway.send(deviceId, frame)
    expect(gateway.sent).toHaveLength(1)
    expect(gateway.runtimeStartCount).toBe(1)
    const upstream = gateway.drainUpstream()
    expect(upstream).toHaveLength(1)
    const ack = parseNodeFrame(upstream[0], 'upstream')
    expect(ack.type).toBe('command.ack')
    expect(ack.payload).toMatchObject({
      commandId: '00000000-0000-4000-8000-00000000c0d1',
      accepted: true,
    })
  })

  it('dedupes a re-sent commandId: same ack, no second runtime (R7)', async () => {
    const gateway = new FakeDeviceGateway()
    const frame = runStartFrame(
      '00000000-0000-4000-8000-00000000c0d2',
      '00000000-0000-4000-8000-00000000beef',
    )
    await gateway.send(deviceId, frame)
    gateway.drainUpstream() // 丢弃首个 ack，模拟 ack 丢失
    await gateway.send(deviceId, frame)
    expect(gateway.runtimeStartCount).toBe(1)
    const upstream = gateway.drainUpstream()
    expect(upstream).toHaveLength(1)
    const ack = parseNodeFrame(upstream[0], 'upstream')
    expect(ack.type).toBe('command.ack')
    expect(ack.payload).toMatchObject({
      commandId: '00000000-0000-4000-8000-00000000c0d2',
      accepted: true,
    })
  })

  it('withholds acks when autoAck is off (lost-ack injection)', async () => {
    const gateway = new FakeDeviceGateway({ autoAck: false })
    await gateway.send(
      deviceId,
      runStartFrame('00000000-0000-4000-8000-00000000c0d3', '00000000-0000-4000-8000-00000000beef'),
    )
    expect(gateway.drainUpstream()).toEqual([])
  })

  it('rejects sends while offline', async () => {
    const gateway = new FakeDeviceGateway({ online: false })
    await expect(
      gateway.send(
        deviceId,
        runStartFrame(
          '00000000-0000-4000-8000-00000000c0d4',
          '00000000-0000-4000-8000-00000000beef',
        ),
      ),
    ).rejects.toBeInstanceOf(FakeDeviceOfflineError)
    expect(gateway.sent).toHaveLength(0)
  })
})

describe('refuseCommand：复刻 Node 的受理守卫（#189/#192）', () => {
  const followupFrame = (commandId: string) => ({
    protocolVersion: 1 as const,
    messageId: '00000000-0000-4000-8000-0000000000aa',
    sentAt: '2026-08-25T00:00:00.000Z',
    type: 'run.followup' as const,
    payload: { commandId, runId: '00000000-0000-4000-8000-0000000000bb', text: 'hi' },
  })

  it('守卫拒收时回 accepted=false + 错误码，且不产生任何副作用', async () => {
    const gateway = new FakeDeviceGateway({
      refuseCommand: () => ({
        code: 'INVALID_RUN_TRANSITION',
        message: 'run is queued; runtime.ready has not arrived',
      }),
    })
    await gateway.send('device-1', followupFrame('c1'))
    const [ack] = gateway.drainUpstream()
    expect(ack?.type).toBe('command.ack')
    if (ack?.type !== 'command.ack') throw new Error('unreachable')
    expect(ack.payload).toEqual({
      commandId: 'c1',
      accepted: false,
      error: {
        code: 'INVALID_RUN_TRANSITION',
        message: 'run is queued; runtime.ready has not arrived',
      },
    })
  })

  it('拒收不记「启动过一次 Runtime」（run.start 被拒时 startedRunIds 不增长）', async () => {
    const gateway = new FakeDeviceGateway({
      refuseCommand: () => ({ code: 'INVALID_RUN_TRANSITION', message: 'not ready' }),
    })
    await gateway.send('device-1', {
      protocolVersion: 1,
      messageId: '00000000-0000-4000-8000-0000000000cc',
      sentAt: '2026-08-25T00:00:00.000Z',
      type: 'run.start',
      payload: {
        commandId: 'c-start',
        runId: '00000000-0000-4000-8000-0000000000bb',
        taskId: '00000000-0000-4000-8000-0000000000dd',
        ownerUserId: '00000000-0000-4000-8000-0000000000ff',
        agent: {
          id: '00000000-0000-4000-8000-0000000000ee',
          profileRevisionId: '00000000-0000-4000-8000-0000000000e1',
          persona: 'You are a helpful agent.',
          provider: 'deepseek',
          model: 'deepseek-chat',
          credentialSlot: 'default',
        },
        workspaceId: '00000000-0000-4000-8000-0000000000c0',
        expectedProfileDigest: 'b'.repeat(64),
        expectedPluginPackDigest: 'a'.repeat(64),
        prompt: 'do it',
      },
    })
    expect(gateway.startedRunIds).toEqual([])
  })

  it('同一 commandId 重发：重放同一份拒收 ack（幂等，不二次判定）', async () => {
    let calls = 0
    const gateway = new FakeDeviceGateway({
      refuseCommand: () => {
        calls += 1
        return { code: 'INVALID_RUN_TRANSITION', message: 'not ready' }
      },
    })
    await gateway.send('device-1', followupFrame('c1'))
    await gateway.send('device-1', followupFrame('c1'))
    expect(calls).toBe(1)
    const acks = gateway.drainUpstream()
    expect(acks).toHaveLength(2)
    // 比 payload：两份 ack 的 messageId 各自不同（上行帧的序号），语义部分必须一致。
    expect(acks.map((ack) => (ack.type === 'command.ack' ? ack.payload : null))).toEqual([
      {
        commandId: 'c1',
        accepted: false,
        error: { code: 'INVALID_RUN_TRANSITION', message: 'not ready' },
      },
      {
        commandId: 'c1',
        accepted: false,
        error: { code: 'INVALID_RUN_TRANSITION', message: 'not ready' },
      },
    ])
  })

  it('不传守卫时保持旧行为：accepted=true、无 error 字段', async () => {
    const gateway = new FakeDeviceGateway()
    await gateway.send('device-1', followupFrame('c2'))
    const [ack] = gateway.drainUpstream()
    if (ack?.type !== 'command.ack') throw new Error('unreachable')
    expect(ack.payload).toEqual({ commandId: 'c2', accepted: true })
  })
})
