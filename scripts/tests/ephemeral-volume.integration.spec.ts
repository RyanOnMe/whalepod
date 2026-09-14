/**
 * 一次性 PostgreSQL 的**净增卷 = 0** 判据（#188 评审 S3）。
 *
 * ⚠️ 本用例**刻意不做兜底清理**（#190 评审 R1）：早期版本在 afterAll 里用
 * `docker ps -aq --filter ancestor=postgres:18 | docker rm -f -v` 兜底，结果把**外层**
 * `with-test-postgres.mts` 的共享容器（以及兄弟 worktree 正在用的库）一起删了——
 * CI 上实测自伤：345 条通过后 4 个 spec 文件的 beforeAll 拿到 undefined 而失败。
 * 判据自身已把容器与卷清干净（实测跑完 0 容器 / 净增卷 0），不需要兜底。
 *
 * 为什么需要它：修复前没有任何判据断言过 docker 卷——「不再漏卷」只是提交信息里的话，
 * 无法复跑、无法在回归时变红。评审实测的对照是：修复前每跑一次 `stop()` 漏 1 卷（15→20，
 * 5/5），修复后 0 漏。这条把那个对照固化成机器判据。
 *
 * Docker 不可用时 **skip 而不是假绿**（AGENTS.md：没数据必须失败/跳过，不能假装通过）。
 * 真实容器，真实 `docker volume` 计数；不依赖 postgres 是否已就绪之外的东西。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { startEphemeralPostgres } from '../lib/ephemeral-postgres.mts'

const execFileAsync = promisify(execFile)

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'])
    return true
  } catch {
    return false
  }
}

async function volumeNames(): Promise<string[]> {
  const { stdout } = await execFileAsync('docker', ['volume', 'ls', '-q'])
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
}

let available = false
beforeAll(async () => {
  available = await dockerAvailable()
})

describe('一次性 PostgreSQL 不漏匿名卷（#188）', () => {
  it('启动后正常 stop：docker 卷数量净增 0', async (ctx) => {
    if (!available) {
      // 明确跳过而不是静默通过：本判据的价值就在真 Docker 上。
      ctx.skip()
      return
    }
    const before = await volumeNames()
    const postgres = await startEphemeralPostgres()
    await postgres.stop()
    const after = await volumeNames()
    // 差集为空 = 没有孤儿卷（修复前这里必然多出 1 个匿名卷）。
    const leaked = after.filter((name) => !before.includes(name))
    expect(leaked).toEqual([])
  }, 120_000)
})
