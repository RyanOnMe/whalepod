/**
 * 探针：stdio 单通道边界（02 Task 11 Step 6 的进程级验收）。
 *
 * 以子进程跑真 bin（`node --import tsx src/bin.ts`），父进程即 Node 侧角色：
 * - stdout 每一行都必须过 RuntimeOutputSchema（单通道纯度，六原语 #3）；
 * - stderr 结构化日志行含 `runtime booted`（归因锚点）；
 * - 进程处置表：initialize→ready→prompt→completed→shutdown exit 0；
 *   裸 EOF exit 0；单行超 1 MiB exit 2 且 stdout 无协议垃圾。
 *
 * LLM 出口由 replay overlay 替换（DSH_SNAPSHOT_FILE + PROJECT311_RUNTIME_EXTRA_PATCH_FILES），
 * 不访问外部模型或密钥。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeOutputSchema, type RuntimeOutput } from '@project311/protocol'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const BIN = join(REPO_ROOT, 'apps/runtime/src/bin.ts')
const REPLAY_PATCH = join(REPO_ROOT, 'packages/runtime-dsh/config/replay.yml')
const BASIC_FIXTURE = join(
  REPO_ROOT,
  'packages/runtime-dsh/tests/dsh-contract/fixtures/basic/session.jsonl',
)

const FRAME_TIMEOUT_MS = 90_000

interface ChildHarness {
  readonly frames: RuntimeOutput[]
  readonly stdoutText: () => string
  readonly stderrText: () => string
  send(frame: Record<string, unknown>): void
  writeRaw(text: string): void
  endStdin(): void
  until(type: RuntimeOutput['type']): Promise<RuntimeOutput>
  waitExit(): Promise<number | null>
  kill(): void
}

function spawnRuntime(fixture: string): ChildHarness {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', BIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DSH_SNAPSHOT_FILE: fixture,
      PROJECT311_RUNTIME_EXTRA_PATCH_FILES: REPLAY_PATCH,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames: RuntimeOutput[] = []
  let stdoutText = ''
  let stderrText = ''
  let stdoutBuffer = ''
  const waiters: {
    type: RuntimeOutput['type']
    resolve: (frame: RuntimeOutput) => void
    timer: NodeJS.Timeout
  }[] = []

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdoutText += chunk
    stdoutBuffer += chunk
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n')
      if (newline < 0) return
      const line = stdoutBuffer.slice(0, newline)
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      if (line.length === 0) continue
      // 单通道纯度：每一行都必须是一条合法 RuntimeOutput，否则这里直接抛（fail loud）。
      const frame = RuntimeOutputSchema.parse(JSON.parse(line))
      frames.push(frame)
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i]
        if (waiter && waiter.type === frame.type) {
          clearTimeout(waiter.timer)
          waiters.splice(i, 1)
          waiter.resolve(frame)
        }
      }
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderrText += chunk
  })

  return {
    frames,
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
    send(frame) {
      child.stdin?.write(`${JSON.stringify(frame)}\n`)
    },
    writeRaw(text) {
      child.stdin?.write(text)
    },
    endStdin() {
      child.stdin?.end()
    },
    until(type) {
      const existing = frames.find((frame) => frame.type === type)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `stdio probe: timed out waiting for ${type}; received: ${
                frames.map((frame) => frame.type).join(',') || '(none)'
              }; stderr tail: ${stderrText.slice(-500)}`,
            ),
          )
        }, FRAME_TIMEOUT_MS)
        waiters.push({ type, resolve, timer })
      })
    },
    waitExit() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('stdio probe: child did not exit in time'))
        }, FRAME_TIMEOUT_MS)
        child.on('exit', (code) => {
          clearTimeout(timer)
          resolve(code)
        })
      })
    },
    kill() {
      child.kill('SIGKILL')
    },
  }
}

function commandFrame(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  }
}

function initializePayload(): Record<string, unknown> {
  const workspacePath = mkdtempSync(join(tmpdir(), 'project311-stdio-ws-'))
  const dshHomePath = mkdtempSync(join(tmpdir(), 'project311-stdio-home-'))
  tempDirs.push(workspacePath, dshHomePath)
  return {
    runId: randomUUID(),
    workspacePath,
    dshHomePath,
    profileDigest: '0'.repeat(64),
    pluginPackDigest: '0'.repeat(64),
    provider: 'replay',
    model: 'replay-model',
    persona: 'You are a contract-probe agent for project311.',
  }
}

const tempDirs: string[] = []
const children: ChildHarness[] = []

function launch(): ChildHarness {
  const harness = spawnRuntime(BASIC_FIXTURE)
  children.push(harness)
  return harness
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('probe: stdio single-channel boundary', () => {
  it('drives initialize → prompt → completed → shutdown over NDJSON and exits 0', async () => {
    const runtime = launch()
    const payload = initializePayload()
    const runId = payload['runId'] as string

    runtime.send(commandFrame('runtime.initialize', payload))
    const ready = await runtime.until('runtime.ready')
    expect(ready.payload).toMatchObject({ runId })

    runtime.send(commandFrame('run.prompt', { runId, text: 'hello' }))
    const completed = await runtime.until('run.completed')
    expect(completed.payload).toMatchObject({ runId })

    // stderr 归因锚点：结构化日志行含 runtime booted。
    expect(runtime.stderrText()).toContain('runtime booted')

    runtime.send(commandFrame('runtime.shutdown', { runId }))
    await expect(runtime.waitExit()).resolves.toBe(0)
  })

  it('stdin EOF (parent vanished) converges and exits 0 without a shutdown command', async () => {
    const runtime = launch()
    const payload = initializePayload()
    runtime.send(commandFrame('runtime.initialize', payload))
    await runtime.until('runtime.ready')

    runtime.endStdin()
    await expect(runtime.waitExit()).resolves.toBe(0)
  })

  it('a command line over 1 MiB exits non-zero and leaves stdout free of protocol garbage', async () => {
    const runtime = launch()
    runtime.writeRaw(`${'x'.repeat(1024 * 1024 + 1)}\n`)
    const code = await runtime.waitExit()
    expect(code).not.toBe(0)
    // stdout 上没有任何一帧（每行能过 schema 这一点由 harness 读取侧保证——
    // 若有垃圾行，RuntimeOutputSchema.parse 已在 data 回调里抛出）。
    expect(runtime.frames.length).toBe(0)
  })
})
