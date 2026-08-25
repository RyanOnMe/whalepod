#!/usr/bin/env tsx
/**
 * 临时 PostgreSQL 启动器（Q2 数据门，P1-04；02-第一阶段实施计划.md Task 4 Step 2）。
 *
 * 用法: tsx scripts/with-test-postgres.mts [--] <command> [args...]
 *
 * 启动一次性 postgres:18 容器（127.0.0.1 随机端口、随机密码、--rm），等 ready 后
 * 注入 DATABASE_URL 运行指定命令；命令退出或收到 SIGINT/SIGTERM 后强制删除容器，
 * 保证 `docker ps` 无残留。Docker 不可用、镜像缺失或启动超时一律非零退出，不得报绿。
 * 密码不进仓库、不进日志；日志一律写 stderr，stdout 留给被包裹的命令。
 */
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const IMAGE = 'postgres:18'
const READY_TIMEOUT_MS = 60_000
const READY_POLL_MS = 250

const log = (message: string): void => console.error(`[with-test-postgres] ${message}`)

function fail(message: string): never {
  log(`FAIL ${message}`)
  process.exit(1)
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

async function ensureDocker(): Promise<void> {
  try {
    await docker(['version', '--format', '{{.Server.Version}}'])
  } catch {
    fail('Docker 不可用；Q2 数据门需要本机 Docker 运行临时 postgres:18')
  }
}

async function ensureImage(): Promise<void> {
  try {
    await docker(['image', 'inspect', IMAGE])
  } catch {
    log(`本地无 ${IMAGE}，拉取中…`)
    try {
      await docker(['pull', IMAGE])
    } catch (error) {
      fail(`拉取 ${IMAGE} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** 解析 `docker port <id> 5432` 的输出（形如 `127.0.0.1:55001`），取宿主机端口。 */
async function publishedPort(containerId: string): Promise<string> {
  const out = await docker(['port', containerId, '5432'])
  const line = out.trim().split('\n')[0] ?? ''
  const port = line.split(':').pop()?.trim()
  if (!port || !/^\d+$/.test(port)) fail(`无法解析容器端口映射：${JSON.stringify(out)}`)
  return port
}

async function waitReady(containerId: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    try {
      // 走容器内 TCP（而非本地 socket），确保发布端口对应的监听已就绪。
      await docker(['exec', containerId, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'])
      return
    } catch {
      if (Date.now() >= deadline) {
        let logs = ''
        try {
          logs = await docker(['logs', '--tail', '20', containerId])
        } catch {
          logs = '(docker logs 也不可用)'
        }
        fail(`PostgreSQL ${READY_TIMEOUT_MS / 1000}s 内未就绪。容器日志尾部：\n${logs}`)
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    }
  }
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env })
    // 信号转发给子进程，由子进程决定如何退出；清理容器在 finally 中保证。
    const onSigint = (): void => {
      child.kill('SIGINT')
    }
    const onSigterm = (): void => {
      child.kill('SIGTERM')
    }
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
      if (code !== null) resolve(code)
      else reject(new Error(`命令被信号 ${signal ?? 'unknown'} 终止`))
    })
  })
}

async function removeContainer(containerId: string): Promise<void> {
  try {
    await docker(['rm', '-f', containerId])
    log(`容器 ${containerId.slice(0, 12)} 已删除`)
  } catch (error) {
    log(
      `WARN 删除容器失败（需人工检查 docker ps）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv[0] === '--') argv.shift()
  const [command, ...args] = argv
  if (command === undefined) {
    fail('用法: tsx scripts/with-test-postgres.mts [--] <command> [args...]')
  }

  await ensureDocker()
  await ensureImage()

  // 随机密码：一次性容器不落到任何文件，避免 secret-scan 语料与真实凭据混淆。
  const password = randomBytes(12).toString('base64url')
  const containerId = (
    await docker([
      'run',
      '-d',
      '--rm',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-p',
      '127.0.0.1:0:5432',
      IMAGE,
    ])
  ).trim()
  log(`容器 ${containerId.slice(0, 12)} 已启动（${IMAGE}）`)

  try {
    const port = await publishedPort(containerId)
    await waitReady(containerId)
    const databaseUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`
    log(`PostgreSQL ready，运行命令：${[command, ...args].join(' ')}`)
    return await runCommand(command, args, { ...process.env, DATABASE_URL: databaseUrl })
  } finally {
    await removeContainer(containerId)
  }
}

run().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    log(`FAIL ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  },
)
