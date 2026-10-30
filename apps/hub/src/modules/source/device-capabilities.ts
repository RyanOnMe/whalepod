import type { DeviceRow } from '@whalepod/db'
import type { SourceCapability, SourcePlatform } from '@whalepod/protocol'

/** hello 持久化的能力集合：只接受已知字面量，坏数据当作未声明。 */
export function sourceCapabilitiesOf(device: DeviceRow): SourceCapability[] {
  const capabilities = device.capabilities
  if (typeof capabilities !== 'object' || capabilities === null) return []
  const raw = (capabilities as { sourceCapabilities?: unknown }).sourceCapabilities
  if (!Array.isArray(raw)) return []
  const known: SourceCapability[] = ['feishu.read.v1']
  return raw.filter((value): value is SourceCapability => known.includes(value as SourceCapability))
}

/** 平台 → 首轮能力标识；新增平台时在这里强制补齐。 */
export function capabilityForPlatform(platform: SourcePlatform): SourceCapability {
  switch (platform) {
    case 'feishu':
      return 'feishu.read.v1'
  }
}
