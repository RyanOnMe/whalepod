/**
 * #89 组合根验收：生产 `cli.ts start` 起会话后必须**自己**上报 node.inventory。
 *
 * 真要素：真 Hub（createTestApp + 真 PG + 真 listen）+ **真 cli 子进程**
 * （`node --import tsx apps/node/src/cli.ts start`，`HOME` 重定向到临时目录，
 * 绝不碰真实 `~/.project311-node`）。用户操作顺序也照真人：先配对写 config、
 * 先 `workspace add` 落 registry，**之后**才起 `start`。
 *
 * 为什么必须打在组合根：#89 能存在的根因正是「构建器有单测、Hub 摄入有集成测、
 * 唯独装配层无人测」——只测 `startDeviceSession` 单元的话，cli 忘注入
 * `inventoryFacts` 照样绿，等于把这个 bug 原样复刻进测试。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  resetDatabase,
  type Session,
  type TestApp,
} from '../../../hub/tests/helpers.js'
import { WorkspaceRegistry } from '../../src/workspace/registry.js'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const CLI_ENTRY = join(REPO_ROOT, 'apps/node/src/cli.ts')
const POLL_DEADLINE_MS = 25_000
const POLL_INTERVAL_MS = 250

async function httpBase(app: TestApp['app']): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no listen port')
  return `http://127.0.0.1:${address.port}`
}

const silence = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('#89 生产 cli 组合根：连接后自行上报 node.inventory', () => {
  let database: Database
  let ctx: TestApp
  let alice: Session
  let home: string

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    ctx = await createTestApp(database)
    alice = await driveSetup(ctx)
    // 临时 HOME：cli 的 DEFAULT_CONFIG_DIR = homedir()/.project311-node 在子进程
    // 模块加载时求值，故重定向 HOME 即可完全隔离真实用户目录。
    home = mkdtempSync(join(tmpdir(), 'p311-cli-home-'))
  })

  afterEach(async () => {
    await ctx.app.close()
    rmSync(home, { recursive: true, force: true })
  })

  afterAll(async () => {
    await database.close()
  })

  async function pairDevice(): Promise<{ deviceId: string; deviceToken: string }> {
    const codeRes = await apiInject(ctx, alice, {
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      payload: {},
    })
    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-claims',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        code: codeRes.json().data.code as string,
        name: 'cli-node',
        platform: 'darwin',
        architecture: 'arm64',
        nodeVersion: process.version,
        nodeAppVersion: '0.1.0',
      },
    })
    expect(claim.statusCode).toBe(201)
    return claim.json().data as { deviceId: string; deviceToken: string }
  }

  it('真 cli 子进程起会话 → Hub 投影出现该 Workspace（无人代偿）', async () => {
    const base = await httpBase(ctx.app)
    const { deviceId, deviceToken } = await pairDevice()

    // 真人写 config（配对产物）与 registry（workspace add 产物）到临时 HOME 下。
    const configDir = join(home, '.project311-node')
    const stateDir = join(configDir, 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ hubUrl: base, deviceId, deviceToken }, null, 2),
      { mode: 0o600 },
    )
    const workspaceDir = join(home, 'repo')
    mkdirSync(workspaceDir, { recursive: true })
    const registry = new WorkspaceRegistry(join(stateDir, 'workspace-registry.sqlite'))
    const registered = await registry.register(workspaceDir, { name: 'cli-ws' })
    registry.close()

    const child: ChildProcess = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_ENTRY, 'start', '--state-dir', stateDir],
      { cwd: REPO_ROOT, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderrTail = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).split('\n').slice(-40).join('\n')
    })
    child.stdout?.resume()

    const deadline = Date.now() + POLL_DEADLINE_MS
    let projection: Record<string, unknown>[] | undefined
    let lastStatus = 0
    try {
      for (;;) {
        const res = await apiInject(ctx, alice, { method: 'GET', url: '/api/v1/workspaces' })
        lastStatus = res.statusCode
        const list = res.json().data as Record<string, unknown>[] | undefined
        if (Array.isArray(list) && list.some((w) => w.workspaceId === registered.id)) {
          projection = list
          break
        }
        if (child.exitCode !== null) {
          throw new Error(
            `cli 子进程提前退出（code=${child.exitCode}），投影仍为空。stderr 尾部：\n${stderrTail}`,
          )
        }
        if (Date.now() > deadline) {
          throw new Error(
            `真 cli 会话建立后 ${POLL_DEADLINE_MS / 1000}s 内 Hub 投影未出现 ` +
              `workspace ${registered.id}（GET /workspaces 最后状态 ${lastStatus}）` +
              `——生产组合根未上报 node.inventory（#89）。stderr 尾部：\n${stderrTail}`,
          )
        }
        await silence(POLL_INTERVAL_MS)
      }

      // 精确判定：投影形状与不透明性（03 §2.4：绝不带本地绝对路径）。
      const mine = projection!.filter((w) => w.workspaceId === registered.id)
      expect(mine).toHaveLength(1)
      expect(mine[0]!.name).toBe('cli-ws')
      expect(mine[0]!.deviceId).toBe(deviceId)
      expect(mine[0]!.kind).toBe('directory')
      expect(mine[0]!.available).toBe(true)
      expect(Object.keys(mine[0]!).sort()).toEqual([
        'available',
        'capabilities',
        'deviceId',
        'kind',
        'lastCheckedAt',
        'name',
        'workspaceId',
      ])
      expect(JSON.stringify(mine[0]!)).not.toContain(workspaceDir)
    } finally {
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  }, 60_000) // 子进程冷启（tsx 加载 + 真 Hub 握手）+ 投影轮询预算，须大于轮询上限。
})
