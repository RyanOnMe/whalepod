import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import {
  coordinationEvaluations,
  projectCoordinatorStates,
  type CoordinationEvaluationRow,
  type NewCoordinationEvaluationRow,
  type ProjectCoordinatorStateRow,
} from '../schema/coordination.js'

export type {
  CoordinationEvaluationRow,
  NewCoordinationEvaluationRow,
  ProjectCoordinatorStateRow,
} from '../schema/coordination.js'

// ADR-0026（PC-04a）：确定性协调的持久化原语。状态迁移与规则由 Hub 命令层裁决；
// 「同项目至多一条 queued / 同输入一条 completed」由部分唯一索引兜底。

export async function ensureCoordinatorState(
  handle: DbHandle,
  values: {
    readonly projectId: string
    readonly rulesVersion: string
    readonly processorVersion: string
  },
): Promise<ProjectCoordinatorStateRow> {
  await handle
    .insert(projectCoordinatorStates)
    .values({
      projectId: values.projectId,
      enabled: true,
      rulesVersion: values.rulesVersion,
      processorVersion: values.processorVersion,
    })
    .onConflictDoNothing()
  const state = await getCoordinatorState(handle, values.projectId)
  if (state === undefined) throw new Error('coordinator state insert lost without conflict row')
  return state
}

export async function getCoordinatorState(
  handle: DbHandle,
  projectId: string,
): Promise<ProjectCoordinatorStateRow | undefined> {
  const [row] = await handle
    .select()
    .from(projectCoordinatorStates)
    .where(eq(projectCoordinatorStates.projectId, projectId))
  return row
}

export async function getCoordinatorStateForUpdate(
  handle: DbHandle,
  projectId: string,
): Promise<ProjectCoordinatorStateRow | undefined> {
  const [row] = await handle
    .select()
    .from(projectCoordinatorStates)
    .where(eq(projectCoordinatorStates.projectId, projectId))
    .for('update')
  return row
}

export type CoordinatorStatePatch = Partial<typeof projectCoordinatorStates.$inferInsert>

export async function updateCoordinatorState(
  handle: DbHandle,
  projectId: string,
  patch: CoordinatorStatePatch,
): Promise<ProjectCoordinatorStateRow | undefined> {
  const [row] = await handle
    .update(projectCoordinatorStates)
    .set({ ...patch, updatedAt: patch.updatedAt ?? new Date() })
    .where(eq(projectCoordinatorStates.projectId, projectId))
    .returning()
  return row
}

export async function insertEvaluation(
  handle: DbHandle,
  values: NewCoordinationEvaluationRow,
): Promise<CoordinationEvaluationRow> {
  const [row] = await handle.insert(coordinationEvaluations).values(values).returning()
  if (row === undefined) throw new Error('insert coordination evaluation returned no row')
  return row
}

export async function getEvaluation(
  handle: DbHandle,
  id: string,
): Promise<CoordinationEvaluationRow | undefined> {
  const [row] = await handle
    .select()
    .from(coordinationEvaluations)
    .where(eq(coordinationEvaluations.id, id))
  return row
}

export async function getEvaluationForUpdate(
  handle: DbHandle,
  id: string,
): Promise<CoordinationEvaluationRow | undefined> {
  const [row] = await handle
    .select()
    .from(coordinationEvaluations)
    .where(eq(coordinationEvaluations.id, id))
    .for('update')
  return row
}

export type EvaluationPatch = Partial<typeof coordinationEvaluations.$inferInsert>

export async function updateEvaluation(
  handle: DbHandle,
  id: string,
  patch: EvaluationPatch,
): Promise<CoordinationEvaluationRow | undefined> {
  const [row] = await handle
    .update(coordinationEvaluations)
    .set({ ...patch, updatedAt: patch.updatedAt ?? new Date() })
    .where(eq(coordinationEvaluations.id, id))
    .returning()
  return row
}

export async function findQueuedEvaluationForUpdate(
  handle: DbHandle,
  projectId: string,
): Promise<CoordinationEvaluationRow | undefined> {
  const [row] = await handle
    .select()
    .from(coordinationEvaluations)
    .where(
      and(
        eq(coordinationEvaluations.projectId, projectId),
        eq(coordinationEvaluations.purpose, 'inference'),
        eq(coordinationEvaluations.status, 'queued'),
      ),
    )
    .for('update')
  return row
}

export async function findCompletedEvaluationForInput(
  handle: DbHandle,
  projectId: string,
  inputDigest: string,
): Promise<CoordinationEvaluationRow | undefined> {
  const [row] = await handle
    .select()
    .from(coordinationEvaluations)
    .where(
      and(
        eq(coordinationEvaluations.projectId, projectId),
        eq(coordinationEvaluations.purpose, 'inference'),
        eq(coordinationEvaluations.inputDigest, inputDigest),
        eq(coordinationEvaluations.status, 'completed'),
      ),
    )
  return row
}

export async function maxAttemptForInput(
  handle: DbHandle,
  projectId: string,
  inputDigest: string,
): Promise<number> {
  const [row] = await handle
    .select({ value: sql<number>`coalesce(max(${coordinationEvaluations.attempt}), 0)` })
    .from(coordinationEvaluations)
    .where(
      and(
        eq(coordinationEvaluations.projectId, projectId),
        eq(coordinationEvaluations.purpose, 'inference'),
        eq(coordinationEvaluations.inputDigest, inputDigest),
      ),
    )
  return Number(row?.value ?? 0)
}

export async function latestCompletedEvaluation(
  handle: DbHandle,
  projectId: string,
): Promise<CoordinationEvaluationRow | undefined> {
  const [row] = await handle
    .select()
    .from(coordinationEvaluations)
    .where(
      and(
        eq(coordinationEvaluations.projectId, projectId),
        eq(coordinationEvaluations.purpose, 'inference'),
        eq(coordinationEvaluations.status, 'completed'),
      ),
    )
    .orderBy(desc(coordinationEvaluations.finishedAt), desc(coordinationEvaluations.id))
    .limit(1)
  return row
}

export async function listRecentEvaluations(
  handle: DbHandle,
  projectId: string,
  limit = 10,
): Promise<CoordinationEvaluationRow[]> {
  return handle
    .select()
    .from(coordinationEvaluations)
    .where(
      and(
        eq(coordinationEvaluations.projectId, projectId),
        eq(coordinationEvaluations.purpose, 'inference'),
      ),
    )
    .orderBy(desc(coordinationEvaluations.createdAt), desc(coordinationEvaluations.id))
    .limit(limit)
}

/** tick：未过期 queued 按入队时间升序，至多 limit 条。 */
export async function listDueQueuedEvaluations(
  handle: DbHandle,
  now: Date,
  limit: number,
): Promise<CoordinationEvaluationRow[]> {
  return handle
    .select()
    .from(coordinationEvaluations)
    .where(
      and(
        eq(coordinationEvaluations.status, 'queued'),
        eq(coordinationEvaluations.purpose, 'inference'),
        gte(coordinationEvaluations.queueExpiresAt, now),
      ),
    )
    .orderBy(asc(coordinationEvaluations.queuedAt), asc(coordinationEvaluations.id))
    .limit(limit)
}

/** tick：已过期 queued（stale_queue）。 */
export async function listExpiredQueuedEvaluations(
  handle: DbHandle,
  now: Date,
  limit: number,
): Promise<CoordinationEvaluationRow[]> {
  return handle
    .select()
    .from(coordinationEvaluations)
    .where(
      and(
        eq(coordinationEvaluations.status, 'queued'),
        eq(coordinationEvaluations.purpose, 'inference'),
        lt(coordinationEvaluations.queueExpiresAt, now),
      ),
    )
    .orderBy(asc(coordinationEvaluations.queuedAt), asc(coordinationEvaluations.id))
    .limit(limit)
}
