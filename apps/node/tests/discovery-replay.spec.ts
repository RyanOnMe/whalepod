import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { discoveryReplayEndpoint, startDiscoveryReplayGate } from '../src/work/discovery-replay.js'

describe('discovery replay gate', () => {
  it('revalidates each stage and never sends the local token or follows redirects', async () => {
    let authorized = true
    let redirect = false
    const observed = vi.fn()
    const upstreamCalls: { path: string | undefined; authorization: string | undefined }[] = []
    const upstream = createServer((req, res) => {
      upstreamCalls.push({ path: req.url, authorization: req.headers.authorization })
      req.resume()
      if (redirect) res.writeHead(302, { location: '/redirected' }).end()
      else res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject)
      upstream.listen(0, '127.0.0.1', () => {
        upstream.removeListener('error', reject)
        resolve()
      })
    })
    const address = upstream.address()
    if (address === null || typeof address === 'string') throw new Error('missing local server')
    const gate = await startDiscoveryReplayGate({
      endpoint: `http://127.0.0.1:${address.port}/chat/completions`,
      model: 'synthetic-model',
      authorize: async () => authorized,
      observe: observed,
    })
    try {
      const headers = { authorization: `Bearer ${gate.token}` }
      const modelCall = (model = 'synthetic-model') =>
        fetch(`${gate.origin}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, messages: [] }),
        })
      expect((await fetch(`${gate.origin}/authorize/read`)).status).toBe(404)
      expect((await fetch(`${gate.origin}/authorize/read`, { headers })).status).toBe(204)
      expect((await modelCall('wrong-model')).status).toBe(403)
      expect(await (await modelCall()).text()).toBe('data: [DONE]\n\n')
      expect(upstreamCalls).toEqual([{ path: '/chat/completions', authorization: undefined }])
      authorized = false
      expect((await fetch(`${gate.origin}/authorize/read`, { headers })).status).toBe(403)
      expect((await fetch(`${gate.origin}/authorize/tool`, { headers })).status).toBe(403)
      expect(await gate.authorizeCandidate()).toBe(false)
      expect((await modelCall()).status).toBe(403)
      expect(upstreamCalls).toHaveLength(1)
      expect(observed.mock.calls).toEqual([
        ['read', true],
        ['model', true],
        ['read', false],
        ['tool', false],
        ['candidate', false],
        ['model', false],
      ])
      authorized = true
      redirect = true
      expect((await modelCall()).status).toBe(503)
      expect(upstreamCalls.map(({ path }) => path)).toEqual([
        '/chat/completions',
        '/chat/completions',
      ])
    } finally {
      gate.close()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it('admits only explicit IPv4 loopback, the fixed route, and no credentials', () => {
    for (const endpoint of [
      'https://127.0.0.1:12345/chat/completions',
      'http://localhost:12345/chat/completions',
      'http://127.0.0.1/chat/completions',
      'http://account@127.0.0.1:12345/chat/completions',
      'http://127.0.0.1:12345/chat/completions?other=1',
      'http://127.0.0.1:12345/v1/chat/completions',
    ])
      expect(() => discoveryReplayEndpoint(endpoint)).toThrow()
  })
})
