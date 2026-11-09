import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import {
  findContextEntryByBusinessVersion,
  getCoordinatorStateForUpdate,
  getCurrentWorkByTask,
  getEnabledMember,
  getLatestConfirmedSpec,
  getProject,
  getRouterConfig,
  getTaskForUpdate,
  getTaskMessage,
  getTeam,
  schema,
  type RouterConfigRow,
  type Tx,
} from '@whalepod/db'
import {
  coordinationInputTokenEstimate,
  DISCOVERY_CAPABILITY,
  type CoordinationInputEntry,
} from '@whalepod/protocol'
import type { ArtifactStore } from '../artifact/store.js'
import { canonicalJson, sha256Hex } from '../coordination/digest.js'
import { supportsRouterConfiguration } from '../router/input.js'
import { ApiError } from '../shared/http-error.js'
import {
  activeConsent,
  available,
  discoveryAdmission,
  discoveryConfig,
  entryGeneration,
  sourceConsent,
  sourceIdentity,
} from './admission.js'

export const DISCOVERY_RULES_VERSION = 'rd04a.v1'
export const DISCOVERY_PROMPT_VERSION = 'discovery.v1'
const MAX_CATALOG = 16
const MAX_BODY_BYTES = 16_384
const MAX_TOTAL_BYTES = 64_000
const MAX_ENTRIES = 32

function manifestId(kind: string, identity: string) {
  const h = sha256Hex(`discovery:${kind}:${identity}`)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export function unavailable() {
  return new ApiError(404, 'NOT_FOUND', 'discovery input unavailable')
}

export function supportsDiscovery(capabilities: unknown, model: RouterConfigRow) {
  const caps = capabilities as { coordinationCapabilities?: unknown[] } | undefined
  return (
    caps?.coordinationCapabilities?.includes(DISCOVERY_CAPABILITY) === true &&
    supportsRouterConfiguration(capabilities, model)
  )
}

/**
 * Authority is rebuilt on download, before provider start, at result acceptance and on every read.
 * Store only manifest metadata in the evaluation. Bodies are rebuilt from their authorized origins.
 */
export async function loadDiscoveryInput(
  tx: Tx,
  sourceId: string,
  now: Date,
  store?: ArtifactStore,
) {
  const initial = await discoveryAdmission(tx, sourceId)
  if (!initial || initial.route !== 'discovery') throw unavailable()
  const task = await getTaskForUpdate(tx, initial.entryTaskId)
  const state = await getCoordinatorStateForUpdate(tx, initial.projectId)
  const admission = await discoveryAdmission(tx, sourceId)
  const cfg = await discoveryConfig(tx, initial.projectId)
  const project = await getProject(tx, initial.projectId)
  if (
    !admission ||
    admission.withdrawnAt !== null ||
    !task ||
    task.projectId !== initial.projectId ||
    task.status === 'done' ||
    task.status === 'cancelled' ||
    !project ||
    project.archivedAt !== null ||
    !state?.enabled ||
    state.pausedAt !== null ||
    !available(cfg, now) ||
    cfg.version !== admission.configVersion ||
    cfg.settings.entryTaskId !== task.id ||
    (await getCurrentWorkByTask(tx, task.id)) ||
    (await entryGeneration(tx, task.id)) !== admission.entryGeneration
  )
    throw unavailable()

  const message = await getTaskMessage(tx, sourceId)
  if (
    !message ||
    message.taskId !== task.id ||
    message.kind !== 'discussion' ||
    message.origin !== 'human'
  )
    throw unavailable()
  const identity = sourceIdentity(message)
  const permit = await activeConsent(tx, cfg, cfg.settings.principalUserId, 'permit')
  const author = await sourceConsent(tx, cfg, message.authorUserId)
  const team = await getTeam(tx)
  const model = await getRouterConfig(tx, project.id)
  if (
    !permit ||
    permit.version !== admission.permitVersion ||
    !author ||
    author.version !== admission.authorVersion ||
    identity.sourceDigest !== admission.sourceDigest ||
    identity.sourceVersion !== admission.sourceVersion ||
    !team ||
    !model?.enabled ||
    model.configVersion !== cfg.modelConfigVersion ||
    cfg.configuredBy !== model.operatorUserId ||
    cfg.configuredBy !== model.billingUserId ||
    !(await getEnabledMember(tx, team.id, model.operatorUserId)) ||
    !(await getEnabledMember(tx, team.id, model.billingUserId))
  )
    throw unavailable()

  const [device] = await tx
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.id, model.deviceId))
  if (!device || device.revokedAt !== null || device.ownerUserId !== model.operatorUserId)
    throw unavailable()

  const manifest: CoordinationInputEntry[] = []
  const bodies = new Map<string, string>()
  const omissions: string[] = []
  const authorityUserIds = new Set([
    cfg.settings.principalUserId,
    message.authorUserId,
    model.operatorUserId,
    model.billingUserId,
  ])
  const scopeAliases = new Map<string, string[]>()
  const agreed = new Set<string>()
  function noteScope(taskId: string, kind: 'agreement' | 'evidence') {
    const alias = `${kind === 'agreement' ? 'A' : 'E'}${manifest.filter((entry) => entry.kind === kind).length}`
    scopeAliases.set(taskId, [...(scopeAliases.get(taskId) ?? []), alias])
    if (kind === 'agreement') agreed.add(taskId)
  }
  let bytes = 0
  function add(
    kind: CoordinationInputEntry['kind'],
    sourceId: string,
    version: string,
    body: string,
    authorizationGeneration: string,
  ): boolean {
    const byteSize = Buffer.byteLength(body)
    if (
      byteSize > MAX_BODY_BYTES ||
      bytes + byteSize > MAX_TOTAL_BYTES ||
      manifest.length >= MAX_ENTRIES
    )
      return false
    const id = manifestId(kind, sourceId)
    manifest.push({
      id,
      kind,
      sourceId,
      version,
      digest: sha256Hex(body),
      byteSize,
      authorizationGeneration,
    })
    bodies.set(id, body)
    bytes += byteSize
    return true
  }
  const slotKey = manifestId(
    'slot',
    canonicalJson([project.id, cfg.settings.activity, cfg.settings.slot]),
  )
  if (
    !add('source', sourceId, identity.sourceVersion, message.body, `author:${author.version}`) ||
    !add(
      'slot',
      slotKey,
      cfg.settings.templateVersion,
      canonicalJson({ activity: cfg.settings.activity, deliverable: cfg.settings.slot }),
      `permit:${permit.version}`,
    )
  )
    throw unavailable()

  const taskCatalog = await tx
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      assignmentStatus: schema.tasks.assignmentStatus,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, project.id), ne(schema.tasks.id, task.id)))
    .orderBy(asc(schema.tasks.id))
    .limit(MAX_CATALOG + 1)
  if (taskCatalog.length > MAX_CATALOG) omissions.push('catalog_truncated')
  const catalogIds = new Set(taskCatalog.slice(0, MAX_CATALOG).map((row) => row.id))

  for (const taskId of [...new Set(cfg.settings.agreementTaskIds)].sort()) {
    if (!catalogIds.has(taskId) && taskId !== task.id) {
      omissions.push('agreement_unavailable')
      continue
    }
    const spec = await getLatestConfirmedSpec(tx, taskId)
    const consent = spec?.confirmedBy ? await sourceConsent(tx, cfg, spec.confirmedBy) : undefined
    const decision =
      spec?.revisionNumber == null
        ? undefined
        : await findContextEntryByBusinessVersion(
            tx,
            'decision',
            `taskSpec:${taskId}`,
            `${spec.id}:${spec.revisionNumber}`,
          )
    if (
      !spec ||
      !consent ||
      decision?.projectId !== project.id ||
      decision.status !== 'active' ||
      decision.correctedAt !== null ||
      !add(
        'agreement',
        spec.id,
        `${spec.id}:${spec.revisionNumber}`,
        canonicalJson(spec.content),
        `confirmed:${consent.version}`,
      )
    ) {
      omissions.push('agreement_unavailable')
      continue
    }
    if (spec.confirmedBy) authorityUserIds.add(spec.confirmedBy)
    noteScope(taskId, 'agreement')
  }

  for (const artifactId of [...new Set(cfg.settings.evidenceArtifactIds)].sort()) {
    const [artifact] = await tx
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId))
    const publishedAt = artifact?.publishedAt?.toISOString()
    if (
      !artifact ||
      (!catalogIds.has(artifact.taskId) && artifact.taskId !== task.id) ||
      artifact.status !== 'published' ||
      !publishedAt ||
      !store ||
      artifact.byteSize > MAX_BODY_BYTES ||
      !/^(text\/|application\/(json|xml)(;|$))/.test(artifact.mediaType)
    ) {
      omissions.push('evidence_unavailable')
      continue
    }
    const consent = await sourceConsent(tx, cfg, artifact.ownerUserId)
    const decision = await findContextEntryByBusinessVersion(
      tx,
      'decision',
      `artifact:${artifact.id}`,
      publishedAt,
    )
    if (
      !consent ||
      decision?.projectId !== project.id ||
      decision.status !== 'active' ||
      decision.correctedAt !== null
    ) {
      omissions.push('evidence_unavailable')
      continue
    }
    try {
      const payload = await store.readVerified(artifact.storageKey, artifact.sha256)
      const body = new TextDecoder('utf-8', { fatal: true }).decode(payload)
      if (
        payload.length !== artifact.byteSize ||
        !add(
          'evidence',
          artifact.id,
          artifact.sha256,
          body,
          `published:${publishedAt}:${consent.version}`,
        )
      ) {
        omissions.push('evidence_unavailable')
        continue
      }
      authorityUserIds.add(artifact.ownerUserId)
      noteScope(artifact.taskId, 'evidence')
    } catch {
      omissions.push('evidence_unavailable')
    }
  }

  const catalog = []
  for (const item of taskCatalog.slice(0, MAX_CATALOG)) {
    const work = await getCurrentWorkByTask(tx, item.id)
    const scope = scopeAliases.get(item.id) ?? []
    // A published outcome can confirm coverage; an active Work without a readable agreement
    // may still cover something absent from its outcomes.
    const scopeAvailable = scope.length > 0 && (work === undefined || agreed.has(item.id))
    if (!scopeAvailable) omissions.push('coverage_unavailable')
    catalog.push({
      id: item.id,
      status: item.status,
      assignment: item.assignmentStatus,
      updatedAt: item.updatedAt.toISOString(),
      work:
        work === undefined
          ? null
          : { id: work.id, state: work.state, updatedAt: work.updatedAt.toISOString() },
      scope,
      scopeAvailable,
    })
  }
  // Model sees project-visible status and which scope could be evaluated, never unapproved titles,
  // Work goals, internal IDs, private artifacts, other conversations, or credential contents.
  if (
    !add(
      'work',
      project.id,
      sha256Hex(canonicalJson(catalog)),
      canonicalJson(
        catalog.map(({ status, assignment, scope, scopeAvailable }) => ({
          status,
          assignment,
          scope,
          scopeAvailable,
        })),
      ),
      `permit:${permit.version}`,
    )
  )
    throw unavailable()
  const coverageComplete = omissions.length === 0
  const inputTokensEstimate = coordinationInputTokenEstimate(manifest)
  if (inputTokensEstimate > model.maxInputTokens)
    throw new ApiError(409, 'CONFLICT', 'discovery input exceeds bounds')
  const evaluationDigest = sha256Hex(
    canonicalJson({
      purpose: 'discovery',
      projectId: project.id,
      sourceId,
      ...identity,
      entryGeneration: admission.entryGeneration,
      permitVersion: permit.version,
      authorVersion: author.version,
      configVersion: cfg.version,
      coordinatorModelConfigVersion: model.configVersion,
      rules: DISCOVERY_RULES_VERSION,
      prompt: DISCOVERY_PROMPT_VERSION,
      coverageComplete,
      omissions,
      manifest,
    }),
  )
  return {
    admission,
    cfg,
    permit,
    model,
    teamId: team.id,
    device,
    authorityUserIds: [...authorityUserIds],
    manifest,
    bodies,
    coverageComplete,
    omissions: [...new Set(omissions)],
    evaluationDigest,
    inputTokensEstimate,
  }
}

/** Serialize disclosure and the outbound permit with member disable and device revoke. */
export async function fenceDiscoveryAuthority(
  tx: Tx,
  input: Awaited<ReturnType<typeof loadDiscoveryInput>>,
): Promise<boolean> {
  const u = schema.userAccounts
  const authorities = await tx
    .select({ disabledAt: u.disabledAt })
    .from(u)
    .where(inArray(u.id, input.authorityUserIds))
    .orderBy(asc(u.id))
    .for('share')
  if (
    authorities.length !== input.authorityUserIds.length ||
    authorities.some(({ disabledAt }) => disabledAt !== null)
  )
    return false
  const d = schema.devices
  const [device] = await tx.select().from(d).where(eq(d.id, input.device.id)).for('share')
  return (
    device?.revokedAt === null &&
    device.ownerUserId === input.model.operatorUserId &&
    supportsDiscovery(device.capabilities, input.model)
  )
}
