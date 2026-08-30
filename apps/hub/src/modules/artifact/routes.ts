/**
 * Artifact HTTP 面（P1-15；03 §4 权限表）：
 *   POST /node/runs/:runId/artifacts          Device Token（该 Run 的设备）上传候选
 *   POST /artifacts/:artifactId/publish       Run owner 发布候选
 *   GET  /artifacts/:artifactId/content       owner 或 published 后的项目成员下载
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
import { eq } from 'drizzle-orm'
import { authorize, asUserId } from '@project311/domain'
import {
  getArtifact,
  getRun,
  insertArtifact,
  deviceHasRunOnTask,
  listPublishedArtifactsByTask,
  transactCommand,
} from '@project311/db'
import type { Database } from '@project311/db'
import { ArtifactUploadMetadataSchema } from '@project311/protocol'
import type { ArtifactUploadMetadata } from '@project311/protocol'
import { authenticateDevice } from '../plugin/pack-resolver.js'
import type { RequireActor } from '../auth/session.js'
import { readIdempotencyKey } from '../auth/idempotency.js'
import { audit } from '../shared/audit.js'
import { ApiError } from '../shared/http-error.js'
import { publishArtifact, requireArtifactRow } from './commands.js'
import { toArtifactView, toManifestEntry } from './queries.js'
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

    // GET /node/runs/:runId/input-manifest：Reviewer Run 的只读输入清单
    // （只含已发布；无 storageKey/sourceRelativePath——G6-07 无路径泄露）。
    artifact.get('/node/runs/:runId/input-manifest', async (request) => {
      const identity = await authenticateDevice(deps.database, request)
      const { runId } = request.params as { runId: string }
      const run = await getRun(deps.database.db, runId)
      if (run === undefined || run.deviceId !== identity.deviceId) {
        throw new ApiError(404, 'NOT_FOUND', 'run not found')
      }
      const rows = await listPublishedArtifactsByTask(deps.database.db, run.taskId)
      return {
        ok: true,
        data: { taskId: run.taskId, artifacts: rows.map(toManifestEntry) },
      }
    })

    // GET /node/artifacts/:artifactId/content：Node 受控下载已发布副本
    // （授权判据：设备承载该 Artifact 所属 Task 的 Run——Reviewer 场景最小面）。
    artifact.get('/node/artifacts/:artifactId/content', async (request, reply) => {
      const identity = await authenticateDevice(deps.database, request)
      const { artifactId } = request.params as { artifactId: string }
      const row = await getArtifact(deps.database.db, artifactId)
      if (row === undefined || row.status !== 'published') {
        throw new ApiError(404, 'NOT_FOUND', 'artifact not found')
      }
      if (!(await deviceHasRunOnTask(deps.database.db, identity.deviceId, row.taskId))) {
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
