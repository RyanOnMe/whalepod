/**
 * 一次性 PostgreSQL 端口发布竞态的确定性测试（Q5 x20 第 8 轮实测 flake 的回归哨兵）。
 *
 * 真因：`docker run -d` 返回后端口映射发布有滞后窗，立即 `docker port` 会报
 * "no public port '5432' published"——本测试用假 docker（注入 exec fn）复现
 * 「前 N 次未发布→第 N+1 次成功」与「永远未发布」两形态，不依赖真实 Docker；
 * 时钟与 sleep 均注入，红/绿两路径毫秒级确定性。
 */
import { describe, expect, it } from 'vitest'
import { waitPublishedPort } from '../lib/ephemeral-postgres.mts'

interface FakeCall {
  args: string[]
}

function makeFakeDocker(options: {
  portFailures: number | 'always'
  port?: string
  logsOutput?: string
}): { docker: (args: string[]) => Promise<string>; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  let portAttempts = 0
  return {
    calls,
    docker: async (args: string[]) => {
      calls.push({ args })
      if (args[0] === 'port') {
        portAttempts += 1
        const limit = options.portFailures === 'always' ? Infinity : options.portFailures
        if (portAttempts <= limit) {
          // 真实 docker 的失败形态：非零退出 + stderr 文案（execFile reject）。
          throw new Error(`Command failed: docker port ...\nno public port '5432' published for x`)
        }
        return `127.0.0.1:${options.port ?? '55001'}\n`
      }
      if (args[0] === 'logs') return options.logsOutput ?? 'LOG:  database system is ready'
      throw new Error(`fake docker 收到意外调用：${args.join(' ')}`)
    },
  }
}

describe('waitPublishedPort（端口发布有界轮询）', () => {
  it('前 3 次未发布、第 4 次成功：拿到端口且不失败', async () => {
    const { docker, calls } = makeFakeDocker({ portFailures: 3 })
    const port = await waitPublishedPort('cid', {
      docker,
      sleep: () => Promise.resolve(),
      now: () => 0, // 成功路径不依赖时钟推进
      timeoutMs: 10_000,
      pollMs: 200,
    })
    expect(port).toBe('55001')
    expect(calls.filter((c) => c.args[0] === 'port')).toHaveLength(4)
    expect(calls.some((c) => c.args[0] === 'logs')).toBe(false) // 成功不收日志
  })

  it('永远未发布：超时红，报错附 docker logs --tail 20 现场（区分滞后与容器即死）', async () => {
    const { docker, calls } = makeFakeDocker({
      portFailures: 'always',
      logsOutput: 'Error: driver failed programing endpoint',
    })
    let clock = 0 // deadline = 0 + 10_000；每次 sleep 推进 1s → 11 次探测后过期
    await expect(
      waitPublishedPort('cid', {
        docker,
        sleep: async () => {
          clock += 1_000
        },
        now: () => clock,
        timeoutMs: 10_000,
        pollMs: 200,
      }),
    ).rejects.toThrow(/端口映射未在 10s 内发布[\s\S]*driver failed programing/)
    expect(calls.filter((c) => c.args[0] === 'port')).toHaveLength(11)
    expect(calls.some((c) => c.args.join(' ') === 'logs --tail 20 cid')).toBe(true)
  })

  it('logs 也不可得时报错仍成立（兜底文案，不二次抛错）', async () => {
    const docker = async (args: string[]): Promise<string> => {
      if (args[0] === 'port') throw new Error('no public port published')
      throw new Error('can not connect to docker daemon')
    }
    let clock = 0
    await expect(
      waitPublishedPort('cid', {
        docker,
        sleep: async () => {
          clock += 5_000
        },
        now: () => clock,
        timeoutMs: 10_000,
        pollMs: 200,
      }),
    ).rejects.toThrow(/docker logs 也不可用/)
  })

  it('映射输出不可解析（端口 0/空串）按未发布重试而非误报成功', async () => {
    let attempts = 0
    const docker = async (args: string[]): Promise<string> => {
      if (args[0] !== 'port') return 'logs-sim'
      attempts += 1
      if (attempts === 1) return 'tcp://0.0.0.0:0\n' // 形似已发布但端口为 0
      if (attempts === 2) return '\n' // 空输出
      return '127.0.0.1:55002\n'
    }
    const port = await waitPublishedPort('cid', {
      docker,
      sleep: () => Promise.resolve(),
      now: () => 0,
      timeoutMs: 10_000,
      pollMs: 200,
    })
    expect(port).toBe('55002')
    expect(attempts).toBe(3)
  })
})
