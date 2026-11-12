import { and, eq } from 'drizzle-orm'
import type { Database, RunRow, Tx } from '@whalepod/db'
import {
  getDispatchIntent,
  getRetractedInboxItemForSource,
  getOrdinaryRun,
  getWorkByKey,
  getWorkMandate,
  schema,
} from '@whalepod/db'
import {
  WORK_INPUT_CAPABILITY,
  WORK_INPUT_MANIFEST_VERSION,
  WorkInputManifestSchema,
  type WorkInputBundle,
} from '@whalepod/protocol'
import { contextCapabilitiesOf } from '../context/run-snapshot.js'
import { RunCommandError } from '../run/errors.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { loadWorkSource } from './admission.js'

// ADR-0028（RD-02a-2b）：工作输入从 Run 清单到 Node 受控下载/派发前复核。
// 正文只在 bundle 响应里出现；清单不可变，复核只读当前交付指针与来源状态。

export function assertWorkInputCapability(
  device: { readonly capabilities: unknown },
  entryCount: number,
): void {
  if (entryCount === 0) return
  if (
    !contextCapabilitiesOf(device as { capabilities: Record<string, unknown> }).includes(
      WORK_INPUT_CAPABILITY,
    )
  ) {
    throw new RunCommandError(
      'CONTEXT_UNAVAILABLE',
      '目标 Node 未声明 work-input.v1，不能执行带工作输入的 Run',
    )
  }
}

export type WorkInputVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** 派发前来源身份核对：版本、摘要与授权代次三者都必须与冻结条目一致。 */
export function workSourceMatchesItem(
  source: {
    readonly sourceVersion: string
    readonly sourceDigest: string
    readonly authorizationGeneration: string
  },
  item: {
    readonly sourceVersion: string
    readonly sourceDigest: string
    readonly authorizationGeneration: string
  },
): boolean {
  return (
    source.sourceVersion === item.sourceVersion &&
    source.sourceDigest === item.sourceDigest &&
    source.authorizationGeneration === item.authorizationGeneration
  )
}

/**
 * RD-03a：机器 Run 的 Mandate/意图/Task 复核。撤权/新版本/改派后即使取消事务
 * 尚未到达，`run.start` 也不得发出；调用方把失败按“取消 queued Run”收敛。
 */
export async function verifyRunMachineDispatch(
  tx: Tx,
  run: RunRow,
  now: Date,
): Promise<WorkInputVerification> {
  if (run.origin !== 'mandate') return { ok: true }
  if (
    run.mandateId === null ||
    run.dispatchIntentId === null ||
    run.workKey === null ||
    run.onBehalfOfUserId === null
  ) {
    return { ok: false, reason: 'machine_provenance_missing' }
  }
  const intent = await getDispatchIntent(tx, run.dispatchIntentId)
  if (
    intent === undefined ||
    intent.status !== 'dispatched' ||
    intent.runId !== run.id ||
    intent.mandateId !== run.mandateId ||
    intent.workKey !== run.workKey ||
    intent.taskId !== run.taskId
  ) {
    return { ok: false, reason: 'dispatch_intent_unavailable' }
  }
  const mandate = await getWorkMandate(tx, run.mandateId)
  if (
    mandate === undefined ||
    mandate.status !== 'active' ||
    mandate.expiresAt.getTime() <= now.getTime()
  ) {
    return { ok: false, reason: 'mandate_invalidated' }
  }
  const work = await getWorkByKey(tx, run.workKey)
  if (
    work === undefined ||
    work.id !== intent.workId ||
    work.mandateId !== run.mandateId ||
    work.taskId !== run.taskId
  ) {
    return { ok: false, reason: 'work_mandate_changed' }
  }
  // work 必须仍允许本 Run：active，或派工事务为本 Run 写入的 waiting(auto, run:<id>)。
  // 没有 manifest 的机器 Run 不会走 verifyRunWorkInputs，这里漏掉 state 会让 retire /
  // waiting(owner_confirmation) 的 work 仍把 run.start 发出去。
  const waitingForThisRun =
    work.state === 'waiting' &&
    work.resumeMode === 'auto' &&
    work.resumeCondition === `run:${run.id}`
  if (work.state !== 'active' && !waitingForThisRun) {
    return { ok: false, reason: 'work_unavailable' }
  }
  const [task] = await tx
    .select({
      assigneeUserId: schema.tasks.assigneeUserId,
      assignmentStatus: schema.tasks.assignmentStatus,
      status: schema.tasks.status,
      approvalPolicy: schema.tasks.approvalPolicy,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, run.taskId))
  if (
    task === undefined ||
    task.assigneeUserId !== run.onBehalfOfUserId ||
    task.assignmentStatus !== 'accepted' ||
    task.status === 'done' ||
    task.status === 'cancelled' ||
    task.approvalPolicy === 'full_access' ||
    run.approvalPolicy === 'full_access'
  ) {
    return { ok: false, reason: 'task_unavailable' }
  }
  return { ok: true }
}

/** 创建后、run.start 前的复核：清单/交付指针/来源版本仍与冻结时一致。 */
export async function verifyRunWorkInputs(tx: Tx, run: RunRow): Promise<WorkInputVerification> {
  if (run.workInputManifest === null) return { ok: true }
  if (run.workKey === null || run.workInputManifestDigest === null) {
    return { ok: false, reason: 'manifest_pointer_missing' }
  }
  const parsed = WorkInputManifestSchema.safeParse(run.workInputManifest)
  if (!parsed.success) return { ok: false, reason: 'manifest_invalid' }
  const manifest = parsed.data
  if (manifest.workKey !== run.workKey) return { ok: false, reason: 'manifest_work_mismatch' }
  if (sha256Hex(canonicalJson(manifest)) !== run.workInputManifestDigest) {
    return { ok: false, reason: 'manifest_digest_mismatch' }
  }
  const [device] = await tx
    .select({ capabilities: schema.devices.capabilities })
    .from(schema.devices)
    .where(eq(schema.devices.id, run.deviceId))
  if (device === undefined || !contextCapabilitiesOf(device).includes(WORK_INPUT_CAPABILITY)) {
    return { ok: false, reason: 'node_capability_missing' }
  }
  const work = await getWorkByKey(tx, manifest.workKey)
  // RD-03a：派工事务把 work 置 waiting(auto, run:<id>) 表示“本 Run 正在执行”。
  // 这是本 Run 自己的等待态，不是不可用；其它 Run 或 owner_confirmation 仍拒绝。
  const waitingForThisRun =
    work?.state === 'waiting' &&
    work.resumeMode === 'auto' &&
    work.resumeCondition === `run:${run.id}`
  if (
    work === undefined ||
    work.taskId !== run.taskId ||
    (work.state !== 'active' && !waitingForThisRun)
  ) {
    return { ok: false, reason: 'work_unavailable' }
  }
  for (const entry of manifest.entries) {
    const [item] = await tx
      .select()
      .from(schema.workInboxItems)
      .where(eq(schema.workInboxItems.id, entry.inboxItemId))
    if (
      item === undefined ||
      item.workId !== work.id ||
      item.deliveryRunId !== run.id ||
      (item.status !== 'delivered' && item.status !== 'unconfirmed') ||
      item.sourceType !== entry.sourceType ||
      item.sourceId !== entry.sourceId ||
      item.sourceVersion !== entry.sourceVersion ||
      item.sourceDigest !== entry.sourceDigest ||
      item.bodyDigest !== entry.bodyDigest ||
      sha256Hex(item.body) !== entry.bodyDigest
    ) {
      return { ok: false, reason: 'item_unavailable' }
    }
    const [delivery] = await tx
      .select({ id: schema.workInboxDeliveries.id })
      .from(schema.workInboxDeliveries)
      .where(
        and(
          eq(schema.workInboxDeliveries.inboxItemId, item.id),
          eq(schema.workInboxDeliveries.runId, run.id),
        ),
      )
      .limit(1)
    if (delivery === undefined) return { ok: false, reason: 'delivery_missing' }
    const retracted = await getRetractedInboxItemForSource(
      tx,
      work.id,
      item.sourceType,
      item.sourceId,
    )
    if (retracted !== undefined) return { ok: false, reason: 'source_retracted' }
    try {
      const source = await loadWorkSource(tx, work, item.sourceType, item.sourceId)
      if (source.ignored !== undefined) return { ok: false, reason: 'source_unavailable' }
      if (!workSourceMatchesItem(source, item)) {
        return { ok: false, reason: 'source_stale' }
      }
    } catch {
      return { ok: false, reason: 'source_unavailable' }
    }
  }
  return { ok: true }
}

/** Node 受控下载：只返回本 Run 清单内、仍属于本 Run 的交付条目正文。 */
export async function buildRunWorkInputBundle(
  database: Database,
  runId: string,
  deviceId: string,
): Promise<RunWorkInputBundleResult> {
  const run = await getOrdinaryRun(database.db, runId)
  if (run === undefined || run.deviceId !== deviceId) return undefined
  if (run.discoveryExecutionId) return undefined
  if (run.workInputManifest === null || run.workInputManifestDigest === null) {
    return undefined
  }
  const parsed = WorkInputManifestSchema.safeParse(run.workInputManifest)
  if (!parsed.success) {
    throw new RunCommandError('CONTEXT_UNAVAILABLE', '工作输入清单损坏')
  }
  const manifest = parsed.data
  if (
    manifest.version !== WORK_INPUT_MANIFEST_VERSION ||
    sha256Hex(canonicalJson(manifest)) !== run.workInputManifestDigest
  ) {
    throw new RunCommandError('CONTEXT_UNAVAILABLE', '工作输入清单摘要不一致')
  }
  const entries: WorkInputBundle['entries'] = []
  for (const expected of manifest.entries) {
    const [item] = await database.db
      .select()
      .from(schema.workInboxItems)
      .where(eq(schema.workInboxItems.id, expected.inboxItemId))
      .for('share')
    if (
      item === undefined ||
      item.workKey !== manifest.workKey ||
      item.deliveryRunId !== runId ||
      (item.status !== 'delivered' && item.status !== 'unconfirmed') ||
      item.sourceType !== expected.sourceType ||
      item.sourceId !== expected.sourceId ||
      item.sourceVersion !== expected.sourceVersion ||
      item.sourceDigest !== expected.sourceDigest ||
      item.bodyDigest !== expected.bodyDigest ||
      item.authorizationGeneration !== expected.authorizationGeneration ||
      item.title !== expected.title ||
      sha256Hex(item.body) !== expected.bodyDigest
    ) {
      throw new RunCommandError('CONTEXT_UNAVAILABLE', '工作输入条目已不可读')
    }
    const body = Buffer.from(item.body, 'utf8')
    if (body.byteLength !== expected.byteSize) {
      throw new RunCommandError('CONTEXT_UNAVAILABLE', '工作输入条目大小不一致')
    }
    entries.push({
      inboxItemId: item.id,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      sourceVersion: item.sourceVersion,
      sourceDigest: item.sourceDigest,
      bodyDigest: item.bodyDigest,
      byteSize: body.byteLength,
      authorizationGeneration: item.authorizationGeneration,
      title: item.title,
      bodyBase64: body.toString('base64'),
    })
  }
  return {
    version: WORK_INPUT_MANIFEST_VERSION,
    workKey: manifest.workKey,
    manifestDigest: run.workInputManifestDigest,
    entries,
  }
}

export type RunWorkInputBundleResult = WorkInputBundle | undefined
