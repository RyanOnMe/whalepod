/**
 * ADR-0030 RD-04b：预授权立项的持久化原语。
 *
 * 这里只做单表读写与唯一约束兜底；事实门、槽位门和事务锁序由 Hub 命令层裁决。
 * 槽位占用（discovery_slot_occupation.slot_id unique）同时服务人工认领与自动立项。
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from 'drizzle-orm'
import type { TaskSpecContent } from '@whalepod/protocol'
import type { DbHandle } from '../client.js'
import {
  discoveryApplications,
  discoveryCandidates,
  discoveryExecutionSources,
  discoveryExecutions,
  discoveryPermits,
  discoverySlotOccupations,
  discoverySlotVerifications,
  discoverySlots,
  discoverySourceBindings,
  discoverySourceCorrections,
  discoveryVerifications,
  type DiscoveryApplicationVerification,
  type DiscoveryExecutionRow,
  type DiscoveryExecutionSourceKind,
  type DiscoveryExecutionSourceRow,
  type DiscoverySlotCatalogEntry,
  type DiscoverySlotVerificationEntry,
} from '../schema/discovery.js'
import { artifacts } from '../schema/artifact.js'
import { taskMessages, taskSpecRevisions } from '../schema/project.js'

export type DiscoverySlotRow = typeof discoverySlots.$inferSelect
export type DiscoveryPermitRow = typeof discoveryPermits.$inferSelect
export type DiscoverySlotVerificationRow = typeof discoverySlotVerifications.$inferSelect
export type DiscoveryVerificationRow = typeof discoveryVerifications.$inferSelect
export type DiscoveryApplicationRow = typeof discoveryApplications.$inferSelect
export type DiscoverySlotOccupationRow = typeof discoverySlotOccupations.$inferSelect
export type DiscoverySourceBindingRow = typeof discoverySourceBindings.$inferSelect
export type DiscoverySourceCorrectionRow = typeof discoverySourceCorrections.$inferSelect

export async function getOrCreateDiscoverySlot(
  handle: DbHandle,
  input: {
    readonly id: string
    readonly projectId: string
    readonly activity: string
    readonly slot: string
    readonly now: Date
  },
): Promise<DiscoverySlotRow> {
  const [existing] = await handle
    .select()
    .from(discoverySlots)
    .where(
      and(
        eq(discoverySlots.projectId, input.projectId),
        eq(discoverySlots.activity, input.activity),
        eq(discoverySlots.slot, input.slot),
      ),
    )
  if (existing !== undefined) return existing
  const [inserted] = await handle
    .insert(discoverySlots)
    .values({
      id: input.id,
      projectId: input.projectId,
      activity: input.activity,
      slot: input.slot,
      generation: 0,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({
      target: [discoverySlots.projectId, discoverySlots.activity, discoverySlots.slot],
    })
    .returning()
  if (inserted !== undefined) return inserted
  const [raced] = await handle
    .select()
    .from(discoverySlots)
    .where(
      and(
        eq(discoverySlots.projectId, input.projectId),
        eq(discoverySlots.activity, input.activity),
        eq(discoverySlots.slot, input.slot),
      ),
    )
  if (raced === undefined) throw new Error('discovery slot vanished after insert conflict')
  return raced
}

export async function findDiscoverySlot(
  handle: DbHandle,
  projectId: string,
  activity: string,
  slot: string,
): Promise<DiscoverySlotRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoverySlots)
    .where(
      and(
        eq(discoverySlots.projectId, projectId),
        eq(discoverySlots.activity, activity),
        eq(discoverySlots.slot, slot),
      ),
    )
  return row
}

export async function getDiscoverySlot(
  handle: DbHandle,
  id: string,
): Promise<DiscoverySlotRow | undefined> {
  const [row] = await handle.select().from(discoverySlots).where(eq(discoverySlots.id, id))
  return row
}

export async function getDiscoverySlotForUpdate(
  handle: DbHandle,
  id: string,
): Promise<DiscoverySlotRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoverySlots)
    .where(eq(discoverySlots.id, id))
    .for('update')
  return row
}

/**
 * 目录写入推进代次前，按 id 顺序锁住项目全部槽位行。
 * 立项/人工认领会先锁单个槽位再推进代次；若不先按同一顺序锁全量，
 * 多槽位项目里两个事务会各持一行互相等待（40P01）。
 */
export async function lockDiscoveryProjectSlots(
  handle: DbHandle,
  projectId: string,
): Promise<void> {
  await handle
    .select({ id: discoverySlots.id })
    .from(discoverySlots)
    .where(eq(discoverySlots.projectId, projectId))
    .orderBy(asc(discoverySlots.id))
    .for('update')
}

/** 目录写入推进代次：任何人工新建、改派、范围变更或成果发布都令旧核对失效。 */
export async function advanceDiscoveryCatalogGeneration(
  handle: DbHandle,
  projectId: string,
  now: Date,
): Promise<void> {
  await lockDiscoveryProjectSlots(handle, projectId)
  await handle
    .update(discoverySlots)
    .set({ generation: sql`${discoverySlots.generation} + 1`, updatedAt: now })
    .where(eq(discoverySlots.projectId, projectId))
}

export async function getActiveDiscoveryPermit(
  handle: DbHandle,
  projectId: string,
  principalUserId: string,
  configVersion: number,
): Promise<DiscoveryPermitRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoveryPermits)
    .where(
      and(
        eq(discoveryPermits.projectId, projectId),
        eq(discoveryPermits.principalUserId, principalUserId),
        eq(discoveryPermits.configVersion, configVersion),
        isNull(discoveryPermits.revokedAt),
      ),
    )
    .orderBy(desc(discoveryPermits.version))
    .limit(1)
  return row
}

export async function getDiscoveryPermit(
  handle: DbHandle,
  id: string,
): Promise<DiscoveryPermitRow | undefined> {
  const [row] = await handle.select().from(discoveryPermits).where(eq(discoveryPermits.id, id))
  return row
}

export async function getDiscoveryPermitForUpdate(
  handle: DbHandle,
  id: string,
): Promise<DiscoveryPermitRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoveryPermits)
    .where(eq(discoveryPermits.id, id))
    .for('update')
  return row
}

export async function insertDiscoveryPermit(
  handle: DbHandle,
  values: typeof discoveryPermits.$inferInsert,
): Promise<DiscoveryPermitRow> {
  const [row] = await handle.insert(discoveryPermits).values(values).returning()
  if (row === undefined) throw new Error('insert discovery permit returned no row')
  return row
}

export async function revokeDiscoveryPermits(
  handle: DbHandle,
  input: {
    readonly projectId: string
    readonly principalUserId?: string
    readonly reason: string
    readonly now: Date
  },
): Promise<void> {
  await handle
    .update(discoveryPermits)
    .set({ revokedAt: input.now, revokedReason: input.reason })
    .where(
      and(
        eq(discoveryPermits.projectId, input.projectId),
        input.principalUserId === undefined
          ? undefined
          : eq(discoveryPermits.principalUserId, input.principalUserId),
        isNull(discoveryPermits.revokedAt),
      ),
    )
}

export async function insertDiscoverySlotVerification(
  handle: DbHandle,
  values: typeof discoverySlotVerifications.$inferInsert,
): Promise<DiscoverySlotVerificationRow> {
  const [row] = await handle.insert(discoverySlotVerifications).values(values).returning()
  if (row === undefined) throw new Error('insert discovery slot verification returned no row')
  return row
}

/** 同一代次内允许责任人更正分类；目录未变时重核是幂等覆盖，不产生第二行。 */
export async function upsertDiscoverySlotVerification(
  handle: DbHandle,
  values: typeof discoverySlotVerifications.$inferInsert,
): Promise<DiscoverySlotVerificationRow> {
  const [row] = await handle
    .insert(discoverySlotVerifications)
    .values(values)
    .onConflictDoUpdate({
      target: [discoverySlotVerifications.slotId, discoverySlotVerifications.generation],
      set: {
        catalogDigest: values.catalogDigest,
        entries: values.entries,
        verifiedBy: values.verifiedBy,
        permitId: values.permitId,
        permitVersion: values.permitVersion,
        verifiedAt: values.verifiedAt,
      },
    })
    .returning()
  if (row === undefined) throw new Error('upsert discovery slot verification returned no row')
  return row
}

export async function getCurrentSlotVerification(
  handle: DbHandle,
  slotId: string,
): Promise<DiscoverySlotVerificationRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoverySlotVerifications)
    .where(eq(discoverySlotVerifications.slotId, slotId))
    .orderBy(desc(discoverySlotVerifications.generation))
    .limit(1)
  return row
}

export async function insertDiscoveryVerification(
  handle: DbHandle,
  values: typeof discoveryVerifications.$inferInsert,
): Promise<DiscoveryVerificationRow> {
  const [row] = await handle.insert(discoveryVerifications).values(values).returning()
  if (row === undefined) throw new Error('insert discovery verification returned no row')
  return row
}

export async function getCurrentDiscoveryReceipt(
  handle: DbHandle,
  input: {
    readonly sourceId: string
    readonly slotId: string
    readonly permitId: string
    readonly verifierUserId: string
  },
): Promise<DiscoveryVerificationRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoveryVerifications)
    .where(
      and(
        eq(discoveryVerifications.sourceId, input.sourceId),
        eq(discoveryVerifications.slotId, input.slotId),
        eq(discoveryVerifications.permitId, input.permitId),
        eq(discoveryVerifications.verifierUserId, input.verifierUserId),
        isNull(discoveryVerifications.revokedAt),
      ),
    )
  return row
}

export async function listCurrentDiscoveryReceipts(
  handle: DbHandle,
  input: { readonly sourceId: string; readonly slotId: string; readonly permitId: string },
): Promise<DiscoveryVerificationRow[]> {
  return handle
    .select()
    .from(discoveryVerifications)
    .where(
      and(
        eq(discoveryVerifications.sourceId, input.sourceId),
        eq(discoveryVerifications.slotId, input.slotId),
        eq(discoveryVerifications.permitId, input.permitId),
        isNull(discoveryVerifications.revokedAt),
      ),
    )
    .orderBy(desc(discoveryVerifications.createdAt))
}

export async function revokeDiscoveryVerificationsForSource(
  handle: DbHandle,
  sourceId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await handle
    .update(discoveryVerifications)
    .set({ revokedAt: now, revokedReason: reason })
    .where(
      and(eq(discoveryVerifications.sourceId, sourceId), isNull(discoveryVerifications.revokedAt)),
    )
}

export async function getDiscoverySlotOccupation(
  handle: DbHandle,
  slotId: string,
): Promise<DiscoverySlotOccupationRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoverySlotOccupations)
    .where(eq(discoverySlotOccupations.slotId, slotId))
  return row
}

export async function insertDiscoverySlotOccupation(
  handle: DbHandle,
  values: typeof discoverySlotOccupations.$inferInsert,
): Promise<DiscoverySlotOccupationRow> {
  const [row] = await handle.insert(discoverySlotOccupations).values(values).returning()
  if (row === undefined) throw new Error('insert discovery slot occupation returned no row')
  return row
}

export async function getDiscoveryApplicationByEvaluation(
  handle: DbHandle,
  evaluationId: string,
): Promise<DiscoveryApplicationRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoveryApplications)
    .where(eq(discoveryApplications.evaluationId, evaluationId))
  return row
}

export async function getDiscoveryApplicationByWork(
  handle: DbHandle,
  workId: string,
): Promise<DiscoveryApplicationRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoveryApplications)
    .where(eq(discoveryApplications.workId, workId))
  return row
}

/** Quota is cumulative for the slot: re-confirming a permit does not reset the count. */
export async function countDiscoveryApplicationsForSlot(
  handle: DbHandle,
  slotId: string,
): Promise<number> {
  const [row] = await handle
    .select({ value: count() })
    .from(discoveryApplications)
    .where(
      and(eq(discoveryApplications.slotId, slotId), eq(discoveryApplications.status, 'applied')),
    )
  return row?.value ?? 0
}

export async function insertDiscoveryApplication(
  handle: DbHandle,
  values: typeof discoveryApplications.$inferInsert,
): Promise<DiscoveryApplicationRow> {
  const [row] = await handle.insert(discoveryApplications).values(values).returning()
  if (row === undefined) throw new Error('insert discovery application returned no row')
  return row
}

export async function insertDiscoverySourceBinding(
  handle: DbHandle,
  values: typeof discoverySourceBindings.$inferInsert,
): Promise<DiscoverySourceBindingRow> {
  const [row] = await handle.insert(discoverySourceBindings).values(values).returning()
  if (row === undefined) throw new Error('insert discovery source binding returned no row')
  return row
}

export async function getDiscoverySourceBindingByApplication(
  handle: DbHandle,
  applicationId: string,
): Promise<DiscoverySourceBindingRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoverySourceBindings)
    .where(eq(discoverySourceBindings.applicationId, applicationId))
  return row
}

/** 派生首份约定：status='derived'，不是正式确认版本。 */
export async function insertDerivedSpec(
  handle: DbHandle,
  input: {
    readonly id: string
    readonly taskId: string
    readonly content: TaskSpecContent
    readonly createdBy: string
    readonly createdAt: Date
  },
): Promise<typeof taskSpecRevisions.$inferSelect> {
  const [row] = await handle
    .insert(taskSpecRevisions)
    .values({
      id: input.id,
      taskId: input.taskId,
      status: 'derived',
      content: input.content,
      draftVersion: 1,
      origin: 'preauthorized_template',
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    })
    .returning()
  if (row === undefined) throw new Error('insert derived spec returned no row')
  return row
}

export async function getLatestSourceCorrection(
  handle: DbHandle,
  sourceId: string,
): Promise<DiscoverySourceCorrectionRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoverySourceCorrections)
    .where(eq(discoverySourceCorrections.sourceId, sourceId))
    .orderBy(desc(discoverySourceCorrections.version))
    .limit(1)
  return row
}

export async function insertSourceCorrection(
  handle: DbHandle,
  values: typeof discoverySourceCorrections.$inferInsert,
): Promise<DiscoverySourceCorrectionRow> {
  const [row] = await handle.insert(discoverySourceCorrections).values(values).returning()
  if (row === undefined) throw new Error('insert discovery source correction returned no row')
  return row
}

/** 待立项候选：跳过已应用、终态与仍在冷却期的行；调用方持有单条事务。 */
export async function listCandidatesAwaitingCreation(
  handle: DbHandle,
  now: Date,
  retryBefore: Date,
  limit: number,
): Promise<{ id: string; projectId: string }[]> {
  return handle
    .select({ id: discoveryCandidates.id, projectId: discoveryCandidates.projectId })
    .from(discoveryCandidates)
    .where(
      and(
        notExists(
          handle
            .select({ one: sql`1` })
            .from(discoveryApplications)
            .where(eq(discoveryApplications.candidateId, discoveryCandidates.id)),
        ),
        eq(discoveryCandidates.creationTerminal, false),
        or(
          isNull(discoveryCandidates.creationCheckedAt),
          lte(discoveryCandidates.creationCheckedAt, retryBefore),
        ),
        gt(discoveryCandidates.expiresAt, now),
      ),
    )
    .orderBy(asc(discoveryCandidates.createdAt), asc(discoveryCandidates.id))
    .limit(limit)
}

export async function markCandidateCreation(
  handle: DbHandle,
  input: {
    readonly id: string
    readonly reason: string
    readonly terminal: boolean
    readonly now: Date
  },
): Promise<void> {
  await handle
    .update(discoveryCandidates)
    .set({
      creationCheckedAt: input.now,
      creationReason: input.reason,
      creationTerminal: input.terminal,
    })
    .where(eq(discoveryCandidates.id, input.id))
}

export async function getDiscoveryCandidateById(
  handle: DbHandle,
  id: string,
): Promise<typeof discoveryCandidates.$inferSelect | undefined> {
  const [row] = await handle
    .select()
    .from(discoveryCandidates)
    .where(eq(discoveryCandidates.id, id))
  return row
}

/** Serialize application with revoke/correction/cleanup deleting the same candidate. */
export async function getDiscoveryCandidateForUpdate(
  handle: DbHandle,
  id: string,
): Promise<typeof discoveryCandidates.$inferSelect | undefined> {
  const [row] = await handle
    .select()
    .from(discoveryCandidates)
    .where(eq(discoveryCandidates.id, id))
    .for('update')
  return row
}

/** 供读模型展示：候选是否已经立项。 */
export async function getDiscoveryApplicationByCandidate(
  handle: DbHandle,
  candidateId: string,
): Promise<DiscoveryApplicationRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoveryApplications)
    .where(eq(discoveryApplications.candidateId, candidateId))
  return row
}

export async function listDiscoveryVerificationsByIds(
  handle: DbHandle,
  ids: readonly string[],
): Promise<DiscoveryVerificationRow[]> {
  if (ids.length === 0) return []
  return handle
    .select()
    .from(discoveryVerifications)
    .where(inArray(discoveryVerifications.id, [...ids]))
}

export async function getDiscoveryApplicationById(
  handle: DbHandle,
  id: string,
): Promise<DiscoveryApplicationRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoveryApplications)
    .where(eq(discoveryApplications.id, id))
  return row
}

export async function getDiscoveryExecutionByApplication(
  handle: DbHandle,
  applicationId: string,
): Promise<DiscoveryExecutionRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoveryExecutions)
    .where(eq(discoveryExecutions.applicationId, applicationId))
  return row
}

export async function getDiscoveryExecutionForUpdate(
  handle: DbHandle,
  applicationId: string,
): Promise<DiscoveryExecutionRow | undefined> {
  const [row] = await handle
    .select()
    .from(discoveryExecutions)
    .where(eq(discoveryExecutions.applicationId, applicationId))
    .for('update')
  return row
}

export async function listDiscoveryExecutionSources(
  handle: DbHandle,
  executionId: string,
): Promise<DiscoveryExecutionSourceRow[]> {
  return handle
    .select()
    .from(discoveryExecutionSources)
    .where(eq(discoveryExecutionSources.executionId, executionId))
    .orderBy(asc(discoveryExecutionSources.kind), asc(discoveryExecutionSources.sourceId))
}

export async function insertDiscoveryExecution(
  handle: DbHandle,
  values: typeof discoveryExecutions.$inferInsert,
): Promise<DiscoveryExecutionRow> {
  const [row] = await handle.insert(discoveryExecutions).values(values).returning()
  if (row === undefined) throw new Error('insert discovery execution returned no row')
  return row
}

export async function insertDiscoveryExecutionSources(
  handle: DbHandle,
  values: readonly (typeof discoveryExecutionSources.$inferInsert)[],
): Promise<void> {
  if (values.length === 0) throw new Error('discovery execution needs at least one source')
  await handle.insert(discoveryExecutionSources).values([...values])
}

export async function revokeDiscoveryExecution(
  handle: DbHandle,
  id: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const rows = await handle
    .update(discoveryExecutions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(discoveryExecutions.id, id), isNull(discoveryExecutions.revokedAt)))
    .returning({ id: discoveryExecutions.id })
  return rows.length > 0
}

export async function revokeDiscoveryExecutionsForProject(
  handle: DbHandle,
  projectId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await handle
    .update(discoveryExecutions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(discoveryExecutions.projectId, projectId), isNull(discoveryExecutions.revokedAt)))
}

export async function revokeDiscoveryExecutionsForTask(
  handle: DbHandle,
  taskId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await handle
    .update(discoveryExecutions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(discoveryExecutions.taskId, taskId), isNull(discoveryExecutions.revokedAt)))
}

export async function revokeDiscoveryExecutionsForWork(
  handle: DbHandle,
  workId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await handle
    .update(discoveryExecutions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(discoveryExecutions.workId, workId), isNull(discoveryExecutions.revokedAt)))
}

/** 成员停用：责任人、来源作者、佐证拥有者或核实人失去资格即撤销相关授权。 */
export async function revokeDiscoveryExecutionsForMember(
  handle: DbHandle,
  userId: string,
  reason: string,
  now: Date,
): Promise<void> {
  const matches = sql`${discoveryExecutions.revokedAt} is null and (
    ${discoveryExecutions.principalUserId} = ${userId}
    or ${discoveryExecutions.applicationId} in (
      select ${discoveryApplications.id}
      from ${discoveryApplications}
      join ${discoverySourceBindings}
        on ${discoverySourceBindings.applicationId} = ${discoveryApplications.id}
      join ${taskMessages} on ${taskMessages.id} = ${discoverySourceBindings.sourceId}
      where ${taskMessages.authorUserId} = ${userId}
    )
    or ${discoveryExecutions.id} in (
      select ${discoveryExecutionSources.executionId}
      from ${discoveryExecutionSources}
      left join ${artifacts}
        on ${discoveryExecutionSources.kind} = 'artifact'
        and ${artifacts.id} = ${discoveryExecutionSources.sourceId}
      left join ${discoveryVerifications}
        on ${discoveryExecutionSources.kind} = 'receipt'
        and ${discoveryVerifications.id} = ${discoveryExecutionSources.sourceId}
      where ${artifacts.ownerUserId} = ${userId}
        or ${discoveryVerifications.verifierUserId} = ${userId}
    )
  )`
  // Authorization holds the member row FOR SHARE, so disableUser either commits before the
  // consent checks or waits; taking Project locks here would invert that order.
  await handle
    .update(discoveryExecutions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(matches)
}

/** 来源更正/撤回只撤销引用该来源的授权，不误伤同项目其它来源。 */
export async function revokeDiscoveryExecutionsForSource(
  handle: DbHandle,
  sourceId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await handle
    .update(discoveryExecutions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(
      and(
        isNull(discoveryExecutions.revokedAt),
        inArray(
          discoveryExecutions.applicationId,
          handle
            .select({ id: discoveryApplications.id })
            .from(discoveryApplications)
            .where(eq(discoveryApplications.sourceId, sourceId)),
        ),
      ),
    )
}

export type {
  DiscoveryApplicationVerification,
  DiscoveryExecutionRow,
  DiscoveryExecutionSourceKind,
  DiscoveryExecutionSourceRow,
  DiscoverySlotCatalogEntry,
  DiscoverySlotVerificationEntry,
}
