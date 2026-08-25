import { customType } from 'drizzle-orm/pg-core'

/**
 * drizzle 0.45 无内建 bytea 列；postgres.js 驱动以 Uint8Array 收发 bytea。
 * 仅用于 token/code 的 SHA-256 哈希列，明文永不分库（见 03 §2 脱敏约定）。
 */
export const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return 'bytea'
  },
})
