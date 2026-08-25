import { randomBytes } from 'node:crypto'

/**
 * RFC 9562 UUIDv7（03 §1：所有持久 ID 使用 UUIDv7 字符串）。
 * Node 24 的 crypto.randomUUID 只产 v4，这里用 48bit 毫秒时间戳 + 随机位自实现。
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16)
  let timestamp = BigInt(nowMs)
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn)
    timestamp >>= 8n
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70 // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80 // variant 10
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return (
    hex.slice(0, 4).join('') +
    `-${hex.slice(4, 6).join('')}` +
    `-${hex.slice(6, 8).join('')}` +
    `-${hex.slice(8, 10).join('')}` +
    `-${hex.slice(10).join('')}`
  )
}
