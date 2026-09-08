/**
 * 生产冷启动：`node dist/server.js` 在**空数据库**上必须自己站起来的组合根测（P1-20）。
 *
 * 为什么存在：compose/Q9 把"从镜像与空卷启动"变成判据后暴露出的事实——
 * `applyMigrations` 的调用方历来**只有测试 helper 与 e2e-serve**，`server.ts`
 * 从头到尾没跑过迁移。测试环境永远"库已就绪"，这个洞在 Q0–Q6 全绿的仓库里
 * 隐身了整个 Phase 1。真·空库上 hub 会在 `getTeam` 查询处炸（relation 不存在），
 * 容器 crash-loop。这是 #95/#97 同族：**生产入口路径从未被执行过**。
 *
 * 判定形态（六原语）：真子进程 + 真端口 + 轮询 `/healthz`（探针本就是给编排
 * 等活用的，这里当场用它的存在意义自证）；deadline 失败带 stderr 尾归因，
 * 绝不静默跳过。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '@project311/db'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const SERVER_ENTRY = join(REPO_ROOT, 'apps/hub/dist/server.js')
const ADMIN_URL = process.env.DATABASE_URL
if (ADMIN_URL === undefined || ADMIN_URL === '') {
  throw new Error('DATABASE_URL 未设置：须经 scripts/with-test-postgres.mts 运行')
}

let admin: Database

function urlWithDatabase(connectionString: string, databaseName: string): string {
  return `${connectionString.slice(0, connectionString.lastIndexOf('/'))}/${databaseName}`
}

async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address() as { port: number }
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  return port
}

const silence = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

beforeAll(async () => {
  admin = createDatabase({ connectionString: ADMIN_URL, max: 2 })
})

afterAll(async () => {
  await admin.close()
})

describe('#24 空库冷启动 server.js', () => {
  it('真 bin + 空数据库 → /healthz 在预算内 200（迁移由启动路径自己应用）', async () => {
    const dbName = `coldboot_${randomBytes(4).toString('hex')}`
    await admin.sql.unsafe(`create database ${dbName}`) // dbName 为自生成 hex，非外部输入
    const dataDir = mkdtempSync(join(tmpdir(), 'p311-coldboot-'))
    let child: ChildProcessWithoutNullStreams | undefined
    const stderr: string[] = []
    try {
      const port = await freePort()
      child = spawn(process.execPath, [SERVER_ENTRY], {
        env: {
          ...process.env,
          DATABASE_URL: urlWithDatabase(ADMIN_URL, dbName),
          PROJECT311_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
          HOST: '127.0.0.1',
          PORT: String(port),
          PROJECT311_SETUP_TOKEN_PATH: join(dataDir, 'setup-token'),
          PROJECT311_ARTIFACT_STORE_DIR: join(dataDir, 'artifact-store'),
          LOG_LEVEL: 'error',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
      child.stdout.resume()

      const deadline = Date.now() + 20_000
      for (;;) {
        if (child.exitCode !== null) {
          throw new Error(
            `server.js 冷启动退出（code=${child.exitCode}）。stderr 尾：\n${stderr.join('').slice(-1200)}`,
          )
        }
        if (Date.now() > deadline) {
          throw new Error(`/healthz 未在 20s 内就绪。stderr 尾：\n${stderr.join('').slice(-1200)}`)
        }
        try {
          const res = await fetch(`http://127.0.0.1:${port}/healthz`)
          if (res.status === 200) {
            const body = (await res.json()) as { ok?: boolean }
            expect(body.ok).toBe(true)
            break
          }
        } catch {
          /* 端口未亮，继续轮询（有 deadline 兜底） */
        }
        await silence(250)
      }
      // 冷启动后业务面也得活着：匿名 setup/status 走真表（迁移没跑它必炸）。
      const status = await fetch(`http://127.0.0.1:${port}/api/v1/setup/status`)
      expect(status.status).toBe(200)
      expect(
        ((await status.json()) as { data?: { initialized?: boolean } }).data?.initialized,
      ).toBe(false)
    } finally {
      child?.kill('SIGKILL')
      rmSync(dataDir, { recursive: true, force: true })
      await admin.sql.unsafe(`drop database ${dbName}`) // 同上，hex 字面量
    }
  }, 90_000)
})
