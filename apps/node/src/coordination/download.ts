import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CoordinationInputDownloadSchema, type AnyCoordinationRequest } from '@whalepod/protocol'
import { readCappedBody } from '../plugin/installer.js'

export class CoordinationInputError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CoordinationInputError'
  }
}
export class CoordinationInputDownloader {
  constructor(
    private readonly deps: { hubUrl: string; deviceToken: string; fetchImpl?: typeof fetch },
  ) {}
  async prepare(
    request: AnyCoordinationRequest,
    homePath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const inputsDir = join(homePath, 'inputs')
    const seen = new Set<string>()
    let bytes = 0
    try {
      if (request.inputTokensEstimate > request.maxInputTokens)
        throw new CoordinationInputError('input_too_large')
      for (const entry of request.manifest) {
        if (seen.has(entry.id)) throw new CoordinationInputError('input_digest_mismatch')
        seen.add(entry.id)
        bytes += entry.byteSize
      }
      if (bytes > 262_144) throw new CoordinationInputError('input_too_large')
      await mkdir(inputsDir, { recursive: true, mode: 0o700 })
      for (const entry of request.manifest) {
        const timeout = AbortSignal.timeout(30_000)
        let response: Response
        try {
          response = await (this.deps.fetchImpl ?? fetch)(
            `${this.deps.hubUrl.replace(/\/$/, '')}/api/v1/${'purpose' in request ? 'discovery' : 'coordination'}/evaluations/${request.evaluationId}/inputs/${entry.id}`,
            {
              headers: {
                authorization: `Device ${this.deps.deviceToken}`,
                'x-coordination-lease': request.leaseToken,
                'x-coordination-attempt': String(request.attempt),
              },
              redirect: 'error',
              signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
            },
          )
        } catch {
          throw new CoordinationInputError(signal?.aborted ? 'cancelled' : 'input_download_failed')
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw new CoordinationInputError(
            [403, 404, 409].includes(response.status)
              ? 'source_unavailable'
              : 'input_download_failed',
          )
        }
        const envelope = JSON.parse(
          (await readCappedBody(response.body, 400_000)).toString('utf8'),
        ) as { ok?: unknown; data?: unknown }
        const parsed = CoordinationInputDownloadSchema.safeParse(envelope.data)
        if (envelope.ok !== true || !parsed.success)
          throw new CoordinationInputError('input_digest_mismatch')
        const { bodyBase64, ...metadata } = parsed.data
        if (JSON.stringify(metadata) !== JSON.stringify(entry)) {
          // Key order from callers is not authority; compare all frozen fields explicitly.
          for (const key of Object.keys(entry) as Array<keyof typeof entry>) {
            if (metadata[key] !== entry[key])
              throw new CoordinationInputError('input_digest_mismatch')
          }
        }
        const body = Buffer.from(bodyBase64, 'base64')
        if (
          body.toString('base64') !== bodyBase64 ||
          body.byteLength !== entry.byteSize ||
          createHash('sha256').update(body).digest('hex') !== entry.digest
        )
          throw new CoordinationInputError('input_digest_mismatch')
        await writeFile(join(inputsDir, `${entry.id}.bin`), body, { mode: 0o600, flag: 'wx' })
      }
      return inputsDir
    } catch (error) {
      await rm(inputsDir, { recursive: true, force: true }).catch(() => {})
      throw error instanceof CoordinationInputError
        ? error
        : new CoordinationInputError('input_download_failed')
    }
  }
}
