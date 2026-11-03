/**
 * ADR-0027 §6（PC-05b）：Node 应用 Hub 下发的上下文状态。
 *
 * - 持久化完整状态与 delivered/read 集合（跨重启）；
 * - 对 `state != frozen` 且本地未读的条目逐条删除副本；删除失败移入
 *   `runtime-home/<runId>/quarantine/`，移动也失败则 fail-closed（paused）；
 * - 原子写 `runtime-context/<runId>/state.json` 供 Runtime 读工具每次校验；
 * - 记录删除重试队列（每小时退避），恢复后自动解除 paused。
 *
 * 不删除已读副本，不整目录删除，不触碰其它条目。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  contextStateDigestInput,
  RUN_CONTEXT_STATE_FILE,
  RuntimeContextLocalStateSchema,
  type ContextStateSync,
  type RunContextState,
  type RunContextStateEntry,
} from '@whalepod/protocol'
import type { PreparedProjectContext } from './project-context.js'
import type { ContextPauseReason, ContextStateStore, StoredContextState } from './state-store.js'

const CLEANUP_RETRY_MS = 60 * 60 * 1000

export interface ContextStateApplierDeps {
  readonly runtimeHomeFor: (runId: string) => string
  readonly store: ContextStateStore
  readonly now: () => Date
  readonly log: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    context?: Record<string, unknown>,
  ) => void
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 下载完成后、首条 Hub 状态到达前的本地初始状态：全部 frozen，版本 0。 */
export async function initializePreparedContextState(
  deps: ContextStateApplierDeps,
  prepared: PreparedProjectContext,
): Promise<void> {
  const existing = deps.store.get(prepared.runId)
  if (existing !== undefined && existing.snapshotId === prepared.snapshotId) {
    // 状态可能在 run.start 之前先到（尤其撤权帧）。这里必须把已持久化的
    // 非 frozen 状态应用到刚下载的副本上，否则撤销后正文仍留在磁盘。
    const generation = checkFrozenGenerations(prepared, existing.entries)
    const read = new Set(existing.read)
    const cleanup = await cleanupUnreadEntries(
      deps,
      prepared,
      existing.entries.filter((entry) => entry.state !== 'frozen' && !read.has(entry.entryId)),
    )
    const pending = deps.store.pendingCleanupCount(prepared.runId)
    const pauseReason: ContextPauseReason | null = generation.regressed
      ? 'generation_regression'
      : cleanup.failedEntryIds.length > 0 || pending > 0
        ? 'cleanup'
        : null
    const paused = pauseReason !== null
    if (generation.regressed) {
      deps.log('warn', 'persisted project context state generation regressed; pausing run', {
        component: 'node.context',
        runId: prepared.runId,
        snapshotId: prepared.snapshotId,
        entryId: generation.entryId,
      })
    }
    deps.store.setPaused(prepared.runId, paused, pauseReason)
    const stored = deps.store.get(prepared.runId)
    if (stored !== undefined) await writeStateFile(deps, prepared, stored)
    return
  }
  const entries: RunContextStateEntry[] = prepared.entries.map((entry) => ({
    entryId: entry.entryId,
    kind: entry.kind,
    state: 'frozen',
    currentAuthorizationGeneration: entry.snapshotAuthorizationGeneration,
    reason: null,
  }))
  const syncedAt = deps.now().toISOString()
  deps.store.putInitial(
    prepared.runId,
    prepared.snapshotId,
    entries,
    sha256Hex(contextStateDigestInput(0, entries)),
    syncedAt,
  )
  const stored = deps.store.get(prepared.runId)
  if (stored !== undefined) await writeStateFile(deps, prepared, stored)
}

interface GenerationCheck {
  readonly regressed: boolean
  readonly entryId?: string
}

/** 冻结条目的当前代次不得低于清单冻结代次；只拦倒退，允许重新核验后递增。 */
function checkFrozenGenerations(
  prepared: PreparedProjectContext,
  entries: readonly RunContextStateEntry[],
): GenerationCheck {
  const pinned = new Map(prepared.entries.map((entry) => [entry.entryId, entry]))
  for (const entry of entries) {
    if (entry.state !== 'frozen') continue
    const manifest = pinned.get(entry.entryId)
    const snapshotGeneration = manifest?.snapshotAuthorizationGeneration
    if (snapshotGeneration === undefined || snapshotGeneration === null) continue
    const current = entry.currentAuthorizationGeneration
    const currentNumber = current === null ? Number.NaN : Number(current)
    const snapshotNumber = Number(snapshotGeneration)
    const regressed =
      current === null ||
      (Number.isFinite(currentNumber) && Number.isFinite(snapshotNumber)
        ? currentNumber < snapshotNumber
        : current !== snapshotGeneration)
    if (regressed) return { regressed: true, entryId: entry.entryId }
  }
  return { regressed: false }
}

interface CleanupOutcome {
  readonly deleted: number
  readonly quarantined: number
  readonly failedEntryIds: readonly string[]
}

async function cleanupUnreadEntries(
  deps: ContextStateApplierDeps,
  prepared: PreparedProjectContext,
  entries: readonly RunContextStateEntry[],
): Promise<CleanupOutcome> {
  let deleted = 0
  let quarantined = 0
  const failedEntryIds: string[] = []
  for (const entry of entries) {
    const outcome = await removeUnreadCopy(deps, prepared.runId, prepared.dir, entry.entryId)
    if (outcome === 'deleted') {
      deleted += 1
      deps.store.clearCleanup(prepared.runId, entry.entryId)
    } else if (outcome === 'quarantined') {
      quarantined += 1
      deps.store.clearCleanup(prepared.runId, entry.entryId)
    } else {
      failedEntryIds.push(entry.entryId)
    }
  }
  return { deleted, quarantined, failedEntryIds }
}

export interface ApplyStateResult {
  readonly applied: boolean
  readonly deleted: number
  readonly quarantined: number
  readonly failedEntryIds: readonly string[]
  /** 本地仍在重试的 entryId；ack 必须带上，Hub 才能看到「清理待完成」。 */
  readonly pendingEntryIds: readonly string[]
  readonly paused: boolean
}

const APPLIED_EMPTY = {
  applied: false,
  deleted: 0,
  quarantined: 0,
  failedEntryIds: [],
  pendingEntryIds: [],
  paused: false,
} as const

async function moveToQuarantine(
  deps: ContextStateApplierDeps,
  runId: string,
  entriesDir: string,
  entryId: string,
): Promise<boolean> {
  try {
    // runtimeHomeFor 也可能抛（配置/路径解析失败）；必须和 mkdir/rename 同一
    // 失败域，否则 apply 会在写 paused/state.json 之前中断。
    const quarantineDir = join(deps.runtimeHomeFor(runId), 'quarantine')
    await mkdir(quarantineDir, { recursive: true })
    await rename(join(entriesDir, entryId), join(quarantineDir, entryId))
    return true
  } catch {
    return false
  }
}

/** 返回 'deleted' | 'quarantined' | 'failed'。 */
async function removeUnreadCopy(
  deps: ContextStateApplierDeps,
  runId: string,
  entriesDir: string,
  entryId: string,
): Promise<'deleted' | 'quarantined' | 'failed'> {
  try {
    await unlink(join(entriesDir, entryId))
    return 'deleted'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'deleted'
  }
  if (await moveToQuarantine(deps, runId, entriesDir, entryId)) return 'quarantined'
  // 先把失败项放进重试队列，再报 paused；调用方据此写 state.json。
  deps.store.enqueueCleanup(
    runId,
    entryId,
    new Date(deps.now().getTime() + CLEANUP_RETRY_MS).toISOString(),
    'copy removal failed',
  )
  return 'failed'
}

async function writeStateFile(
  deps: ContextStateApplierDeps,
  prepared: PreparedProjectContext,
  stored: StoredContextState,
): Promise<void> {
  const payload = RuntimeContextLocalStateSchema.parse({
    runId: stored.runId,
    snapshotId: stored.snapshotId,
    stateVersion: stored.stateVersion,
    stateDigest: stored.stateDigest,
    entries: stored.entries,
    syncedAt: stored.syncedAt,
    paused: stored.paused,
  })
  const target = join(prepared.dir, RUN_CONTEXT_STATE_FILE)
  // 单调写：并发帧/清理重试可能交错；旧版本或同版本异摘要不得覆盖更新的
  // state.json。串行化仍在 RunManager 做，这里是最后一道防线。
  try {
    const previous = RuntimeContextLocalStateSchema.parse(
      JSON.parse(await readFile(target, 'utf8')),
    )
    if (
      previous.snapshotId === stored.snapshotId &&
      (previous.stateVersion > stored.stateVersion ||
        (previous.stateVersion === stored.stateVersion &&
          previous.stateDigest !== stored.stateDigest))
    ) {
      return
    }
  } catch {
    // 文件不存在/损坏：允许写入（损坏本来就会 fail-closed）。
  }
  // 唯一临时名：并发 state 帧/清理重试可能同时写，固定 .tmp 会互相覆盖/rename 失败。
  const tmp = `${target}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(payload), 'utf8')
  await rename(tmp, target)
}

/** 应用完整状态；只删除未读副本，失败时 paused + 重试队列。 */
export async function applyRunContextState(
  deps: ContextStateApplierDeps,
  prepared: PreparedProjectContext | undefined,
  state: RunContextState,
): Promise<ApplyStateResult> {
  const now = deps.now()
  if (sha256Hex(contextStateDigestInput(state.stateVersion, state.entries)) !== state.stateDigest) {
    deps.log('warn', 'project context state digest mismatch ignored', {
      component: 'node.context',
      runId: state.runId,
      snapshotId: state.snapshotId,
      stateVersion: state.stateVersion,
    })
    return APPLIED_EMPTY
  }
  const existing = deps.store.get(state.runId)
  // 同一 runId 的 snapshot 身份不可变；异快照帧在落库前就拒绝，避免覆盖
  // 本地状态后被后续同快照心跳写进 Run 目录。
  if (existing !== undefined && existing.snapshotId !== state.snapshotId) {
    return APPLIED_EMPTY
  }
  // ADR-0027 §6：来源条目的当前代次不得低于快照冻结代次；旧代次即使
  // stateVersion 更高也不得恢复读取。只拦 frozen 恢复，撤权帧仍要处理。
  const generation =
    prepared !== undefined && prepared.snapshotId === state.snapshotId
      ? checkFrozenGenerations(prepared, state.entries)
      : { regressed: false }
  if (generation.regressed) {
    // 整帧不落库，但同帧里的撤权条目仍要删除未读副本；同时 paused 让 Runtime
    // 立即 fail-closed，而不是等 60 秒水位过期。
    let cleanup: CleanupOutcome = { deleted: 0, quarantined: 0, failedEntryIds: [] }
    const read = new Set(existing?.read ?? [])
    if (prepared !== undefined && prepared.snapshotId === state.snapshotId) {
      cleanup = await cleanupUnreadEntries(
        deps,
        prepared,
        state.entries.filter((entry) => entry.state !== 'frozen' && !read.has(entry.entryId)),
      )
    }
    deps.store.setPaused(state.runId, true, 'generation_regression')
    const current = deps.store.get(state.runId)
    if (prepared !== undefined && current !== undefined)
      await writeStateFile(deps, prepared, current)
    deps.log('warn', 'project context state generation regressed; ignored', {
      component: 'node.context',
      runId: state.runId,
      snapshotId: state.snapshotId,
      entryId: generation.entryId,
      stateVersion: state.stateVersion,
      deleted: cleanup.deleted,
      quarantined: cleanup.quarantined,
    })
    return {
      applied: false,
      deleted: cleanup.deleted,
      quarantined: cleanup.quarantined,
      failedEntryIds: cleanup.failedEntryIds,
      pendingEntryIds: deps.store.pendingCleanupEntryIds(state.runId),
      paused: true,
    }
  }
  const storedOk = deps.store.upsert(state, now.toISOString())
  const stored = deps.store.get(state.runId)
  if (
    !storedOk ||
    stored === undefined ||
    stored.snapshotId !== state.snapshotId ||
    stored.stateVersion !== state.stateVersion ||
    stored.stateDigest !== state.stateDigest
  ) {
    // 旧版本/同版本异摘要的迟到帧：绝不能 ack applied，否则 Hub 会停止重发，
    // 而 Node 仍停留在旧的（可能 frozen）状态。
    return APPLIED_EMPTY
  }
  if (prepared === undefined) {
    // Run 尚未下载副本：状态已持久化，等 run.start 后由初始化路径清理/写文件。
    return {
      applied: true,
      deleted: 0,
      quarantined: 0,
      failedEntryIds: [],
      pendingEntryIds: deps.store.pendingCleanupEntryIds(state.runId),
      paused: stored.paused,
    }
  }
  if (prepared.snapshotId !== state.snapshotId) return APPLIED_EMPTY

  const read = new Set(stored.read)
  const cleanup = await cleanupUnreadEntries(
    deps,
    prepared,
    stored.entries.filter((entry) => entry.state !== 'frozen' && !read.has(entry.entryId)),
  )
  const pending = deps.store.pendingCleanupEntryIds(state.runId)
  const pauseReason: ContextPauseReason | null =
    cleanup.failedEntryIds.length > 0 || pending.length > 0 ? 'cleanup' : null
  const paused = pauseReason !== null
  deps.store.setPaused(state.runId, paused, pauseReason)
  const final = deps.store.get(state.runId)
  if (final !== undefined) await writeStateFile(deps, prepared, final)
  return {
    applied: true,
    deleted: cleanup.deleted,
    quarantined: cleanup.quarantined,
    failedEntryIds: cleanup.failedEntryIds,
    pendingEntryIds: pending,
    paused,
  }
}

export interface StateSyncResult {
  readonly pull: boolean
  readonly reason?: string
}

/** 水位帧：摘要一致才刷新 syncedAt；不一致/缺失 → 让调用方发 state_pull。 */
export async function applyContextStateSync(
  deps: ContextStateApplierDeps,
  prepared: PreparedProjectContext | undefined,
  sync: ContextStateSync,
): Promise<StateSyncResult> {
  const stored = deps.store.get(sync.runId)
  if (
    stored === undefined ||
    stored.snapshotId !== sync.snapshotId ||
    stored.stateVersion !== sync.stateVersion ||
    stored.stateDigest !== sync.stateDigest
  ) {
    return { pull: true, reason: 'state_digest_mismatch' }
  }
  // 用 Node 本地时钟：Hub/Node 时钟偏差不能让本机误判「永不过期」。
  deps.store.touchSync(sync.runId, sync.snapshotId, deps.now().toISOString())
  const updated = deps.store.get(sync.runId)
  if (prepared !== undefined && updated !== undefined) {
    await writeStateFile(deps, prepared, updated)
  }
  return { pull: false }
}

export interface CleanupDrainResult {
  readonly retried: number
  readonly failed: number
  readonly resumedRuns: readonly string[]
}

/**
 * 处理到期的删除重试项；恢复后解除 paused 并重写 state.json。
 * 传 `onlyRunId` 时只处理该 Run（生产路径必须按 Run 串行调用，避免与状态帧
 * 并发写同一 state.json）。
 */
export async function drainContextCleanupQueue(
  deps: ContextStateApplierDeps,
  preparedForRun: (runId: string) => PreparedProjectContext | undefined,
  onlyRunId?: string,
): Promise<CleanupDrainResult> {
  let retried = 0
  let failed = 0
  const resumed = new Set<string>()
  const touched = new Set<string>()
  for (const task of deps.store.dueCleanup(deps.now())) {
    if (onlyRunId !== undefined && task.runId !== onlyRunId) continue
    touched.add(task.runId)
    const prepared = preparedForRun(task.runId)
    if (prepared === undefined) continue
    const stored = deps.store.get(task.runId)
    if (stored === undefined || stored.snapshotId !== prepared.snapshotId) {
      deps.store.clearCleanup(task.runId, task.entryId)
      continue
    }
    const entry = stored.entries.find((item) => item.entryId === task.entryId)
    // 重试前必须复核当前状态：条目已恢复 frozen、已经被读取、或已不在快照里，
    // 都不能再删。旧队列项无脑重试会删掉恢复后的副本或已读副本。
    if (entry === undefined || entry.state === 'frozen' || stored.read.includes(task.entryId)) {
      deps.store.clearCleanup(task.runId, task.entryId)
      continue
    }
    retried += 1
    const outcome = await removeUnreadCopy(deps, task.runId, prepared.dir, task.entryId)
    if (outcome === 'failed') {
      failed += 1
      deps.store.recordCleanupFailure(
        task.runId,
        task.entryId,
        new Date(deps.now().getTime() + CLEANUP_RETRY_MS).toISOString(),
        'copy removal retry failed',
      )
      continue
    }
    deps.store.clearCleanup(task.runId, task.entryId)
  }

  // 本轮涉及的 Run：只解除 drain 自己拥有的 cleanup pause；代次倒退等
  // 其他原因的 pause 必须保留，直到一条通过代次闸的完整状态到达。
  for (const runId of touched) {
    const prepared = preparedForRun(runId)
    if (prepared === undefined) continue
    const stored = deps.store.get(runId)
    if (stored === undefined) continue
    if (deps.store.pendingCleanupCount(runId) > 0) {
      // 代次倒退是更强的 pause；cleanup 重试可以继续跑，但不能把原因改写成
      // 可被 drain 解除的 cleanup，否则队列清空后会误恢复读取。
      if (stored.paused && stored.pauseReason === 'generation_regression') continue
      if (!stored.paused || stored.pauseReason !== 'cleanup') {
        deps.store.setPaused(runId, true, 'cleanup')
        const pausedState = deps.store.get(runId)
        if (pausedState !== undefined) await writeStateFile(deps, prepared, pausedState)
      }
      continue
    }
    const pauseReason = stored.pauseReason ?? 'cleanup'
    if (!stored.paused || pauseReason !== 'cleanup') continue
    deps.store.setPaused(runId, false, null)
    const updated = deps.store.get(runId)
    if (updated !== undefined) {
      await writeStateFile(deps, prepared, updated)
      resumed.add(runId)
    }
  }
  return { retried, failed, resumedRuns: [...resumed] }
}
