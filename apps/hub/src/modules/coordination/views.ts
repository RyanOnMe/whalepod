import type { CoordinationEvaluationRow, ProjectCoordinatorStateRow } from '@whalepod/db'
import type { CoordinationEvaluationView, ProjectCoordinatorStateView } from '@whalepod/protocol'
import { COORDINATION_PROCESSOR_VERSION, COORDINATION_RULES_VERSION } from './rules.js'

export function toEvaluationView(row: CoordinationEvaluationRow): CoordinationEvaluationView {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    attempt: row.attempt,
    inputDigest: row.inputDigest,
    manifestVersion: row.manifestVersion,
    rulesVersion: row.rulesVersion,
    processorVersion: row.processorVersion,
    queuedAt: row.queuedAt.toISOString(),
    queueExpiresAt: row.queueExpiresAt.toISOString(),
    coalescedAt: row.coalescedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    failureCode: row.failureCode,
    failureSummary: row.failureSummary,
    inferenceEntryId: row.inferenceEntryId,
    createdAt: row.createdAt.toISOString(),
  }
}

export function toCoordinatorStateView(
  projectId: string,
  state: ProjectCoordinatorStateRow | undefined,
): ProjectCoordinatorStateView {
  return {
    projectId,
    enabled: state?.enabled ?? true,
    rulesVersion: state?.rulesVersion ?? COORDINATION_RULES_VERSION,
    processorVersion: state?.processorVersion ?? COORDINATION_PROCESSOR_VERSION,
    lastSuccessfulEvaluationId: state?.lastSuccessfulEvaluationId ?? null,
    pausedAt: state?.pausedAt?.toISOString() ?? null,
    pauseReason: state?.pauseReason ?? null,
  }
}
