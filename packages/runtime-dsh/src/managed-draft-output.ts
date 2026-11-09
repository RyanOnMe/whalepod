/** Private worker write receipt and host verification; never a generic upload. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync, readdirSync, realpathSync, type BigIntStats } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { MANAGED_DRAFT_MAX_CONTENT_BYTES, MANAGED_DRAFT_OUTPUT_NAME } from '@whalepod/protocol'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const SHA = /^[a-f0-9]{64}$/
const rejected = () => new Error('managed_draft_output_rejected')
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

interface WriteBinding {
  readonly runId: string
  readonly manifestDigest: string
  readonly modelAttemptId: string
}
interface CandidateReceipt extends WriteBinding {
  readonly kind: 'candidate'
  readonly fileWriteReceiptId: string
  readonly sha256: string
  readonly byteSize: number
  readonly fileIdentity: string
}
interface OutputBinding {
  readonly runId: string
  readonly manifestDigest: string
  readonly outputDir: string
}

function rootIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

function fileIdentity(stat: BigIntStats): string {
  return `${rootIdentity(stat)}:${stat.ctimeNs}`
}

function validSize(size: unknown): size is number {
  return (
    typeof size === 'number' &&
    Number.isSafeInteger(size) &&
    size > 0 &&
    size <= MANAGED_DRAFT_MAX_CONTENT_BYTES
  )
}

function privateFile(stat: BigIntStats, size: number): boolean {
  return (
    stat.isFile() && stat.nlink === 1n && (stat.mode & 0o077n) === 0n && stat.size === BigInt(size)
  )
}

/** O_EXCL prevents a pre-existing file being relabeled as this worker's output. */
export async function writeManagedDraftOutput(
  binding: WriteBinding,
  bytes: Buffer,
): Promise<CandidateReceipt> {
  if (!validSize(bytes.byteLength)) throw rejected()
  const file = await open(
    MANAGED_DRAFT_OUTPUT_NAME,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await file.writeFile(bytes)
    await file.sync()
    const stat = await file.stat({ bigint: true })
    if (!privateFile(stat, bytes.byteLength)) throw rejected()
    return {
      kind: 'candidate',
      ...binding,
      fileWriteReceiptId: randomUUID(),
      sha256: digest(bytes),
      byteSize: bytes.byteLength,
      fileIdentity: fileIdentity(stat),
    }
  } finally {
    await file.close()
  }
}

function readReceipt(value: unknown): CandidateReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw rejected()
  const receipt = value as Record<string, unknown>
  const {
    kind,
    runId,
    manifestDigest,
    modelAttemptId,
    fileWriteReceiptId,
    sha256,
    byteSize,
    fileIdentity,
  } = receipt
  if (
    Object.keys(receipt).length !== 8 ||
    kind !== 'candidate' ||
    typeof runId !== 'string' ||
    !UUID.test(runId) ||
    typeof manifestDigest !== 'string' ||
    !SHA.test(manifestDigest) ||
    typeof modelAttemptId !== 'string' ||
    !UUID.test(modelAttemptId) ||
    typeof fileWriteReceiptId !== 'string' ||
    !UUID.test(fileWriteReceiptId) ||
    typeof sha256 !== 'string' ||
    !SHA.test(sha256) ||
    !validSize(byteSize) ||
    typeof fileIdentity !== 'string' ||
    !/^[0-9:]{7,160}$/.test(fileIdentity)
  )
    throw rejected()
  return {
    kind,
    runId,
    manifestDigest,
    modelAttemptId,
    fileWriteReceiptId,
    sha256,
    byteSize,
    fileIdentity,
  }
}

/**
 * Capture the initially empty root before the trusted host launches its worker.
 * A separately provisioned managed account must exclude ordinary processes
 * from this root; the check does not certify who controls the OS account.
 */
export function prepareManagedDraftCollector(binding: OutputBinding) {
  try {
    const { runId, manifestDigest, outputDir } = binding
    if (!UUID.test(runId) || !SHA.test(manifestDigest) || !isAbsolute(outputDir)) throw rejected()
    const initial = lstatSync(outputDir, { bigint: true })
    if (
      !initial.isDirectory() ||
      (initial.mode & 0o077n) !== 0n ||
      readdirSync(outputDir).length !== 0
    )
      throw rejected()
    const root = realpathSync(outputDir)
    const identity = rootIdentity(initial)
    const verifyRoot = () => {
      const stat = lstatSync(root, { bigint: true })
      if (!stat.isDirectory() || (stat.mode & 0o077n) !== 0n || rootIdentity(stat) !== identity)
        throw rejected()
    }
    verifyRoot()
    let consumed = false
    return {
      async collect(
        rawReceipt: unknown,
        exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null },
        approvedModelAttemptId: string | undefined,
      ) {
        if (consumed) throw rejected()
        consumed = true
        try {
          const proof = readReceipt(rawReceipt)
          if (
            exit.code !== 0 ||
            exit.signal !== null ||
            proof.runId !== runId ||
            proof.manifestDigest !== manifestDigest ||
            proof.modelAttemptId !== approvedModelAttemptId
          )
            throw rejected()
          verifyRoot()
          const path = join(root, MANAGED_DRAFT_OUTPUT_NAME)
          const file = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          )
          try {
            const before = await file.stat({ bigint: true })
            if (!privateFile(before, proof.byteSize) || fileIdentity(before) !== proof.fileIdentity)
              throw rejected()
            const bytes = Buffer.alloc(proof.byteSize + 1)
            let total = 0
            while (total < bytes.length) {
              const { bytesRead } = await file.read(bytes, total, bytes.length - total, total)
              if (bytesRead === 0) break
              total += bytesRead
            }
            const body = bytes.subarray(0, proof.byteSize)
            const after = await file.stat({ bigint: true })
            const linked = lstatSync(path, { bigint: true })
            verifyRoot()
            if (
              total !== proof.byteSize ||
              !privateFile(after, proof.byteSize) ||
              !privateFile(linked, proof.byteSize) ||
              fileIdentity(after) !== proof.fileIdentity ||
              fileIdentity(linked) !== proof.fileIdentity ||
              digest(body) !== proof.sha256
            )
              throw rejected()
            return {
              runId,
              manifestDigest,
              modelAttemptId: proof.modelAttemptId,
              fileWriteReceiptId: proof.fileWriteReceiptId,
              sha256: proof.sha256,
              byteSize: proof.byteSize,
              title: '受管草稿',
              mediaType: 'text/plain' as const,
              body,
            }
          } finally {
            await file.close()
          }
        } catch {
          throw rejected()
        }
      },
    }
  } catch {
    throw rejected()
  }
}
