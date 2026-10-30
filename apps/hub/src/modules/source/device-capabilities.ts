import type { DeviceRow } from '@whalepod/db'
import {
  SourceCapabilitySchema,
  type SourceCapability,
  type SourcePlatform,
} from '@whalepod/protocol'

/** hello 持久化的能力集合：只接受已知字面量，坏数据当作未声明。 */
export function sourceCapabilitiesOf(device: DeviceRow): SourceCapability[] {
  const capabilities = device.capabilities
  if (typeof capabilities !== 'object' || capabilities === null) return []
  const raw = (capabilities as { sourceCapabilities?: unknown }).sourceCapabilities
  if (!Array.isArray(raw)) return []
  const known = SourceCapabilitySchema.options
  return raw.filter((value): value is SourceCapability =>
    (known as readonly string[]).includes(value as string),
  )
}

/** 平台 → 首轮能力标识；新增平台时在这里强制补齐。 */
export function capabilityForPlatform(platform: SourcePlatform): SourceCapability {
  switch (platform) {
    case 'feishu':
      return 'feishu.read.v1'
  }
}
