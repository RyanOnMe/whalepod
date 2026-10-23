/**
 * Artifact HTTP 面（P1-15；03 §4 权限表）：
 *   POST /node/runs/:runId/artifacts          Device Token（该 Run 的设备）上传候选
 *   POST /artifacts/:artifactId/publish       Run owner 发布候选
 *   GET  /artifacts/:artifactId/content       owner 或 published 后的项目成员下载
 *   PUT  /node/artifacts/:artifactId/preview  Device Token：上传 Office 派生 PDF
 *   POST /node/artifacts/:artifactId/preview-failure  Device Token：登记转换失败
 *   GET  /artifacts/:artifactId/preview-info  可读原件者：预览状态（不给新权限）
 *   GET  /artifacts/:artifactId/preview       owner 或 published 后的项目成员读 PDF
 *   GET  /node/runs/:runId/input-manifest     Device Token：Reviewer 只读输入清单
 *   GET  /node/artifacts/:artifactId/content  Device Token：受控下载（已发布）
 *
 * 安全形态：
 * - octet-stream 解析器与本组错误处理封装在子作用域（body 上限 50 MiB，超限
 *   映射 ARTIFACT_TOO_LARGE）；其他 /api/v1 路由不受影响。
 * - hash 权威在 Hub 复核：实收字节 sha256 ≠ 声明 → ARTIFACT_HASH_MISMATCH，
 *   临时文件由 store 删除、无 candidate 行（G6-03）。
 * - 候选可见性折叠：candidate 下载/Node 下载对他者与「不存在」同作 404（§6.1
 *   不可枚举）；发布是他者可见的唯一入口（G6-04）。
 * - 上传幂等：Idempotency-Key → command_receipt，重试返回同一 artifact。
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authorize, asUserId } from '@whalepod/domain'
import {
  getArtifact,
  getRun,
  insertArtifact,
  deviceHandoffInputReferences,
  deviceHasRunOnTask,
  transactCommand,
} from '@whalepod/db'
import type { Database } from '@whalepod/db'
import { ArtifactUploadMetadataSchema } from '@whalepod/protocol'
import type { ArtifactUploadMetadata } from '@whalepod/protocol'
import {
  ArtifactPreviewFailureRequestSchema,
  ArtifactPreviewUploadMetadataSchema,
} from '@whalepod/protocol'
import { authenticateDevice } from '../plugin/pack-resolver.js'
import type { RequireActor } from '../auth/session.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { publishArtifact, requireArtifactRow } from './commands.js'
import {
  getArtifactPreviewInfo,
  readArtifactPreview,
  recordArtifactPreview,
  recordArtifactPreviewFailure,
} from './preview.js'
import { savedRunInputs } from '../run/input-manifest.js'
import { savedHandoffInput } from '../run/handoff-input.js'
import { toArtifactView } from './queries.js'
import { ArtifactStore, ARTIFACT_MAX_BYTES } from './store.js'

export interface ArtifactRoutesDeps {
  readonly database: Database
  readonly store: ArtifactStore
  readonly requireActor: RequireActor
}

/** query 串元数据 → 协议 DTO（byteSize 必须可解析为整数，其余原样校验）。 */
function metadataFromQuery(query: Record<string, unknown>): ArtifactUploadMetadata {
  return ArtifactUploadMetadataSchema.parse({
    title: query.title,
    mediaType: query.mediaType,
    byteSize: Number(query.byteSize),
    sha256: query.sha256,
    sourceRelativePath: query.sourceRelativePath,
  })
}

/** 统一下载应答：digest 已由 store 复核；文件名固定用 artifact id（不可注入）。 */
function sendArtifactBytes(
  reply: FastifyReply,
  bytes: Uint8Array,
  mediaType: string,
  artifactId: string,
): FastifyReply {
  return reply
    .code(200)
    .header('content-type', mediaType)
    .header('content-length', String(bytes.byteLength))
    .header('content-disposition', `attachment; filename="artifact-${artifactId}"`)
    .send(bytes)
}

/** 预览是内联阅读副本：不允许被当作 HTML/脚本嗅探，也不进共享缓存。 */
function sendPreviewBytes(
  reply: FastifyReply,
  bytes: Uint8Array,
  artifactId: string,
): FastifyReply {
  return reply
    .code(200)
    .header('content-type', 'application/pdf')
    .header('content-length', String(bytes.byteLength))
    .header('content-disposition', `inline; filename="artifact-${artifactId}.pdf"`)
    .header('cache-control', 'private, no-store')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', 'sandbox')
    .send(bytes)
}

/** PUT /node/artifacts/:artifactId/preview 的 query → 协议 DTO。 */
function previewMetadataFromQuery(
  query: Record<string, unknown>,
): ReturnType<typeof ArtifactPreviewUploadMetadataSchema.parse> {
  return ArtifactPreviewUploadMetadataSchema.parse({
    sourceSha256: query.sourceSha256,
    sha256: query.sha256,
    byteSize: Number(query.byteSize),
    converter: query.converter,
  })
}

export function registerArtifactRoutes(app: FastifyInstance, deps: ArtifactRoutesDeps): void {
  app.register(async (artifact: FastifyInstance) => {
    // 本组路由的 octet-stream body（封装在子作用域：/api/v1 其余路由不受影响）。
    artifact.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body)
      },
    )
    artifact.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
      const code = (error as { code?: unknown }).code
      if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return reply.code(413).send({
          ok: false,
          error: {
            code: 'ARTIFACT_TOO_LARGE',
            message: 'artifact content exceeds the size limit',
            requestId: String(request.id),
          },
        })
      }
      // 其余交回上层（app.ts 统一 envelope）。
      throw error
    })

    // POST /node/runs/:runId/artifacts：Node 上传候选（Device Token；该 Run 的
    // 设备才能上传，越权与未知 run 同作 404）。
    artifact.post(
      '/node/runs/:runId/artifacts',
      { bodyLimit: ARTIFACT_MAX_BYTES },
      async (request, reply) => {
        const identity = await authenticateDevice(deps.database, request)
        const { runId } = request.params as { runId: string }
        const run = await getRun(deps.database.db, runId)
        if (run === undefined || run.deviceId !== identity.deviceId) {
          throw new ApiError(404, 'NOT_FOUND', 'run not found')
        }
        const meta = metadataFromQuery(request.query as Record<string, unknown>)
        const body = request.body
        if (!Buffer.isBuffer(body)) {
          throw new ApiError(400, 'VALIDATION_FAILED', 'artifact body must be raw bytes')
        }
        // hash/size 权威复核 + 内容寻址落位（失败即无副作用：临时文件清理）。
        const blob = await deps.store.saveUpload(meta.sha256, body)
        // 幂等落行：同 key 重试返回首次结果（不产生第二行）。
        const view = await transactCommand(
          deps.database,
          `artifact.upload:${readIdempotencyKey(request)}`,
          async (tx) => {
            const row = await insertArtifact(tx, {
              id: randomUUID(),
              taskId: run.taskId,
              runId: run.id,
              ownerUserId: run.ownerUserId,
              title: meta.title,
              mediaType: meta.mediaType,
              byteSize: blob.byteSize,
              sha256: blob.sha256,
              storageKey: blob.storageKey,
              sourceRelativePath: meta.sourceRelativePath,
            })
            return toArtifactView(row)
          },
        )
        request.log.info(
          {
            component: 'artifact.store',
            msg: 'artifact candidate uploaded',
            runId: run.id,
            artifactId: view.id,
          },
          'artifact candidate uploaded',
        )
        return reply.code(201).send({ ok: true, data: view })
      },
    )

    // PUT /node/artifacts/:artifactId/preview：产出原件的设备上传派生 PDF。
    // body 与原件上传同用 octet-stream；hash/size 由 store 复核（声明不符即 400）。
    artifact.put(
      '/node/artifacts/:artifactId/preview',
      { bodyLimit: ARTIFACT_MAX_BYTES },
      async (request, reply) => {
        const identity = await authenticateDevice(deps.database, request)
        const { artifactId } = request.params as { artifactId: string }
        const metadata = previewMetadataFromQuery(request.query as Record<string, unknown>)
        const body = request.body
        if (!Buffer.isBuffer(body)) {
          throw new ApiError(400, 'VALIDATION_FAILED', 'preview body must be raw bytes')
        }
        const view = await recordArtifactPreview(
          deps.database,
          deps.store,
          { deviceId: identity.deviceId, artifactId },
          metadata,
          body,
        )
        request.log.info(
          {
            component: 'artifact.preview',
            msg: 'artifact preview uploaded',
            artifactId: view.artifactId,
            status: view.status,
          },
          'artifact preview uploaded',
        )
        return reply.code(200).send({ ok: true, data: view })
      },
    )

    // POST /node/artifacts/:artifactId/preview-failure：转换失败也登记，读面才能
    // 区分「没有预览」与「转换失败」；不改变 Artifact 状态。
    artifact.post('/node/artifacts/:artifactId/preview-failure', async (request, reply) => {
      const identity = await authenticateDevice(deps.database, request)
      const { artifactId } = request.params as { artifactId: string }
      const body = ArtifactPreviewFailureRequestSchema.parse(request.body)
      const view = await recordArtifactPreviewFailure(
        deps.database,
        { deviceId: identity.deviceId, artifactId },
        body,
      )
      return reply.code(200).send({ ok: true, data: view })
    })

    // GET /artifacts/:artifactId/preview-info：可读原件者即可读状态，不授予新权限；
    // 候选对非拥有者与不存在同作 404。
    artifact.get('/artifacts/:artifactId/preview-info', async (request, reply) => {
      const session = await deps.requireActor(request)
      const { artifactId } = request.params as { artifactId: string }
      const view = await getArtifactPreviewInfo(
        deps.database.db,
        { userId: asUserId(session.userId), role: session.role },
        artifactId,
      )
      return reply.header('cache-control', 'no-store').send({ ok: true, data: view })
    })

    // GET /artifacts/:artifactId/preview：只读 PDF 阅读副本，权限继承原件。
    artifact.get('/artifacts/:artifactId/preview', async (request, reply) => {
      const session = await deps.requireActor(request)
      const { artifactId } = request.params as { artifactId: string }
      const preview = await readArtifactPreview(
        deps.database.db,
        deps.store,
        { userId: asUserId(session.userId), role: session.role },
        artifactId,
      )
      return sendPreviewBytes(reply, preview.bytes, artifactId)
    })

    // Run创建时固化的输入清单。旧NULL不以当前发布列表回填，避免伪造历史。
    artifact.get('/node/runs/:runId/input-manifest', async (request) => {
      const identity = await authenticateDevice(deps.database, request)
      const { runId } = request.params as { runId: string }
      const run = await getRun(deps.database.db, runId)
      if (run === undefined || run.deviceId !== identity.deviceId) {
        throw new ApiError(404, 'NOT_FOUND', 'run not found')
      }
      const manifest = savedRunInputs(run)
      if (manifest === null)
        throw new ApiError(
          409,
          'CONFLICT',
          '该旧执行的历史输入无法确认，请开始新执行或显式选择材料后重跑',
        )
      return { ok: true, data: manifest }
    })

    // Team members can inspect only the immutable, published-material metadata.
    artifact.get('/runs/:runId/input-manifest', async (request, reply) => {
      await deps.requireActor(request)
      const { runId } = request.params as { runId: string }
      const run = await getRun(deps.database.db, runId)
      if (run === undefined) throw new ApiError(404, 'NOT_FOUND', 'run not found')
      return reply.header('cache-control', 'no-store').send({ ok: true, data: savedRunInputs(run) })
    })

    // #380：该 Run 的跨 Task 交接输入快照（与同 Task 清单互不合并的独立读面）。
    // Node 侧拉它下载上游已发布材料；null = 本条 Run 不带交接输入（新列语义）。
    artifact.get('/node/runs/:runId/handoff-input', async (request) => {
      const identity = await authenticateDevice(deps.database, request)
      const { runId } = request.params as { runId: string }
      const run = await getRun(deps.database.db, runId)
      if (run === undefined || run.deviceId !== identity.deviceId) {
        throw new ApiError(404, 'NOT_FOUND', 'run not found')
      }
      return { ok: true, data: savedHandoffInput(run) }
    })

    artifact.get('/runs/:runId/handoff-input', async (request, reply) => {
      await deps.requireActor(request)
      const { runId } = request.params as { runId: string }
      const run = await getRun(deps.database.db, runId)
      if (run === undefined) throw new ApiError(404, 'NOT_FOUND', 'run not found')
      return reply
        .header('cache-control', 'no-store')
        .send({ ok: true, data: savedHandoffInput(run) })
    })

    // GET /node/artifacts/:artifactId/content：Node 受控下载已发布副本。
    // 授权判据（#380 最小扩展）：设备承载该 Artifact 所属 Task 的 Run（Reviewer
    // 场景），**或**该设备自己的 Run 的交接输入快照引用了它（下游消费上游材料）。
    // 两条都不满足 → 404（含上游其他材料、候选与私有现场）。
    artifact.get('/node/artifacts/:artifactId/content', async (request, reply) => {
      const identity = await authenticateDevice(deps.database, request)
      const { artifactId } = request.params as { artifactId: string }
      const row = await getArtifact(deps.database.db, artifactId)
      if (row === undefined || row.status !== 'published') {
        throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
      }
      const authorized =
        (await deviceHasRunOnTask(deps.database.db, identity.deviceId, row.taskId)) ||
        (await deviceHandoffInputReferences(deps.database.db, identity.deviceId, row.id))
      if (!authorized) {
        throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
      }
      const bytes = await deps.store.readVerified(row.storageKey, row.sha256)
      return sendArtifactBytes(reply, bytes, row.mediaType, row.id)
    })

    // POST /artifacts/:artifactId/publish：Run owner 发布候选（G6-05）。
    artifact.post('/artifacts/:artifactId/publish', async (request, reply) => {
      const session = await deps.requireActor(request)
      const { artifactId } = request.params as { artifactId: string }
      const row = await publishArtifact(deps.database, {
        artifactId,
        actorUserId: session.userId,
        actorRole: session.role,
      })
      audit(request, 'artifact.publish', 'success', session.userId)
      return reply.code(200).send({ ok: true, data: toArtifactView(row) })
    })

    // GET /artifacts/:artifactId/content：下载内容。owner 始终可见（含
    // candidate）；其他成员仅 published 后可见；不可见与不存在同作 404（G6-01）。
    artifact.get('/artifacts/:artifactId/content', async (request, reply) => {
      const session = await deps.requireActor(request)
      const { artifactId } = request.params as { artifactId: string }
      const row = await requireArtifactRow(deps.database, artifactId)
      const allowed = authorize(
        { userId: asUserId(session.userId), role: session.role },
        'read_artifact_content',
        { ownerUserId: asUserId(row.ownerUserId), artifactStatus: row.status },
      )
      if (!allowed) throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
      const bytes = await deps.store.readVerified(row.storageKey, row.sha256)
      return sendArtifactBytes(reply, bytes, row.mediaType, row.id)
    })
  })
}
