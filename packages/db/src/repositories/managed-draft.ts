import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { Tx } from '../client.js'
import { managedDraftSourcePolicies as policies } from '../schema/managed-draft.js'

/** Call in the Task reassignment transaction. A prior registration never becomes active again. */
export async function revokeManagedDraftSourcesForTask(
  tx: Tx,
  taskId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(policies)
    .set({ revokedAt: sql`greatest(${policies.createdAt}, ${now.toISOString()}::timestamptz)` })
    .where(and(eq(policies.taskId, taskId), isNull(policies.revokedAt)))
}

/** Call while the member deactivation holds its user-row lock. */
export async function revokeManagedDraftSourcesForMember(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(policies)
    .set({ revokedAt: sql`greatest(${policies.createdAt}, ${now.toISOString()}::timestamptz)` })
    .where(
      and(
        or(eq(policies.ownerUserId, userId), eq(policies.recipientUserId, userId)),
        isNull(policies.revokedAt),
      ),
    )
}
