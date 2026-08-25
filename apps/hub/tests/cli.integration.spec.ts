/**
 * CLI 验收：project311-hub setup-token 只在尚无 Team 时打印 Token（02 Task 5 Step 3）。
 * 驱动真实子进程 + 真实 PostgreSQL，不走 mock。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@project311/db'
import { createTestApp, createTestDatabase, driveSetup, resetDatabase } from './helpers.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'src', 'cli.ts')
const TSX = join(HERE, '..', '..', '..', 'node_modules', '.bin', 'tsx')

let database: Database
let dir: string

beforeAll(async () => {
  database = await createTestDatabase()
})

beforeEach(async () => {
  await resetDatabase(database)
  dir = await mkdtemp(join(tmpdir(), 'p311-cli-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

afterAll(async () => {
  await database.close()
})

async function runCli(setupTokenPath: string): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(TSX, [CLI, 'setup-token'], {
      env: {
        ...process.env,
        PROJECT311_PUBLIC_ORIGIN: 'http://localhost:4242',
        PROJECT311_SETUP_TOKEN_PATH: setupTokenPath,
      },
    })
    return { code: 0, stdout }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string }
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '' }
  }
}

describe('project311-hub setup-token', () => {
  it('尚无 Team 时生成 Token 文件并打印到 stdout；重复调用不轮换', async () => {
    const setupTokenPath = join(dir, 'setup-token')
    const first = await runCli(setupTokenPath)
    expect(first.code).toBe(0)
    expect(first.stdout.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // 打印值与文件一致；重复调用读取同一文件，不轮换 Token
    expect(await readFile(setupTokenPath, 'utf8')).toBe(first.stdout.trim())
    const second = await runCli(setupTokenPath)
    expect(second.code).toBe(0)
    expect(second.stdout).toBe(first.stdout)
  })

  it('已有 Team 时拒绝打印并退出非零', async () => {
    const ctx = await createTestApp(database)
    try {
      await driveSetup(ctx)
      const result = await runCli(join(dir, 'setup-token'))
      expect(result.code).not.toBe(0)
      expect(result.stdout.trim()).toBe('')
    } finally {
      await ctx.close()
    }
  })

  it('未知子命令退出非零', async () => {
    try {
      await execFileAsync(TSX, [CLI, 'bogus'], {
        env: { ...process.env, PROJECT311_PUBLIC_ORIGIN: 'http://localhost:4242' },
      })
      expect.unreachable('应当失败')
    } catch (error) {
      expect((error as { code?: number }).code).not.toBe(0)
    }
  })
})
