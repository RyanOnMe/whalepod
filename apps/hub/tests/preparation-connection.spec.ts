import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import { NodeConnectionRegistry } from '../src/modules/device/connection-registry.js'
class Socket extends EventEmitter {
  OPEN = 1
  readyState = 1
  frames: Array<{ payload: { requestId: string } }> = []
  send(raw: string) {
    this.frames.push(JSON.parse(raw))
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
}
const input = {
  workspaceId: '00000000-0000-4000-8000-000000000011',
  provider: 'fixture',
  credentialSlot: 'default',
}
function attach(registry: NodeConnectionRegistry, id: string, socket: Socket) {
  registry.attach({ deviceId: id, ownerUserId: 'owner', socket: socket as unknown as WebSocket })
}
describe('准备结果绑定连接（#320）', () => {
  it('错设备/连接不能完成请求，同连接正确结果才完成', async () => {
    const registry = new NodeConnectionRegistry()
    const socket = new Socket()
    const other = new Socket()
    attach(registry, 'device', socket)
    attach(registry, 'other', other)
    const pending = registry.requestPreparation('device', input)
    const result = {
      requestId: socket.frames[0]!.payload.requestId,
      workspace: 'available' as const,
      credential: 'configured' as const,
    }
    expect(registry.deliverPreparation('other', other as unknown as WebSocket, result)).toBe(false)
    expect(registry.deliverPreparation('device', other as unknown as WebSocket, result)).toBe(false)
    expect(registry.deliverPreparation('device', socket as unknown as WebSocket, result)).toBe(true)
    expect(await pending).toEqual(result)
    expect(registry.deliverPreparation('device', socket as unknown as WebSocket, result)).toBe(
      false,
    )
  })
  it('连接替换拒绝旧等待者，迟到旧结果不能供新连接使用', async () => {
    const registry = new NodeConnectionRegistry()
    const socket = new Socket()
    attach(registry, 'device', socket)
    const pending = registry.requestPreparation('device', input)
    const rejected = expect(pending).rejects.toThrow('connection changed')
    const next = new Socket()
    attach(registry, 'device', next)
    await rejected
    expect(
      registry.deliverPreparation('device', socket as unknown as WebSocket, {
        requestId: socket.frames[0]!.payload.requestId,
        workspace: 'available',
        credential: 'configured',
      }),
    ).toBe(false)
  })
  it('没有响应超时失败，可重试且无旧回执', async () => {
    const registry = new NodeConnectionRegistry()
    const socket = new Socket()
    attach(registry, 'device', socket)
    await expect(registry.requestPreparation('device', input, 10)).rejects.toThrow('timed out')
    const pending = registry.requestPreparation('device', input)
    const response = {
      requestId: socket.frames.at(-1)!.payload.requestId,
      workspace: 'unavailable' as const,
      credential: 'unconfigured' as const,
    }
    registry.deliverPreparation('device', socket as unknown as WebSocket, response)
    expect(await pending).toEqual(response)
  })
})
