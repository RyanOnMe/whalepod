import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  apiInject,
  createTestApp,
  createTestDatabase,
  driveSetup,
  resetDatabase,
  seedRunChainForUser,
  waitForValue,
  type TestApp,
} from './helpers.js'
import type { Database } from '@whalepod/db'
const nodeBin = createRequire(new URL('../../node/package.json', import.meta.url)).resolve(
  '@whalepod/node/bin',
)
const run = promisify(execFile)
let db: Database
let ctx: TestApp
let root: string
let child: ChildProcess | undefined
beforeEach(async () => {
  db = await createTestDatabase()
  await resetDatabase(db)
  ctx = await createTestApp(db)
  root = await mkdtemp(join(tmpdir(), 'wp-prepare-bin-'))
})
afterEach(async () => {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(() => child?.kill('SIGKILL'), 3000)
      child!.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    child.kill('SIGTERM')
    await exited
  }
  child = undefined
  await ctx.close()
  await db.close()
  await rm(root, { recursive: true, force: true })
})
describe('生产Node bin准备链（#320）', () => {
  it('真CLI配对/登记/启动，经HTTP只回配置状态并不启动Run', async () => {
    const owner = await driveSetup(ctx)
    const chain = await seedRunChainForUser(db.db, owner.userId)
    await ctx.app.listen({ host: '127.0.0.1', port: 0 })
    const address = ctx.app.server.address()
    if (address === null || typeof address === 'string') throw new Error('listen missing')
    const hub = `http://127.0.0.1:${address.port}`
    const project = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: '首次准备' },
    })
    const task = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/projects/${project.json().data.id}/tasks`,
      payload: { title: '真bin检查', assigneeUserId: owner.userId },
    })
    const code = await apiInject(ctx, owner, {
      method: 'POST',
      url: '/api/v1/devices/pairing-codes',
      payload: {},
    })
    const environment = {
      ...process.env,
      WHALEPOD_DSH_SECRET_DEEPSEEK_OFFICIAL_DEFAULT: 'fixture-key-for-preparation',
    }
    const cli = async (args: string[]) => {
      try {
        await run(process.execPath, [nodeBin, ...args, '--state-dir', root], { env: environment })
      } catch {
        throw new Error('production Node CLI setup failed')
      }
    }
    await cli(['pair', '--hub', hub, '--code', code.json().data.code, '--name', 'preparation-bin'])
    await mkdir(join(root, 'work'))
    await cli(['workspace', 'add', join(root, 'work'), '--name', 'prepare-work'])
    child = spawn(process.execPath, [nodeBin, 'start', '--state-dir', root], {
      env: environment,
      stdio: 'ignore',
    })
    const workspace = await waitForValue(
      async () =>
        (await apiInject(ctx, owner, { method: 'GET', url: '/api/v1/workspaces' }))
          .json()
          .data.find((row: { name: string }) => row.name === 'prepare-work') as
          | { workspaceId: string; deviceId: string }
          | undefined,
      'production Node inventory',
      { timeoutMs: 10000 },
    )
    const response = await apiInject(ctx, owner, {
      method: 'POST',
      url: `/api/v1/tasks/${task.json().data.id}/preparation-check`,
      payload: {
        agentId: chain.agentId,
        profileRevisionId: chain.profileRevisionId,
        deviceId: workspace.deviceId,
        workspaceId: workspace.workspaceId,
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({
      workspace: 'available',
      credential: 'configured',
      modelCall: 'not_tested',
    })
    const room = await apiInject(ctx, owner, {
      method: 'GET',
      url: `/api/v1/tasks/${task.json().data.id}`,
    })
    expect(room.json().data.runs).toEqual([])
    expect(room.json().data.instructions).toEqual([])
    expect(JSON.stringify(response.json())).not.toContain(root)
    expect(JSON.stringify(response.json())).not.toContain('fixture-key-for-preparation')
    await mkdir('artifacts/evidence/execution-preparation', { recursive: true })
    await writeFile(
      'artifacts/evidence/execution-preparation/node-bin.json',
      JSON.stringify(
        {
          component: 'node.preparation',
          realNodeBin: true,
          realPairing: true,
          realWorkspaceRegistration: true,
          environmentCredentialConfirmed: true,
          zeroRuns: true,
          zeroInstructions: true,
          modelNotCalled: true,
        },
        null,
        2,
      ) + '\n',
    )
  }, 20000)
})
