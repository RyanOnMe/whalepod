/**
 * ADR-0025 §1/§5：人工纠正追加写。
 *
 * Correction 只由成员 HTTP 命令写；不修改目标条目正文/引用/status，只写目标行
 * `correctedAt` 作为「退出当前有效集」的派生标记。同一目标重复纠正返回既有行。
 */
import type { Database } from '@whalepod/db'
import {
  findCorrectionForTarget,
  getContextEntryForUpdate,
  insertContextEntry,
  Outbox,
  transactCommandWithOrigin,
  updateContextEntry,
} from '@whalepod/db'
import type { CorrectContextEntryRequest, ProjectContextEntryView } from '@whalepod/protocol'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { toContextEntryView } from './queries.js'
import { clipContextText } from './projector.js'
import { enqueueCoordinationEvaluation } from '../coordination/enqueue.js'
import { admitContextCorrection, workEntryDeps } from '../work/entry.js'
import { refreshRunContextStateForEntry } from './state.js'

export interface ContextActor {
  readonly userId: string
  readonly role: 'owner' | 'admin' | 'member'
}

export interface CorrectContextEntryResult {
  readonly view: ProjectContextEntryView
  /** false = 同 key 重放或目标已纠正（返回既有行）；观测日志只记 true。 */
  readonly created: boolean
}

export async function correctContextEntry(
  database: Database,
  actor: ContextActor,
  projectId: string,
  entryId: string,
  input: CorrectContextEntryRequest,
  idempotencyKey: string,
): Promise<CorrectContextEntryResult> {
  const commandKey = `context.correct:${actor.userId}:${projectId}:${entryId}:${idempotencyKey}`
  let inserted = false
  const outcome = await transactCommandWithOrigin<ProjectContextEntryView>(
    database,
    commandKey,
    async (tx) => {
      const target = await getContextEntryForUpdate(tx, entryId)
      if (target === undefined || target.projectId !== projectId) {
        throw new ApiError(404, 'NOT_FOUND', 'context entry not found')
      }
      if (target.kind === 'correction') {
        throw new ApiError(409, 'CONFLICT', 'a correction cannot be corrected')
      }
      if (target.correctedAt !== null) {
        const existing = await findCorrectionForTarget(tx, target.id)
        if (existing === undefined) {
          throw new ApiError(409, 'CONFLICT', 'entry is already corrected')
        }
        return toContextEntryView(existing, [])
      }
      const now = new Date()
      const correction = await insertContextEntry(tx, {
        id: uuidv7(),
        projectId,
        kind: 'correction',
        status: 'active',
        title: clipContextText(`人工纠正：${target.title}`, 200),
        body: clipContextText(input.note, 60_000),
        payload: { correctionKind: input.correctionKind },
        targetEntryId: target.id,
        actorKind: 'member',
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      await updateContextEntry(tx, target.id, { correctedAt: now })
      // 纠正改变当前有效集 → 同事务合并一次协调评估（ADR-0026 §2）。
      await enqueueCoordinationEvaluation(tx, projectId, now)
      // ADR-0027 §6（PC-05b）：活跃 Run 的快照入口随之撤回，并下发完整状态。
      await refreshRunContextStateForEntry(
        tx,
        { database, outbox: new Outbox(database), now: () => now },
        target.id,
        now,
      )
      // ADR-0028（RD-02b）：纠正也是业务引用订阅的补充。
      await admitContextCorrection(tx, correction, target, workEntryDeps(tx, now))
      inserted = true
      return toContextEntryView(correction, [])
    },
  )
  return { view: outcome.value, created: outcome.executed && inserted }
}
