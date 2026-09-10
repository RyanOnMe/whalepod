import { randomBytes } from 'node:crypto'
import type { Database } from '@whalepod/db'
import {
  consumePairingCode,
  getDeviceById,
  insertDevice,
  insertPairingCode,
  listDevicesByOwner,
  revokeDevice,
  unwrapPgError,
} from '@whalepod/db'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { hashToken, issueOpaqueToken } from '../auth/token.js'

/** 配对码有效期：10 分钟（02 Task 9 Step 3）。 */
export const PAIRING_CODE_TTL_MS: number = 10 * 60 * 1000

/** Device 在线判定窗口：与 Run 租约同源（03 §3.2，30 秒）。 */
export const DEVICE_ONLINE_WINDOW_MS = 30_000 as const

/**
 * 配对码（03 §2.4「六组 base32」）：120bit 随机 → RFC4648 base32 大写 24 字符，
 * 按四字符六组展示（XXXX-XXXX-XXXX-XXXX-XXXX-XXXX，人抄写友好）。
 * 库内只存 SHA-256，且哈希输入是**归一形**（去连字符/空白、大写）——
 * Node 侧照抄的大小写/分组差异不影响命中。
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function toBase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** 归一化：去掉连字符/空白并大写；签发与 claim 两侧共用同一归一形取哈希。 */
export function canonicalizePairingCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

export function issuePairingCodeValue(): { code: string; codeHash: Uint8Array } {
  const canonical = toBase32(randomBytes(15)) // 15 字节 = 120bit → 恰好 24 字符
  const code = (canonical.match(/.{4}/g) ?? [canonical]).join('-')
  return { code, codeHash: hashToken(canonical) }
}

export interface CreatedPairingCode {
  readonly pairingCodeId: string
  readonly code: string
  readonly expiresAt: Date
}

export async function issuePairingCode(
  database: Database,
  input: { ownerUserId: string },
): Promise<CreatedPairingCode> {
  const { code, codeHash } = issuePairingCodeValue()
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS)
  const row = await insertPairingCode(database.db, {
    id: uuidv7(),
    ownerUserId: input.ownerUserId,
    codeHash,
    expiresAt,
  })
  return { pairingCodeId: row.id, code, expiresAt: row.expiresAt }
}

export interface ClaimedDevice {
  readonly deviceId: string
  /** 明文 Token 只在本响应出现一次；Hub 只存 SHA-256（03 §2.4）。 */
  readonly deviceToken: string
}

/**
 * 用配对码换 Device Token（G3-01..03）：原子消费挡重用/过期；
 * 归属取自码行的 owner_user_id——谁创建的码，设备就归谁（G3-02）。
 */
export async function claimPairingCode(
  database: Database,
  input: {
    code: string
    name: string
    platform: 'darwin' | 'linux' | 'win32'
    architecture: string
    nodeVersion: string
    nodeAppVersion: string
  },
): Promise<ClaimedDevice> {
  const now = new Date()
  let claimed: ClaimedDevice
  try {
    claimed = await database.transaction(async (tx) => {
      // 消费是唯一防重用闸门，必须先行；失败即整体回滚且不产生任何设备行。
      // claim 前归一化：人抄写的分组/大小写差异不影响命中（与签发侧同一归一形）。
      const consumed = await consumePairingCode(
        tx,
        hashToken(canonicalizePairingCode(input.code)),
        now,
      )
      if (consumed === undefined) {
        throw new ApiError(409, 'CONFLICT', 'pairing code is invalid, expired or already used')
      }
      const { token, hash } = issueOpaqueToken()
      const row = await insertDevice(tx, {
        id: uuidv7(),
        ownerUserId: consumed.ownerUserId,
        name: input.name,
        platform: input.platform,
        architecture: input.architecture,
        nodeVersion: input.nodeVersion,
        nodeAppVersion: input.nodeAppVersion,
        tokenHash: hash,
        // 能力矩阵随使用逐步上报（P1-12 inventory）；配对时未知 → 空对象。
        capabilities: {},
      })
      return { deviceId: row.id, deviceToken: token }
    })
  } catch (error) {
    // device_owner_name_unique（03 §2.4：owner 内唯一）撞名 → 409（与 agent/project 同形态）。
    const pg = unwrapPgError(error)
    if (pg?.code === '23505' && (pg.constraintName ?? '').includes('device_owner_name')) {
      throw new ApiError(409, 'CONFLICT', 'device name already taken for this owner')
    }
    throw error
  }
  return claimed
}

/** 撤销权限（03 §4）：本人或 Owner/Admin；其余一律 404（不可枚举）。 */
export async function revokeDeviceForActor(
  database: Database,
  actor: { userId: string; role: 'owner' | 'admin' | 'member' },
  deviceId: string,
): Promise<void> {
  const device = await getDeviceById(database.db, deviceId)
  const allowed =
    device !== undefined &&
    (device.ownerUserId === actor.userId || actor.role === 'owner' || actor.role === 'admin')
  if (!allowed) throw new ApiError(404, 'NOT_FOUND', 'device not found')
  await revokeDevice(database.db, deviceId, new Date())
}

export type DeviceStatus = 'online' | 'offline' | 'revoked'

export function deriveDeviceStatus(
  device: { revokedAt: Date | null; lastSeenAt: Date | null },
  now: Date,
): DeviceStatus {
  if (device.revokedAt !== null) return 'revoked'
  if (
    device.lastSeenAt !== null &&
    now.getTime() - device.lastSeenAt.getTime() <= DEVICE_ONLINE_WINDOW_MS
  ) {
    return 'online'
  }
  return 'offline'
}

export async function listOwnDevices(
  database: Database,
  userId: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await listDevicesByOwner(database.db, userId)
  const now = new Date()
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform,
    architecture: row.architecture,
    nodeVersion: row.nodeVersion,
    nodeAppVersion: row.nodeAppVersion,
    dshDistributionVersion: row.dshDistributionVersion,
    pluginPackDigests: row.pluginPackDigests,
    status: deriveDeviceStatus(row, now),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  }))
}
