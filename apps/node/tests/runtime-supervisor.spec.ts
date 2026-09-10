/**
 * RuntimeSupervisor 单测（P1-12；02 Task 12 Step 5/6/7、G3-05、R5/R8 前置）。
 *
 * 判定基线：
 * - 容量上限：同时最多 2 个 Runtime，第 3 个 → NODE_CAPACITY_REACHED；
 * - 环境白名单 scrub：子进程 env 只含 PATH/locale/TMPDIR + 该 provider 的最小凭据，
 *   绝不出现 Device Token、SSH agent、其他云凭据；
 * - 凭据缺失 → spawn 前即 MODEL_CREDENTIAL_UNAVAILABLE（Runtime 一个不启动）；
 * - stderr 只保留末尾 8KiB；
 * - 超时回收：Runtime 超过 wall-clock 上限被终止并标记 runtime_timeout。
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SecretStore } from '../src/secret/store.js'
import { WorkspaceRegistry } from '../src/workspace/registry.js'
import { RuntimeSupervisor } from '../src/supervisor/runtime-supervisor.js'
import { StderrTail } from '../src/supervisor/stderr-tail.js'
import type { RuntimeStartSpec } from '../src/runtime-driver.js'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-supervisor-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const LONG_SCRIPT = 'setInterval(() => {}, 1000)' // 直到被杀才退出

const CREDENTIAL_ENV = { WHALEPOD_DSH_SECRET_DSH_API_KEY: 'sk-test-123' }

function makeSpec(runId: string): RuntimeStartSpec {
  return {
    runId,
    nonce: `nonce-${runId}`,
    workspaceId: 'ws',
    prompt: 'do things',
    agent: {
      id: '00000000-0000-4000-8000-000000000001',
      profileRevisionId: '00000000-0000-4000-8000-000000000002',
      persona: 'p',
      provider: 'dsh',
      model: 'test-model',
      credentialSlot: 'api_key',
      maxTokens: 100,
    },
    expectedProfileDigest: 'a'.repeat(64),
    expectedPluginPackDigest: 'b'.repeat(64),
  }
}

interface SpawnRecord {
  readonly runId: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

/** 测试驱动：spawn 真实 node 长驻进程（cmdline 带 --run-id/--nonce 供恢复探针），记录 env。 */
function makeFakeDriver() {
  const spawns: SpawnRecord[] = []
  // vitest worker（线程池）内 libuv 收不到 SIGCHLD：真实子进程会死（SIGTERM 真实送达，
  // 用 liveness 探针断言），但 'exit' 事件不会在 worker 里触发——因此 fake driver 在
  // terminate 后自行派发 onExit 并 resolve exitPromise（真实死亡 + 显式回调同形）。
  const exitCallbacks = new Map<number, (code: number | null, signal: string | null) => void>()
  const exitResolvers = new Map<number, () => void>()
  const driver = {
    async spawn(
      spec: RuntimeStartSpec,
      ctx: {
        cwd: string
        env: NodeJS.ProcessEnv
        onExit: (code: number | null, signal: string | null) => void
      },
    ) {
      const { spawn } = await import('node:child_process')
      const child = spawn(
        process.execPath,
        ['-e', LONG_SCRIPT, '--', '--run-id', spec.runId, '--nonce', spec.nonce],
        { cwd: ctx.cwd, env: ctx.env, stdio: 'ignore', detached: true },
      )
      spawns.push({ runId: spec.runId, cwd: ctx.cwd, env: ctx.env })
      const pid = child.pid ?? -1
      exitCallbacks.set(pid, (code, signal) => ctx.onExit(code, signal))
      return {
        pid,
        exitPromise: new Promise<void>((resolve) => {
          exitResolvers.set(pid, resolve)
        }),
      }
    },
    async terminate(handle: { pid: number }) {
      try {
        process.kill(-handle.pid, 'SIGTERM') // 真实终止进程组
      } catch {
        // 已退出。
      }
      // 等 OS 回收（liveness 确定窗口）后显式派发退出：vitest worker 收不到 SIGCHLD。
      await new Promise((resolve) => setTimeout(resolve, 50))
      exitCallbacks.get(handle.pid)?.(null, 'SIGTERM')
      exitResolvers.get(handle.pid)?.()
    },
  }
  return { driver, spawns }
}

/**
 * 环境齐备的 supervisor：注册一个真实目录 workspace；
 * env 缺省带凭据（credential-missing 用例显式去掉）。
 */
async function makeSupervisor(driver: unknown, env: NodeJS.ProcessEnv = CREDENTIAL_ENV) {
  const registry = new WorkspaceRegistry(
    join(root, `reg-${Math.random().toString(36).slice(2)}.sqlite`),
  )
  const secrets = new SecretStore(
    join(root, `sec-${Math.random().toString(36).slice(2)}.json`),
    env,
  )
  const dir = join(root, `ws-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir)
  const ws = await registry.register(dir, { name: 'ws' })
  const supervisor = new RuntimeSupervisor({
    driver: driver as never,
    registry,
    secrets,
    stateDbPath: join(root, `sup-${Math.random().toString(36).slice(2)}.sqlite`),
    capacity: 2,
    runtimeTimeoutMs: 60_000,
    processEnv: env,
  })
  return { supervisor, registry, secrets, ws }
}

describe('RuntimeSupervisor', () => {
  it('容量上限：第 3 个 Runtime 拒绝 NODE_CAPACITY_REACHED，前两个仍在跑', async () => {
    const { driver } = makeFakeDriver()
    const { supervisor, ws } = await makeSupervisor(driver)
    await supervisor.start(makeSpec('r-1'), { workspaceId: ws.id })
    await supervisor.start(makeSpec('r-2'), { workspaceId: ws.id })
    await expect(supervisor.start(makeSpec('r-3'), { workspaceId: ws.id })).rejects.toMatchObject({
      code: 'NODE_CAPACITY_REACHED',
    })
    expect((await supervisor.activeRuns()).length).toBe(2)
    await supervisor.stopAll()
  })

  it('环境白名单 scrub：只含 PATH/locale/TMPDIR + 最小凭据，无任何敏感残留', async () => {
    const { driver, spawns } = makeFakeDriver()
    const { supervisor, ws } = await makeSupervisor(driver, {
      ...CREDENTIAL_ENV,
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp',
      WHALEPOD_DEVICE_TOKEN: 'must-not-leak',
      SSH_AUTH_SOCK: '/socket',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    })
    await supervisor.start(makeSpec('r-1'), { workspaceId: ws.id })

    expect(spawns).toHaveLength(1)
    const env = spawns[0]?.env ?? {}
    expect(env.PATH).toBe('/usr/bin')
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.TMPDIR).toBe('/tmp')
    expect(env.DSH_API_KEY).toBe('sk-test-123')
    const serialized = JSON.stringify(env)
    expect(serialized).not.toContain('must-not-leak')
    expect(serialized).not.toContain('/socket')
    await supervisor.stopAll()
  })

  it('凭据缺失：spawn 前 MODEL_CREDENTIAL_UNAVAILABLE，Runtime 一个不启动', async () => {
    const { driver, spawns } = makeFakeDriver()
    const { supervisor, ws } = await makeSupervisor(driver, { PATH: '/usr/bin' })
    await expect(supervisor.start(makeSpec('r-1'), { workspaceId: ws.id })).rejects.toMatchObject({
      code: 'MODEL_CREDENTIAL_UNAVAILABLE',
    })
    expect(spawns).toHaveLength(0)
    expect((await supervisor.activeRuns()).length).toBe(0)
    await supervisor.stopAll()
  })

  it('G3-05: 删除目录后启动 Run → WORKSPACE_UNAVAILABLE，不启动 Runtime', async () => {
    const { driver, spawns } = makeFakeDriver()
    const { supervisor, registry, ws } = await makeSupervisor(driver)
    const dir = await registry.resolve(ws.id)
    await rm(dir, { recursive: true })

    await expect(
      supervisor.start(makeSpec('r-g305'), { workspaceId: ws.id }),
    ).rejects.toMatchObject({
      code: 'WORKSPACE_UNAVAILABLE',
    })
    expect(spawns).toHaveLength(0) // Runtime 一个不启动
    expect((await supervisor.activeRuns()).length).toBe(0)
    await supervisor.stopAll()
  })

  it('stderr tail 只保留末尾 8KiB', () => {
    const tail = new StderrTail()
    tail.push('x'.repeat(10_000))
    expect(tail.text().length).toBeLessThanOrEqual(8192)
    tail.push('tail-marker')
    expect(tail.text().endsWith('tail-marker')).toBe(true)
  })

  it('超时回收：超过 wall-clock 上限的 Runtime 被终止并标记 runtime_timeout', async () => {
    const { driver } = makeFakeDriver()
    const { supervisor } = await makeSupervisor(driver)
    const registry = new WorkspaceRegistry(join(root, 'reg-timeout.sqlite'))
    const dir = join(root, 'ws-timeout')
    await mkdir(dir)
    const tightWs = await registry.register(dir, { name: 'ws-timeout' })
    const tight = new RuntimeSupervisor({
      driver: driver as never,
      registry,
      secrets: new SecretStore(join(root, 'sec-timeout.json'), CREDENTIAL_ENV),
      stateDbPath: join(root, 'sup-timeout.sqlite'),
      capacity: 2,
      runtimeTimeoutMs: 200,
    })
    const lost: Array<{ runId: string; reason: string }> = []
    tight.onLost((runId, reason) => lost.push({ runId, reason }))
    await tight.start(makeSpec('r-timeout'), { workspaceId: tightWs.id })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(lost).toEqual([{ runId: 'r-timeout', reason: 'runtime_timeout' }])
    expect(await tight.activeRuns()).toEqual([])
    await tight.stopAll()
    await supervisor.stopAll()
  })
})
