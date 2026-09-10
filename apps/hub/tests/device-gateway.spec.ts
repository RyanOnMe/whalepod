import { describe, expect, it } from 'vitest'
import type { NodeDownstream } from '@whalepod/protocol'
import {
  NodeConnectionRegistry,
  NodeOfflineError,
} from '../src/modules/device/connection-registry.js'
import { WsDeviceGateway } from '../src/modules/device/gateway.js'

// P1-09：下行网关经注册表投递；在线投合法 JSON 帧，离线抛瞬时错误（worker 留队重投）。
function fakeOpenSocket() {
  const sent: string[] = []
  return {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => {
      sent.push(data)
    },
    close: () => {},
    once: () => {},
    on: () => {},
    sent,
  }
}

describe('WsDeviceGateway (P1-09 步骤 3)', () => {
  const frame = {
    protocolVersion: 1,
    messageId: '00000000-0000-4000-8000-000000000001',
    sentAt: '2026-08-26T00:00:00.000Z',
    type: 'run.start',
    payload: { runId: 'r-1', taskId: 't-1' },
  } as unknown as NodeDownstream

  it('在线：投递合法 JSON 帧并返回 sentAt', async () => {
    const registry = new NodeConnectionRegistry()
    const socket = fakeOpenSocket()
    registry.attach({ deviceId: 'd1', ownerUserId: 'u1', socket: socket as never })
    const gateway = new WsDeviceGateway(registry)

    const ack = await gateway.send('d1', frame)
    expect(ack.sentAt).toBeInstanceOf(Date)
    expect(socket.sent).toHaveLength(1)
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({
      type: 'run.start',
      payload: { runId: 'r-1' },
    })
  })

  it('离线：send 抛 NodeOfflineError（OutboxWorker 视为瞬时，不置 failed_at）', async () => {
    const gateway = new WsDeviceGateway(new NodeConnectionRegistry())
    await expect(gateway.send('no-such-device', frame)).rejects.toBeInstanceOf(NodeOfflineError)
  })

  it('替换：新连接 4008 踢旧连接，后续投递走新 socket', async () => {
    const registry = new NodeConnectionRegistry()
    const first = fakeOpenSocket()
    const second = fakeOpenSocket()
    registry.attach({ deviceId: 'd1', ownerUserId: 'u1', socket: first as never })
    registry.attach({ deviceId: 'd1', ownerUserId: 'u1', socket: second as never })
    // 旧 socket 应被 close（这里断言不会在 send 上被投到）。
    await new WsDeviceGateway(registry).send('d1', frame)
    expect(second.sent).toHaveLength(1)
    expect(first.sent).toHaveLength(0)
  })
})
