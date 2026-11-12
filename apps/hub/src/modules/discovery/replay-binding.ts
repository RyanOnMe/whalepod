import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import {
  getDispatchIntent,
  getRun,
  getTaskMessage,
  getWorkMandate,
  getWorkByKey,
  listDiscoveryExecutionSources,
  schema,
  type DiscoveryExecutionRow,
  type DiscoveryExecutionSourceRow,
  type RunRow,
  type Tx,
} from '@whalepod/db'
import {
  DISCOVERY_EXECUTION_REPLAY_CAPABILITY,
  WORK_INPUT_MAX_ENTRY_BYTES,
  WORK_INPUT_MANIFEST_VERSION,
  WorkInputManifestSchema,
  type DiscoveryExecutionExecutor,
  type WorkInputBundle,
  type WorkInputManifest,
} from '@whalepod/protocol'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { contextCapabilitiesOf } from '../context/run-snapshot.js'
import type { ArtifactStore } from '../artifact/store.js'
import { sourceIdentity } from './admission.js'
import { revalidateDiscoveryExecution } from './execution.js'

export const DISCOVERY_REPLAY_TOOLS = ['write'] as const
export type DiscoveryReplayRoute = DiscoveryExecutionExecutor

export function discoveryReplayRouteIsLoopback(route: DiscoveryReplayRoute): boolean {
  try {
    const endpoint = new URL(route.endpoint)
    return (
      route.provider === 'deepseek-official' &&
      endpoint.href === route.endpoint &&
      endpoint.protocol === 'http:' &&
      endpoint.hostname === '127.0.0.1' &&
      endpoint.port !== '' &&
      endpoint.pathname === '/chat/completions' &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash
    )
  } catch {
    return false
  }
}

export function matchesDiscoveryReplayRoute(
  execution: DiscoveryExecutionRow,
  route: DiscoveryReplayRoute,
): boolean {
  return (
    discoveryReplayRouteIsLoopback(route) &&
    execution.executorProvider === route.provider &&
    execution.executorModel === route.model &&
    execution.executorEndpoint === route.endpoint &&
    execution.executorAccount === route.account &&
    execution.executorPolicyGeneration === route.policyGeneration &&
    execution.executorDigest === sha256Hex(canonicalJson({ ...route, purpose: 'private_draft' }))
  )
}

async function getReplayExecution(tx: Tx, id: string): Promise<DiscoveryExecutionRow | undefined> {
  const [execution] = await tx
    .select()
    .from(schema.discoveryExecutions)
    .where(eq(schema.discoveryExecutions.id, id))
  return execution
}

async function sourceBytes(
  tx: Tx,
  source: DiscoveryExecutionSourceRow,
  store: ArtifactStore,
): Promise<Buffer | undefined> {
  switch (source.kind) {
    case 'task_message': {
      const message = await getTaskMessage(tx, source.sourceId)
      if (!message) return undefined
      const current = await sourceIdentity(tx, message)
      return current.sourceVersion === source.sourceVersion &&
        current.sourceDigest === source.sourceDigest
        ? Buffer.from(current.body)
        : undefined
    }
    case 'receipt': {
      const [receipt] = await tx
        .select()
        .from(schema.discoveryVerifications)
        .where(eq(schema.discoveryVerifications.id, source.sourceId))
      if (
        !receipt ||
        receipt.revokedAt !== null ||
        receipt.sourceVersion !== source.sourceVersion ||
        receipt.sourceDigest !== source.sourceDigest
      )
        return undefined
      return Buffer.from(
        canonicalJson({
          kind: 'verified_observation',
          sourceId: receipt.sourceId,
          sourceVersion: receipt.sourceVersion,
          sourceDigest: receipt.sourceDigest,
          verifiedAt: receipt.createdAt.toISOString(),
        }),
      )
    }
    case 'artifact': {
      const [artifact] = await tx
        .select()
        .from(schema.artifacts)
        .where(
          and(eq(schema.artifacts.id, source.sourceId), eq(schema.artifacts.status, 'published')),
        )
      if (
        !artifact ||
        artifact.sha256 !== source.sourceDigest ||
        artifact.sha256 !== source.sourceVersion ||
        artifact.byteSize > WORK_INPUT_MAX_ENTRY_BYTES
      )
        return undefined
      const bytes = await store.readVerified(artifact.storageKey, artifact.sha256)
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return undefined
      }
      return bytes
    }
  }
}

async function materialize(
  tx: Tx,
  executionId: string,
  workKey: string,
  store: ArtifactStore,
): Promise<{ manifest: WorkInputManifest; bundle: WorkInputBundle } | undefined> {
  const rows = await listDiscoveryExecutionSources(tx, executionId)
  const entries: WorkInputBundle['entries'] = []
  for (const source of rows) {
    const bytes = await sourceBytes(tx, source, store)
    if (!bytes || bytes.byteLength > WORK_INPUT_MAX_ENTRY_BYTES) return undefined
    entries.push({
      inboxItemId: source.id,
      sourceType: 'discovery_source',
      sourceId: source.sourceId,
      sourceVersion: source.sourceVersion,
      sourceDigest: source.sourceDigest,
      authorizationGeneration: source.authorizationGeneration,
      title: {
        task_message: 'Authorized discussion',
        receipt: 'Independent verification',
        artifact: 'Published evidence',
      }[source.kind],
      bodyDigest: createHash('sha256').update(bytes).digest('hex'),
      byteSize: bytes.byteLength,
      bodyBase64: bytes.toString('base64'),
    })
  }
  const parsed = WorkInputManifestSchema.safeParse({
    version: WORK_INPUT_MANIFEST_VERSION,
    workKey,
    entries: entries.map(({ bodyBase64: _, ...entry }) => entry),
  })
  if (!parsed.success) return undefined
  const manifestDigest = sha256Hex(canonicalJson(parsed.data))
  return {
    manifest: parsed.data,
    bundle: { version: WORK_INPUT_MANIFEST_VERSION, workKey, manifestDigest, entries },
  }
}

export const materializeDiscoveryReplayInput = materialize

export async function verifyDiscoveryReplayRun(
  tx: Tx,
  run: RunRow,
  now: Date,
  options: {
    readonly lock?: boolean
    readonly route?: DiscoveryReplayRoute
    readonly allowCompleted?: boolean
    readonly lockRunBeforeWork?: boolean
  } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const reject = { ok: false, reason: 'discovery_execution_unavailable' } as const
  if (
    !run.discoveryExecutionId ||
    !run.workKey ||
    !run.mandateId ||
    run.approvalPolicy !== 'approval_required' ||
    run.mandateInvalidatedAt !== null ||
    !(
      ['queued', 'dispatching', 'running'].includes(run.status) ||
      (options.allowCompleted && run.status === 'completed')
    )
  )
    return reject
  const execution = await getReplayExecution(tx, run.discoveryExecutionId)
  if (
    !execution ||
    execution.taskId !== run.taskId ||
    execution.principalUserId !== run.ownerUserId ||
    (options.route && !matchesDiscoveryReplayRoute(execution, options.route)) ||
    !(await revalidateDiscoveryExecution(tx, execution, now, {
      runId: run.id,
      ...(options.lock ? { lock: true } : {}),
      ...(options.lockRunBeforeWork ? { lockRunBeforeWork: true } : {}),
    }))
  )
    return reject
  if (options.lock) {
    const current = await getRun(tx, run.id)
    if (
      !current ||
      current.mandateInvalidatedAt !== null ||
      current.discoveryExecutionId !== run.discoveryExecutionId ||
      !(
        ['queued', 'dispatching', 'running'].includes(current.status) ||
        (options.allowCompleted && current.status === 'completed')
      )
    )
      return reject
  }
  const work = await getWorkByKey(tx, run.workKey)
  const mandate = await getWorkMandate(tx, run.mandateId)
  const intent = run.dispatchIntentId
    ? await getDispatchIntent(tx, run.dispatchIntentId)
    : undefined
  const [device] = await tx.select().from(schema.devices).where(eq(schema.devices.id, run.deviceId))
  if (
    !work ||
    work.id !== execution.workId ||
    work.mandateId !== run.mandateId ||
    !mandate ||
    mandate.status !== 'active' ||
    mandate.version !== 1 ||
    mandate.expiresAt.getTime() <= (options.lock ? Date.now() : now.getTime()) ||
    mandate.principalUserId !== run.ownerUserId ||
    mandate.workId !== execution.workId ||
    mandate.taskId !== run.taskId ||
    mandate.draftRecipientUserId !== run.ownerUserId ||
    !intent ||
    intent.status !== 'dispatched' ||
    intent.runId !== run.id ||
    intent.mandateId !== mandate.id ||
    intent.inputDigest !== execution.sourceManifestDigest ||
    !device ||
    device.revokedAt !== null ||
    device.ownerUserId !== run.ownerUserId ||
    !contextCapabilitiesOf(device).includes(DISCOVERY_EXECUTION_REPLAY_CAPABILITY)
  )
    return reject
  const manifest = WorkInputManifestSchema.safeParse(run.workInputManifest)
  if (
    !manifest.success ||
    manifest.data.workKey !== run.workKey ||
    sha256Hex(canonicalJson(manifest.data)) !== run.workInputManifestDigest
  )
    return reject
  const sources = await listDiscoveryExecutionSources(tx, execution.id)
  if (
    sources.length !== manifest.data.entries.length ||
    sources.some((source, i) => {
      const entry = manifest.data.entries[i]
      return (
        !entry ||
        entry.sourceType !== 'discovery_source' ||
        entry.inboxItemId !== source.id ||
        entry.sourceId !== source.sourceId ||
        entry.sourceVersion !== source.sourceVersion ||
        entry.sourceDigest !== source.sourceDigest ||
        entry.authorizationGeneration !== source.authorizationGeneration
      )
    })
  )
    return reject
  return { ok: true }
}

export async function discoveryReplayBundle(
  tx: Tx,
  run: RunRow,
  store: ArtifactStore,
): Promise<WorkInputBundle | undefined> {
  if (!run.discoveryExecutionId || !run.workKey) return undefined
  const current = await materialize(tx, run.discoveryExecutionId, run.workKey, store)
  return current?.bundle.manifestDigest === run.workInputManifestDigest ? current.bundle : undefined
}
