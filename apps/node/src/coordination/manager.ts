import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  CoordinationHeartbeatPayloadSchema,
  CoordinationRequestPayloadSchema,
  CoordinationResultPayloadSchema,
  coordinationInputTokenEstimate,
  type CoordinationRequest,
  type CoordinationResult,
  type NodeDownstream,
  type RouterRuntimeOutput,
} from '@whalepod/protocol'
import {
  coordinationSecrets,
  loadCoordinationConfig,
  type CoordinationLocalConfig,
} from './config.js'
import { CoordinationInputDownloader, CoordinationInputError } from './download.js'
import {
  CoordinationRuntimeDriver,
  type CoordinationHandle,
  type CoordinationProcessDriver,
} from './driver.js'
import { CoordinationStore, type CoordinationJournal } from './store.js'
import {
  killProcessGroup,
  processAlive,
  processCommandLine,
  processStartTime,
} from '../supervisor/process.js'

interface Active {
  readonly request: CoordinationRequest
  readonly controller: AbortController
  handle?: CoordinationHandle
  timer?: ReturnType<typeof setInterval>
  needsStartAck: boolean
  finishing?: Promise<void>
}
export interface CoordinationManagerDeps {
  stateDir: string
  hubUrl: string
  deviceToken: string
  runtimeEntry: string
  capable: boolean
  send: (frame: string) => boolean
  driver?: CoordinationProcessDriver
  store?: CoordinationStore
  fetchImpl?: typeof fetch
  now?: () => Date
  removeHome?: (path: string) => Promise<void>
  readProcessStartTime?: (pid: number) => Promise<string | undefined>
  log?: (event: string, fields: Record<string, unknown>) => void
}
function envelope(type: string, payload: unknown): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  })
}
function binding(request: CoordinationRequest) {
  return {
    evaluationId: request.evaluationId,
    attempt: request.attempt,
    leaseToken: request.leaseToken,
  }
}

/** A separate bounded evaluation lifecycle. It never calls RunManager or business Run APIs. */
export class CoordinationManager {
  private readonly store: CoordinationStore
  private readonly driver: CoordinationProcessDriver
  private readonly downloader: CoordinationInputDownloader
  private readonly active = new Map<string, Active>()
  private readonly starting = new Set<Promise<void>>()
  private readonly root: string
  private readonly cleanupTimer: ReturnType<typeof setInterval>
  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }
  constructor(private readonly deps: CoordinationManagerDeps) {
    this.root = resolve(deps.stateDir, 'coordination-home')
    this.store = deps.store ?? new CoordinationStore(join(deps.stateDir, 'coordination.sqlite'))
    this.driver = deps.driver ?? new CoordinationRuntimeDriver(deps.runtimeEntry)
    this.downloader = new CoordinationInputDownloader({
      hubUrl: deps.hubUrl,
      deviceToken: deps.deviceToken,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    })
    this.cleanupTimer = setInterval(() => {
      void this.retryCleanup()
    }, 60_000)
    this.cleanupTimer.unref()
  }
  private key(r: { evaluationId: string; attempt: number }): string {
    return `${r.evaluationId}:${r.attempt}`
  }
  private homeFor(r: { evaluationId: string; attempt: number }): string {
    return join(this.root, r.evaluationId, String(r.attempt))
  }
  private log(
    event: string,
    r: { evaluationId: string; attempt: number },
    extra: Record<string, unknown> = {},
  ): void {
    this.deps.log?.(event, {
      component: 'node.coordination',
      evaluationId: r.evaluationId,
      attempt: r.attempt,
      ...extra,
    })
  }
  async handleFrame(frame: NodeDownstream): Promise<void> {
    switch (frame.type) {
      case 'coordination.request': {
        const starting = this.start(CoordinationRequestPayloadSchema.parse(frame.payload))
        this.starting.add(starting)
        try {
          await starting
        } finally {
          this.starting.delete(starting)
        }
        return
      }
      case 'coordination.cancel': {
        const r = this.store.get(frame.payload.evaluationId, frame.payload.attempt)
        if (r?.leaseToken !== frame.payload.leaseToken) return
        const active = this.active.get(this.key(r))
        if (active !== undefined) {
          active.controller.abort()
          if (active.handle !== undefined)
            await this.finish(active, this.failure(active.request, 'cancelled'))
        }
        return
      }
      case 'coordination.result_ack':
        this.store.ackResult(
          frame.payload.evaluationId,
          frame.payload.attempt,
          frame.payload.leaseToken,
        )
        return
      default:
        return
    }
  }
  private failure(request: CoordinationRequest, code: string): CoordinationResult {
    return {
      ...binding(request),
      evaluationDigest: request.evaluationDigest,
      status: 'failed',
      failureCode: code,
      readEntryIds: this.store.get(request.evaluationId, request.attempt)?.readEntryIds ?? [],
    }
  }
  private configMatches(
    config: CoordinationLocalConfig | undefined,
    r: CoordinationRequest,
  ): config is CoordinationLocalConfig {
    return (
      config !== undefined &&
      config.enabled &&
      config.ownerUserId === r.principalUserId &&
      config.billingUserId === r.billingUserId &&
      config.provider === r.provider &&
      config.model === r.model &&
      config.credentialSlot === r.credentialSlot &&
      config.configRevision === r.credentialConfigRevision
    )
  }
  private async start(request: CoordinationRequest): Promise<void> {
    const key = this.key(request)
    const existing = this.store.get(request.evaluationId, request.attempt)
    if (existing !== undefined) {
      if (
        existing.leaseToken !== request.leaseToken ||
        existing.requestJson !== JSON.stringify(request)
      ) {
        this.log('duplicate_binding_rejected', request)
        return
      }
      this.flushOne(existing)
      return
    }
    const homePath = this.homeFor(request)
    this.store.begin({
      ...binding(request),
      nonce: randomUUID(),
      requestJson: JSON.stringify(request),
      homePath,
    })
    const active: Active = { request, controller: new AbortController(), needsStartAck: false }
    this.active.set(key, active)
    try {
      if (!this.deps.capable) throw new CoordinationInputError('isolation_unavailable')
      if (
        Date.parse(request.deadlineAt) <= this.now().getTime() ||
        Date.parse(request.leaseExpiresAt) <= this.now().getTime()
      )
        throw new CoordinationInputError('timeout')
      if (
        request.inputTokensEstimate !== coordinationInputTokenEstimate(request.manifest) ||
        request.inputTokensEstimate > request.maxInputTokens
      )
        throw new CoordinationInputError('input_too_large')
      const config = await loadCoordinationConfig(this.deps.stateDir)
      if (!this.configMatches(config, request))
        throw new CoordinationInputError('credential_unavailable')
      const secret = coordinationSecrets(this.deps.stateDir).resolve(
        config.provider,
        config.credentialSlot,
      )
      if (secret === undefined) throw new CoordinationInputError('credential_unavailable')
      await mkdir(homePath, { recursive: true, mode: 0o700 })
      const inputsDir = await this.downloader.prepare(request, homePath, active.controller.signal)
      if (active.controller.signal.aborted) throw new CoordinationInputError('cancelled')
      if (Date.parse(request.deadlineAt) <= this.now().getTime())
        throw new CoordinationInputError('timeout')
      const journal = this.store.get(request.evaluationId, request.attempt)!
      const handle = await this.driver.spawn(
        {
          evaluationId: request.evaluationId,
          attempt: request.attempt,
          nonce: journal.nonce,
          homePath,
          secret,
        },
        (frame) => {
          void this.output(active, frame).catch(() =>
            this.finish(active, this.failure(request, 'runtime_protocol_failed')),
          )
        },
        () => {
          void this.finish(active, this.failure(request, 'runtime_lost'))
        },
      )
      active.handle = handle
      const started = await (this.deps.readProcessStartTime ?? processStartTime)(handle.pid)
      if (started === undefined) throw new CoordinationInputError('runtime_start_failed')
      this.store.setProcess(request.evaluationId, request.attempt, handle.pid, started)
      if (
        active.controller.signal.aborted ||
        this.store.get(request.evaluationId, request.attempt)?.state !== 'active'
      )
        throw new CoordinationInputError('cancelled')
      handle.send({
        type: 'coordination.initialize',
        request,
        homePath,
        inputsDir,
        endpoint: config.endpoint,
      })
      active.timer = setInterval(() => {
        if (this.now().getTime() >= Date.parse(request.deadlineAt)) {
          void this.finish(active, this.failure(request, 'timeout'))
          return
        }
        const latest = this.store.get(request.evaluationId, request.attempt)
        if (latest !== undefined) this.flushOne(latest)
      }, 10_000)
      active.timer.unref()
      this.log('runtime_started', request)
    } catch (error) {
      await this.finish(
        active,
        this.failure(
          request,
          error instanceof CoordinationInputError ? error.code : 'runtime_start_failed',
        ),
      )
    }
  }
  private async output(active: Active, frame: RouterRuntimeOutput): Promise<void> {
    const request = active.request
    const payload = frame.payload
    if (
      payload.evaluationId !== request.evaluationId ||
      payload.attempt !== request.attempt ||
      payload.leaseToken !== request.leaseToken ||
      payload.readEntryIds.some((id) => !request.manifest.some((entry) => entry.id === id))
    )
      throw new Error('runtime binding rejected')
    if (active.finishing !== undefined) return
    if (frame.type === 'coordination.heartbeat') {
      this.store.markHeartbeat(
        request.evaluationId,
        request.attempt,
        payload.readEntryIds,
        frame.payload.modelStartedAt,
      )
      this.log(
        frame.payload.modelStartedAt === undefined ? 'inputs_read' : 'model_started',
        request,
        {
          component: 'runtime.bridge.coordination',
          readCount: payload.readEntryIds.length,
        },
      )
      if (frame.payload.modelStartedAt !== undefined) active.needsStartAck = true
      const row = this.store.get(request.evaluationId, request.attempt)
      if (row !== undefined) this.flushOne(row)
      return
    }
    const result = CoordinationResultPayloadSchema.parse(frame.payload)
    if (result.evaluationDigest !== request.evaluationDigest)
      throw new Error('runtime digest rejected')
    const row = this.store.get(request.evaluationId, request.attempt)
    if (result.readEntryIds.some((id) => !row?.readEntryIds.includes(id)))
      throw new Error('missing read receipt')
    await this.finish(active, result)
  }
  private flushOne(row: CoordinationJournal): void {
    const request = CoordinationRequestPayloadSchema.parse(JSON.parse(row.requestJson))
    const heartbeat = CoordinationHeartbeatPayloadSchema.parse({
      ...binding(request),
      readEntryIds: row.readEntryIds,
      ...(row.modelStartedAt === null ? {} : { modelStartedAt: row.modelStartedAt }),
    })
    const sent = this.deps.send(envelope('coordination.heartbeat', heartbeat))
    const active = this.active.get(this.key(row))
    if (sent && active?.needsStartAck && active.handle !== undefined) {
      active.handle.send({ type: 'coordination.model_start_ack', payload: binding(request) })
      active.needsStartAck = false
    }
    if (row.state === 'result' && row.resultJson !== null)
      this.deps.send(
        envelope(
          'coordination.result',
          CoordinationResultPayloadSchema.parse(JSON.parse(row.resultJson)),
        ),
      )
  }
  onReconnect(): void {
    for (const row of [...this.store.active(), ...this.store.pendingResults()]) this.flushOne(row)
  }
  private async finish(active: Active, result: CoordinationResult): Promise<void> {
    if (active.finishing !== undefined) return active.finishing
    // Install the promise before any await so output/exit/cancel races have one terminal owner.
    active.finishing = Promise.resolve().then(async () => {
      if (active.timer !== undefined) clearInterval(active.timer)
      active.controller.abort()
      const r = active.request
      this.store.saveResult(
        r.evaluationId,
        r.attempt,
        JSON.stringify(CoordinationResultPayloadSchema.parse(result)),
      )
      const row = this.store.get(r.evaluationId, r.attempt)
      if (row !== undefined) this.flushOne(row)
      if (active.handle !== undefined) await this.driver.terminate(active.handle)
      this.active.delete(this.key(r))
      if (row !== undefined) await this.cleanup(row)
      this.log('evaluation_terminal', r, {
        status: result.status,
        ...(result.status === 'failed' ? { reason: result.failureCode } : {}),
      })
    })
    return active.finishing
  }
  private async cleanup(row: CoordinationJournal): Promise<void> {
    // A hand-edited local journal must not turn cleanup into arbitrary directory deletion.
    if (row.homePath !== this.homeFor(row) || this.active.has(this.key(row))) return
    try {
      await (
        this.deps.removeHome ?? ((path: string) => rm(path, { recursive: true, force: true }))
      )(row.homePath)
      this.store.markCleaned(row.evaluationId, row.attempt)
      this.log('cleanup_done', row)
    } catch {
      this.log('cleanup_pending', row)
    }
  }
  async retryCleanup(): Promise<void> {
    for (const row of this.store.cleanupTasks()) await this.cleanup(row)
  }
  /** Restart never automatically replays a possibly charged model call. */
  async recover(): Promise<void> {
    for (const row of this.store.active()) {
      if (row.pid !== null && row.processStartTime !== null && (await processAlive(row.pid))) {
        const [start, command] = await Promise.all([
          processStartTime(row.pid),
          processCommandLine(row.pid),
        ])
        if (
          start === row.processStartTime &&
          command?.includes('--coordination') &&
          command.includes(row.evaluationId) &&
          command.includes(row.nonce)
        )
          await killProcessGroup(row.pid, 'SIGKILL')
      }
      const request = CoordinationRequestPayloadSchema.parse(JSON.parse(row.requestJson))
      this.store.saveResult(
        row.evaluationId,
        row.attempt,
        JSON.stringify(this.failure(request, 'node_lost')),
      )
      this.log('orphan_reconciled', row)
    }
    await this.retryCleanup()
    this.onReconnect()
  }
  async stop(): Promise<void> {
    clearInterval(this.cleanupTimer)
    for (const active of this.active.values()) active.controller.abort()
    // Preparing an input bundle is part of the lifecycle too: do not exit before its
    // cancellation has saved a terminal result and removed its private input copies.
    await Promise.all([...this.starting])
    await Promise.all(
      [...this.active.values()].map(async (active) => {
        active.controller.abort()
        if (active.handle !== undefined)
          await this.finish(active, this.failure(active.request, 'cancelled'))
      }),
    )
  }
}
