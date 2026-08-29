/**
 * Hub plugin pack descriptor 拉取（P1-17；03 §4 `GET /node/plugin-packs/:packDigest`，
 * Device Token 鉴权）。
 *
 * gateway 现为纯 WS（hub-socket.ts 无 HTTP client），pairing/client.ts 的
 * fetch 先例属配对域——按交付约束在 run 目录放一个窄的 fetch 封装：fetch 注入
 * （测试用内存 descriptor 服务）+ AbortSignal 超时 + `{ ok, data | error }`
 * envelope 严格解析。descriptor 线形由 protocol 的 PluginPackDescriptorSchema
 * 定义（含可选 entry 双保险通道）；fail-closed。失败折算为 PluginPreflightError，
 * code 直接可回 command.ack。
 */
import {
  ErrorCodeSchema,
  PluginPackDescriptorSchema,
  type PluginManifest,
  type PluginPackEntry,
} from '@project311/protocol'
import {
  PluginPreflightError,
  type PluginPackDescriptor,
  type PreflightFailureCode,
} from '../plugin/plugin-preflight.js'

export const DEFAULT_DESCRIPTOR_TIMEOUT_MS = 15_000

export interface FetchDescriptorOptions {
  /** fetch 注入点（测试用内存服务；缺省全局 fetch）。 */
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

function descriptorError(code: PreflightFailureCode, message: string): PluginPreflightError {
  return new PluginPreflightError(code, message)
}

/** 把 Hub envelope 错误码折算成 preflight 失败码（协议外码 → RUNTIME_START_FAILED）。 */
function hubErrorCode(code: unknown): PreflightFailureCode {
  const parsed = ErrorCodeSchema.safeParse(code)
  if (
    parsed.success &&
    (parsed.data === 'NOT_FOUND' ||
      parsed.data === 'AUTH_REQUIRED' ||
      parsed.data === 'FORBIDDEN' ||
      parsed.data === 'PLUGIN_PACK_MISMATCH' ||
      parsed.data === 'PLUGIN_UNREVIEWED' ||
      parsed.data === 'VALIDATION_FAILED')
  ) {
    return parsed.data
  }
  return 'RUNTIME_START_FAILED'
}

/**
 * 拉取并校验 pack descriptor。任何传输/解析失败都抛 PluginPreflightError；
 * 返回值里 manifest 已过 PluginManifestSchema（fail-closed，schema 外字段拒绝）。
 */
export async function fetchPluginPackDescriptor(
  hubUrl: string,
  deviceToken: string,
  packDigest: string,
  options: FetchDescriptorOptions = {},
): Promise<PluginPackDescriptor> {
  const fetchFn = options.fetchImpl ?? fetch
  const url = `${hubUrl.replace(/\/$/, '')}/api/v1/node/plugin-packs/${packDigest}`
  let response: Response
  try {
    response = await fetchFn(url, {
      headers: { authorization: `Device ${deviceToken}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_DESCRIPTOR_TIMEOUT_MS),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'network error'
    throw descriptorError('RUNTIME_START_FAILED', `plugin pack descriptor fetch failed: ${reason}`)
  }
  if (!response.ok) {
    const code =
      response.status === 404
        ? 'NOT_FOUND'
        : response.status === 401
          ? 'AUTH_REQUIRED'
          : response.status === 403
            ? 'FORBIDDEN'
            : 'RUNTIME_START_FAILED'
    throw descriptorError(
      code,
      `plugin pack descriptor request failed with http ${response.status}`,
    )
  }
  let body: unknown
  try {
    body = (await response.json()) as unknown
  } catch {
    throw descriptorError('VALIDATION_FAILED', 'plugin pack descriptor response is not json')
  }
  if (typeof body !== 'object' || body === null) {
    throw descriptorError('VALIDATION_FAILED', 'plugin pack descriptor envelope is malformed')
  }
  const envelope = body as {
    ok?: unknown
    data?: unknown
    error?: { code?: unknown; message?: unknown }
  }
  if (envelope.ok !== true || typeof envelope.data !== 'object' || envelope.data === null) {
    const hubMessage =
      typeof envelope.error?.message === 'string' ? envelope.error.message.slice(0, 500) : ''
    throw descriptorError(
      hubErrorCode(envelope.error?.code),
      `plugin pack descriptor rejected by hub${hubMessage === '' ? '' : `: ${hubMessage}`}`,
    )
  }
  const parsed = PluginPackDescriptorSchema.safeParse(envelope.data)
  if (!parsed.success) {
    throw descriptorError('VALIDATION_FAILED', 'plugin pack descriptor shape rejected by schema')
  }
  const packages = parsed.data.packages.map((pkg) => {
    const entry: PluginPackEntry | undefined = pkg.entry
    return {
      manifest: pkg.manifest as PluginManifest,
      lockfile: pkg.lockfile,
      ...(entry !== undefined ? { entry } : {}),
    }
  })
  return {
    schemaVersion: 1,
    packDigest: parsed.data.packDigest,
    name: parsed.data.name,
    packages,
  }
}
