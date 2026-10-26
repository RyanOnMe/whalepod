/**
 * 预览上传客户端（#431）wire 判据：路径/方法/头/重试与失败上报形状。
 * Hub 对所有写请求强制 Idempotency-Key，重试必须复用同一个键。
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  reportArtifactPreviewFailure,
  uploadArtifactPreview,
} from '../src/artifact/preview-upload-client.js'

const PDF = Buffer.from('%PDF-1.7\nclient test\n')
const SOURCE_SHA = 'a'.repeat(64)
const PDF_SHA = createHash('sha256').update(PDF).digest('hex')

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('#431 preview upload client', () => {
  it('PUT 路径/元数据/幂等键正确，成功返回', async () => {
    const calls: Captured[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: init?.headers as Record<string, string>,
        body: Buffer.from(init?.body as Uint8Array).toString('utf8'),
      })
      return new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch
    await uploadArtifactPreview(
      'http://hub:4000/',
      'device-token',
      'artifact-1',
      {
        sourceSha256: SOURCE_SHA,
        sha256: PDF_SHA,
        byteSize: PDF.byteLength,
        converter: 'libreoffice',
      },
      PDF,
      { fetchImpl },
    )
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.method).toBe('PUT')
    expect(call.url).toContain('/api/v1/node/artifacts/artifact-1/preview?')
    expect(call.url).toContain(`sourceSha256=${SOURCE_SHA}`)
    expect(call.url).toContain(`sha256=${PDF_SHA}`)
    expect(call.url).toContain(`byteSize=${PDF.byteLength}`)
    expect(call.url).toContain('converter=libreoffice')
    expect(call.headers.authorization).toBe('Device device-token')
    expect(call.headers['content-type']).toBe('application/octet-stream')
    expect(call.headers['idempotency-key']?.length).toBeGreaterThanOrEqual(16)
    expect(call.body).toBe(PDF.toString('utf8'))
  })

  it('5xx 有界重试且复用同一幂等键；4xx 不重试', async () => {
    const keys: string[] = []
    let attempt = 0
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      keys.push(headers['idempotency-key'] ?? '')
      attempt += 1
      return attempt === 1
        ? jsonResponse(503, { error: { code: 'INTERNAL_ERROR' } })
        : new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch
    await uploadArtifactPreview(
      'http://hub',
      't',
      'artifact-1',
      { sourceSha256: SOURCE_SHA, sha256: PDF_SHA, byteSize: PDF.byteLength, converter: 'x' },
      PDF,
      { fetchImpl },
    )
    expect(attempt).toBe(2)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])

    let rejectedAttempts = 0
    const rejected = (async () => {
      rejectedAttempts += 1
      return jsonResponse(409, { error: { code: 'CONFLICT' } })
    }) as unknown as typeof fetch
    await expect(
      uploadArtifactPreview(
        'http://hub',
        't',
        'artifact-1',
        { sourceSha256: SOURCE_SHA, sha256: PDF_SHA, byteSize: PDF.byteLength, converter: 'x' },
        PDF,
        { fetchImpl: rejected },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(rejectedAttempts).toBe(1)
  })

  it('失败上报 POST JSON（source 摘要/转换器/原因）', async () => {
    let captured: Captured | undefined
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = {
        url: String(url),
        method: init?.method ?? 'GET',
        headers: init?.headers as Record<string, string>,
        body: String(init?.body),
      }
      return new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch
    await reportArtifactPreviewFailure(
      'http://hub',
      't',
      'artifact-1',
      { sourceSha256: SOURCE_SHA, converter: 'libreoffice', reason: 'CONVERT_TIMEOUT' },
      { fetchImpl },
    )
    expect(captured?.method).toBe('POST')
    expect(captured?.url).toContain('/api/v1/node/artifacts/artifact-1/preview-failure')
    expect(captured?.headers['content-type']).toBe('application/json')
    expect(captured?.headers['idempotency-key']?.length).toBeGreaterThanOrEqual(16)
    expect(JSON.parse(captured?.body ?? '{}')).toEqual({
      sourceSha256: SOURCE_SHA,
      converter: 'libreoffice',
      reason: 'CONVERT_TIMEOUT',
    })
  })

  it('含控制字符的 reason 被 schema 拒绝（fail loud，不发请求）', async () => {
    let called = 0
    const fetchImpl = (async () => {
      called += 1
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch
    await expect(
      reportArtifactPreviewFailure(
        'http://hub',
        't',
        'artifact-1',
        { sourceSha256: SOURCE_SHA, converter: 'libreoffice', reason: 'bad\u0000reason' },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' })
    expect(called).toBe(0)
  })
})
