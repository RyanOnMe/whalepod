/**
 * ADR-0027（PC-05a）：Run 创建事务内冻结项目上下文快照。
 *
 * 选择规则固定在 `pc05a.v1`：
 * - 本 Task 当前约定（`taskSpec:<taskId>`）、本 Task 成果（`artifact:<id>`）与本 Task
 *   参与的交接接收（`handoffReceipt:<up>:<down>`）的当前有效 Decision；
 * - 与本 Task 的运行存在归属关系的当前有效 Observation（`run:<id>`）；
 * - Inference/Correction 永不选入。
 *
 * 只取有效版本，不静默截断：单条超 64KiB、合计超 32 条/256KiB 的条目进入
 * `unselected` 清单并写明原因。header/digest 在创建事务内生成并持久化。
 */
import type { Database, RunRow, Tx } from '@whalepod/db'
import {
  getContextEntry,
  getRunProjectContextByRun,
  insertRunProjectContext,
  insertRunProjectContextEntries,
  listRunProjectContextEntries,
  schema,
} from '@whalepod/db'
import type { ContextEntryRow, DeviceRow } from '@whalepod/db'
import {
  CONTEXT_STATE_CAPABILITY,
  PROJECT_CONTEXT_CAPABILITY,
  PROJECT_CONTEXT_HEADER_MAX_CHARS,
  PROJECT_CONTEXT_MAX_ENTRIES,
  PROJECT_CONTEXT_MAX_ENTRY_BYTES,
  PROJECT_CONTEXT_MAX_TOTAL_BYTES,
  PROJECT_CONTEXT_MAX_UNSELECTED_DETAIL,
  type ProjectContextUnselected,
  type ProjectContextUnselectedOmitted,
  type ProjectContextUnselectedReason,
  type RunProjectContextBundle,
  type RunProjectContextEntryStatus,
  type RunProjectContextEntryView,
  type RunProjectContextView,
  type RunStartProjectContext,
} from '@whalepod/protocol'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { RunCommandError } from '../run/errors.js'
import { uuidv7 } from '../shared/uuid.js'
import { deriveRunContextStateReadOnly, verifyRunContextStateFrozen } from './state.js'

export const RUN_PROJECT_CONTEXT_SELECTION_RULE_VERSION = 'pc05a.v1' as const

export interface CreateRunProjectContextInput {
  readonly runId: string
  readonly projectId: string
  readonly taskId: string
  readonly now: Date
}

export interface CreatedRunProjectContext {
  readonly snapshotId: string
  readonly start: RunStartProjectContext | undefined
}

/** ADR-0027 §4：nonce 由快照 digest 与 Run 身份确定，随 headerText 进入首条请求。 */
export function projectContextNonce(snapshotDigest: string, runId: string): string {
  return sha256Hex(`${snapshotDigest}|${runId}`).slice(0, 16)
}

function clipCodePoints(value: string, max: number): string {
  const points = Array.from(value)
  return points.length <= max ? value : `${points.slice(0, Math.max(0, max - 1)).join('')}…`
}

function decisionPriority(entry: ContextEntryRow): number {
  if (entry.businessRef?.startsWith('taskSpec:')) return 0
  if (entry.businessRef?.startsWith('handoffReceipt:')) return 1
  if (entry.businessRef?.startsWith('artifact:')) return 2
  return 3
}

function selectionPriority(entry: ContextEntryRow): number {
  return entry.kind === 'decision' ? decisionPriority(entry) : 4
}

function buildHeader(
  snapshotId: string,
  runId: string,
  snapshotDigest: string,
  entries: readonly { entryId: string; kind: string; title: string; entryVersion: string }[],
  totalBytes: number,
  unselectedCount: number,
): { headerText: string; headerDigest: string; nonce: string } {
  const nonce = projectContextNonce(snapshotDigest, runId)
  const lines = [
    `[project-context:${nonce}]`,
    `项目上下文快照 ${snapshotId}：${entries.length} 条，${totalBytes} 字节。`,
    ...entries.map(
      (entry) =>
        `- ${entry.entryId} ${entry.kind} ${clipCodePoints(entry.title, 60)} (v${entry.entryVersion})`,
    ),
    '用 read_project_context 按 entryId 读取条目正文；这是本次执行的固定依据，后续变化不会自动替换。',
    ...(unselectedCount > 0 ? [`另有 ${unselectedCount} 条未纳入，原因见快照。`] : []),
  ]
  const headerText = lines.join('\n')
  // 与 zod `.max()` 同一计量（UTF-16 code units）：否则 astral 字符标题可能在这里
  // 通过、到 RunStartSchema.parse 才 500——合法输入不该看起来像服务端故障。
  if (headerText.length > PROJECT_CONTEXT_HEADER_MAX_CHARS) {
    throw new RunCommandError(
      'CONTEXT_UNAVAILABLE',
      '项目上下文快照头超过 4000 字符，请缩小任务上下文后重试',
    )
  }
  return { headerText, headerDigest: sha256Hex(headerText), nonce }
}

async function currentEntriesForTask(tx: Tx, taskId: string): Promise<ContextEntryRow[]> {
  const [artifacts, receipts, runs] = await Promise.all([
    tx
      .select({ id: schema.artifacts.id })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.taskId, taskId)),
    // 交接可能由本 Task 接收（downstream），也可能由本 Task 交付（upstream）。
    tx
      .select({
        upstreamTaskId: schema.handoffReceipts.upstreamTaskId,
        downstreamTaskId: schema.handoffReceipts.downstreamTaskId,
      })
      .from(schema.handoffReceipts)
      .where(
        or(
          eq(schema.handoffReceipts.upstreamTaskId, taskId),
          eq(schema.handoffReceipts.downstreamTaskId, taskId),
        ),
      ),
    tx.select({ id: schema.runs.id }).from(schema.runs).where(eq(schema.runs.taskId, taskId)),
  ])

  const decisionRefs = [
    `taskSpec:${taskId}`,
    ...artifacts.map((row) => `artifact:${row.id}`),
    ...receipts.map((row) => `handoffReceipt:${row.upstreamTaskId}:${row.downstreamTaskId}`),
  ]
  const observationRefs = runs.map((row) => `run:${row.id}`)

  const [decisions, observations] = await Promise.all([
    tx
      .select()
      .from(schema.contextEntries)
      .where(
        and(
          eq(schema.contextEntries.kind, 'decision'),
          eq(schema.contextEntries.status, 'active'),
          isNull(schema.contextEntries.correctedAt),
          inArray(schema.contextEntries.businessRef, [...new Set(decisionRefs)]),
        ),
      ),
    observationRefs.length === 0
      ? Promise.resolve([])
      : tx
          .select()
          .from(schema.contextEntries)
          .where(
            and(
              eq(schema.contextEntries.kind, 'observation'),
              eq(schema.contextEntries.status, 'active'),
              isNull(schema.contextEntries.correctedAt),
              inArray(schema.contextEntries.businessRef, observationRefs),
            ),
          ),
  ])

  return [...decisions, ...observations]
}

export async function createRunProjectContext(
  tx: Tx,
  input: CreateRunProjectContextInput,
): Promise<CreatedRunProjectContext> {
  const snapshotId = uuidv7()
  const candidates = (await currentEntriesForTask(tx, input.taskId)).sort((a, b) => {
    const priority = selectionPriority(a) - selectionPriority(b)
    if (priority !== 0) return priority
    const created = a.createdAt.getTime() - b.createdAt.getTime()
    return created !== 0 ? created : a.id.localeCompare(b.id)
  })

  const unselected: ProjectContextUnselected[] = []
  const selected: {
    row: ContextEntryRow
    digest: string
    byteSize: number
  }[] = []
  let totalBytes = 0

  for (const row of candidates) {
    // Decision/Observation 的业务条目必须带 businessVersion；无版本的来源行由
    // 后续切片按来源规则处理，不在本切片冒充可执行依据。
    if (row.businessVersion === null) {
      unselected.push({ entryId: row.id, reason: 'conflict' })
      continue
    }
    const byteSize = Buffer.byteLength(row.body, 'utf8')
    if (byteSize > PROJECT_CONTEXT_MAX_ENTRY_BYTES) {
      unselected.push({ entryId: row.id, reason: 'entry_too_large' })
      continue
    }
    if (selected.length >= PROJECT_CONTEXT_MAX_ENTRIES) {
      unselected.push({ entryId: row.id, reason: 'capacity_exceeded' })
      continue
    }
    if (totalBytes + byteSize > PROJECT_CONTEXT_MAX_TOTAL_BYTES) {
      unselected.push({ entryId: row.id, reason: 'capacity_exceeded' })
      continue
    }
    selected.push({ row, digest: sha256Hex(row.body), byteSize })
    totalBytes += byteSize
  }

  // 候选条目数理论上不设死上限（项目越久越多），明细若全量落库会把 Run 创建拖进
  // 16KiB 列约束的 500 里。超出上限的部分按原因聚合计数：既不截断事实，
  // 也不让容量问题变成建 Run 的失败原因（评审 B3）。
  const unselectedDetail = unselected.slice(0, PROJECT_CONTEXT_MAX_UNSELECTED_DETAIL)
  const unselectedOmitted: ProjectContextUnselectedOmitted = {}
  for (const { reason } of unselected.slice(PROJECT_CONTEXT_MAX_UNSELECTED_DETAIL)) {
    const key = reason satisfies ProjectContextUnselectedReason
    unselectedOmitted[key] = (unselectedOmitted[key] ?? 0) + 1
  }

  const digestItems = selected
    .map(({ row, digest }) => ({ entryId: row.id, kind: row.kind, digest }))
    .sort((a, b) => a.entryId.localeCompare(b.entryId))
  const snapshotDigest = sha256Hex(
    canonicalJson({
      selectionRuleVersion: RUN_PROJECT_CONTEXT_SELECTION_RULE_VERSION,
      entries: digestItems,
    }),
  )
  const header = buildHeader(
    snapshotId,
    input.runId,
    snapshotDigest,
    selected.map(({ row }) => ({
      entryId: row.id,
      kind: row.kind,
      title: row.title,
      entryVersion: row.businessVersion ?? '',
    })),
    totalBytes,
    unselected.length,
  )

  await insertRunProjectContext(tx, {
    id: snapshotId,
    runId: input.runId,
    projectId: input.projectId,
    selectionRuleVersion: RUN_PROJECT_CONTEXT_SELECTION_RULE_VERSION,
    snapshotDigest,
    headerText: header.headerText,
    headerDigest: header.headerDigest,
    entryCount: selected.length,
    totalBytes,
    unselected: unselectedDetail,
    unselectedOmitted,
    status: 'frozen',
    createdAt: input.now,
  })
  await insertRunProjectContextEntries(
    tx,
    selected.map(({ row, digest, byteSize }) => ({
      snapshotId,
      entryId: row.id,
      entryVersion: row.businessVersion!,
      kind: row.kind as 'observation' | 'decision',
      citation: row.businessRef === null ? ('source' as const) : ('business' as const),
      sourceId: row.sourceId,
      revisionId: row.revisionId,
      threadId: row.threadId,
      businessRef: row.businessRef,
      // PC-05a 只选内部业务引用；来源 Observation 的代次由后续切片接入。
      authorizationGeneration: null,
      digest,
      byteSize,
      title: row.title,
      body: row.body,
      entryStatus: 'frozen',
      statusReason: null,
      permissionStateAtSelection: 'authorized',
      identityUnverified: false,
      selectedByMemberId: null,
    })),
  )

  if (selected.length === 0) return { snapshotId, start: undefined }
  return {
    snapshotId,
    start: {
      snapshotId,
      digest: snapshotDigest,
      headerText: header.headerText,
      headerDigest: header.headerDigest,
      manifest: selected.map(({ row, digest, byteSize }) => ({
        entryId: row.id,
        kind: row.kind as 'observation' | 'decision',
        title: row.title,
        revisionId: row.revisionId,
        businessRef: row.businessRef,
        digest,
        byteSize,
        snapshotAuthorizationGeneration: null,
      })),
    },
  }
}

export function contextCapabilitiesOf(device: Pick<DeviceRow, 'capabilities'>): string[] {
  const capabilities = device.capabilities
  if (typeof capabilities !== 'object' || capabilities === null) return []
  const raw = (capabilities as { contextCapabilities?: unknown }).contextCapabilities
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is string => typeof value === 'string')
}

export function assertProjectContextCapability(
  device: Pick<DeviceRow, 'capabilities'>,
  entryCount: number,
): void {
  if (entryCount === 0) return
  const capabilities = contextCapabilitiesOf(device)
  if (
    !capabilities.includes(PROJECT_CONTEXT_CAPABILITY) ||
    !capabilities.includes(CONTEXT_STATE_CAPABILITY)
  ) {
    throw new RunCommandError(
      'CONTEXT_UNAVAILABLE',
      '目标 Node 未同时声明 project-context.v1 与 context-state.v1，不能执行带项目上下文的 Run',
    )
  }
}

export type RunProjectContextVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * 创建后、`run.start` 前复核：冻结正文/头部 digest 未损坏，引用的条目仍是当前
 * 有效版本，且目标 Node 仍声明能力。任一失败 → 现有派发失败路径（不换版本、
 * 不静默丢条目）。
 */
export async function verifyRunProjectContext(
  tx: Tx,
  run: RunRow,
): Promise<RunProjectContextVerification> {
  const snapshot = await getRunProjectContextByRun(tx, run.id)
  if (snapshot === undefined) return { ok: true } // 迁移前创建的历史 Run
  if (snapshot.entryCount > 0) {
    const [device] = await tx
      .select({ capabilities: schema.devices.capabilities })
      .from(schema.devices)
      .where(eq(schema.devices.id, run.deviceId))
    if (
      device === undefined ||
      !contextCapabilitiesOf(device).includes(PROJECT_CONTEXT_CAPABILITY) ||
      !contextCapabilitiesOf(device).includes(CONTEXT_STATE_CAPABILITY)
    ) {
      return { ok: false, reason: 'node_capability_missing' }
    }
  }
  if (sha256Hex(snapshot.headerText) !== snapshot.headerDigest) {
    return { ok: false, reason: 'header_digest_mismatch' }
  }
  const entries = await listRunProjectContextEntries(tx, snapshot.id)
  if (entries.length !== snapshot.entryCount) return { ok: false, reason: 'entry_count_mismatch' }
  const digestItems = entries
    .map((entry) => ({ entryId: entry.entryId, kind: entry.kind, digest: entry.digest }))
    .sort((a, b) => a.entryId.localeCompare(b.entryId))
  if (
    sha256Hex(
      canonicalJson({
        selectionRuleVersion: snapshot.selectionRuleVersion,
        entries: digestItems,
      }),
    ) !== snapshot.snapshotDigest
  ) {
    return { ok: false, reason: 'snapshot_digest_mismatch' }
  }
  for (const entry of entries) {
    if (
      sha256Hex(entry.body) !== entry.digest ||
      Buffer.byteLength(entry.body, 'utf8') !== entry.byteSize
    ) {
      return { ok: false, reason: 'entry_digest_mismatch' }
    }
    const current = await getContextEntry(tx, entry.entryId)
    if (
      current === undefined ||
      current.kind !== entry.kind ||
      current.status !== 'active' ||
      current.correctedAt !== null ||
      current.businessVersion !== entry.entryVersion
    ) {
      return { ok: false, reason: 'entry_changed' }
    }
    if (entry.kind === 'decision') {
      const [active] = await tx
        .select({ id: schema.contextEntries.id })
        .from(schema.contextEntries)
        .where(
          and(
            eq(schema.contextEntries.kind, 'decision'),
            eq(schema.contextEntries.businessRef, entry.businessRef!),
            eq(schema.contextEntries.status, 'active'),
            isNull(schema.contextEntries.correctedAt),
          ),
        )
      if (active?.id !== entry.entryId) return { ok: false, reason: 'entry_changed' }
    }
  }
  // ADR-0027 §6（PC-05b）：撤权状态机已把来源/权限变化写回入口行；派发前
  // 不得把非 frozen 快照交给 Node。
  const state = await verifyRunContextStateFrozen(tx, run.id)
  if (!state.ok) return state
  return { ok: true }
}

export function toRunProjectContextView(
  snapshot: {
    readonly id: string
    readonly selectionRuleVersion: string
    readonly snapshotDigest: string
    readonly headerDigest: string
    readonly entryCount: number
    readonly totalBytes: number
    readonly unselected: unknown[]
    readonly unselectedOmitted: Partial<Record<string, number>>
    readonly status: 'frozen' | 'partially_unavailable' | 'invalidated'
    readonly deliveredAt: Date | null
    readonly consumedAt: Date | null
    readonly consumedAllAt: Date | null
  },
  entries: readonly {
    readonly entryId: string
    readonly kind: 'observation' | 'decision'
    readonly entryVersion: string
    readonly title: string
    readonly body: string
    readonly digest: string
    readonly byteSize: number
    readonly businessRef: string | null
    readonly revisionId: string | null
    readonly threadId: string | null
    readonly entryStatus: RunProjectContextEntryStatus
    readonly statusReason: string | null
    readonly identityUnverified: boolean
    readonly deliveredAt: Date | null
    readonly readAt: Date | null
  }[],
): RunProjectContextView {
  const views: RunProjectContextEntryView[] = entries.map((entry) => ({
    entryId: entry.entryId,
    kind: entry.kind,
    entryVersion: entry.entryVersion,
    title: entry.title,
    body: entry.entryStatus === 'frozen' ? entry.body : null,
    digest: entry.digest,
    byteSize: entry.byteSize,
    businessRef: entry.businessRef,
    revisionId: entry.revisionId,
    threadId: entry.threadId,
    entryStatus: entry.entryStatus,
    statusReason: entry.statusReason,
    identityUnverified: entry.identityUnverified,
    deliveredAt: entry.deliveredAt?.toISOString() ?? null,
    readAt: entry.readAt?.toISOString() ?? null,
  }))
  return {
    snapshotId: snapshot.id,
    selectionRuleVersion: snapshot.selectionRuleVersion,
    snapshotDigest: snapshot.snapshotDigest,
    headerDigest: snapshot.headerDigest,
    entryCount: snapshot.entryCount,
    totalBytes: snapshot.totalBytes,
    unselected: snapshot.unselected as ProjectContextUnselected[],
    unselectedOmitted: snapshot.unselectedOmitted as ProjectContextUnselectedOmitted,
    status: snapshot.status,
    deliveredAt: snapshot.deliveredAt?.toISOString() ?? null,
    consumedAt: snapshot.consumedAt?.toISOString() ?? null,
    consumedAllAt: snapshot.consumedAllAt?.toISOString() ?? null,
    unavailable: snapshot.status !== 'frozen',
    entries: views,
  }
}

/**
 * ADR-0027 §6（PC-05b）：成员读面按当前事实派生，而不是信任上次 tick 落库的
 * entryStatus。终态 Run 不在状态同步的活跃集合里，若只读持久化行，纠正/撤权后
 * 历史页仍会返回正文——这正是 §9 负控要求不可读的路径。
 */
export async function buildRunProjectContextView(
  database: Database,
  runId: string,
  now: Date = new Date(),
): Promise<RunProjectContextView | undefined> {
  return database.transaction(async (tx) => {
    const snapshot = await getRunProjectContextByRun(tx, runId)
    if (snapshot === undefined) return undefined
    const derived = await deriveRunContextStateReadOnly(tx, snapshot.id, now)
    const entries = await listRunProjectContextEntries(tx, snapshot.id)
    if (derived === undefined) return undefined
    const byId = new Map(derived.entries.map((entry) => [entry.entryId, entry]))
    return toRunProjectContextView(
      { ...snapshot, status: derived.status },
      entries.map((entry) => {
        const state = byId.get(entry.entryId)
        return {
          ...entry,
          entryStatus: state?.state ?? 'unavailable',
          statusReason: state?.reason ?? 'entry_state_missing',
        }
      }),
    )
  })
}

export async function buildRunProjectContextBundle(
  database: Database,
  runId: string,
): Promise<RunProjectContextBundle | undefined> {
  return database.transaction(async (tx) => {
    const snapshot = await getRunProjectContextByRun(tx, runId)
    if (snapshot === undefined) return undefined
    // ADR-0027 §6（PC-05b）：下载前按当前来源/纠正状态重新派生；不依赖
    // 周期 tick 是否已经落库，撤销后不得再交付正文。
    const derived = await deriveRunContextStateReadOnly(tx, snapshot.id, new Date())
    if (
      derived === undefined ||
      derived.status !== 'frozen' ||
      derived.entries.some((entry) => entry.state !== 'frozen')
    ) {
      throw new RunCommandError('CONTEXT_UNAVAILABLE', '项目上下文快照含不可读条目')
    }
    const entries = await listRunProjectContextEntries(tx, snapshot.id)
    if (entries.some((entry) => entry.entryStatus !== 'frozen')) {
      throw new RunCommandError('CONTEXT_UNAVAILABLE', '项目上下文快照含不可读条目')
    }
    return {
      snapshotId: snapshot.id,
      digest: snapshot.snapshotDigest,
      headerText: snapshot.headerText,
      headerDigest: snapshot.headerDigest,
      entries: entries.map((entry) => ({
        entryId: entry.entryId,
        kind: entry.kind,
        title: entry.title,
        digest: entry.digest,
        byteSize: entry.byteSize,
        bodyBase64: Buffer.from(entry.body, 'utf8').toString('base64'),
      })),
    }
  })
}
