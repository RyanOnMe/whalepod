/**
 * ADR-0027 §3（PC-05a）：Node 按 Run 归属下载项目上下文快照。
 *
 * `run.start.projectContext` 只给清单；正文经 `GET /node/runs/:runId/project-context/bundle`
 * 受控下载（Device Token + Run 归属）。Node 逐条核对 digest/byteSize（并核对快照
 * 摘要与 headerDigest），不一致即 `CONTEXT_DIGEST_MISMATCH`，绝不启动 Runtime。
 *
 * 副本目录 `runtime-context/<runId>`，文件名 = entryId（清单成员 UUID，无路径面）。
 */
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ErrorCodeSchema,
  RunProjectContextBundleSchema,
  type RunProjectContextManifestEntry,
  type RunStartProjectContext,
} from '@whalepod/protocol'

export const DEFAULT_CONTEXT_TIMEOUT_MS = 30_000

export class ProjectContextError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ProjectContextError'
  }
}

export interface PreparedProjectContext {
  /** 本地只读副本目录（本地 wire 绝对路径，红线同 artifactInputsDir）。 */
  readonly dir: string
  readonly snapshotId: string
  readonly snapshotDigest: string
  readonly headerText: string
  readonly headerDigest: string
  readonly entries: readonly RunProjectContextManifestEntry[]
}

export interface ProjectContextDownloaderDeps {
  readonly hubUrl: string
  readonly deviceToken: string
  /** 输入根目录（<stateDir>/runtime-context；每 run 一层子目录）。 */
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
  if (status === 409) return 'CONFLICT'
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

export class ProjectContextDownloader {
  constructor(private readonly deps: ProjectContextDownloaderDeps) {}

  async prepare(runId: string, manifest: RunStartProjectContext): Promise<PreparedProjectContext> {
    const dir = join(this.deps.inputsRoot, runId)
    try {
      await mkdir(dir, { recursive: true })
      const response = await this.request(
        `${this.deps.hubUrl.replace(/\/$/, '')}/api/v1/node/runs/${runId}/project-context/bundle`,
      )
      if (!response.ok) {
        const envelopeCode = await wireErrorCodeFrom(response)
        throw new ProjectContextError(
          envelopeCode ?? mapStatus(response.status),
          envelopeCode !== undefined
            ? 'project context bundle rejected by hub'
            : `project context bundle failed with http ${response.status}`,
        )
      }
      const envelope = (await response.json()) as { ok?: unknown; data?: unknown }
      if (envelope.ok !== true) {
        throw new ProjectContextError('VALIDATION_FAILED', 'bundle response malformed')
      }
      const parsed = RunProjectContextBundleSchema.safeParse(envelope.data)
      if (!parsed.success) {
        throw new ProjectContextError('VALIDATION_FAILED', 'bundle rejected by schema')
      }
      const bundle = parsed.data
      if (
        bundle.snapshotId !== manifest.snapshotId ||
        bundle.digest !== manifest.digest ||
        bundle.headerDigest !== manifest.headerDigest ||
        bundle.headerText !== manifest.headerText ||
        sha256Hex(Buffer.from(bundle.headerText, 'utf8')) !== bundle.headerDigest
      ) {
        throw new ProjectContextError(
          'CONTEXT_DIGEST_MISMATCH',
          'project context bundle header does not match run.start',
        )
      }

      const expected = new Map(manifest.manifest.map((entry) => [entry.entryId, entry]))
      const seen = new Set<string>()
      for (const entry of bundle.entries) {
        const pinned = expected.get(entry.entryId)
        if (pinned === undefined || seen.has(entry.entryId)) {
          throw new ProjectContextError(
            'CONTEXT_DIGEST_MISMATCH',
            'project context bundle contains an unexpected entry',
          )
        }
        seen.add(entry.entryId)
        if (
          entry.kind !== pinned.kind ||
          entry.title !== pinned.title ||
          entry.digest !== pinned.digest ||
          entry.byteSize !== pinned.byteSize
        ) {
          throw new ProjectContextError(
            'CONTEXT_DIGEST_MISMATCH',
            'project context entry metadata does not match run.start',
          )
        }
        const bytes = Buffer.from(entry.bodyBase64, 'base64')
        if (bytes.byteLength !== pinned.byteSize || sha256Hex(bytes) !== pinned.digest) {
          throw new ProjectContextError(
            'CONTEXT_DIGEST_MISMATCH',
            'project context entry copy failed digest verification',
          )
        }
        await writeFile(join(dir, entry.entryId), bytes)
      }
      if (seen.size !== expected.size) {
        throw new ProjectContextError(
          'CONTEXT_DIGEST_MISMATCH',
          'project context bundle is missing an entry',
        )
      }
      this.deps.log?.('info', 'project context prepared', {
        component: 'node.context',
        runId,
        snapshotId: manifest.snapshotId,
        count: bundle.entries.length,
      })
      return {
        dir,
        snapshotId: manifest.snapshotId,
        snapshotDigest: manifest.digest,
        headerText: manifest.headerText,
        headerDigest: manifest.headerDigest,
        entries: manifest.manifest,
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      if (error instanceof ProjectContextError) throw error
      const reason = error instanceof Error ? error.name : 'unknown error'
      throw new ProjectContextError(
        'RUNTIME_START_FAILED',
        `project context prepare failed: ${reason}`,
      )
    }
  }

  /** Run 终态/启动拒绝后的本地副本清理（best-effort）。 */
  async cleanup(runId: string): Promise<void> {
    await rm(join(this.deps.inputsRoot, runId), { recursive: true, force: true }).catch(() => {})
  }

  private async request(url: string): Promise<Response> {
    const fetchFn = this.deps.fetchImpl ?? fetch
    try {
      return await fetchFn(url, {
        headers: { authorization: `Device ${this.deps.deviceToken}` },
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_CONTEXT_TIMEOUT_MS),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'network error'
      throw new ProjectContextError('DEVICE_OFFLINE', `hub request failed: ${reason}`)
    }
  }
}
