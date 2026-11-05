/**
 * ADR-0028 §8（RD-03d2b）：authorize_scope 回答 → pending Mandate 草案 → 显式确认 →
 * 新 Mandate 版本。驱动走生产 HTTP；草案确认不创建 Run，也不改写旧 Mandate 历史。
 *
 * `authorize_scope` 问题的生产端（模型 Router 应用）由 #520 的
 * router-application.integration.spec.ts 覆盖；本 spec 从“问题已持久化”开始，
 * 只直插协调表 work_question 作为夹具，不写运行时状态。
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@whalepod/db'
import { schema } from '@whalepod/db'
import { canonicalJson, sha256Hex } from '../src/modules/coordination/digest.js'
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

const GOAL = '持续整理场地比较与预算变化，产出可审阅草稿'

describe('RD-03d2b authorize_scope proposal and confirmation', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let bob: Session
  let projectId: string
  let taskId: string
  let workKey: string
  let initialMandateId: string
  let initialMandateVersion: number
  let questionSeq = 0

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
      payload: { name: `rd03d2b-${randomUUID()}` },
    })
    expect(project.statusCode, project.body).toBe(201)
    projectId = project.json().data.id as string
    const task = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      payload: { title: '扩权与续接', assigneeUserId: alice.userId },
    })
    expect(task.statusCode, task.body).toBe(201)
    taskId = task.json().data.id as string
    expect(
      (await apiInject(ctx, alice, { method: 'POST', url: `/api/v1/tasks/${taskId}/accept` }))
        .statusCode,
    ).toBe(200)
    const work = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/works`,
      payload: { goal: GOAL },
      idempotencyKey: idemKey(),
    })
    expect(work.statusCode, work.body).toBe(201)
    workKey = work.json().data.workKey as string
    const mandate = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/mandates`,
      payload: scopePayload(),
      idempotencyKey: idemKey(),
    })
    expect(mandate.statusCode, mandate.body).toBe(201)
    initialMandateId = mandate.json().data.id as string
    initialMandateVersion = mandate.json().data.version as number
  })
  afterEach(async () => {
    await ctx.app.close()
  })
  afterAll(async () => {
    await database.close()
  })

  function futureIso(ms = 3_600_000): string {
    return new Date(Date.now() + ms).toISOString()
  }

  function scopePayload(overrides: Record<string, unknown> = {}) {
    return {
      expiresAt: futureIso(),
      allowedActionClasses: ['analysis', 'draft'],
      allowedSourceTypes: ['task_message'],
      allowedAgentIds: [],
      allowedToolNames: [],
      autoDispatch: 'off',
      maxRunsPerWork: 9,
      maxCostMicros: 2_000_000,
      maxTokens: 300_000,
      maxAttempts: 4,
      waitDeadlineSeconds: 600,
      ...overrides,
    }
  }

  async function seedAuthorizeQuestion(overrides: Record<string, unknown> = {}) {
    questionSeq += 1
    const decisionId = String(questionSeq).padStart(64, '0')
    const [row] = await database.db
      .insert(schema.workQuestions)
      .values({
        id: randomUUID(),
        workId: (
          await database.db.select().from(schema.works).where(eq(schema.works.workKey, workKey))
        )[0]!.id,
        taskId,
        projectId,
        decisionId,
        questionType: 'authorize_scope',
        blockedDecision: 'dispatch',
        summary: '当前职责范围不足以继续执行，请确认是否扩大。',
        options: [{ id: 'approve', label: '扩大范围' }],
        recommendedOptionId: 'approve',
        refs: {},
        inputDigest: 'a'.repeat(64),
        mandateId: initialMandateId,
        mandateVersion: initialMandateVersion,
        principalUserId: alice.userId,
        dispatchIntentId: null,
        status: 'open',
        answeredAt: null,
        closedAt: null,
        ...overrides,
      })
      .returning()
    return row!
  }

  function answerUrl(decisionId: string) {
    return `/api/v1/works/${workKey}/questions/${decisionId}/answers`
  }

  function confirmUrl(proposalId: string) {
    return `/api/v1/works/${workKey}/mandate-proposals/${proposalId}/confirm`
  }

  async function answerScope(question: { decisionId: string }, scope = scopePayload()) {
    const res = await apiInject(ctx, alice, {
      method: 'POST',
      url: answerUrl(question.decisionId),
      payload: { answerType: 'authorize_scope', scope },
      idempotencyKey: idemKey(),
    })
    expect(res.statusCode, res.body).toBe(200)
    return res.json().data as {
      question: { id: string; status: string }
      answer: { binding: boolean; answerType: string }
      scopeProposal: {
        id: string
        status: string
        baseMandateId: string
        baseMandateVersion: number
        scope: Record<string, unknown>
      }
    }
  }

  async function workDetail() {
    const res = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}`,
    })
    expect(res.statusCode, res.body).toBe(200)
    return res.json().data
  }

  it('records a pending proposal without expanding the current mandate, then confirms one new version', async () => {
    const question = await seedAuthorizeQuestion()
    const answered = await answerScope(question, scopePayload({ maxRunsPerWork: 4242 }))
    expect(answered.answer).toMatchObject({ answerType: 'authorize_scope', binding: true })
    expect(answered.question).toMatchObject({ status: 'answered' })
    expect(answered.scopeProposal).toMatchObject({
      status: 'pending',
      baseMandateId: initialMandateId,
      baseMandateVersion: initialMandateVersion,
      scope: { maxRunsPerWork: 4242 },
    })
    expect(
      await database.db
        .select()
        .from(schema.workMandates)
        .where(eq(schema.workMandates.workKey, workKey)),
    ).toHaveLength(1)

    const before = await workDetail()
    expect(before.currentMandate).toMatchObject({ id: initialMandateId, version: 1 })
    expect(before.pendingMandateProposals).toHaveLength(1)
    expect(before.openQuestions).toEqual([])
    expect(before.dispatchIntents).toEqual([])

    // 审计只记 id/版本，不记 scope 正文（4242 只存在于草案）。
    const answerAudit = ctx.auditEvents
      .filter((event) => event.action === 'work.decision.scope_answer')
      .at(-1)
    expect(answerAudit).toMatchObject({
      actor: alice.userId,
      workKey,
      decisionId: question.decisionId,
      proposalId: answered.scopeProposal.id,
      mandateId: initialMandateId,
      version: 1,
    })
    expect(JSON.stringify(answerAudit)).not.toContain('4242')

    const key = idemKey()
    const confirmed = await apiInject(ctx, alice, {
      method: 'POST',
      url: confirmUrl(answered.scopeProposal.id),
      idempotencyKey: key,
    })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    const confirmedBody = confirmed.json().data
    expect(confirmedBody.proposal).toMatchObject({
      id: answered.scopeProposal.id,
      status: 'confirmed',
      resultMandateId: confirmedBody.mandate.id,
    })
    expect(confirmedBody.mandate).toMatchObject({
      version: 2,
      maxRunsPerWork: 4242,
      allowedActionClasses: ['analysis', 'draft'],
      status: 'active',
    })
    expect(confirmedBody.question).toMatchObject({
      status: 'superseded',
      closedAt: expect.any(String),
    })

    const after = await workDetail()
    expect(after.currentMandate).toMatchObject({
      id: confirmedBody.mandate.id,
      version: 2,
      maxRunsPerWork: 4242,
    })
    expect(after.pendingMandateProposals).toEqual([])
    expect(after.openQuestions).toEqual([])
    const mandates = await database.db
      .select()
      .from(schema.workMandates)
      .where(eq(schema.workMandates.workKey, workKey))
    expect(mandates).toHaveLength(2)
    expect(mandates.find((row) => row.id === initialMandateId)).toMatchObject({
      version: 1,
      maxRunsPerWork: 9,
    })
    expect(await database.db.select().from(schema.runs)).toHaveLength(0)

    // 同 key 重放、不同 key 重复确认都返回同一版本，不产生第三个版本。
    for (const confirmationKey of [key, idemKey()]) {
      const again = await apiInject(ctx, alice, {
        method: 'POST',
        url: confirmUrl(answered.scopeProposal.id),
        idempotencyKey: confirmationKey,
      })
      expect(again.statusCode, again.body).toBe(200)
      expect(again.json().data.mandate.id).toBe(confirmedBody.mandate.id)
      expect(again.json().data.mandate.version).toBe(2)
    }
    expect(
      await database.db
        .select()
        .from(schema.workMandates)
        .where(eq(schema.workMandates.workKey, workKey)),
    ).toHaveLength(2)
    const confirmAudit = ctx.auditEvents
      .filter(
        (event) => event.action === 'work.decision.scope_confirm' && event.outcome === 'success',
      )
      .at(-1)
    expect(confirmAudit).toMatchObject({
      actor: alice.userId,
      workKey,
      proposalId: answered.scopeProposal.id,
      decisionId: question.decisionId,
      questionId: question.id,
      mandateId: confirmedBody.mandate.id,
      version: 2,
    })
    expect(JSON.stringify(confirmAudit)).not.toContain('4242')
  })

  it('rejects wrong answer types, missing or invalid scope, and non-assignee actors', async () => {
    const question = await seedAuthorizeQuestion()
    const downgrade = await apiInject(ctx, alice, {
      method: 'POST',
      url: answerUrl(question.decisionId),
      payload: { answerType: 'choose_option', optionId: 'approve' },
      idempotencyKey: idemKey(),
    })
    expect(downgrade.statusCode).toBe(400)
    expect(downgrade.json().error.code).toBe('UNSUPPORTED_ANSWER')

    const missingScope = await apiInject(ctx, alice, {
      method: 'POST',
      url: answerUrl(question.decisionId),
      payload: { answerType: 'authorize_scope' },
      idempotencyKey: idemKey(),
    })
    expect(missingScope.statusCode).toBe(400)
    expect(missingScope.json().error.code).toBe('VALIDATION_FAILED')

    const incompleteScope = await apiInject(ctx, alice, {
      method: 'POST',
      url: answerUrl(question.decisionId),
      payload: { answerType: 'authorize_scope', scope: { expiresAt: futureIso() } },
      idempotencyKey: idemKey(),
    })
    expect(incompleteScope.statusCode).toBe(400)
    expect(incompleteScope.json().error.code).toBe('VALIDATION_FAILED')

    const duplicateScope = await apiInject(ctx, alice, {
      method: 'POST',
      url: answerUrl(question.decisionId),
      payload: {
        answerType: 'authorize_scope',
        scope: scopePayload({ allowedActionClasses: ['analysis', 'analysis'] }),
      },
      idempotencyKey: idemKey(),
    })
    expect(duplicateScope.statusCode).toBe(400)
    expect(duplicateScope.json().error.code).toBe('VALIDATION_FAILED')

    const foreignRecipient = await apiInject(ctx, alice, {
      method: 'POST',
      url: answerUrl(question.decisionId),
      payload: {
        answerType: 'authorize_scope',
        scope: scopePayload({ draftRecipientUserId: bob.userId }),
      },
      idempotencyKey: idemKey(),
    })
    expect(foreignRecipient.statusCode).toBe(400)
    expect(foreignRecipient.json().error.code).toBe('VALIDATION_FAILED')

    const missingAgent = await apiInject(ctx, alice, {
      method: 'POST',
      url: answerUrl(question.decisionId),
      payload: {
        answerType: 'authorize_scope',
        scope: scopePayload({ allowedAgentIds: [randomUUID()] }),
      },
      idempotencyKey: idemKey(),
    })
    expect(missingAgent.statusCode).toBe(400)
    expect(missingAgent.json().error.code).toBe('VALIDATION_FAILED')

    const choiceQuestion = await seedAuthorizeQuestion({
      questionType: 'choose_option',
      options: [{ id: 'retry', label: '稍后重试' }],
      recommendedOptionId: 'retry',
    })
    const reverseDowngrade = await apiInject(ctx, alice, {
      method: 'POST',
      url: answerUrl(choiceQuestion.decisionId),
      payload: { answerType: 'authorize_scope', scope: scopePayload() },
      idempotencyKey: idemKey(),
    })
    expect(reverseDowngrade.statusCode).toBe(400)
    expect(reverseDowngrade.json().error.code).toBe('UNSUPPORTED_ANSWER')

    const crossMember = await apiInject(ctx, bob, {
      method: 'POST',
      url: answerUrl(question.decisionId),
      payload: { answerType: 'authorize_scope', scope: scopePayload() },
      idempotencyKey: idemKey(),
    })
    expect(crossMember.statusCode).toBe(403)

    const answered = await answerScope(question)
    const secondAnswer = await apiInject(ctx, alice, {
      method: 'POST',
      url: answerUrl(question.decisionId),
      payload: { answerType: 'authorize_scope', scope: scopePayload({ maxRunsPerWork: 2 }) },
      idempotencyKey: idemKey(),
    })
    expect(secondAnswer.statusCode).toBe(409)
    expect(secondAnswer.json().error.code).toBe('CONFLICT')
    const crossMemberConfirm = await apiInject(ctx, bob, {
      method: 'POST',
      url: confirmUrl(answered.scopeProposal.id),
      idempotencyKey: idemKey(),
    })
    expect(crossMemberConfirm.statusCode).toBe(403)
    expect(
      await database.db
        .select()
        .from(schema.workMandates)
        .where(eq(schema.workMandates.workKey, workKey)),
    ).toHaveLength(1)

    const unknownProposal = await apiInject(ctx, alice, {
      method: 'POST',
      url: confirmUrl(randomUUID()),
      idempotencyKey: idemKey(),
    })
    expect(unknownProposal.statusCode).toBe(404)
  })

  it('allows denying an authorization request without creating a proposal', async () => {
    const question = await seedAuthorizeQuestion()
    const denied = await apiInject(ctx, alice, {
      method: 'POST',
      url: answerUrl(question.decisionId),
      payload: { answerType: 'deny', reason: '当前不需要扩大范围' },
      idempotencyKey: idemKey(),
    })
    expect(denied.statusCode, denied.body).toBe(200)
    expect(denied.json().data).toMatchObject({
      question: { status: 'answered' },
      answer: { answerType: 'deny', binding: true },
      scopeProposal: null,
    })
    expect(await database.db.select().from(schema.workMandateProposals)).toHaveLength(0)
    expect(
      await database.db
        .select()
        .from(schema.workMandates)
        .where(eq(schema.workMandates.workKey, workKey)),
    ).toHaveLength(1)
  })

  it('supersedes the pending proposal when a new mandate version appears, and refuses confirmation', async () => {
    const question = await seedAuthorizeQuestion()
    const answered = await answerScope(question)
    const replacement = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/mandates`,
      payload: scopePayload({ maxRunsPerWork: 3 }),
      idempotencyKey: idemKey(),
    })
    expect(replacement.statusCode, replacement.body).toBe(201)
    expect(replacement.json().data.version).toBe(2)

    const [proposal] = await database.db
      .select()
      .from(schema.workMandateProposals)
      .where(eq(schema.workMandateProposals.id, answered.scopeProposal.id))
    expect(proposal).toMatchObject({ status: 'superseded', resultMandateId: null })
    const [row] = await database.db
      .select()
      .from(schema.workQuestions)
      .where(eq(schema.workQuestions.id, question.id))
    expect(row).toMatchObject({ status: 'superseded' })

    const confirm = await apiInject(ctx, alice, {
      method: 'POST',
      url: confirmUrl(answered.scopeProposal.id),
      idempotencyKey: idemKey(),
    })
    expect(confirm.statusCode).toBe(409)
    expect(confirm.json().error.code).toBe('DECISION_STALE')
    expect(confirm.json().error.details.reason).toBe('proposal_superseded')
    const deniedAudit = ctx.auditEvents
      .filter(
        (event) => event.action === 'work.decision.scope_confirm' && event.outcome === 'denied',
      )
      .at(-1)
    expect(deniedAudit).toMatchObject({
      actor: alice.userId,
      workKey,
      proposalId: answered.scopeProposal.id,
      decisionId: question.decisionId,
      questionId: question.id,
      reason: 'proposal_superseded',
    })
    expect(
      await database.db
        .select()
        .from(schema.workMandates)
        .where(eq(schema.workMandates.workKey, workKey)),
    ).toHaveLength(2)
  })

  it('refuses confirmation when the base mandate has expired', async () => {
    const question = await seedAuthorizeQuestion()
    const answered = await answerScope(question)
    // 约束要求 expires_at > created_at；把它压到接近现在，再等过期限。
    await database.db
      .update(schema.workMandates)
      .set({ expiresAt: new Date(Date.now() + 3_000) })
      .where(eq(schema.workMandates.id, initialMandateId))
    await new Promise((resolve) => setTimeout(resolve, 3_200))
    const expired = await apiInject(ctx, alice, {
      method: 'POST',
      url: confirmUrl(answered.scopeProposal.id),
      idempotencyKey: idemKey(),
    })
    expect(expired.statusCode).toBe(409)
    expect(expired.json().error.code).toBe('DECISION_STALE')
    expect(expired.json().error.details.reason).toBe('mandate_inactive')
    expect(
      await database.db
        .select()
        .from(schema.workMandates)
        .where(eq(schema.workMandates.workKey, workKey)),
    ).toHaveLength(1)
  })

  it('refuses confirmation when the base mandate advanced without a pending supersede', async () => {
    const question = await seedAuthorizeQuestion()
    const answered = await answerScope(question)
    const replacement = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/mandates`,
      payload: scopePayload({ maxRunsPerWork: 3 }),
      idempotencyKey: idemKey(),
    })
    expect(replacement.statusCode, replacement.body).toBe(201)
    // 模拟崩溃/旧数据：新版本已经建立，但旧提案仍 pending、问题仍处于已答状态。
    await database.db
      .update(schema.workMandateProposals)
      .set({ status: 'pending', closedAt: null, updatedAt: new Date() })
      .where(eq(schema.workMandateProposals.id, answered.scopeProposal.id))
    await database.db
      .update(schema.workQuestions)
      .set({ status: 'answered', updatedAt: new Date() })
      .where(eq(schema.workQuestions.id, question.id))
    const confirm = await apiInject(ctx, alice, {
      method: 'POST',
      url: confirmUrl(answered.scopeProposal.id),
      idempotencyKey: idemKey(),
    })
    expect(confirm.statusCode).toBe(409)
    expect(confirm.json().error.code).toBe('DECISION_STALE')
    expect(confirm.json().error.details.reason).toBe('mandate_changed')
    expect(
      await database.db
        .select()
        .from(schema.workMandates)
        .where(eq(schema.workMandates.workKey, workKey)),
    ).toHaveLength(2)
  })

  it('refuses confirmation after the work is retired', async () => {
    const question = await seedAuthorizeQuestion()
    const answered = await answerScope(question)
    const retired = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/retire`,
    })
    expect(retired.statusCode).toBe(200)
    const afterRetire = await apiInject(ctx, alice, {
      method: 'POST',
      url: confirmUrl(answered.scopeProposal.id),
      idempotencyKey: idemKey(),
    })
    expect(afterRetire.statusCode).toBe(409)
    expect(afterRetire.json().error.code).toBe('DECISION_STALE')
    expect(
      await database.db
        .select()
        .from(schema.workMandates)
        .where(eq(schema.workMandates.workKey, workKey)),
    ).toHaveLength(1)
  })

  it('returns DECISION_STALE to the reassigned owner and hides the proposal from the new assignee', async () => {
    const question = await seedAuthorizeQuestion()
    const answered = await answerScope(question)
    const reassign = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/reassign`,
      payload: { assigneeUserId: bob.userId },
      idempotencyKey: idemKey(),
    })
    expect(reassign.statusCode, reassign.body).toBe(200)

    const stale = await apiInject(ctx, alice, {
      method: 'POST',
      url: confirmUrl(answered.scopeProposal.id),
      idempotencyKey: idemKey(),
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('DECISION_STALE')
    expect(stale.json().error.details.reason).toBe('assignee_changed')
    expect(
      await database.db
        .select()
        .from(schema.workMandates)
        .where(eq(schema.workMandates.workKey, workKey)),
    ).toHaveLength(1)

    const accept = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/accept`,
    })
    expect(accept.statusCode, accept.body).toBe(200)
    const bobDetail = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/works/${workKey}`,
    })
    expect(bobDetail.statusCode, bobDetail.body).toBe(200)
    expect(bobDetail.json().data.pendingMandateProposals).toEqual([])
    expect(bobDetail.json().data.openQuestions).toEqual([])

    // 新责任人显式承接工作（RD-03d1）时，旧草案随旧版本一起收口。
    const workAccept = await apiInject(ctx, bob, {
      method: 'POST',
      url: `/api/v1/works/${workKey}/accept`,
      payload: scopePayload(),
      idempotencyKey: idemKey(),
    })
    expect(workAccept.statusCode, workAccept.body).toBe(201)
    const [superseded] = await database.db
      .select()
      .from(schema.workMandateProposals)
      .where(eq(schema.workMandateProposals.id, answered.scopeProposal.id))
    expect(superseded).toMatchObject({ status: 'superseded' })
  })

  it('reports a repeated confirmation as not current after a newer mandate version', async () => {
    const question = await seedAuthorizeQuestion()
    const answered = await answerScope(question)
    const key = idemKey()
    const confirmed = await apiInject(ctx, alice, {
      method: 'POST',
      url: confirmUrl(answered.scopeProposal.id),
      idempotencyKey: key,
    })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    const confirmedMandate = confirmed.json().data.mandate as { id: string; version: number }
    expect(confirmedMandate.version).toBe(2)
    const paused = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/mandates/${confirmedMandate.id}/pause`,
      payload: {},
      idempotencyKey: idemKey(),
    })
    expect(paused.statusCode, paused.body).toBe(200)
    expect(paused.json().data.version).toBe(3)

    for (const confirmationKey of [key, idemKey()]) {
      const replay = await apiInject(ctx, alice, {
        method: 'POST',
        url: confirmUrl(answered.scopeProposal.id),
        idempotencyKey: confirmationKey,
      })
      expect(replay.statusCode, replay.body).toBe(200)
      expect(replay.json().data.mandate).toMatchObject({
        id: confirmedMandate.id,
        version: 2,
        current: false,
      })
    }
    const detail = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}`,
    })
    expect(detail.json().data.currentMandate).toMatchObject({ version: 3, status: 'paused' })
  })

  it('supersedes a pending proposal when the task becomes full_access', async () => {
    const question = await seedAuthorizeQuestion()
    const answered = await answerScope(question)
    const patched = await apiInject(ctx, alice, {
      method: 'PATCH',
      url: `/api/v1/tasks/${taskId}`,
      payload: { approvalPolicy: 'full_access' },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    const [proposal] = await database.db
      .select()
      .from(schema.workMandateProposals)
      .where(eq(schema.workMandateProposals.id, answered.scopeProposal.id))
    expect(proposal).toMatchObject({ status: 'superseded' })
    const detail = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}`,
    })
    expect(detail.json().data.pendingMandateProposals).toEqual([])
  })

  it('supersedes a pending proposal when the task reaches a terminal state', async () => {
    const question = await seedAuthorizeQuestion()
    const answered = await answerScope(question)
    const cancelled = await apiInject(ctx, alice, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/cancel`,
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    const [proposal] = await database.db
      .select()
      .from(schema.workMandateProposals)
      .where(eq(schema.workMandateProposals.id, answered.scopeProposal.id))
    expect(proposal).toMatchObject({ status: 'superseded' })
    const detail = await apiInject(ctx, alice, {
      method: 'GET',
      url: `/api/v1/works/${workKey}`,
    })
    expect(detail.json().data.pendingMandateProposals).toEqual([])
  })

  it('refuses confirmation while the work is waiting', async () => {
    const question = await seedAuthorizeQuestion()
    const answered = await answerScope(question)
    await database.db
      .update(schema.works)
      .set({ state: 'waiting', resumeMode: 'auto', resumeCondition: 'test_wait' })
      .where(eq(schema.works.workKey, workKey))
    const confirm = await apiInject(ctx, alice, {
      method: 'POST',
      url: confirmUrl(answered.scopeProposal.id),
      idempotencyKey: idemKey(),
    })
    expect(confirm.statusCode).toBe(409)
    expect(confirm.json().error.code).toBe('DECISION_STALE')
    expect(confirm.json().error.details.reason).toBe('work_inactive')
  })

  it('refuses confirmation after the answered scope itself expires', async () => {
    const question = await seedAuthorizeQuestion()
    const answered = await answerScope(
      question,
      scopePayload({ expiresAt: new Date(Date.now() + 3_000).toISOString() }),
    )
    await new Promise((resolve) => setTimeout(resolve, 3_200))
    const confirm = await apiInject(ctx, alice, {
      method: 'POST',
      url: confirmUrl(answered.scopeProposal.id),
      idempotencyKey: idemKey(),
    })
    expect(confirm.statusCode).toBe(409)
    expect(confirm.json().error.code).toBe('DECISION_STALE')
    expect(confirm.json().error.details.reason).toBe('scope_invalid')
    expect(
      await database.db
        .select()
        .from(schema.workMandates)
        .where(eq(schema.workMandates.workKey, workKey)),
    ).toHaveLength(1)
  })

  it('refuses confirmation when the task policy changed to full_access', async () => {
    const question = await seedAuthorizeQuestion()
    const answered = await answerScope(question)
    await database.db
      .update(schema.tasks)
      .set({ approvalPolicy: 'full_access' })
      .where(eq(schema.tasks.id, taskId))
    const confirm = await apiInject(ctx, alice, {
      method: 'POST',
      url: confirmUrl(answered.scopeProposal.id),
      idempotencyKey: idemKey(),
    })
    expect(confirm.statusCode).toBe(409)
    expect(confirm.json().error.code).toBe('DECISION_STALE')
    expect(confirm.json().error.details.reason).toBe('task_policy_changed')
    expect(
      await database.db
        .select()
        .from(schema.workMandates)
        .where(eq(schema.workMandates.workKey, workKey)),
    ).toHaveLength(1)
  })

  it('does not expose another member pending proposal in the work detail', async () => {
    const question = await seedAuthorizeQuestion()
    await answerScope(question)
    // 模拟改派进行中：Task 已指向 bob，但旧 work/草案尚未由生命周期路径收口。
    await database.db
      .update(schema.tasks)
      .set({ assigneeUserId: bob.userId, assignmentStatus: 'accepted' })
      .where(eq(schema.tasks.id, taskId))
    const bobDetail = await apiInject(ctx, bob, {
      method: 'GET',
      url: `/api/v1/works/${workKey}`,
    })
    expect(bobDetail.statusCode, bobDetail.body).toBe(200)
    expect(bobDetail.json().data.pendingMandateProposals).toEqual([])
    expect(bobDetail.json().data.openQuestions).toEqual([])
  })

  it('replays a pre-#517 answer receipt without a scopeProposal field', async () => {
    const question = await seedAuthorizeQuestion({
      questionType: 'choose_option',
      options: [{ id: 'retry', label: '稍后重试' }],
      recommendedOptionId: 'retry',
    })
    const payload = { answerType: 'choose_option', optionId: 'retry' }
    const key = idemKey()
    const commandKey = `work.question.answer:${workKey}:${question.decisionId}:${alice.userId}:${sha256Hex(canonicalJson(payload))}:${key}`
    const createdAt = new Date().toISOString()
    const legacyAnswerId = randomUUID()
    const legacyView = {
      question: {
        id: question.id,
        workKey,
        decisionId: question.decisionId,
        questionType: 'choose_option',
        blockedDecision: 'dispatch',
        summary: '旧回执',
        options: [{ id: 'retry', label: '稍后重试' }],
        recommendedOptionId: 'retry',
        refs: {},
        inputDigest: 'a'.repeat(64),
        mandateId: initialMandateId,
        mandateVersion: initialMandateVersion,
        principalUserId: alice.userId,
        dispatchIntentId: null,
        status: 'answered',
        createdAt,
        answeredAt: createdAt,
        closedAt: createdAt,
      },
      answer: {
        id: legacyAnswerId,
        decisionId: question.decisionId,
        answerType: 'choose_option',
        optionId: 'retry',
        binding: true,
        rejectionReason: null,
        createdAt,
      },
      reevaluate: true,
      deferred: false,
      intentCancelled: true,
    }
    await database.db.insert(schema.commandReceipts).values({ key: commandKey, result: legacyView })
    const replay = await apiInject(ctx, alice, {
      method: 'POST',
      url: answerUrl(question.decisionId),
      payload,
      idempotencyKey: key,
    })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().data.answer.id).toBe(legacyAnswerId)
    expect(replay.json().data.scopeProposal).toBeNull()
    expect(await database.db.select().from(schema.workQuestionAnswers)).toHaveLength(0)
  })

  it('converges concurrent same-key scope answers to one proposal', async () => {
    const question = await seedAuthorizeQuestion()
    const key = idemKey()
    const payload = { answerType: 'authorize_scope', scope: scopePayload() }
    const [first, second] = await Promise.all([
      apiInject(ctx, alice, {
        method: 'POST',
        url: answerUrl(question.decisionId),
        payload,
        idempotencyKey: key,
      }),
      apiInject(ctx, alice, {
        method: 'POST',
        url: answerUrl(question.decisionId),
        payload,
        idempotencyKey: key,
      }),
    ])
    expect(first.statusCode, first.body).toBe(200)
    expect(second.statusCode, second.body).toBe(200)
    expect(first.json().data.answer.id).toBe(second.json().data.answer.id)
    expect(first.json().data.scopeProposal.id).toBe(second.json().data.scopeProposal.id)
    expect(await database.db.select().from(schema.workMandateProposals)).toHaveLength(1)
    expect(await database.db.select().from(schema.workQuestionAnswers)).toHaveLength(1)
  })

  it('converges concurrent confirmations to exactly one new mandate version', async () => {
    const question = await seedAuthorizeQuestion()
    const answered = await answerScope(question)
    const [first, second] = await Promise.all([
      apiInject(ctx, alice, {
        method: 'POST',
        url: confirmUrl(answered.scopeProposal.id),
        idempotencyKey: idemKey(),
      }),
      apiInject(ctx, alice, {
        method: 'POST',
        url: confirmUrl(answered.scopeProposal.id),
        idempotencyKey: idemKey(),
      }),
    ])
    expect(first.statusCode, first.body).toBe(200)
    expect(second.statusCode, second.body).toBe(200)
    expect(first.json().data.mandate.id).toBe(second.json().data.mandate.id)
    expect(first.json().data.mandate.version).toBe(2)
    expect(
      await database.db
        .select()
        .from(schema.workMandates)
        .where(eq(schema.workMandates.workKey, workKey)),
    ).toHaveLength(2)
    const [proposal] = await database.db
      .select()
      .from(schema.workMandateProposals)
      .where(eq(schema.workMandateProposals.id, answered.scopeProposal.id))
    expect(proposal).toMatchObject({ status: 'confirmed' })
  })
})
