import type { DbHandle, ProjectSourceRow } from '@whalepod/db'
import { listProjectSources } from '@whalepod/db'
import type { ProjectSourceView } from '@whalepod/protocol'

/** 来源视图（ADR-0024 §10）：只含团队可读的生命周期与状态。 */
export function toSourceView(row: ProjectSourceRow): ProjectSourceView {
  return {
    id: row.id,
    projectId: row.projectId,
    platform: row.platform,
    kind: row.kind,
    displayLabel: row.displayLabel,
    collectorNodeId: row.collectorNodeId,
    shareScope: 'team',
    autoExtraction: row.autoExtraction,
    status: row.status,
    permissionState: row.permissionState,
    permissionCheckedAt: row.permissionCheckedAt?.toISOString() ?? null,
    permissionExpiresAt: row.permissionExpiresAt?.toISOString() ?? null,
    authorizationGeneration: row.authorizationGeneration,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    latestRevisionId: row.latestRevisionId,
    boundBy: row.boundBy,
    boundAt: row.boundAt.toISOString(),
    pausedAt: row.pausedAt?.toISOString() ?? null,
    unavailableAt: row.unavailableAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy,
    revokeReason: row.revokeReason,
  }
}

export async function listSourceViews(
  handle: DbHandle,
  projectId: string,
): Promise<ProjectSourceView[]> {
  return (await listProjectSources(handle, projectId)).map(toSourceView)
}
