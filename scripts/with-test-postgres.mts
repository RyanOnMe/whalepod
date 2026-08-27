#!/usr/bin/env tsx
/**
 * 临时 PostgreSQL 启动器（Q2 数据门，P1-04；02-第一阶段实施计划.md Task 4 Step 2）。
 *
 * 用法: tsx scripts/with-test-postgres.mts [--] <command> [args...]
 *
 * 容器生命周期在 scripts/lib/ephemeral-postgres.mts（e2e-serve 复用同一实现）；
 * 本文件是薄 CLI：启动容器 → 注入 DATABASE_URL 运行指定命令 → 退出后删容器。
 * 收到 SIGINT/SIGTERM 时先转发给被包裹命令，容器删除在 finally 中保证。
 * 密码不进仓库、不进日志；日志一律写 stderr，stdout 留给被包裹的命令。
 */
import { spawn } from 'node:child_process'
import { startEphemeralPostgres } from './lib/ephemeral-postgres.mts'

const log = (message: string): void => console.error(`[with-test-postgres] ${message}`)

async function run(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv[0] === '--') argv.shift()
  const [command, ...args] = argv
  if (command === undefined) {
    log('用法: tsx scripts/with-test-postgres.mts [--] <command> [args...]')
    process.exit(1)
  }

  const postgres = await startEphemeralPostgres()
  log(`PostgreSQL ready，运行命令：${[command, ...args].join(' ')}`)
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: postgres.databaseUrl },
      })
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
  } finally {
    await postgres.stop()
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
