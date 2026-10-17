/**
 * 下游 Run 的跨 Task 交接输入快照（#380；ADR-0017 §5）。
 *
 * 与同 Task 的 `artifact_input_manifest`（ADR-0016）**互不合并、语义互不借用**：
 * 独立列、独立路由、独立继承规则。这里固化的每条材料来自上游 Task 的**已发布**
 * 交付物，逐件带固定摘要（sha256/byteSize）；Node 下载时按此校验。
 *
 * 时点语义：
 * - 显式传 `handoffReceiptId`（只有会建 Run 的意图可以带）→ 以该 receipt 的
 *   上游版本重建固定清单（材料身份以**发布版本的系统块**为准，防止「发布后
 *   又被重发」的漂移）；
 * - 重跑/续跑未显式传 → **继承来源 Run 的快照**（材料固定，上游之后再发新版本
 *   不改任何历史 Run 的输入）；来源没有快照则如实为空；
 * - 全新执行未传 → null（不带交接输入）。
 */
import { inArray } from 'drizzle-orm'
import type { RunRow, TaskRow, Tx } from '@whalepod/db'
import { getHandoffReceipt, getHandoffRevision, getTask, schema } from '@whalepod/db'
import { HandoffInputManifestSchema, type HandoffInputManifest } from '@whalepod/protocol'
import { toManifestEntry } from '../artifact/queries.js'
import { RunCommandError } from './errors.js'

/** 调用方持 Task 行锁（与输入清单同一事务内固化）。 */
export async function snapshotHandoffInput(
  tx: Tx,
  task: TaskRow,
  receiptId: string | undefined,
  source?: RunRow,
): Promise<HandoffInputManifest | null> {
  if (receiptId === undefined) {
    if (source === undefined || source.handoffInput === null) return null
    // 继承来源快照：原样复制（parse 只做形状自证，不改写）；上游新版本不改它。
    return HandoffInputManifestSchema.parse(source.handoffInput)
  }

  const receipt = await getHandoffReceipt(tx, receiptId.toLowerCase())
  // 非本任务/不存在一律 404（receipt 团队可见，但「不是你的下游」不构成可用输入）。
  if (receipt === undefined || receipt.downstreamTaskId !== task.id) {
    throw new RunCommandError('NOT_FOUND', 'handoff receipt not found for this task')
  }
  if (receipt.status !== 'confirmed') {
    throw new RunCommandError('CONFLICT', '交接接收尚未确认；请先确认这次准备做什么再执行')
  }
  // 交接包属于接收人：责任人被改派后旧 receipt 不再自动喂给新责任人。
  if (receipt.receiverUserId !== task.assigneeUserId) {
    throw new RunCommandError('CONFLICT', '交接包的接收人已不是本任务责任人')
  }
  const upstream = await getTask(tx, receipt.upstreamTaskId)
  if (upstream === undefined || upstream.projectId !== task.projectId) {
    throw new RunCommandError('NOT_FOUND', 'upstream task not found in this project')
  }
  const revision = await getHandoffRevision(tx, receipt.revisionId)
  if (revision === undefined || revision.taskId !== upstream.id) {
    throw new RunCommandError('NOT_FOUND', 'handoff revision not found')
  }

  // 材料身份以发布版本的系统块为准，摘要与媒体信息回读 Artifact 行复核
  // （已发布 Artifact 不可变；行缺失或不再 published = 材料不可用，fail-closed）。
  const entries = revision.content.system.artifacts
  if (entries.length > 0) {
    const rows = await tx
      .select()
      .from(schema.artifacts)
      .where(
        inArray(
          schema.artifacts.id,
          entries.map((entry) => entry.artifactId),
        ),
      )
    const byId = new Map(rows.map((row) => [row.id, row]))
    for (const entry of entries) {
      const row = byId.get(entry.artifactId)
      if (row === undefined || row.status !== 'published') {
        throw new RunCommandError('CONFLICT', '交接材料已不可用（未发布或已不存在）')
      }
      if (row.sha256 !== entry.sha256 || Number(row.byteSize) !== entry.byteSize) {
        throw new RunCommandError('CONFLICT', '交接材料与发布版本摘要不一致')
      }
    }
    return HandoffInputManifestSchema.parse({
      upstreamTaskId: upstream.id,
      upstreamTaskTitle: upstream.title,
      receiptId: receipt.id,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      artifacts: entries.map((entry) => toManifestEntry(byId.get(entry.artifactId)!)),
    })
  }
  return HandoffInputManifestSchema.parse({
    upstreamTaskId: upstream.id,
    upstreamTaskTitle: upstream.title,
    receiptId: receipt.id,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    artifacts: [],
  })
}

/** NULL = 本条 Run 不带交接输入（新列；旧 Run 一律如此，不回填）。 */
export function savedHandoffInput(run: RunRow): HandoffInputManifest | null {
  if (run.handoffInput === null) return null
  const manifest = HandoffInputManifestSchema.parse(run.handoffInput)
  return manifest
}
