import type { ContextEntryRow, DbHandle } from '@whalepod/db'
import { countCoordinationInputEntries, listCoordinationInputEntries } from '@whalepod/db'
import { sha256Hex, canonicalJson } from './digest.js'
import {
  COORDINATION_INPUT_MAX_BYTES,
  COORDINATION_INPUT_MAX_ENTRIES,
  COORDINATION_PROCESSOR_VERSION,
  COORDINATION_RULES_VERSION,
} from './rules.js'

export interface CoordinationInputEntry {
  readonly id: string
  readonly kind: ContextEntryRow['kind']
  readonly businessRef: string | null
  readonly businessVersion: string | null
  readonly correctedAt: string | null
  readonly createdAt: string
  readonly bodyBytes: number
}

export interface CoordinationInput {
  /** 放入 digest 的条目清单（按 id 排序，只含不透明 id/类型/版本/时间）。 */
  readonly manifestEntries: readonly CoordinationInputEntry[]
  /** 实际参与求值的条目（按 createdAt 升序，正文可读）。 */
  readonly selected: readonly ContextEntryRow[]
  readonly inputDigest: string
  readonly manifest: Record<string, unknown>
  readonly omittedCount: number
  readonly truncated: boolean
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * 读取项目当前有效集的协调输入。
 *
 * 输入身份覆盖：条目身份/类型/业务坐标/纠正时间 + 规则与处理器版本 + 显式省略。
 * 超出 32 条或 256KiB 的部分进入 omittedCount；抓取页内未选中的条目 id 一并入清单，
 * 不静默丢弃（ADR-0026 §5）。
 */
export async function loadCoordinationInput(
  handle: DbHandle,
  projectId: string,
): Promise<CoordinationInput> {
  const page = await listCoordinationInputEntries(handle, projectId, COORDINATION_INPUT_MAX_ENTRIES)
  const total = await countCoordinationInputEntries(handle, projectId)
  const selected: ContextEntryRow[] = []
  let bytes = 0
  for (const row of page) {
    const rowBytes = Buffer.byteLength(row.body, 'utf8')
    if (bytes + rowBytes > COORDINATION_INPUT_MAX_BYTES) break
    bytes += rowBytes
    selected.push(row)
  }
  const selectedIds = new Set(selected.map((row) => row.id))
  const omittedEntryIds = page
    .filter((row) => !selectedIds.has(row.id))
    .map((row) => row.id)
    .sort(compareCodePoints)
  const manifestEntries = selected
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      businessRef: row.businessRef,
      businessVersion: row.businessVersion,
      correctedAt: row.correctedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      bodyBytes: Buffer.byteLength(row.body, 'utf8'),
    }))
    .sort((left, right) => compareCodePoints(left.id, right.id))
  const omittedCount = Math.max(0, total - selected.length)
  const inputDigest = sha256Hex(
    canonicalJson({
      projectId,
      rulesVersion: COORDINATION_RULES_VERSION,
      processorVersion: COORDINATION_PROCESSOR_VERSION,
      entries: manifestEntries,
      omittedEntryIds,
      omittedCount,
    }),
  )
  return {
    manifestEntries,
    selected: [...selected].sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        compareCodePoints(left.id, right.id),
    ),
    inputDigest,
    manifest: {
      entries: manifestEntries,
      omittedEntryIds,
      omittedCount,
      truncated: omittedCount > 0,
      rulesVersion: COORDINATION_RULES_VERSION,
      processorVersion: COORDINATION_PROCESSOR_VERSION,
      maxEntries: COORDINATION_INPUT_MAX_ENTRIES,
      maxBytes: COORDINATION_INPUT_MAX_BYTES,
    },
    omittedCount,
    truncated: omittedCount > 0,
  }
}
