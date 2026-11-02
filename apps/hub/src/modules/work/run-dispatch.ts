import { and, eq } from 'drizzle-orm'
import type { Database, RunRow, Tx } from '@whalepod/db'
import { getRetractedInboxItemForSource, getRun, getWorkByKey, schema } from '@whalepod/db'
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
  if (work === undefined || work.state !== 'active' || work.taskId !== run.taskId) {
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
  const run = await getRun(database.db, runId)
  if (run === undefined || run.deviceId !== deviceId) return undefined
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
