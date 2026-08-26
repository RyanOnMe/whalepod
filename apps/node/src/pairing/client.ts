import { randomUUID } from 'node:crypto'

/** 配对 claim 的设备初始信息（写入 device 行；hello 后补运行时事实）。 */
export interface NodePublicInfo {
  name: string
  platform: 'darwin' | 'linux' | 'win32'
  architecture: string
  nodeVersion: string
  nodeAppVersion: string
}

export interface ClaimResult {
  deviceId: string
  deviceToken: string
}

export interface ClaimDeviceOptions {
  /** fetch 注入点（测试用）。 */
  fetch?: typeof fetch
  /** 幂等键（调用方传入随机串）；缺省由本函数生成。 */
  idempotencyKey?: string
}

/**
 * 向 Hub 换取一次性 Device Token（02 Task 9 Step 3）。
 * 匿名 Node 路由：不带 Cookie/Origin，但带 Idempotency-Key（03 §4 末段）。
 */
export async function claimDevice(
  hubUrl: string,
  code: string,
  info: NodePublicInfo,
  options: ClaimDeviceOptions = {},
): Promise<ClaimResult> {
  const fetchFn = options.fetch ?? fetch
  const idempotencyKey = options.idempotencyKey ?? randomUUID()
  const response = await fetchFn(`${hubUrl.replace(/\/$/, '')}/api/v1/devices/pairing-claims`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({ code, ...info }),
  })
  const body = (await response.json().catch(() => null)) as
    | { ok: true; data: ClaimResult }
    | { ok: false; error: { code: string; message: string } }
    | null
  if (!response.ok || body === null || body.ok !== true) {
    const code = body !== null && body.ok === false ? body.error.code : 'CLAIM_FAILED'
    const message = body !== null && body.ok === false ? body.error.message : 'pairing claim failed'
    throw new Error(`${code}: ${message}`)
  }
  return body.data
}
