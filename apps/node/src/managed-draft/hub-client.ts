import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { MANAGED_DRAFT_MAX_CONTENT_BYTES } from '@whalepod/protocol'
import { z } from 'zod'

export interface ManagedDraftHubIdentity {
  readonly hubUrl: string
  readonly deviceToken: string
  readonly managedHostToken: string
}

const maxReplyBytes = 8 * MANAGED_DRAFT_MAX_CONTENT_BYTES
const unavailable = () => new Error('managed_draft_hub_unavailable')
const ModelReplySchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ attemptId: z.uuid(), text: z.string().min(1) }),
})

async function readReply(
  response: IncomingMessage,
  mediaType: string,
  cap: number,
): Promise<Buffer> {
  try {
    if (
      response.statusCode !== 200 ||
      response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== mediaType ||
      (response.headers['content-encoding'] !== undefined &&
        response.headers['content-encoding'] !== 'identity')
    )
      throw unavailable()
    const bytes = Buffer.alloc(cap)
    let size = 0
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        if (size + chunk.byteLength > cap) throw unavailable()
        chunk.copy(bytes, size)
        size += chunk.byteLength
      }
      return Buffer.from(bytes.subarray(0, size))
    } finally {
      bytes.fill(0)
    }
  } finally {
    response.destroy()
  }
}

function post(
  hub: ManagedDraftHubIdentity,
  runId: string,
  action: 'source' | 'model',
  idempotencyKey: string,
  payload: object,
  mediaType: string,
  cap: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = new URL(`/api/v1/node/managed-drafts/${runId}/${action}`, hub.hubUrl)
  const body = JSON.stringify(payload)
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    // A direct one-shot request, without inherited proxies, retries, or redirects.
    const req = request(
      url,
      {
        method: 'POST',
        agent: false,
        signal,
        ...(url.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
        headers: {
          authorization: `Device ${hub.deviceToken}`,
          'x-whalepod-managed-host': hub.managedHostToken,
          'idempotency-key': idempotencyKey,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'accept-encoding': 'identity',
          accept: mediaType,
        },
      },
      (response) => void readReply(response, mediaType, cap).then(resolve, reject),
    )
    req.once('error', reject)
    req.end(body)
  })
}

export function fetchManagedDraftSource(
  hub: ManagedDraftHubIdentity,
  runId: string,
  binding: { commandId: string; manifestDigest: string; requestId: string },
  byteSize: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return post(
    hub,
    runId,
    'source',
    binding.requestId,
    binding,
    'application/octet-stream',
    byteSize,
    signal,
  )
}

export async function callManagedDraftModel(
  hub: ManagedDraftHubIdentity,
  runId: string,
  binding: {
    commandId: string
    manifestDigest: string
    modelBindingDigest: string
    attemptId: string
    requestDigest: string
    byteSize: number
  },
  signal: AbortSignal,
): Promise<string> {
  const reply = await post(
    hub,
    runId,
    'model',
    binding.attemptId,
    binding,
    'application/json',
    maxReplyBytes,
    signal,
  )
  try {
    const { data } = ModelReplySchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply)),
    )
    if (
      data.attemptId !== binding.attemptId ||
      Buffer.byteLength(data.text) > MANAGED_DRAFT_MAX_CONTENT_BYTES
    )
      throw unavailable()
    return data.text
  } finally {
    reply.fill(0)
  }
}
