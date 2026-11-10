import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import {
  MANAGED_DRAFT_CONTROL_VERSION,
  MANAGED_DRAFT_EXECUTION_VERSION,
  ManagedDraftOutcomeSchema,
  type NodeDownstream,
} from '@whalepod/protocol'
import { canonicalJson } from '@whalepod/protocol/plugin-pack-digest'
import { z } from 'zod'
import { detectPlatformKind } from '../gateway/hello-facts.js'
import { commandAckFrame } from '../gateway/hub-socket.js'
import { startDeviceSession } from '../gateway/session.js'

const maxProvisioningBytes = 4096
const ProvisioningSchema = z.strictObject({
  hubUrl: z.url(),
  deviceId: z.uuid(),
  deviceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  managedHostToken: z.string().regex(/^[a-f0-9]{64}$/),
  ownerUserId: z.uuid(),
  workspaceId: z.uuid(),
  profileRevisionId: z.uuid(),
  managedHostGeneration: z.int().positive(),
  managedDraftExecution: z.boolean().optional(),
})
type Provisioning = z.infer<typeof ProvisioningSchema>

function provisionedHub(origin: string): string {
  const url = new URL(origin)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && url.port)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('managed_draft_hub_origin_invalid')
  }
  return url.origin
}

async function readProvisioning(path: string): Promise<Provisioning> {
  try {
    // Deployment credentials are external to the ordinary paired Node state. Fail closed
    // when the platform cannot validate the actual open file and reject symlinks.
    if (
      process.getuid === undefined ||
      typeof constants.O_NOFOLLOW !== 'number' ||
      typeof constants.O_NONBLOCK !== 'number'
    ) {
      throw new Error('managed_draft_file_protection_unavailable')
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      const mode = stat.mode & 0o7777
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid() ||
        stat.nlink !== 1 ||
        (mode !== 0o600 && mode !== 0o400) ||
        stat.size > maxProvisioningBytes
      ) {
        throw new Error('managed_draft_file_protection_invalid')
      }
      const bytes = Buffer.alloc(maxProvisioningBytes + 1)
      try {
        let size = 0
        while (size < bytes.length) {
          const { bytesRead } = await file.read(bytes, size, bytes.length - size, size)
          if (bytesRead === 0) break
          size += bytesRead
        }
        if (size > maxProvisioningBytes) throw new Error('managed_draft_file_too_large')
        const json: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)),
        )
        const config = ProvisioningSchema.parse(json)
        return { ...config, hubUrl: provisionedHub(config.hubUrl) }
      } finally {
        bytes.fill(0)
      }
    } finally {
      await file.close()
    }
  } catch {
    // FS/URL/JSON/schema errors may include paths or credentials.
    throw new Error('managed_draft_provisioning_unavailable')
  }
}

function checkManifest(
  { manifest, manifestDigest }: Extract<NodeDownstream, { type: 'managed_draft.start' }>['payload'],
  provision: Provisioning,
): { code: string; message: string } | undefined {
  if (
    manifest.deviceId !== provision.deviceId ||
    manifest.ownerUserId !== provision.ownerUserId ||
    manifest.workspaceId !== provision.workspaceId ||
    manifest.profileRevisionId !== provision.profileRevisionId ||
    manifest.managedHostGeneration !== provision.managedHostGeneration
  ) {
    return { code: 'FORBIDDEN', message: 'managed_draft_placement_mismatch' }
  }
  if (createHash('sha256').update(canonicalJson(manifest)).digest('hex') !== manifestDigest) {
    return { code: 'VALIDATION_FAILED', message: 'managed_draft_manifest_digest_mismatch' }
  }
  const expiry = Date.parse(manifest.expiresAt)
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    return { code: 'CONTEXT_UNAVAILABLE', message: 'managed_draft_manifest_expired' }
  }
}

export async function runManagedDraftNode(provisioningPath: string): Promise<void> {
  const provision = await readProvisioning(provisioningPath)
  const executionEnabled = provision.managedDraftExecution === true && process.platform === 'darwin'
  const recent = new Map<string, number>()
  let active: { cancellation: AbortController; finished: Promise<void> } | undefined
  let stopping = false
  const shutdown = (code: number) => {
    if (stopping) return
    stopping = true
    session.stop()
    active?.cancellation.abort()
    void (active?.finished ?? Promise.resolve()).finally(() => process.exit(code))
  }
  const reportOutcome = (
    {
      commandId,
      manifest,
      manifestDigest,
    }: Extract<NodeDownstream, { type: 'managed_draft.execute' }>['payload'],
    attemptId?: string,
  ): void => {
    session.send(
      JSON.stringify(
        ManagedDraftOutcomeSchema.parse({
          protocolVersion: 1,
          messageId: randomUUID(),
          sentAt: new Date().toISOString(),
          type: 'managed_draft.outcome',
          payload: {
            commandId,
            runId: manifest.runId,
            manifestDigest,
            ...(attemptId === undefined
              ? { outcome: 'failed' }
              : { outcome: 'completed', attemptId }),
          },
        }),
      ),
    )
  }
  const session = startDeviceSession({
    config: {
      hubUrl: provision.hubUrl,
      deviceId: provision.deviceId,
      deviceToken: provision.deviceToken,
    },
    managedHostToken: provision.managedHostToken,
    helloFacts: () => ({
      nodeVersion: process.version,
      platform: detectPlatformKind(),
      architecture: process.arch,
      dshDistributionVersion: executionEnabled
        ? MANAGED_DRAFT_EXECUTION_VERSION
        : MANAGED_DRAFT_CONTROL_VERSION,
      pluginPackDigests: [],
      contextCapabilities: [],
    }),
    onRevoked: () => {
      // Rotation and removal of the deployment file belong to its provisioner.
      active?.cancellation.abort()
    },
    onDisconnected: () => active?.cancellation.abort(),
    onFrame: (frame) => {
      if (stopping) return
      if (frame.type === 'managed_draft.start') {
        // A preparation ACK remains metadata only, even on an execution-enabled Node.
        const error = checkManifest(frame.payload, provision)
        session.send(commandAckFrame(frame.payload.commandId, error === undefined, error))
        return
      }
      if (frame.type === 'managed_draft.execute') {
        const { commandId, manifest } = frame.payload
        const now = Date.now()
        for (const [key, expiry] of recent) if (expiry <= now) recent.delete(key)
        if (recent.has(commandId) || recent.size >= 1024) return
        const expiry = Date.parse(manifest.expiresAt)
        if (expiry > now) recent.set(commandId, expiry)
        if (
          !executionEnabled ||
          checkManifest(frame.payload, provision) !== undefined ||
          active !== undefined
        ) {
          reportOutcome(frame.payload)
          return
        }
        const cancellation = new AbortController()
        const finished = import('./execution.js')
          .then(({ executeManagedDraft }) =>
            executeManagedDraft(provision, frame.payload, cancellation.signal),
          )
          .then(
            (attemptId) => {
              if (!cancellation.signal.aborted) reportOutcome(frame.payload, attemptId)
            },
            () => {
              if (!cancellation.signal.aborted) reportOutcome(frame.payload)
            },
          )
          .finally(() => {
            active = undefined
          })
        active = { cancellation, finished }
        return
      }
      if ('commandId' in frame.payload && typeof frame.payload.commandId === 'string') {
        session.send(
          commandAckFrame(frame.payload.commandId, false, {
            code: 'FORBIDDEN',
            message: 'managed_draft_only',
          }),
        )
      }
    },
    exit: (code) => {
      process.stderr.write(
        `${JSON.stringify({
          level: 'error',
          component: 'node.managed_draft',
          msg: 'managed_draft_session_closed',
        })}\n`,
      )
      shutdown(code)
    },
  })
  process.once('SIGTERM', () => shutdown(0))
  process.once('SIGINT', () => shutdown(0))
}
