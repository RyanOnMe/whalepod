import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { MANAGED_DRAFT_CONTROL_VERSION, type NodeDownstream } from '@whalepod/protocol'
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
  // This process has only the control lane. An ACK confirms metadata checks; it grants
  // no authority to read a source, launch a runtime, or send bytes to a model.
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
      dshDistributionVersion: MANAGED_DRAFT_CONTROL_VERSION,
      pluginPackDigests: [],
      contextCapabilities: [],
    }),
    onRevoked: () => {
      // Rotation and removal of the deployment file belong to its provisioner.
    },
    onFrame: (frame) => {
      if (frame.type === 'managed_draft.start') {
        const error = checkManifest(frame.payload, provision)
        session.send(commandAckFrame(frame.payload.commandId, error === undefined, error))
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
      process.exit(code)
    },
  })
  const stop = (): void => {
    session.stop()
    process.exit(0)
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
