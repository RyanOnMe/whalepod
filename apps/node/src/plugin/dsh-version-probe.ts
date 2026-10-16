/**
 * Runtime DSH 版本探针（#288）。
 *
 * 「敏感不兼容禁启动」需要本机真实的 DSH 版本，而它是 Node 不该自己解析的东西
 * （业务代码不得 import @deepseek-ai/*）。所以 Node 不读包，而是**问 Runtime**：
 * 以 `--print-dsh-version` 一次性模式起一次入口，读回它打印的一行 JSON。
 *
 * fail-closed 方向由调用方负责：本探针拿不到可信版本就返回 null（探针崩溃、非
 * JSON、形状不对、非零退出、超时都归这里），绝不猜、绝不兜底成别的字符串。
 * preflight 见到 null + 有兼容声明的 pack 时选择拒绝，而不是放行。
 */
import { spawn } from 'node:child_process'

/** 探针输出上限：一行 JSON，超过即视为畸形（不把无界 stdout 收进内存）。 */
const MAX_PROBE_OUTPUT_BYTES = 4 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

export interface DshVersionProbeOptions {
  readonly timeoutMs?: number
}

interface ProbeResult {
  readonly dshName: string
  readonly dshVersion: string
}

function parseProbeOutput(stdout: string): ProbeResult | null {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '')
  if (lines.length !== 1) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(lines[0] ?? '')
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const name = record['dshName']
  const version = record['dshVersion']
  if (typeof name !== 'string' || name === '') return null
  if (typeof version !== 'string' || version === '') return null
  return { dshName: name, dshVersion: version }
}

/**
 * 探测本机 DSH 发行版版本。成功返回版本字符串；任何不确定都返回 null。
 * 探针进程总是会被收掉（成功、失败、超时都一样）。
 */
export async function probeDshDistributionVersion(
  runtimeEntry: string,
  options: DshVersionProbeOptions = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return await new Promise<string | null>((resolve) => {
    let settled = false
    let stdout = ''
    let overflow = false
    const child = spawn(process.execPath, [runtimeEntry, '--print-dsh-version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出：无事可做。
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (overflow) return
      stdout += chunk
      if (Buffer.byteLength(stdout, 'utf8') > MAX_PROBE_OUTPUT_BYTES) {
        overflow = true
        finish(null)
      }
    })
    child.on('error', () => {
      finish(null)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        finish(null)
        return
      }
      const parsed = parseProbeOutput(stdout)
      finish(parsed === null ? null : parsed.dshVersion)
    })
  })
}
