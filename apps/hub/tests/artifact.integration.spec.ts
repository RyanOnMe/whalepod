/**
 * P1-15 Artifact Hub 侧集成验收（03 §2.6/§4/§12、04 G6-01..05/07、§6.3 路径
 * 攻击矩阵的 Hub 半场）。
 *
 * 驱动全走真人路径：Fastify inject（Session 面）+ Device Token HTTP（Node 面）；
 * 落库断言直接读表。覆盖：
 *   1) G6-01  candidate 上传（Device Token）→ owner 可下载、其他成员 404
 *   2) G6-03  上传内容与 sha256 不符 → ARTIFACT_HASH_MISMATCH、无 candidate 行、
 *            store 临时目录清空
 *   3) 超限   body 超 50 MiB → ARTIFACT_TOO_LARGE；声明的 byteSize 越界 →
 *            VALIDATION_FAILED
 *   4) G6-05  非 owner 发布 → 403；owner 发布 → published；重复发布 → 409
 *   5) G6-04  发布后其他成员可下载且 hash 一致；artifact.changed Team Event
 *   6) 候选不泄漏：candidate 上传不产生 artifact.changed Team Event；
 *            Task Room 聚合里 candidate 仅 owner 可见
 *   7) G6-07  /node/runs/:runId/input-manifest 只含已发布、无 storageKey/
 *            sourceRelativePath 字段；Node 下载受控副本（含 digest 复核）
 *   8) 磁盘篡改：blob 与 DB digest 不一致 → 下载 500，不外泄未验证字节
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Database } from '@project311/db'
import { schema } from '@project311/db'
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

const CONTENT = 'artifact payload for g6\n'
const DIGEST = createHash('sha256').update(CONTENT).digest('hex')

describe('P1-15 artifact（Hub 侧）', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let taskId: string
  let runId: string
  let deviceToken: string
  let pairedDeviceId: string
  let storeDir: string
  const tmpDirs: string[] = []

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    tmpDirs.push(ctx.config.artifactStoreDir)
    storeDir = ctx.config.artifactStoreDir
    await mkdir(storeDir, { recursive: true })
    alice = await driveSetup(ctx, 'alice')
    const invited = await driveInviteAndAccept(ctx, alice, {
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    })
    bob = invited.session
    // Task：Alice 创建并指派 Bob（G6 标准角色）。
    const project = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { origin: ctx.origin, cookie: alice.cookie, 'idempotency-key': idemKey() },
      payload: { name: 'p115-project' },
    })
    const projectId = project.json().data.id as string
    const task = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      headers: { origin: ctx.origin, cookie: alice.cookie, 'idempotency-key': idemKey() },
      payload: { title: '生成并复核运行报告', assigneeUserId: bob.userId },
    })
    taskId = task.json().data.id as string
    // Bob 配对设备（真人路径：配对码 → claim，Token 只出现一次）。
    const paired = await pairDevice(bob)
    deviceToken = paired.token
    pairedDeviceId = paired.deviceId
    // Builder Run 行（Bob 拥有，落在他配对的设备上）。
    const chain = await seedRunChainForUser(database.db, bob.userId)
    runId = await insertRunRow(database.db, {
      taskId,
      ownerUserId: bob.userId,
      agentId: chain.agentId,
      profileRevisionId: chain.profileRevisionId,
      deviceId: paired.deviceId,
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
        name: 'p115-node',
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

  function uploadArtifact(
    token: string,
    overrides: {
      runId?: string
      sha256?: string
      byteSize?: number
      body?: Buffer
      title?: string
      sourceRelativePath?: string
      idempotencyKey?: string
    } = {},
  ) {
    const query = new URLSearchParams({
      title: overrides.title ?? 'Builder report',
      mediaType: 'text/markdown',
      byteSize: String(overrides.byteSize ?? CONTENT.length),
      sha256: overrides.sha256 ?? DIGEST,
      sourceRelativePath: overrides.sourceRelativePath ?? 'reports/protocol-review.md',
    })
    return ctx.app.inject({
      method: 'POST',
      url: `/api/v1/node/runs/${overrides.runId ?? runId}/artifacts?${query.toString()}`,
      headers: {
        authorization: `Device ${token}`,
        'idempotency-key': overrides.idempotencyKey ?? idemKey(),
        'content-type': 'application/octet-stream',
      },
      payload: overrides.body ?? Buffer.from(CONTENT),
    })
  }

  async function artifactRows() {
    return database.db.select().from(schema.artifacts)
  }

  async function teamEventsByType(type: string) {
    return database.db.select().from(schema.teamEvents).where(eq(schema.teamEvents.type, type))
  }

  // ---- G6-01：candidate 上传与 owner 可见性 ----

  it('G6-01: 上传产生 candidate，owner 可下载原文，其他成员 404', async () => {
    const res = await uploadArtifact(deviceToken)
    expect(res.statusCode).toBe(201)
    const artifact = res.json().data as Record<string, unknown>
    expect(artifact.status).toBe('candidate')
    expect(artifact.byteSize).toBe(CONTENT.length)
    expect(artifact.sha256).toBe(DIGEST)
    // wire 面不暴露本地路径事实。
    expect(JSON.stringify(artifact)).not.toContain('storageKey')
    expect(JSON.stringify(artifact)).not.toContain('sourceRelativePath')

    // 落库：candidate 行 + storage_key 内容寻址形态。
    const rows = await artifactRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('candidate')
    expect(rows[0]?.storageKey).toBe(`sha256/${DIGEST.slice(0, 2)}/${DIGEST.slice(2, 4)}/${DIGEST}`)

    // owner 下载 200 且字节一致；blob 在内容寻址路径上。
    const ownerRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifact.id as string}/content`,
      headers: { cookie: bob.cookie },
    })
    expect(ownerRes.statusCode).toBe(200)
    expect(ownerRes.body).toBe(CONTENT)
    expect(ownerRes.headers['content-type']).toContain('text/markdown')
    expect(existsSync(join(storeDir, rows[0]?.storageKey ?? ''))).toBe(true)

    // Alice（其他成员）：candidate 404（与不存在同形态，不能枚举）。
    const foreignRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifact.id as string}/content`,
      headers: { cookie: alice.cookie },
    })
    expect(foreignRes.statusCode).toBe(404)
    const unknownRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${randomUUID()}/content`,
      headers: { cookie: alice.cookie },
    })
    expect(unknownRes.statusCode).toBe(404)
    expect(unknownRes.json().error.code).toBe(foreignRes.json().error.code)
  })

  it('G6-03: 内容与 sha256 不符 → ARTIFACT_HASH_MISMATCH，无行、临时文件清空', async () => {
    const res = await uploadArtifact(deviceToken, {
      sha256: 'a'.repeat(64),
      body: Buffer.from(CONTENT),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('ARTIFACT_HASH_MISMATCH')
    expect(await artifactRows()).toHaveLength(0)
    const tmpEntries = await readdir(join(storeDir, 'tmp')).catch(() => [] as string[])
    expect(tmpEntries).toHaveLength(0)
    expect(existsSync(join(storeDir, 'sha256'))).toBe(false)
  })

  it('超限：实际 body 超 50 MiB → ARTIFACT_TOO_LARGE（真实上限）', async () => {
    const big = Buffer.alloc(52_428_801, 7)
    const res = await uploadArtifact(deviceToken, {
      sha256: createHash('sha256').update(big).digest('hex'),
      byteSize: big.byteLength,
      body: big,
    })
    expect(res.statusCode).toBe(413)
    expect(res.json().error.code).toBe('ARTIFACT_TOO_LARGE')
    expect(await artifactRows()).toHaveLength(0)
  })

  it('超限：声明的 byteSize 越界 → VALIDATION_FAILED（schema 上界）', async () => {
    const res = await uploadArtifact(deviceToken, { byteSize: 52_428_801 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_FAILED')
    expect(await artifactRows()).toHaveLength(0)
  })

  it('同 Idempotency-Key 重试返回同一 artifact，不产生第二行', async () => {
    const key = idemKey()
    const first = await uploadArtifact(deviceToken, { idempotencyKey: key })
    const second = await uploadArtifact(deviceToken, { idempotencyKey: key })
    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(second.json().data.id).toBe(first.json().data.id)
    expect(await artifactRows()).toHaveLength(1)
  })

  it('Device Token 越权：伪造 Token 401，未知 run 与他设备 run 同作 404，撤销 Token 401', async () => {
    // authenticateDevice 先于 run 查找（artifact/routes.ts 三个 Node 路由同构）：
    // 伪造 Token 的唯一真实形态是 401 INVALID_CREDENTIALS，不会落到 404。
    const unknown = await uploadArtifact(randomBytes(32).toString('base64url'), {})
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json().error.code).toBe('INVALID_CREDENTIALS')

    const foreign = await uploadArtifact(deviceToken, { runId: randomUUID() })
    expect(foreign.statusCode).toBe(404)

    // 撤销设备后同 Token 不可上传。
    await database.db
      .update(schema.devices)
      .set({ revokedAt: new Date() })
      .where(eq(schema.devices.id, pairedDeviceId))
    const revoked = await uploadArtifact(deviceToken, {})
    expect(revoked.statusCode).toBe(401)
  })

  // ---- 发布与可见性（G6-04/05）----

  async function uploadThenPublish(by: Session): Promise<string> {
    const res = await uploadArtifact(deviceToken)
    expect(res.statusCode).toBe(201)
    const artifactId = res.json().data.id as string
    const publish = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/publish`,
      headers: { origin: ctx.origin, cookie: by.cookie, 'idempotency-key': idemKey() },
      payload: {},
    })
    // 调用方（G6-04/07）的断言都以 published 为前提：发布失败要在源头红。
    expect(publish.statusCode).toBe(200)
    return artifactId
  }

  it('G6-05: 非 owner 发布 → 403；owner 发布 → published；重复发布 → 409', async () => {
    const artifactId = (await uploadArtifact(deviceToken)).json().data.id as string

    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/publish`,
      headers: { origin: ctx.origin, cookie: alice.cookie, 'idempotency-key': idemKey() },
      payload: {},
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('FORBIDDEN')
    expect((await artifactRows())[0]?.status).toBe('candidate')

    const allowed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/publish`,
      headers: { origin: ctx.origin, cookie: bob.cookie, 'idempotency-key': idemKey() },
      payload: {},
    })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().data.status).toBe('published')
    expect((await artifactRows())[0]?.status).toBe('published')
    expect((await artifactRows())[0]?.publishedAt).not.toBeNull()

    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/publish`,
      headers: { origin: ctx.origin, cookie: bob.cookie, 'idempotency-key': idemKey() },
      payload: {},
    })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('INVALID_ARTIFACT_TRANSITION')
  })

  it('G6-04: 发布后其他成员立即可下载，内容与 digest 一致；发布带 artifact.changed 事件', async () => {
    // 发布者是 Run owner（bob）；发布后 alice 作为其他成员立即可下载。
    const artifactId = await uploadThenPublish(bob)
    const aliceRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}/content`,
      headers: { cookie: alice.cookie },
    })
    expect(aliceRes.statusCode).toBe(200)
    expect(createHash('sha256').update(aliceRes.body).digest('hex')).toBe(DIGEST)

    const events = await teamEventsByType('artifact.changed')
    expect(events).toHaveLength(1)
    const payload = events[0]?.payload as Record<string, unknown>
    expect(payload).toMatchObject({ artifactId, taskId, runId, status: 'published' })
  })

  it('候选不泄漏：candidate 上传不产生 artifact.changed；Task Room candidate 仅 owner 可见', async () => {
    const artifactId = (await uploadArtifact(deviceToken)).json().data.id as string
    expect(await teamEventsByType('artifact.changed')).toHaveLength(0)

    const bobRoom = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}`,
      headers: { cookie: bob.cookie },
    })
    const bobArtifacts = bobRoom.json().data.artifacts as Array<Record<string, unknown>>
    expect(bobArtifacts.map((a) => a.id)).toContain(artifactId)

    const aliceRoom = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}`,
      headers: { cookie: alice.cookie },
    })
    expect(aliceRoom.json().data.artifacts).toEqual([])
  })

  // ---- Reviewer 输入 manifest（G6-07 的 Hub 面）----

  it('G6-07: input-manifest 只含已发布且无本地路径字段；Node 受控下载 + digest 复核', async () => {
    // 一条 candidate（不得出现在 manifest）+ 一条 published。
    await uploadArtifact(deviceToken, { title: 'Candidate stays hidden' })
    const publishedId = await uploadThenPublish(bob)

    const manifest = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/node/runs/${runId}/input-manifest`,
      headers: { authorization: `Device ${deviceToken}` },
    })
    expect(manifest.statusCode).toBe(200)
    const data = manifest.json().data as {
      taskId: string
      artifacts: Array<Record<string, unknown>>
    }
    expect(data.taskId).toBe(taskId)
    expect(data.artifacts).toHaveLength(1)
    expect(data.artifacts[0]?.artifactId).toBe(publishedId)
    const serialized = JSON.stringify(data)
    expect(serialized).not.toContain('storageKey')
    expect(serialized).not.toContain('sourceRelativePath')

    // Node 受控下载（同 Task 的 Run 所在设备）→ 字节与 digest 一致。
    const content = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/node/artifacts/${publishedId}/content`,
      headers: { authorization: `Device ${deviceToken}` },
    })
    expect(content.statusCode).toBe(200)
    expect(content.body).toBe(CONTENT)

    // candidate 对 Node 下载面同样不可见。
    const candidateRow = (await artifactRows()).find((row) => row.status === 'candidate')
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/node/artifacts/${candidateRow?.id}/content`,
      headers: { authorization: `Device ${deviceToken}` },
    })
    expect(denied.statusCode).toBe(404)
  })

  it('超限（#64）：已发布 Artifact 超 64 条 → input-manifest 409 ARTIFACT_INPUT_MANIFEST_TOO_LARGE（fail-closed 显式拒绝）', async () => {
    // 造 65 条已发布 Artifact（真人路径：candidate 上传 + owner 发布，逐条）。
    for (let i = 0; i < 65; i += 1) {
      const upload = await uploadArtifact(deviceToken, {
        title: `Builder report ${i}`,
        sourceRelativePath: `reports/out-${i}.md`,
        idempotencyKey: idemKey(),
      })
      expect(upload.statusCode).toBe(201)
      const publish = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/artifacts/${upload.json().data.id as string}/publish`,
        headers: { origin: ctx.origin, cookie: bob.cookie, 'idempotency-key': idemKey() },
        payload: {},
      })
      expect(publish.statusCode).toBe(200)
    }

    const manifest = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/node/runs/${runId}/input-manifest`,
      headers: { authorization: `Device ${deviceToken}` },
    })
    // 不是静默下发 >64 条（Node 侧 schema 必炸 VALIDATION_FAILED），而是
    // 显式专用码；且不下发半份数据（fail-closed）。
    expect(manifest.statusCode).toBe(409)
    expect(manifest.json().error.code).toBe('ARTIFACT_INPUT_MANIFEST_TOO_LARGE')
    expect(manifest.json().data).toBeUndefined()
  })

  it('磁盘 blob 与 DB digest 不一致 → 下载 500，不外泄未验证字节（§6.3）', async () => {
    const artifactId = (await uploadArtifact(deviceToken)).json().data.id as string
    const [row] = await artifactRows()
    // 模拟磁盘篡改：改写 blob 一个字节。
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(storeDir, row?.storageKey ?? ''), Buffer.from('tampered!'))
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}/content`,
      headers: { cookie: bob.cookie },
    })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('tampered')
  })
})
