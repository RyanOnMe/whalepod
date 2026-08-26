import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { claimDevice } from '../src/pairing/client.js'

// P1-09：配对 claim 客户端——POST pairing-claims（匿名 + Idempotency-Key，无 Origin/Cookie）。
describe('pairing client (claimDevice)', () => {
  it('向正确端点 POST 配对码与设备初始信息，并带幂等键', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(
        JSON.stringify({
          ok: true,
          data: { deviceId: 'dev-1', deviceToken: 'tok'.repeat(15).slice(0, 43) },
        }),
        { status: 201 },
      )
    })
    const result = await claimDevice(
      'http://hub',
      'PAIR-CODE',
      {
        name: 'node-a',
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: '24.12.0',
        nodeAppVersion: '0.1.0',
      },
      { fetch: fetchStub as unknown as typeof fetch, idempotencyKey: randomUUID() },
    )
    expect(result).toEqual({ deviceId: 'dev-1', deviceToken: expect.any(String) })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://hub/api/v1/devices/pairing-claims')
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body).toMatchObject({ code: 'PAIR-CODE', name: 'node-a', platform: 'darwin' })
    // 幂等键头：Node 路由豁免 Origin，但 Idempotency-Key 仍强制。
    expect(calls[0]?.init.headers).toMatchObject({ 'content-type': 'application/json' })
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['idempotency-key']).toMatch(/^.{16,128}$/)
    // 不携带 Browser Origin / Cookie。
    expect(headers['origin']).toBeUndefined()
    expect(headers['cookie']).toBeUndefined()
  })

  it('Hub 拒绝（409）时抛出含错误码的错误，不返回 Token', async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: 'CONFLICT', message: 'code used', requestId: 'r' },
          }),
          { status: 409 },
        ),
    )
    await expect(
      claimDevice(
        'http://hub',
        'STALE',
        {
          name: 'node-a',
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: '24.12.0',
          nodeAppVersion: '0.1.0',
        },
        { fetch: fetchStub as unknown as typeof fetch, idempotencyKey: randomUUID() },
      ),
    ).rejects.toThrow(/CONFLICT/)
  })
})
