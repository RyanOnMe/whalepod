import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  DISCOVERY_CAPABILITY,
  RouterRuntimeInputSchema,
  RouterRuntimeOutputSchema,
  type RouterRuntimeInput,
  type RouterRuntimeOutput,
} from '@whalepod/protocol'
import { killProcessGroup } from '../supervisor/process.js'

const execFileAsync = promisify(execFile)
export interface CoordinationHandle {
  readonly pid: number
  readonly exitPromise: Promise<void>
  send(frame: RouterRuntimeInput): void
}
export interface CoordinationProcessDriver {
  spawn(
    input: {
      evaluationId: string
      attempt: number
      nonce: string
      homePath: string
      secret: string
    },
    onOutput: (output: RouterRuntimeOutput) => void,
    onExit: () => void,
  ): Promise<CoordinationHandle>
  terminate(handle: CoordinationHandle): Promise<void>
}
function minimalEnvironment(homePath?: string): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
    ...(homePath === undefined ? {} : { HOME: homePath, TMPDIR: homePath, DSH_HOME: homePath }),
  }
}
export async function probeCoordinationRuntime(
  runtimeEntry: string,
  purpose?: 'discovery',
): Promise<boolean> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [runtimeEntry, '--coordination-probe', ...(purpose === 'discovery' ? ['--discovery'] : [])],
      {
        env: minimalEnvironment(),
        timeout: 30_000,
        maxBuffer: 64_000,
      },
    )
    const parsed = JSON.parse(result.stdout.trim()) as {
      supported?: unknown
      discovery?: unknown
      discoveryPromptVersion?: unknown
    }
    return (
      parsed.supported === true &&
      (purpose === undefined ||
        (parsed.discovery === true && parsed.discoveryPromptVersion === DISCOVERY_CAPABILITY))
    )
  } catch {
    return false
  }
}
export class CoordinationRuntimeDriver implements CoordinationProcessDriver {
  constructor(private readonly runtimeEntry: string) {}
  async spawn(
    input: {
      evaluationId: string
      attempt: number
      nonce: string
      homePath: string
      secret: string
    },
    onOutput: (output: RouterRuntimeOutput) => void,
    onExit: () => void,
  ): Promise<CoordinationHandle> {
    const child = spawn(
      process.execPath,
      [
        this.runtimeEntry,
        '--coordination',
        '--evaluation-id',
        input.evaluationId,
        '--attempt',
        String(input.attempt),
        '--nonce',
        input.nonce,
      ],
      {
        cwd: input.homePath,
        env: { ...minimalEnvironment(input.homePath), WHALEPOD_COORDINATION_API_KEY: input.secret },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    )
    // The broker's stderr is private and may contain provider diagnostics; never project it.
    child.stderr.resume()
    let buffer = ''
    let invalid = false
    const reject = () => {
      invalid = true
      if (child.pid !== undefined && child.pid > 1) void killProcessGroup(child.pid, 'SIGKILL')
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (invalid) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > 1_048_576) {
        reject()
        return
      }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        try {
          onOutput(RouterRuntimeOutputSchema.parse(JSON.parse(line)))
        } catch {
          reject()
          return
        }
      }
    })
    // A dead stdin is a failure of this evaluation, not an uncaught Node process error.
    child.stdin.on('error', () => {})
    const exitPromise = new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        onExit()
        resolve()
      }
      child.once('exit', finish)
      child.once('error', finish)
    })
    const send = (frame: RouterRuntimeInput) => {
      if (!child.stdin.destroyed)
        child.stdin.write(`${JSON.stringify(RouterRuntimeInputSchema.parse(frame))}\n`, () => {})
    }
    if (child.pid === undefined) {
      await exitPromise
      throw new Error('runtime_start_failed')
    }
    return { pid: child.pid, exitPromise, send }
  }
  async terminate(handle: CoordinationHandle): Promise<void> {
    await killProcessGroup(handle.pid, 'SIGTERM')
    let timer: ReturnType<typeof setTimeout> | undefined
    const exited = await Promise.race([
      handle.exitPromise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000)
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (!exited) {
      await killProcessGroup(handle.pid, 'SIGKILL')
      await handle.exitPromise
    }
  }
}
