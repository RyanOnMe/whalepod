/**
 * 一次性 PostgreSQL 端口发布竞态的确定性测试（Q5 x20 第 8 轮实测 flake 的回归哨兵）。
 *
 * 真因：`docker run -d` 返回后端口映射发布有滞后窗，立即 `docker port` 会报
 * "no public port '5432' published"——本测试用假 docker（注入 exec fn）复现
 * 「前 N 次未发布→第 N+1 次成功」与「永远未发布」两形态，不依赖真实 Docker；
 * 时钟与 sleep 均注入，红/绿两路径毫秒级确定性。
 */
import { describe, expect, it } from 'vitest'
import {
  launchWithPortRetry,
  sweepStaleContainers,
  waitPublishedPort,
} from '../lib/ephemeral-postgres.mts'
import type { LaunchDeps } from '../lib/ephemeral-postgres.mts'

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

/**
 * 容器创建重试（x20 第 18/19 轮实测形态：容器活着但端口始终不发布——
 * 病态绑在单个 endpoint 上，延长等待无效，删容器重建才有效）。
 */
describe('launchWithPortRetry（发布失败删容器重建）', () => {
  /**
   * 假 docker：`brokenRuns` 里列出的第 N 个容器，其端口永不发布。
   * 时钟由 sleep 推进 pollMs，保证内层 waitPublishedPort 的 deadline 可达。
   */
  function makeFakeLaunch(options: { brokenRuns: number[] }): {
    docker: (args: string[]) => Promise<string>
    calls: string[][]
    deps: Omit<LaunchDeps, 'docker' | 'attempts' | 'backoffMs'>
  } {
    const calls: string[][] = []
    let runs = 0
    let clock = 0
    const docker = async (args: string[]): Promise<string> => {
      calls.push(args)
      if (args[0] === 'run') {
        runs += 1
        return `container-${runs}\n`
      }
      if (args[0] === 'port') {
        if (options.brokenRuns.includes(runs)) {
          throw new Error("no public port '5432' published")
        }
        return `127.0.0.1:${55000 + runs}\n`
      }
      if (args[0] === 'logs') return 'LOG:  init complete, server not started'
      if (args[0] === 'rm') return ''
      if (args[0] === 'exec') return '' // waitReady 的 pg_isready 探针
      throw new Error(`fake docker 收到意外调用：${args.join(' ')}`)
    }
    return {
      docker,
      calls,
      deps: {
        sleep: async (ms: number) => {
          clock += ms
        },
        now: () => clock,
        timeoutMs: 5_000,
        pollMs: 250,
        log: () => {},
      },
    }
  }

  it('首次发布失败：删掉该容器并重建，第二次成功', async () => {
    const fake = makeFakeLaunch({ brokenRuns: [1] })
    const result = await launchWithPortRetry(['run', '-d', 'img'], {
      ...fake.deps,
      docker: fake.docker,
      attempts: 3,
      backoffMs: 1_000,
    })
    // 第 1 个容器发布失败 → 必须被清掉，再拿全新沙箱（container-2）。
    // `-v` 是 #188 的回归判据：删的是**活着**的容器，`--rm` 不生效，而 docker rm 默认
    // 不回收匿名卷（postgres 镜像声明了 VOLUME）——少了它每次重试永久漏 ~45 MB。
    expect(fake.calls.some((c) => c.join(' ') === 'rm -f -v container-1')).toBe(true)
    expect(result.containerId).toBe('container-2')
    expect(result.port).toBe('55002')
  })

  it('连续失败到上限：抛错且每次失败都删容器（不泄漏僵尸）', async () => {
    const fake = makeFakeLaunch({ brokenRuns: [1, 2, 3] })
    await expect(
      launchWithPortRetry(['run', '-d', 'img'], {
        ...fake.deps,
        docker: fake.docker,
        attempts: 3,
        backoffMs: 1_000,
      }),
    ).rejects.toThrow(/端口映射未在 5s 内发布/)
    const removals = fake.calls.filter((c) => c[0] === 'rm')
    expect(removals.map((c) => c[c.length - 1])).toEqual([
      'container-1',
      'container-2',
      'container-3',
    ])
    // 每一次都带 -v（#188）：三次重试就是三个匿名卷，漏一个都是永久的。
    expect(removals.every((c) => c.includes('-v'))).toBe(true)
  })

  it('失败路径写结构化 WARN（attempt 计数可见，供归因）', async () => {
    const logged: string[] = []
    const fake = makeFakeLaunch({ brokenRuns: [1, 2] })
    await expect(
      launchWithPortRetry(['run', '-d', 'img'], {
        ...fake.deps,
        docker: fake.docker,
        attempts: 2,
        backoffMs: 0,
        log: (m: string) => logged.push(m),
      }),
    ).rejects.toThrow()
    expect(logged.filter((l) => l.startsWith('WARN 第 1/2 次'))).toHaveLength(1)
    expect(logged.filter((l) => l.startsWith('WARN 第 2/2 次'))).toHaveLength(1)
  })
})

describe('陈旧容器清扫（#188：中断的运行会留下容器 + 匿名卷）', () => {
  it('按本 worktree 的 scope 标签筛，逐条 rm -f -v（卷跟着走）', async () => {
    const calls: string[][] = []
    const docker = async (args: string[]): Promise<string> => {
      calls.push(args)
      if (args[0] === 'ps') return 'aaa\nbbb\n'
      return ''
    }
    await sweepStaleContainers({ docker, log: () => {} })
    // 筛选用的是 scope 标签（并行 worktree 隔离），不是全量清扫。
    expect(calls[0]?.slice(0, 3)).toEqual(['ps', '-aq', '--filter'])
    expect(calls[0]?.[3]).toMatch(/^label=whalepod\.e2e-scope=/)
    expect(calls.slice(1)).toEqual([
      ['rm', '-f', '-v', 'aaa'],
      ['rm', '-f', '-v', 'bbb'],
    ])
  })

  it('没有陈旧容器时一条命令都不删', async () => {
    const calls: string[][] = []
    await sweepStaleContainers({
      docker: async (args: string[]) => {
        calls.push(args)
        return '\n'
      },
      log: () => {},
    })
    expect(calls).toEqual([['ps', '-aq', '--filter', expect.stringContaining('label=')]])
  })

  it('docker ps 抖动时只告警、不抛错（清扫是尽力而为，不该挡住启动）', async () => {
    const logged: string[] = []
    await expect(
      sweepStaleContainers({
        docker: async () => {
          throw new Error('docker daemon not running')
        },
        log: (message: string) => logged.push(message),
      }),
    ).resolves.toBeUndefined()
    expect(logged.join('\n')).toContain('清扫陈旧容器失败')
  })
})
