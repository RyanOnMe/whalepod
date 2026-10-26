/**
 * Office 只读 PDF 预览（#431；ADR-0021 §2）Hub 集成判据。
 *
 * 驱动走真实 HTTP：Device Token 上传候选与派生 PDF、owner 发布、Session 读面。
 * 覆盖：
 *   - 预览与原件 sha256 绑定（sourceSha256 不符 409），hash 由 Hub 复核；
 *   - 权限继承原件：候选仅 owner，发布后团队成员可读；不可见与不存在同 404；
 *   - 只有产出原件的设备可写派生件；失败上报只登记，不改变原件状态；
 *   - ready 不降级、failed 可被重转换覆盖；published 时发 artifact.changed；
 *   - 无预览/失败读取明确返回 PREVIEW_UNAVAILABLE（下载回退）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Database } from '@whalepod/db'
import { schema } from '@whalepod/db'
import {
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  insertRunRow,
  resetDatabase,
  seedRunChainForUser,
  type Session,
  type TestApp,
} from './helpers.js'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const OFFICE_BYTES = Buffer.from('fake office document bytes\n')
const OFFICE_SHA = createHash('sha256').update(OFFICE_BYTES).digest('hex')
const PDF_BYTES = Buffer.from('%PDF-1.7\nwhalepod preview\n')
const PDF_SHA = createHash('sha256').update(PDF_BYTES).digest('hex')

describe('artifact preview (#431)', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let aliceToken: string
  let bobToken: string
  let bobDeviceId: string
  let taskId: string
  let runId: string
  const tmpDirs: string[] = []

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    tmpDirs.push(ctx.config.artifactStoreDir)
    await mkdir(ctx.config.artifactStoreDir, { recursive: true })
    alice = await driveSetup(ctx, 'alice')
    const invited = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    bob = invited.session
    const project = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { origin: ctx.origin, cookie: alice.cookie, 'idempotency-key': idemKey() },
      payload: { name: 'p431-project' },
    })
    const projectId = project.json().data.id as string
    const task = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      headers: { origin: ctx.origin, cookie: alice.cookie, 'idempotency-key': idemKey() },
      payload: { title: '交付 Office 文档', assigneeUserId: bob.userId },
    })
    taskId = task.json().data.id as string
    aliceToken = (await pairDevice(alice)).token
    const bobDevice = await pairDevice(bob)
    bobToken = bobDevice.token
    bobDeviceId = bobDevice.deviceId
    const chain = await seedRunChainForUser(database.db, bob.userId)
    runId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: bob.userId,
      agentId: chain.agentId,
      profileRevisionId: chain.profileRevisionId,
      deviceId: bobDeviceId,
      workspaceId: chain.workspaceId,
      status: 'running',
    })
  })

  afterEach(async () => {
    await ctx.app.close()
  })

  afterAll(async () => {
    await database.close()
    for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function pairDevice(as: Session): Promise<{ deviceId: string; token: string }> {
    const codeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      headers: { origin: ctx.origin, cookie: as.cookie, 'idempotency-key': idemKey() },
      payload: {},
    })
    expect(codeRes.statusCode).toBe(201)
    const code = codeRes.json().data.code as string
    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': idemKey() },
      payload: {
        code,
        name: `p431-${as.userId.slice(0, 8)}`,
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: '24.12.0',
        nodeAppVersion: '0.1.0',
      },
    })
    expect(claim.statusCode).toBe(201)
    const data = claim.json().data as { deviceId: string; deviceToken: string }
    return { deviceId: data.deviceId, token: data.deviceToken }
  }

  /** Bob 的设备产出原件（真实 Node 路径的 HTTP 等价步骤）。 */
  async function uploadCandidate(mediaType = DOCX): Promise<string> {
    const query = new URLSearchParams({
      title: '季度报告.docx',
      mediaType,
      byteSize: String(OFFICE_BYTES.byteLength),
      sha256: OFFICE_SHA,
      sourceRelativePath: 'reports/quarterly.docx',
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/node/runs/${runId}/artifacts?${query.toString()}`,
      headers: {
        authorization: `Device ${bobToken}`,
        'idempotency-key': idemKey(),
        'content-type': 'application/octet-stream',
      },
      payload: OFFICE_BYTES,
    })
    expect(res.statusCode).toBe(201)
    return res.json().data.id as string
  }

  async function publish(artifactId: string): Promise<void> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/publish`,
      headers: { origin: ctx.origin, cookie: bob.cookie, 'idempotency-key': idemKey() },
    })
    expect(res.statusCode).toBe(200)
  }

  function putPreview(
    token: string,
    artifactId: string,
    overrides: {
      body?: Buffer
      sha256?: string
      byteSize?: number
      sourceSha256?: string
      converter?: string
    } = {},
  ) {
    const body = overrides.body ?? PDF_BYTES
    const query = new URLSearchParams({
      sourceSha256: overrides.sourceSha256 ?? OFFICE_SHA,
      sha256: overrides.sha256 ?? createHash('sha256').update(body).digest('hex'),
      byteSize: String(overrides.byteSize ?? body.byteLength),
      converter: overrides.converter ?? 'libreoffice',
    })
    return ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/node/artifacts/${artifactId}/preview?${query.toString()}`,
      headers: {
        authorization: `Device ${token}`,
        'content-type': 'application/octet-stream',
        'idempotency-key': idemKey(),
      },
      payload: body,
    })
  }

  function postFailure(
    token: string,
    artifactId: string,
    overrides: {
      sourceSha256?: string
      converter?: string
      reason?: string
      key?: string
    } = {},
  ) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/v1/node/artifacts/${artifactId}/preview-failure`,
      headers: {
        authorization: `Device ${token}`,
        'content-type': 'application/json',
        'idempotency-key': overrides.key ?? idemKey(),
      },
      payload: {
        sourceSha256: overrides.sourceSha256 ?? OFFICE_SHA,
        converter: overrides.converter ?? 'libreoffice',
        reason: overrides.reason ?? 'CONVERTER_UNAVAILABLE',
      },
    })
  }

  function info(cookie: string, artifactId: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}/preview-info`,
      headers: { cookie },
    })
  }

  function readPreview(cookie: string, artifactId: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}/preview`,
      headers: { cookie },
    })
  }

  function readContent(cookie: string, artifactId: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}/content`,
      headers: { cookie },
    })
  }

  async function previewRows() {
    return database.db.select().from(schema.artifactPreviews)
  }

  async function previewEvents() {
    const rows = await database.db
      .select()
      .from(schema.teamEvents)
      .where(eq(schema.teamEvents.type, 'artifact.changed'))
    return rows.filter((row) => (row.payload as { change?: unknown }).change === 'preview')
  }

  it('候选预览：设备上传 PDF 后 owner 可读，其他成员与不存在同 404；不产生团队事件', async () => {
    const artifactId = await uploadCandidate()
    const upload = await putPreview(bobToken, artifactId)
    expect(upload.statusCode).toBe(200)
    expect(upload.json().data).toMatchObject({
      artifactId,
      status: 'ready',
      sourceSha256: OFFICE_SHA,
      converter: 'libreoffice',
      mediaType: 'application/pdf',
      byteSize: PDF_BYTES.byteLength,
      failureReason: null,
    })

    const rows = await previewRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      artifactId,
      status: 'ready',
      sourceSha256: OFFICE_SHA,
      sha256: PDF_SHA,
      byteSize: PDF_BYTES.byteLength,
      mediaType: 'application/pdf',
      failureReason: null,
    })

    const ownerInfo = await info(bob.cookie, artifactId)
    expect(ownerInfo.statusCode).toBe(200)
    expect(ownerInfo.json().data.status).toBe('ready')
    const ownerPdf = await readPreview(bob.cookie, artifactId)
    expect(ownerPdf.statusCode).toBe(200)
    expect(ownerPdf.body).toBe(PDF_BYTES.toString())
    expect(ownerPdf.headers['content-type']).toContain('application/pdf')
    expect(ownerPdf.headers['content-disposition']).toContain('inline')
    expect(ownerPdf.headers['cache-control']).toContain('no-store')
    expect(ownerPdf.headers['x-content-type-options']).toBe('nosniff')
    expect(ownerPdf.headers['content-security-policy']).toBe('sandbox')

    // 候选对非拥有者与不存在同形：info/字节都 404，且错误码不可区分。
    const foreignInfo = await info(alice.cookie, artifactId)
    expect(foreignInfo.statusCode).toBe(404)
    expect(foreignInfo.json().error.code).toBe('NOT_FOUND')
    const foreignPdf = await readPreview(alice.cookie, artifactId)
    expect(foreignPdf.statusCode).toBe(404)
    expect(foreignPdf.json().error.code).toBe('NOT_FOUND')
    expect(await previewEvents()).toHaveLength(0)

    // 重试同一派生件：仍是一条记录，不重复事件。
    const replay = await putPreview(bobToken, artifactId)
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data.status).toBe('ready')
    expect(await previewRows()).toHaveLength(1)
  })

  it('发布后权限继承原件：团队成员可读 PDF，原件内容不变；发 preview 变更事件', async () => {
    const artifactId = await uploadCandidate()
    await publish(artifactId)
    const upload = await putPreview(bobToken, artifactId)
    expect(upload.statusCode).toBe(200)

    const events = await previewEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({
      artifactId,
      taskId,
      change: 'preview',
      previewStatus: 'ready',
    })

    const aliceInfo = await info(alice.cookie, artifactId)
    expect(aliceInfo.statusCode).toBe(200)
    expect(aliceInfo.json().data.status).toBe('ready')
    const alicePdf = await readPreview(alice.cookie, artifactId)
    expect(alicePdf.statusCode).toBe(200)
    expect(alicePdf.body).toBe(PDF_BYTES.toString())

    // 派生预览不改原件：下载仍是原始 Office 字节与摘要。
    const content = await readContent(alice.cookie, artifactId)
    expect(content.statusCode).toBe(200)
    expect(content.body).toBe(OFFICE_BYTES.toString())
    const [row] = await database.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId))
    expect(row?.sha256).toBe(OFFICE_SHA)
  })

  it('未生成预览的已发布件：info 为 none，读 PDF 明确 PREVIEW_UNAVAILABLE，原件仍可下载', async () => {
    const artifactId = await uploadCandidate()
    await publish(artifactId)
    const noneInfo = await info(alice.cookie, artifactId)
    expect(noneInfo.statusCode).toBe(200)
    expect(noneInfo.json().data).toMatchObject({
      artifactId,
      status: 'none',
      sourceSha256: null,
      failureReason: null,
    })
    const missing = await readPreview(alice.cookie, artifactId)
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('PREVIEW_UNAVAILABLE')
    const content = await readContent(alice.cookie, artifactId)
    expect(content.statusCode).toBe(200)
    expect(content.body).toBe(OFFICE_BYTES.toString())
  })

  it('并发上传同一原件的两份派生 PDF：只有一条记录，首个 ready 稳定', async () => {
    const artifactId = await uploadCandidate()
    await publish(artifactId)
    const firstPdf = Buffer.from('%PDF-1.7\nfirst\n')
    const secondPdf = Buffer.from('%PDF-1.7\nsecond\n')
    const [first, second] = await Promise.all([
      putPreview(bobToken, artifactId, { body: firstPdf }),
      putPreview(bobToken, artifactId, { body: secondPdf }),
    ])
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    const rows = await previewRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('ready')
    const served = (await readPreview(alice.cookie, artifactId)).body
    expect([firstPdf.toString(), secondPdf.toString()]).toContain(served)
    expect(await previewEvents()).toHaveLength(1)
  })

  it('转换失败：登记 failed 与原因，下载回退；ready 不被迟到的失败上报降级', async () => {
    const artifactId = await uploadCandidate()
    await publish(artifactId)
    const failed = await postFailure(bobToken, artifactId, { reason: 'CONVERT_FAILED' })
    expect(failed.statusCode).toBe(200)
    expect(failed.json().data).toMatchObject({
      artifactId,
      status: 'failed',
      failureReason: 'CONVERT_FAILED',
      byteSize: null,
      mediaType: null,
    })
    const failedInfo = await info(alice.cookie, artifactId)
    expect(failedInfo.json().data.status).toBe('failed')
    const unavailable = await readPreview(alice.cookie, artifactId)
    expect(unavailable.statusCode).toBe(404)
    expect(unavailable.json().error.code).toBe('PREVIEW_UNAVAILABLE')
    expect((await readContent(alice.cookie, artifactId)).statusCode).toBe(200)

    // failed → ready 允许覆盖。
    const uploaded = await putPreview(bobToken, artifactId)
    expect(uploaded.statusCode).toBe(200)
    expect(uploaded.json().data.status).toBe('ready')

    // ready 之后的失败上报只返回现有 ready，不降级。
    const lateFailure = await postFailure(bobToken, artifactId, { reason: 'CONVERT_TIMEOUT' })
    expect(lateFailure.statusCode).toBe(200)
    expect(lateFailure.json().data.status).toBe('ready')
    const after = await info(alice.cookie, artifactId)
    expect(after.json().data.status).toBe('ready')
    expect(after.json().data.failureReason).toBeNull()
  })

  it('绑定与权限负向：source 摘要不符、非产出设备、未知原件、声明超限都被拒绝', async () => {
    const artifactId = await uploadCandidate()
    const wrongSource = await putPreview(bobToken, artifactId, {
      sourceSha256: 'a'.repeat(64),
    })
    expect(wrongSource.statusCode).toBe(409)
    expect(await previewRows()).toHaveLength(0)

    // Alice 的设备不是原件的产出设备：与不存在同 404。
    const foreignDevice = await putPreview(aliceToken, artifactId)
    expect(foreignDevice.statusCode).toBe(404)
    expect(foreignDevice.json().error.code).toBe('NOT_FOUND')
    const foreignFailure = await postFailure(aliceToken, artifactId)
    expect(foreignFailure.statusCode).toBe(404)

    const unknown = await putPreview(bobToken, randomUUID())
    expect(unknown.statusCode).toBe(404)

    const oversized = await putPreview(bobToken, artifactId, { byteSize: 52_428_801 })
    expect(oversized.statusCode).toBe(400)
    expect(oversized.json().error.code).toBe('VALIDATION_FAILED')
    expect(await previewRows()).toHaveLength(0)
  })

  it('派生 PDF 的 hash 由 Hub 复核：声明不符 → ARTIFACT_HASH_MISMATCH，无预览行', async () => {
    const artifactId = await uploadCandidate()
    const res = await putPreview(bobToken, artifactId, { sha256: 'b'.repeat(64) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('ARTIFACT_HASH_MISMATCH')
    expect(await previewRows()).toHaveLength(0)
    const tmpEntries = await readdir(join(ctx.config.artifactStoreDir, 'tmp')).catch(() => [])
    expect(tmpEntries).toHaveLength(0)
  })

  it('同一幂等键重放失败上报：返回首次原因，不被第二次 body 改写', async () => {
    const artifactId = await uploadCandidate()
    const key = idemKey()
    const first = await postFailure(bobToken, artifactId, { key, reason: 'CONVERT_FAILED' })
    expect(first.statusCode).toBe(200)
    expect(first.json().data.failureReason).toBe('CONVERT_FAILED')
    const replay = await postFailure(bobToken, artifactId, { key, reason: 'CONVERT_TIMEOUT' })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data.failureReason).toBe('CONVERT_FAILED')
    const rows = await previewRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.failureReason).toBe('CONVERT_FAILED')
  })

  it('设备原始诊断不能进入团队读面、持久记录或幂等重放', async () => {
    const artifactId = await uploadCandidate()
    await publish(artifactId)
    const privateDetail = 'workspace/private.docx credential=fixture-sensitive-value'
    const key = idemKey()
    const response = await postFailure(bobToken, artifactId, {
      key, converter: privateDetail, reason: privateDetail,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({ converter: 'unknown', failureReason: 'CONVERT_FAILED' })
    const shared = await info(alice.cookie, artifactId)
    expect(shared.statusCode).toBe(200)
    expect(shared.json().data).toMatchObject({ converter: 'unknown', failureReason: 'CONVERT_FAILED' })
    const replay = await postFailure(bobToken, artifactId, { key, reason: 'CONVERT_TIMEOUT' })
    expect(replay.json().data.failureReason).toBe('CONVERT_FAILED')
    const rows = await previewRows()
    expect(rows[0]).toMatchObject({ converter: 'unknown', failureReason: 'CONVERT_FAILED' })
    expect(JSON.stringify([response.json(), shared.json(), replay.json(), rows, await previewEvents()])).not.toContain(privateDetail)
  })

  it('ready 上报的转换器同样受白名单保护，版本标识只保留受控名称', async () => {
    const artifactId = await uploadCandidate()
    await publish(artifactId)
    const privateConverter = 'soffice/26.8.1 credential=fixture-sensitive-value'
    const uploaded = await putPreview(bobToken, artifactId, { converter: privateConverter })
    expect(uploaded.statusCode).toBe(200)
    expect(uploaded.json().data.converter).toBe('unknown')
    expect((await info(alice.cookie, artifactId)).json().data.converter).toBe('unknown')
    expect((await previewRows())[0]?.converter).toBe('unknown')
    const other = await uploadCandidate()
    const accepted = await postFailure(bobToken, other, { converter: 'soffice/26.8.1', reason: 'PREVIEW_TOO_LARGE' })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().data).toMatchObject({ converter: 'libreoffice', failureReason: 'PREVIEW_TOO_LARGE' })
  })

  it('失败上报 schema strict：未知字段 → 400，不落预览行', async () => {
    const artifactId = await uploadCandidate()
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/node/artifacts/${artifactId}/preview-failure`,
      headers: {
        authorization: `Device ${bobToken}`,
        'content-type': 'application/json',
        'idempotency-key': idemKey(),
      },
      payload: {
        sourceSha256: OFFICE_SHA,
        converter: 'libreoffice',
        reason: 'CONVERT_FAILED',
        absolutePath: '/tmp/secret.docx',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_FAILED')
    expect(await previewRows()).toHaveLength(0)
  })
})
