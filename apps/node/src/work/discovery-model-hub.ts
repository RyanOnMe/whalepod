import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { z } from 'zod'
import type {
  DiscoveryModelBegin,
  DiscoveryModelHubPort,
  DiscoveryModelSettle,
} from './discovery-live-model.js'

const denied = () => new Error('discovery model authority unavailable')
export class DiscoverySettlementUnacknowledged extends Error {
  constructor(readonly retryable: boolean) {
    super('discovery model settlement unacknowledged')
  }
}
const SettlementReply = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ allowContinue: z.boolean() }),
})

export function createDiscoveryModelHubPort(
  identity: { readonly hubUrl: string; readonly deviceToken: string },
  runId: string,
  onBeginRejected?: (status: number) => void,
): DiscoveryModelHubPort {
  const base = new URL(identity.hubUrl)
  if (
    (base.protocol !== 'https:' &&
      !(
        base.protocol === 'http:' &&
        (base.hostname === '127.0.0.1' || base.hostname === '[::1]')
      )) ||
    base.username ||
    base.password ||
    base.hash ||
    base.search
  )
    throw denied()

  function post(
    action: 'begin' | 'settle',
    input: DiscoveryModelBegin | DiscoveryModelSettle,
    signal: AbortSignal,
  ): Promise<boolean> {
    const endpoint = new URL(`/api/v1/node/runs/${runId}/discovery-model/${action}`, base)
    const body = Buffer.from(JSON.stringify(input))
    const send = endpoint.protocol === 'https:' ? httpsRequest : httpRequest
    return new Promise((resolve, reject) => {
      const request = send(
        endpoint,
        {
          method: 'POST',
          agent: false,
          ...(endpoint.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
          signal,
          headers: {
            authorization: `Device ${identity.deviceToken}`,
            'idempotency-key': input.attemptId,
            'content-type': 'application/json',
            'content-length': body.byteLength,
            accept: 'application/json',
          },
        },
        (response) => {
          if (action === 'begin' && response.statusCode !== 204)
            onBeginRejected?.(response.statusCode ?? 0)
          void read(response, action)
            .then(resolve, reject)
            .finally(() => response.destroy())
        },
      )
      request.once('error', reject)
      request.end(body)
    })
  }

  return {
    begin: (input, signal) => post('begin', input, signal),
    settle: (input, signal) => post('settle', input, signal),
  }
}

async function read(response: IncomingMessage, action: 'begin' | 'settle'): Promise<boolean> {
  if (action === 'begin') return response.statusCode === 204
  const status = response.statusCode ?? 0
  if (status !== 200) {
    throw new DiscoverySettlementUnacknowledged(
      status < 400 || status >= 500 || status === 408 || status === 425 || status === 429,
    )
  }
  if (
    response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !==
      'application/json' ||
    (response.headers['content-encoding'] !== undefined &&
      response.headers['content-encoding'] !== 'identity')
  )
    throw new DiscoverySettlementUnacknowledged(true)
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of response) {
    const bytes = Buffer.from(value)
    size += bytes.byteLength
    if (size > 4096) throw denied()
    chunks.push(bytes)
  }
  if (!response.complete) throw new DiscoverySettlementUnacknowledged(true)
  const raw: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
  )
  const result = SettlementReply.safeParse(raw)
  if (!result.success) throw new DiscoverySettlementUnacknowledged(true)
  // `false` is a durable receipt acknowledgement with continuation refused.
  return result.data.data.allowContinue
}
