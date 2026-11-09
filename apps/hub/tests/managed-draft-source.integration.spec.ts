import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { prepareManagedDraftSourceManifest } from '../src/modules/draft-share/source-manifest.js'
import {
  loadRegisteredDraftSource,
  registerManagedDraftSource,
  revokeManagedDraftSource,
} from '../src/modules/draft-share/source-registry.js'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveInviteAndAccept,
  driveSetup,
  idemKey,
  resetDatabase,
  type Session,
  type TestApp,
} from './helpers.js'

const MODEL_ROUTE = {
  provider: 'managed-model-provider',
  model: 'test-model',
  endpointId: 'approved-endpoint',
  accountId: 'approved-account',
  policyGeneration: 1,
  expiresAt: new Date('2026-11-09T14:00:00Z'),
}
const NOW = new Date('2026-11-09T12:00:00Z')
const EXPIRY = new Date('2026-11-09T13:00:00Z')
const SOURCE_MARKER = 'registered-source-policy-probe'

describe('managed draft source registration over a real Task agreement', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let taskId: string
  let projectId: string

  beforeAll(async () => {
    database = await createTestDatabase()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx, 'alice')
    bob = (
      await driveInviteAndAccept(ctx, alice, {
        username: 'bob',
        displayName: 'Bob',
        password: 'correct horse battery staple',
      })
    ).session
    const project = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Managed draft source probe' },
    })
    expect(project.statusCode).toBe(201)
    projectId = project.json().data.id as string
    const task = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: 'Managed draft source probe', assigneeUserId: alice.userId },
    })
    expect(task.statusCode).toBe(201)
    taskId = task.json().data.id as string
    const accepted = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/accept`,
    })
    expect(accepted.statusCode).toBe(200)
  })
  afterEach(async () => {
    await ctx.close()
  })
  afterAll(async () => {
    await database.close()
  })

  async function confirmAgreement(author = alice, goal = SOURCE_MARKER): Promise<string> {
    const draft = await apiInject(ctx, author, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/draft`,
      payload: { content: { goal, constraints: '', acceptance: '', openQuestions: '' } },
    })
    expect(draft.statusCode).toBe(200)
    const confirmed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/agreement/confirm`,
      payload: { draftVersion: draft.json().data.draftVersion },
    })
    expect(confirmed.statusCode).toBe(200)
    return confirmed.json().data.id as string
  }

  function registration(revisionId: string) {
    return {
      projectId,
      taskId,
      revisionId,
      recipientUserId: bob.userId,
      permitsPublishedAudience: false,
      confirmsOwnershipAndUses: true as const,
      expiresAt: EXPIRY,
      idempotencyKey: idemKey(),
    }
  }

  it('pins content, a named recipient and model route; version drift invalidates without changing old bytes', async () => {
    const revisionId = await confirmAgreement()
    const input = registration(revisionId)
    const registered = await registerManagedDraftSource(
      database,
      alice.userId,
      input,
      MODEL_ROUTE,
      NOW,
    )
    expect(registered).toMatchObject({
      revisionId,
      recipientUserId: bob.userId,
      permitsPublishedAudience: false,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(JSON.stringify(registered)).not.toContain(SOURCE_MARKER)
    expect(
      await registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW),
    ).toEqual(registered)
    const loaded = await loadRegisteredDraftSource(database, registered.id, MODEL_ROUTE, NOW)
    expect(loaded?.bytes.toString('utf8')).toContain(SOURCE_MARKER)

    const changedRoute = { ...MODEL_ROUTE, accountId: 'another-account' }
    expect(
      await loadRegisteredDraftSource(database, registered.id, changedRoute, NOW),
    ).toBeUndefined()
    const renewedRoute = { ...MODEL_ROUTE, policyGeneration: MODEL_ROUTE.policyGeneration + 1 }
    expect(
      await loadRegisteredDraftSource(database, registered.id, renewedRoute, NOW),
    ).toBeUndefined()
    expect(
      await loadRegisteredDraftSource(database, registered.id, MODEL_ROUTE, EXPIRY),
    ).toBeUndefined()

    const next = await confirmAgreement(alice, 'new revision')
    expect(next).not.toBe(revisionId)
    expect(
      await loadRegisteredDraftSource(database, registered.id, MODEL_ROUTE, NOW),
    ).toBeUndefined()
    await expect(
      registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('freezes the exact source and active Mandate with an independently approved managed host', async () => {
    const revisionId = await confirmAgreement()
    const source = await registerManagedDraftSource(
      database,
      alice.userId,
      registration(revisionId),
      MODEL_ROUTE,
      NOW,
    )
    const workResponse = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/works`,
      payload: { goal: 'Draft the registered agreement' },
    })
    expect(workResponse.statusCode).toBe(201)
    const workKey = workResponse.json().data.workKey as string
    const mandateResponse = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/mandates`,
      payload: {
        allowedActionClasses: ['draft'],
        allowedSourceTypes: ['task_message'],
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
    })
    expect(mandateResponse.statusCode).toBe(201)

    const request = { actorUserId: alice.userId, workKey, runId: randomUUID(), sourceId: source.id }
    const placement = {
      deviceId: randomUUID(),
      workspaceId: randomUUID(),
      profileRevisionId: randomUUID(),
      managedHostGeneration: 2,
    }
    const prepare = (trustedPlacement: typeof placement | undefined) =>
      database.transaction((tx) =>
        prepareManagedDraftSourceManifest(tx, request, trustedPlacement, MODEL_ROUTE, NOW),
      )
    expect(await prepare(undefined)).toBeUndefined()
    const plan = await prepare(placement)
    expect(plan?.manifest).toMatchObject({
      runId: request.runId,
      projectId,
      taskId,
      workKey,
      ownerUserId: alice.userId,
      ...placement,
      instruction: 'draft_registered_agreement.v1',
      source: { policyId: source.id, revisionId, sha256: source.sha256, byteSize: source.byteSize },
      expiresAt: EXPIRY.toISOString(),
    })
    expect(plan?.manifestDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(plan)).not.toContain(SOURCE_MARKER)
    expect(await prepare(placement)).toEqual(plan)

    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${mandateResponse.json().data.id}/pause`,
      payload: {},
    })
    expect(paused.statusCode).toBe(200)
    expect(await prepare(placement)).toBeUndefined()
  })

  it('does not infer ownership from readability, task responsibility or a model-looking identifier', async () => {
    const revisionId = await confirmAgreement(bob)
    const input = registration(revisionId)
    await expect(
      registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW),
    ).rejects.toMatchObject({ statusCode: 409 })
    await expect(
      registerManagedDraftSource(database, bob.userId, input, MODEL_ROUTE, NOW),
    ).rejects.toMatchObject({ statusCode: 403 })
    const own = await confirmAgreement()
    const ownInput = registration(own)
    await expect(
      registerManagedDraftSource(database, alice.userId, ownInput, undefined, NOW),
    ).rejects.toMatchObject({ statusCode: 409 })
    await expect(
      registerManagedDraftSource(
        database,
        alice.userId,
        { ...ownInput, projectId: randomUUID() },
        MODEL_ROUTE,
        NOW,
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('rejects a draft with unknown editor provenance, even if A wrote the first version', async () => {
    const url = `/api/v1/tasks/${taskId}/agreement`
    const body = { goal: SOURCE_MARKER, constraints: '', acceptance: '', openQuestions: '' }
    const original = await apiInject(ctx, alice, {
      method: 'POST',
      url: `${url}/draft`,
      payload: { content: body },
    })
    expect(original.statusCode).toBe(200)
    const edited = await apiInject(ctx, bob, {
      method: 'POST',
      url: `${url}/draft`,
      payload: { content: { ...body, goal: 'another author' }, expectedDraftVersion: 1 },
    })
    expect(edited.statusCode).toBe(200)
    const confirmed = await apiInject(ctx, alice, {
      method: 'POST',
      url: `${url}/confirm`,
      payload: { draftVersion: 2 },
    })
    expect(confirmed.statusCode).toBe(200)
    await expect(
      registerManagedDraftSource(
        database,
        alice.userId,
        registration(confirmed.json().data.id),
        MODEL_ROUTE,
        NOW,
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('invalidates the old registration when assignment moves away and then back', async () => {
    const revisionId = await confirmAgreement()
    const input = registration(revisionId)
    const first = await registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW)
    for (const assignee of [bob, alice]) {
      const reassign = await apiInject(ctx, alice, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/reassign`,
        payload: { assigneeUserId: assignee.userId },
      })
      expect(reassign.statusCode).toBe(200)
      const accept = await apiInject(ctx, assignee, {
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/accept`,
      })
      expect(accept.statusCode).toBe(200)
      expect(await loadRegisteredDraftSource(database, first.id, MODEL_ROUTE, NOW)).toBeUndefined()
    }
    await expect(
      registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW),
    ).rejects.toMatchObject({
      statusCode: 409,
    })
    const next = await registerManagedDraftSource(
      database,
      alice.userId,
      { ...input, idempotencyKey: idemKey() },
      MODEL_ROUTE,
      NOW,
    )
    expect(next.id).not.toBe(first.id)
  })

  it('persists source invalidation in the member-disable transaction', async () => {
    const revisionId = await confirmAgreement()
    const input = registration(revisionId)
    const registered = await registerManagedDraftSource(
      database,
      alice.userId,
      input,
      MODEL_ROUTE,
      NOW,
    )
    const disabled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/team/members/${bob.userId}/disable`,
    })
    expect(disabled.statusCode).toBe(200)
    expect(
      await loadRegisteredDraftSource(database, registered.id, MODEL_ROUTE, NOW),
    ).toBeUndefined()
    const [row] = await database.sql<
      { revoked: boolean }[]
    >`select revoked_at is not null as revoked from managed_draft_source_policy where id = ${registered.id}`
    expect(row?.revoked).toBe(true)
  })

  it('revokes an exact registration and never revives it when explicitly reauthorizing', async () => {
    const revisionId = await confirmAgreement()
    const input = registration(revisionId)
    const first = await registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW)
    await expect(
      revokeManagedDraftSource(database, bob.userId, first.id, NOW),
    ).rejects.toMatchObject({ statusCode: 404 })
    await revokeManagedDraftSource(database, alice.userId, first.id, NOW)
    expect(await loadRegisteredDraftSource(database, first.id, MODEL_ROUTE, NOW)).toBeUndefined()
    await expect(
      registerManagedDraftSource(database, alice.userId, input, MODEL_ROUTE, NOW),
    ).rejects.toMatchObject({ statusCode: 409 })
    const next = await registerManagedDraftSource(
      database,
      alice.userId,
      { ...input, idempotencyKey: idemKey() },
      MODEL_ROUTE,
      NOW,
    )
    expect(next.id).not.toBe(first.id)
    expect(await loadRegisteredDraftSource(database, first.id, MODEL_ROUTE, NOW)).toBeUndefined()
    expect(await loadRegisteredDraftSource(database, next.id, MODEL_ROUTE, NOW)).toBeDefined()
  })
})
