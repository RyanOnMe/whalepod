/**
 * OS 进程探测与进程组终止（P1-12；02 Task 12 Step 6）。
 *
 * 孤儿恢复的三重匹配判据：
 * 1. pid 存活（kill 0）；
 * 2. 进程启动时间一致（ps lstart，防 pid 复用）；
 * 3. cmdline 含 --run-id <id> 与 --nonce <nonce>（防误杀同 pid 无关进程）。
 * 三者全过才允许对进程组发信号；任何一项不匹配绝不发信号。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 进程启动时间（ps lstart 字符串）；进程不存在或不可见 → undefined。 */
export async function processStartTime(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)])
    const value = stdout.trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** 进程 cmdline；不可见 → undefined。 */
export async function processCommandLine(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)])
    const value = stdout.trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** 对进程组发信号（detached 子进程的 pgid 即其 pid）。 */
export async function killProcessGroup(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, signal)
    } else {
      process.kill(pid, signal)
    }
  } catch {
    // 组已不存在：视为成功。
  }
}

export interface OrphanProbe {
  readonly pid: number
  readonly processStartTime: string
  readonly runId: string
  readonly runtimeNonce: string
}

/** 三重匹配判定；返回 'matched' | 'dead' | 'mismatch'。 */
export async function probeOrphan(record: OrphanProbe): Promise<'matched' | 'dead' | 'mismatch'> {
  if (!(await processAlive(record.pid))) return 'dead'
  const [startTime, commandLine] = await Promise.all([
    processStartTime(record.pid),
    processCommandLine(record.pid),
  ])
  if (startTime === undefined || commandLine === undefined) return 'dead'
  const startTimeMatches = startTime === record.processStartTime
  const cmdlineMatches =
    commandLine.includes('--run-id') &&
    commandLine.includes(record.runId) &&
    commandLine.includes('--nonce') &&
    commandLine.includes(record.runtimeNonce)
  return startTimeMatches && cmdlineMatches ? 'matched' : 'mismatch'
}
