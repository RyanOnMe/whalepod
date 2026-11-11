import type { Database } from '@whalepod/db'
import {
  MANAGED_DRAFT_MAX_CONTENT_BYTES,
  ManagedDraftCandidateUploadSchema,
  ManagedDraftModelForwardRequestSchema,
  ManagedDraftSourceReadRequestSchema,
} from '@whalepod/protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ManagedDraftHost } from '../../config.js'
import { ApiError } from '../shared/http-error.js'
import type { ManagedDraftExecution } from './execution.js'
import { deviceForNodeRequest, matchesManagedDraftHost } from './host-auth.js'

const missing = () => new ApiError(404, 'NOT_FOUND', 'managed draft execution unavailable')

function decodeCandidateHeader(value: unknown): unknown {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(value)) return undefined
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) return undefined
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    return undefined
  }
}

export function registerManagedDraftExecutionRoutes(
  app: FastifyInstance,
  deps: {
    database: Database
    host: ManagedDraftHost
    requiresTls: boolean
    execution: ManagedDraftExecution
  },
): void {
  const base = '/node/managed-drafts/:runId'
  async function requireHost(request: FastifyRequest): Promise<void> {
    const device = await deviceForNodeRequest(deps.database, request)
    if (!matchesManagedDraftHost(request, deps.host, device, deps.requiresTls)) throw missing()
  }
  app.post<{ Params: { runId: string } }>(
    `${base}/source`,
    { bodyLimit: 2_048 },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store')
      await requireHost(request)
      const run = z.uuid().safeParse(request.params.runId)
      const body = ManagedDraftSourceReadRequestSchema.safeParse(request.body)
      if (!run.success || !body.success) throw missing()
      if (request.raw.aborted || reply.raw.destroyed) throw missing()
      const bytes = await deps.execution.source(run.data, body.data)
      if (bytes === undefined) throw missing()
      request.log.info(
        {
          component: 'hub.managed-draft',
          action: 'source.admitted',
          runId: run.data,
          requestId: body.data.requestId,
        },
        'managed source transfer admitted',
      )
      return reply.type('application/octet-stream').send(bytes)
    },
  )
  app.post<{ Params: { runId: string } }>(
    `${base}/model`,
    { bodyLimit: 2_048 },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store')
      const controller = new AbortController()
      const close = () => controller.abort()
      reply.raw.once('close', close)
      if (request.raw.aborted || reply.raw.destroyed || reply.raw.writableEnded) close()
      try {
        await requireHost(request)
        const run = z.uuid().safeParse(request.params.runId)
        const body = ManagedDraftModelForwardRequestSchema.safeParse(request.body)
        if (!run.success || !body.success || controller.signal.aborted) throw missing()
        const result = await deps.execution.model(run.data, body.data, controller.signal)
        if (result === undefined) throw missing()
        request.log.info(
          {
            component: 'hub.managed-draft',
            action: 'model.responded',
            runId: run.data,
            attemptId: body.data.attemptId,
          },
          'managed model response admitted',
        )
        return reply.send({ ok: true, data: result })
      } finally {
        reply.raw.off('close', close)
      }
    },
  )

  app.register(async (upload) => {
    upload.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    )
    upload.post<{ Params: { runId: string } }>(
      `${base}/candidate`,
      {
        bodyLimit: MANAGED_DRAFT_MAX_CONTENT_BYTES,
        onRequest: async (request, reply) => {
          reply.header('cache-control', 'private, no-store')
          await requireHost(request)
        },
      },
      async (request, reply) => {
        const controller = new AbortController()
        const close = () => controller.abort()
        reply.raw.once('close', close)
        if (request.raw.aborted || reply.raw.destroyed || reply.raw.writableEnded) close()
        try {
          const run = z.uuid().safeParse(request.params.runId)
          const proof = ManagedDraftCandidateUploadSchema.safeParse(
            decodeCandidateHeader(request.headers['x-whalepod-managed-candidate']),
          )
          if (
            !run.success ||
            !proof.success ||
            !Buffer.isBuffer(request.body) ||
            request.headers['idempotency-key'] !== proof.data.fileWriteReceiptId ||
            controller.signal.aborted
          )
            throw missing()
          const receipt = await deps.execution.candidate(
            run.data,
            proof.data,
            request.body,
            controller.signal,
          )
          if (receipt === undefined) throw missing()
          request.log.info(
            {
              component: 'hub.managed-draft',
              action: 'candidate.verified',
              runId: run.data,
              verifiedUploadReceiptId: receipt.verifiedUploadReceiptId,
            },
            'managed draft upload verified',
          )
          return reply.code(201).send({ ok: true, data: receipt })
        } finally {
          reply.raw.off('close', close)
        }
      },
    )
  })
}
