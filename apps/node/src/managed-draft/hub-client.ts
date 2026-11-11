import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  MANAGED_DRAFT_MAX_CONTENT_BYTES,
  ManagedDraftCandidateProofSchema,
  ManagedDraftCandidateUploadSchema,
  type ManagedDraftCandidateProof,
  type ManagedDraftCandidateUpload,
} from '@whalepod/protocol'
import { z } from 'zod'

export interface ManagedDraftHubIdentity {
  readonly hubUrl: string
  readonly deviceToken: string
  readonly managedHostToken: string
}

const maxReplyBytes = 8 * MANAGED_DRAFT_MAX_CONTENT_BYTES
const maxCandidateReplyBytes = 4096
const unavailable = () => new Error('managed_draft_hub_unavailable')
const CandidateReplySchema = z.strictObject({
  ok: z.literal(true),
  data: ManagedDraftCandidateProofSchema,
})
const ModelReplySchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ attemptId: z.uuid(), text: z.string().min(1) }),
})

async function readReply(
  response: IncomingMessage,
  status: 200 | 201,
  mediaType: string,
  cap: number,
): Promise<Buffer> {
  try {
    if (
      response.statusCode !== status ||
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

type PostRequest = {
  idempotencyKey: string
  replyType: string
  replyLimit: number
} & (
  | { action: 'source' | 'model'; body: string }
  | { action: 'candidate'; body: Buffer; proofHeader: string }
)

function post(
  hub: ManagedDraftHubIdentity,
  runId: string,
  requestBody: PostRequest,
  signal: AbortSignal,
): Promise<Buffer> {
  const { action, body, idempotencyKey, replyType, replyLimit } = requestBody
  const url = new URL(`/api/v1/node/managed-drafts/${runId}/${action}`, hub.hubUrl)
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
          'content-type': action === 'candidate' ? 'application/octet-stream' : 'application/json',
          ...(requestBody.action === 'candidate'
            ? { 'x-whalepod-managed-candidate': requestBody.proofHeader }
            : {}),
          'content-length': String(Buffer.byteLength(body)),
          'accept-encoding': 'identity',
          accept: replyType,
        },
      },
      (response) =>
        void readReply(response, action === 'candidate' ? 201 : 200, replyType, replyLimit).then(
          resolve,
          reject,
        ),
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
    {
      action: 'source',
      idempotencyKey: binding.requestId,
      body: JSON.stringify(binding),
      replyType: 'application/octet-stream',
      replyLimit: byteSize,
    },
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
    {
      action: 'model',
      idempotencyKey: binding.attemptId,
      body: JSON.stringify(binding),
      replyType: 'application/json',
      replyLimit: maxReplyBytes,
    },
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

export async function uploadManagedDraftCandidate(
  hub: ManagedDraftHubIdentity,
  runId: string,
  binding: ManagedDraftCandidateUpload,
  body: Buffer,
  signal: AbortSignal,
): Promise<Pick<ManagedDraftCandidateProof, 'artifactId' | 'verifiedUploadReceiptId'>> {
  const proof = ManagedDraftCandidateUploadSchema.parse(binding)
  const reply = await post(
    hub,
    runId,
    {
      action: 'candidate',
      idempotencyKey: proof.fileWriteReceiptId,
      body,
      replyType: 'application/json',
      replyLimit: maxCandidateReplyBytes,
      proofHeader: Buffer.from(JSON.stringify(proof)).toString('base64url'),
    },
    signal,
  )
  try {
    const { data } = CandidateReplySchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply)),
    )
    if (
      data.runId !== runId ||
      data.manifestDigest !== proof.manifestDigest ||
      data.sha256 !== proof.sha256 ||
      data.byteSize !== proof.byteSize ||
      data.fileWriteReceiptId !== proof.fileWriteReceiptId
    )
      throw unavailable()
    return { artifactId: data.artifactId, verifiedUploadReceiptId: data.verifiedUploadReceiptId }
  } finally {
    reply.fill(0)
  }
}
