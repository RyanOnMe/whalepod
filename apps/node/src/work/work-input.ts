/**
 * ADR-0028 §3（RD-02a-2b）：Node 按 Run 归属下载工作输入正文。
 *
 * `run.start.workInput` 只给冻结清单；正文经
 * `GET /node/runs/:runId/work-input/bundle` 受控下载（Device Token + Run 归属）。
 * 逐条核对 bodyDigest/byteSize 与清单元数据，不一致即拒绝启动 Runtime。
 *
 * 副本目录 `<stateDir>/runtime-work-inputs/<runId>`，文件名 = inboxItemId。
 */
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ErrorCodeSchema,
  WorkInputBundleSchema,
  type RunStartWorkInput,
  type WorkInputBundle,
  type WorkInputManifest,
  type WorkInputManifestEntry,
} from '@whalepod/protocol'

export const DEFAULT_WORK_INPUT_TIMEOUT_MS = 30_000

export class WorkInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'WorkInputError'
  }
}

export interface PreparedWorkInputs {
  readonly dir: string
  readonly workKey: string
  readonly manifestDigest: string
  readonly entries: readonly WorkInputManifestEntry[]
}

export interface WorkInputDownloaderDeps {
  readonly hubUrl: string
  readonly deviceToken: string
  readonly inputsRoot: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly log?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    context?: Record<string, unknown>,
  ) => void
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function mapStatus(status: number): string {
  if (status === 404) return 'NOT_FOUND'
  if (status === 401) return 'AUTH_REQUIRED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 409) return 'CONTEXT_UNAVAILABLE'
  return 'INTERNAL_ERROR'
}

async function wireErrorCodeFrom(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { ok?: unknown; error?: { code?: unknown } }
    if (body.ok !== false) return undefined
    const code = body.error?.code
    if (typeof code !== 'string') return undefined
    return ErrorCodeSchema.safeParse(code).success ? code : undefined
  } catch {
    return undefined
  }
}

export class WorkInputDownloader {
  constructor(private readonly deps: WorkInputDownloaderDeps) {}

  async prepare(
    runId: string,
    input: RunStartWorkInput,
    privateDirectory?: string,
  ): Promise<PreparedWorkInputs> {
    const manifest = input.manifest
    if ((input.discoveryExecutionId !== undefined) !== (privateDirectory !== undefined)) {
      throw new WorkInputError('CONTEXT_UNAVAILABLE', 'discovery input directory unavailable')
    }
    const dir = privateDirectory ?? join(this.deps.inputsRoot, runId)
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const response = await this.request(
        `${this.deps.hubUrl.replace(/\/$/, '')}/api/v1/node/runs/${runId}/work-input/bundle`,
      )
      if (!response.ok) {
        const envelopeCode = await wireErrorCodeFrom(response)
        throw new WorkInputError(
          envelopeCode ?? mapStatus(response.status),
          envelopeCode !== undefined
            ? 'work input bundle rejected by hub'
            : `work input bundle failed with http ${response.status}`,
        )
      }
      const envelope = (await response.json()) as { ok?: unknown; data?: unknown }
      if (envelope.ok !== true) {
        throw new WorkInputError('VALIDATION_FAILED', 'bundle response malformed')
      }
      const parsed = WorkInputBundleSchema.safeParse(envelope.data)
      if (!parsed.success) {
        throw new WorkInputError('VALIDATION_FAILED', 'bundle rejected by schema')
      }
      const bundle = parsed.data
      if (
        bundle.version !== manifest.version ||
        bundle.workKey !== manifest.workKey ||
        bundle.manifestDigest !== input.manifestDigest
      ) {
        throw new WorkInputError('CONTEXT_DIGEST_MISMATCH', 'work input bundle header mismatch')
      }
      const expected = new Map(manifest.entries.map((entry) => [entry.inboxItemId, entry]))
      const seen = new Set<string>()
      for (const entry of bundle.entries) {
        const pinned = expected.get(entry.inboxItemId)
        if (pinned === undefined || seen.has(entry.inboxItemId)) {
          throw new WorkInputError(
            'CONTEXT_DIGEST_MISMATCH',
            'work input bundle contains an unexpected entry',
          )
        }
        seen.add(entry.inboxItemId)
        if (
          entry.sourceType !== pinned.sourceType ||
          entry.sourceId !== pinned.sourceId ||
          entry.sourceVersion !== pinned.sourceVersion ||
          entry.sourceDigest !== pinned.sourceDigest ||
          entry.bodyDigest !== pinned.bodyDigest ||
          entry.byteSize !== pinned.byteSize ||
          entry.authorizationGeneration !== pinned.authorizationGeneration ||
          entry.title !== pinned.title
        ) {
          throw new WorkInputError(
            'CONTEXT_DIGEST_MISMATCH',
            'work input entry metadata does not match run.start',
          )
        }
        const bytes = Buffer.from(entry.bodyBase64, 'base64')
        if (bytes.byteLength !== pinned.byteSize || sha256Hex(bytes) !== pinned.bodyDigest) {
          throw new WorkInputError(
            'CONTEXT_DIGEST_MISMATCH',
            'work input copy failed digest verification',
          )
        }
        await writeFile(join(dir, entry.inboxItemId), bytes, { mode: 0o600 })
      }
      if (seen.size !== expected.size) {
        throw new WorkInputError('CONTEXT_DIGEST_MISMATCH', 'work input bundle is missing an entry')
      }
      this.deps.log?.('info', 'work inputs prepared', {
        component: 'node.work_input',
        runId,
        count: bundle.entries.length,
      })
      return {
        dir,
        workKey: manifest.workKey,
        manifestDigest: bundle.manifestDigest,
        entries: manifest.entries,
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      if (error instanceof WorkInputError) throw error
      const reason = error instanceof Error ? error.name : 'unknown error'
      throw new WorkInputError('RUNTIME_START_FAILED', `work input prepare failed: ${reason}`)
    }
  }

  async cleanup(runId: string): Promise<void> {
    await rm(join(this.deps.inputsRoot, runId), { recursive: true, force: true }).catch(() => {})
  }

  /** Fail closed when the Hub cannot revalidate a discovery Run's exact input binding. */
  async authorizeDiscovery(runId: string, signal: AbortSignal): Promise<boolean> {
    const response = await this.request(
      `${this.deps.hubUrl.replace(/\/$/, '')}/api/v1/node/runs/${runId}/work-input/authorize`,
      signal,
    )
    if (response.status === 204) return true
    await response.body?.cancel()
    return false
  }

  private async request(url: string, signal?: AbortSignal): Promise<Response> {
    const fetchFn = this.deps.fetchImpl ?? fetch
    try {
      const deadline = AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_WORK_INPUT_TIMEOUT_MS)
      return await fetchFn(url, {
        headers: { authorization: `Device ${this.deps.deviceToken}` },
        redirect: 'error',
        signal: signal === undefined ? deadline : AbortSignal.any([deadline, signal]),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'network error'
      throw new WorkInputError('DEVICE_OFFLINE', `hub request failed: ${reason}`)
    }
  }
}

/** 测试/诊断用：把 bundle 摘要与清单重新核对一遍（与 Hub 的 canonicalJson 无关）。 */
export function workInputBundleMatchesManifest(
  bundle: WorkInputBundle,
  manifest: WorkInputManifest,
): boolean {
  if (bundle.version !== manifest.version || bundle.workKey !== manifest.workKey) return false
  if (bundle.entries.length !== manifest.entries.length) return false
  return bundle.entries.every((entry, index) => {
    const pinned = manifest.entries[index]
    return (
      pinned !== undefined &&
      entry.inboxItemId === pinned.inboxItemId &&
      entry.bodyDigest === pinned.bodyDigest &&
      entry.byteSize === pinned.byteSize
    )
  })
}
