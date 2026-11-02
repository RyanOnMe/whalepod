import type { DbHandle } from '@whalepod/db'
import {
  getContextEntry,
  getCoordinatorState,
  getEvaluation,
  latestCompletedEvaluation,
  listContextCitations,
  listCurrentContextEntriesByBusinessRefs,
  listRecentEvaluations,
} from '@whalepod/db'
import type { CoordinationOpenQuestionView, ProjectCoordinationView } from '@whalepod/protocol'
import { CoordinationOpenQuestionViewSchema } from '@whalepod/protocol'
import { toContextEntryView } from '../context/queries.js'
import { toCoordinatorStateView, toEvaluationView } from './views.js'

function openQuestionsFrom(payload: Record<string, unknown>): CoordinationOpenQuestionView[] {
  const raw = payload.openQuestions
  if (!Array.isArray(raw)) return []
  const out: CoordinationOpenQuestionView[] = []
  for (const item of raw) {
    const parsed = CoordinationOpenQuestionViewSchema.safeParse(item)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/** 协调读面：状态 + 最近评估 + 最近一条 Inference（含引用）+ 开放问题。 */
export async function loadProjectCoordination(
  handle: DbHandle,
  projectId: string,
): Promise<ProjectCoordinationView> {
  const [state, recent, latestCompleted] = await Promise.all([
    getCoordinatorState(handle, projectId),
    listRecentEvaluations(handle, projectId, 1),
    latestCompletedEvaluation(handle, projectId),
  ])
  // 状态指针是「最近成功」的权威：finishedAt 是调用方在锁外的时刻，锁竞争下可能乱序。
  const pointed =
    state?.lastSuccessfulEvaluationId != null
      ? await getEvaluation(handle, state.lastSuccessfulEvaluationId)
      : undefined
  const completed =
    pointed !== undefined && pointed.status === 'completed' ? pointed : latestCompleted
  const inference =
    completed?.inferenceEntryId != null
      ? await getContextEntry(handle, completed.inferenceEntryId)
      : undefined
  // 被成员纠正的 Inference 退出读面（与事实账本同一「当前有效」口径）。
  let visibleInference =
    inference !== undefined && inference.status === 'active' && inference.correctedAt === null
      ? inference
      : undefined
  const citations =
    visibleInference !== undefined ? await listContextCitations(handle, [visibleInference.id]) : []
  if (visibleInference !== undefined) {
    // 引用的事实若已被纠正/被新版本取代，旧结论不再代表「当前」，整条退出读面。
    const business = citations.filter(
      (citation) =>
        citation.kind === 'business' &&
        citation.businessRef !== null &&
        citation.businessVersion !== null,
    )
    if (business.length === 0) {
      visibleInference = undefined
    } else {
      const current = await listCurrentContextEntriesByBusinessRefs(
        handle,
        projectId,
        business.map((citation) => citation.businessRef ?? ''),
      )
      const currentKeys = new Set(
        current.map((entry) => `${entry.businessRef}|${entry.businessVersion}`),
      )
      if (
        business.some(
          (citation) => !currentKeys.has(`${citation.businessRef}|${citation.businessVersion}`),
        )
      ) {
        visibleInference = undefined
      }
    }
  }
  return {
    projectId,
    state: toCoordinatorStateView(projectId, state),
    latestEvaluation: recent[0] !== undefined ? toEvaluationView(recent[0]) : null,
    latestInference:
      visibleInference !== undefined ? toContextEntryView(visibleInference, citations) : null,
    openQuestions:
      visibleInference !== undefined ? openQuestionsFrom(visibleInference.payload) : [],
  }
}
