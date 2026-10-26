/**
 * Office 只读 PDF 预览（#431；ADR-0021 §2）Hub 集成判据。
 *
 * 驱动走真实 HTTP：Device Token 上传候选、owner 发布、隔离暂停策略与 Session 下载。
 * 覆盖：
 *   - 未完成可核验隔离前不接受派生PDF、不公开旧PDF；原件和批注不受影响；
 *   - 私有原件/预览权限仍相同，失败诊断保持稳定、脱敏和幂等。
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

  it('候选保留拥有者下载和明确回退，其他成员的原件与预览三路均不可见', async () => {
    const artifactId = await uploadCandidate()
    const own = await info(bob.cookie, artifactId)
    expect(own.statusCode).toBe(200)
    expect(own.json().data).toMatchObject({
      artifactId,
      status: 'failed',
      sourceSha256: OFFICE_SHA,
      converter: 'unknown',
      failureReason: 'ISOLATION_REQUIRED',
      mediaType: null,
      byteSize: null,
      updatedAt: null,
    })
    expect((await readContent(bob.cookie, artifactId)).body).toBe(OFFICE_BYTES.toString())
    const unavailable = await readPreview(bob.cookie, artifactId)
    expect(unavailable.statusCode).toBe(404)
    expect(unavailable.json().error.code).toBe('PREVIEW_UNAVAILABLE')
    for (const denied of [
      await info(alice.cookie, artifactId),
      await readPreview(alice.cookie, artifactId),
      await readContent(alice.cookie, artifactId),
    ]) {
      expect(denied.statusCode).toBe(404)
      expect(denied.json().error.code).toBe('NOT_FOUND')
    }
    expect(await previewRows()).toHaveLength(0)
    expect(await previewEvents()).toHaveLength(0)
  })

  it('已发布原件仍可下载，团队明确收到隔离未开放而不是历史PDF', async () => {
    const artifactId = await uploadCandidate()
    await publish(artifactId)
    const shared = await info(alice.cookie, artifactId)
    expect(shared.statusCode).toBe(200)
    expect(shared.json().data).toMatchObject({
      status: 'failed',
      failureReason: 'ISOLATION_REQUIRED',
      sourceSha256: OFFICE_SHA,
    })
    const unavailable = await readPreview(alice.cookie, artifactId)
    expect(unavailable.statusCode).toBe(404)
    expect(unavailable.json().error.code).toBe('PREVIEW_UNAVAILABLE')
    const content = await readContent(alice.cookie, artifactId)
    expect(content.statusCode).toBe(200)
    expect(content.body).toBe(OFFICE_BYTES.toString())
    const [artifact] = await database.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId))
    expect(artifact?.sha256).toBe(OFFICE_SHA)
  })

  it('拒绝旧Node的新PDF上传，不保存blob或预览记录；重试也不能打开通道', async () => {
    const artifactId = await uploadCandidate()
    await publish(artifactId)
    for (const upload of [
      await putPreview(bobToken, artifactId),
      await putPreview(bobToken, artifactId, { sha256: 'b'.repeat(64) }),
    ]) {
      expect(upload.statusCode).toBe(409)
      expect(upload.json().error.code).toBe('PREVIEW_UNAVAILABLE')
    }
    expect(await previewRows()).toHaveLength(0)
    expect(await previewEvents()).toHaveLength(0)
    const objects = await readdir(
      join(ctx.config.artifactStoreDir, 'sha256', PDF_SHA.slice(0, 2), PDF_SHA.slice(2, 4)),
    ).catch(() => [])
    expect(objects).not.toContain(PDF_SHA)
  })

  it('并发的不受限预览上传全部拒绝，不产生首个ready或团队事件', async () => {
    const artifactId = await uploadCandidate()
    await publish(artifactId)
    const uploads = await Promise.all([
      putPreview(bobToken, artifactId),
      putPreview(bobToken, artifactId, { body: Buffer.from('%PDF-1.7 different') }),
    ])
    expect(uploads.map((row) => row.statusCode)).toEqual([409, 409])
    expect(await previewRows()).toHaveLength(0)
    expect(await previewEvents()).toHaveLength(0)
  })

  it('源绑定、设备和请求大小守卫仍在暂停策略之前生效', async () => {
    const artifactId = await uploadCandidate()
    const wrong = await putPreview(bobToken, artifactId, { sourceSha256: 'a'.repeat(64) })
    expect(wrong.statusCode).toBe(409)
    expect(wrong.json().error.code).toBe('CONFLICT')
    for (const denied of [
      await putPreview(aliceToken, artifactId),
      await postFailure(aliceToken, artifactId),
      await putPreview(bobToken, randomUUID()),
    ]) {
      expect(denied.statusCode).toBe(404)
      expect(denied.json().error.code).toBe('NOT_FOUND')
    }
    const oversized = await putPreview(bobToken, artifactId, { byteSize: 52_428_801 })
    expect(oversized.statusCode).toBe(400)
    expect(oversized.json().error.code).toBe('VALIDATION_FAILED')
    expect(await previewRows()).toHaveLength(0)
  })

  it('默认生成器可报告隔离缺失，原件发布状态和下载不受影响', async () => {
    const artifactId = await uploadCandidate()
    await publish(artifactId)
    const blocked = await postFailure(bobToken, artifactId, {
      converter: 'unknown',
      reason: 'ISOLATION_REQUIRED',
    })
    expect(blocked.statusCode).toBe(200)
    expect(blocked.json().data).toMatchObject({
      status: 'failed',
      failureReason: 'ISOLATION_REQUIRED',
      updatedAt: null,
    })
    expect((await previewRows())[0]).toMatchObject({
      artifactId,
      status: 'failed',
      failureReason: 'ISOLATION_REQUIRED',
      storageKey: null,
    })
    expect((await previewEvents())[0]?.payload).toMatchObject({
      artifactId,
      taskId,
      change: 'preview',
      previewStatus: 'failed',
    })
    expect((await readContent(alice.cookie, artifactId)).body).toBe(OFFICE_BYTES.toString())
  })

  it('失败上报继续幂等存第一份安全诊断，返回读面始终是隔离回退', async () => {
    const artifactId = await uploadCandidate(),
      key = idemKey()
    const first = await postFailure(bobToken, artifactId, { key, reason: 'CONVERT_FAILED' })
    const second = await postFailure(bobToken, artifactId, { key, reason: 'CONVERT_TIMEOUT' })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(first.json().data.failureReason).toBe('ISOLATION_REQUIRED')
    expect(second.json().data).toEqual(first.json().data)
    const rows = await previewRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.failureReason).toBe('CONVERT_FAILED')
  })

  it('任意设备诊断不进入存储或团队投影，历史回执也不重放ready', async () => {
    const artifactId = await uploadCandidate()
    await publish(artifactId)
    const raw = 'workspace/private.docx credential=fixture-sensitive-value',
      key = idemKey()
    const first = await postFailure(bobToken, artifactId, { key, converter: raw, reason: raw })
    const shared = await info(alice.cookie, artifactId)
    const second = await postFailure(bobToken, artifactId, { key, reason: 'CONVERT_TIMEOUT' })
    for (const response of [first, shared, second]) {
      expect(response.statusCode).toBe(200)
      expect(response.json().data).toMatchObject({
        converter: 'unknown',
        failureReason: 'ISOLATION_REQUIRED',
      })
    }
    const rows = await previewRows()
    expect(rows[0]).toMatchObject({ converter: 'unknown', failureReason: 'CONVERT_FAILED' })
    expect(
      JSON.stringify([first.json(), shared.json(), second.json(), rows, await previewEvents()]),
    ).not.toContain(raw)
  })

  it('未知字段仍拒绝，不会将本机路径纳入失败元数据', async () => {
    const artifactId = await uploadCandidate()
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/node/artifacts/${artifactId}/preview-failure`,
      headers: { authorization: `Device ${bobToken}`, 'idempotency-key': idemKey() },
      payload: {
        sourceSha256: OFFICE_SHA,
        converter: 'unknown',
        reason: 'ISOLATION_REQUIRED',
        extraPath: 'private-source',
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('VALIDATION_FAILED')
    expect(await previewRows()).toHaveLength(0)
  })
})
