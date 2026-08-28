import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import type { DbHandle } from '../client.js'
import { devicePairingCodes, devices } from '../schema/device.js'

export type DeviceRow = typeof devices.$inferSelect
export type DevicePairingCodeRow = typeof devicePairingCodes.$inferSelect

export interface NewDevice {
  id: string
  ownerUserId: string
  name: string
  platform: DeviceRow['platform']
  architecture: string
  nodeVersion: string
  nodeAppVersion: string
  /** 只存 SHA-256；明文 Device Token 仅在 claim 响应中出现一次（03 §2.4）。 */
  tokenHash: Uint8Array
  /** 配对时未知，空对象起算；能力矩阵由后续上报扩展（03 §2.4）。 */
  capabilities: Record<string, unknown>
}

export async function insertDevice(handle: DbHandle, device: NewDevice): Promise<DeviceRow> {
  const [row] = await handle.insert(devices).values(device).returning()
  if (row === undefined) throw new Error('insert device returned no row')
  return row
}

export async function getDeviceById(handle: DbHandle, id: string): Promise<DeviceRow | undefined> {
  const [row] = await handle.select().from(devices).where(eq(devices.id, id)).limit(1)
  return row
}

/** Device Token 认证：按 SHA-256 hash 找唯一行（schema 唯一约束，03 §6）。 */
export async function findDeviceByTokenHash(
  handle: DbHandle,
  tokenHash: Uint8Array,
): Promise<DeviceRow | undefined> {
  const [row] = await handle.select().from(devices).where(eq(devices.tokenHash, tokenHash)).limit(1)
  return row
}

export async function listDevicesByOwner(
  handle: DbHandle,
  ownerUserId: string,
): Promise<DeviceRow[]> {
  return handle
    .select()
    .from(devices)
    .where(eq(devices.ownerUserId, ownerUserId))
    .orderBy(desc(devices.id))
}

/** 撤销（幂等）：重复调用只刷新 revokedAt，不报错。 */
export async function revokeDevice(
  handle: DbHandle,
  id: string,
  revokedAt: Date,
): Promise<DeviceRow | undefined> {
  const [row] = await handle
    .update(devices)
    .set({ revokedAt })
    .where(eq(devices.id, id))
    .returning()
  return row
}

/**
 * node.hello 运行时事实回填（03 §6.2；#37 列）。digests 必须已是数组，
 * CHECK 兜底；lastSeenAt 同步刷新。
 */
export async function setDeviceHelloFacts(
  handle: DbHandle,
  id: string,
  facts: { dshDistributionVersion: string; pluginPackDigests: string[]; lastSeenAt: Date },
): Promise<DeviceRow | undefined> {
  const [row] = await handle.update(devices).set(facts).where(eq(devices.id, id)).returning()
  return row
}

/** 只刷 lastSeenAt（inventory 等非 hello 帧的活跃投影；不动 #37 事实列）。 */
export async function touchDeviceLastSeenAt(handle: DbHandle, id: string): Promise<void> {
  await handle
    .update(devices)
    .set({ lastSeenAt: new Date() })
    .where(eq(devices.id, id))
}

// ---------------- pairing code ----------------

export interface NewPairingCode {
  id: string
  ownerUserId: string
  /** 只存 SHA-256；明文码仅返回给发起 Member 一次。 */
  codeHash: Uint8Array
  expiresAt: Date
}

export async function insertPairingCode(
  handle: DbHandle,
  code: NewPairingCode,
): Promise<DevicePairingCodeRow> {
  const [row] = await handle.insert(devicePairingCodes).values(code).returning()
  if (row === undefined) throw new Error('insert pairing code returned no row')
  return row
}

export async function getPairingCodeById(
  handle: DbHandle,
  id: string,
): Promise<DevicePairingCodeRow | undefined> {
  const [row] = await handle
    .select()
    .from(devicePairingCodes)
    .where(eq(devicePairingCodes.id, id))
    .limit(1)
  return row
}

/**
 * 原子消费配对码（G3-01/03）：未消费且未过期才更新，并发双 claim 只有一个赢，
 * 败者拿到 undefined → 统一 409（不可枚举）。归属以行为准（owner_user_id），
 * 与发起 claim 的调用方身份无关。
 */
export async function consumePairingCode(
  handle: DbHandle,
  codeHash: Uint8Array,
  now: Date,
): Promise<DevicePairingCodeRow | undefined> {
  const [row] = await handle
    .update(devicePairingCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(devicePairingCodes.codeHash, codeHash),
        isNull(devicePairingCodes.consumedAt),
        gt(devicePairingCodes.expiresAt, now),
      ),
    )
    .returning()
  return row
}
