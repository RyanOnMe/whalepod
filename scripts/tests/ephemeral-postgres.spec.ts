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
  e2eScope,
  findStaleContainers,
  launchWithPortRetry,
  startEphemeralPostgres,
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

describe('startEphemeralPostgres 的接线与清理（#188 评审 S1/S2）', () => {
  /**
   * 假 docker 走完整条启动链：sweep → run → port → exec(pg_isready) → stop。
   * 存在的意义：`removeContainer` 的 `-v`、清扫的接线、以及与启动标签的**同值**关系
   * 原先都没有判据（评审实测：删掉 sweep 调用或改错 scope，Q0 全绿）。
   */
  function makeFakeStartDocker(): {
    docker: (args: string[]) => Promise<string>
    calls: string[][]
  } {
    const calls: string[][] = []
    return {
      calls,
      docker: async (args: string[]) => {
        calls.push(args)
        if (args[0] === 'ps') return '' // 无陈旧容器
        if (args[0] === 'run') return 'container-under-test\n'
        if (args[0] === 'port') return '127.0.0.1:55099\n'
        return '' // exec / rm / logs
      },
    }
  }

  it('启动链：先按 scope 清扫、再 run（标签与清扫判据同值）、stop 用 rm -f -v', async () => {
    const fake = makeFakeStartDocker()
    const started = await startEphemeralPostgres({
      docker: fake.docker,
      skipPrelude: true,
      log: () => {},
      isPidAlive: () => true,
    })
    await started.stop()

    // ① 第一条命令是清扫，且筛的正是本 worktree 的 scope（与启动标签同值）。
    expect(fake.calls[0]).toEqual([
      'ps',
      '-aq',
      '--filter',
      `label=whalepod.e2e-scope=${e2eScope()}`,
    ])
    // ② 清扫在 run 之前（顺序可断言；评审 M8 的变异即颠倒这两步）。
    const runIndex = fake.calls.findIndex((call) => call[0] === 'run')
    expect(runIndex).toBeGreaterThan(0)

    // ③ 启动标签带同一个 scope + 启动者 pid（清扫据此区分活着的兄弟运行）。
    const runArgs = fake.calls[runIndex] ?? []
    expect(runArgs).toContain(`whalepod.e2e-scope=${e2eScope()}`)
    expect(runArgs).toContain(`whalepod.e2e-runner-pid=${process.pid}`)

    // ④ stop 必须 rm -f -v（少 -v 就是一次永久漏卷——评审 S1：这条路径原先零判据）。
    const removals = fake.calls.filter((call) => call[0] === 'rm')
    expect(removals).toEqual([['rm', '-f', '-v', 'container-under-test']])
  })

  it('清理失败只记 WARN，不抛错（容器可能已被 --rm 自清）', async () => {
    const logged: string[] = []
    const docker = async (args: string[]): Promise<string> => {
      if (args[0] === 'ps') return ''
      if (args[0] === 'run') return 'c1\n'
      if (args[0] === 'port') return '127.0.0.1:55001\n'
      if (args[0] === 'rm') throw new Error('No such container: c1')
      return ''
    }
    const started = await startEphemeralPostgres({
      docker,
      skipPrelude: true,
      log: (message: string) => logged.push(message),
    })
    await expect(started.stop()).resolves.toBeUndefined()
    expect(logged.join('\n')).toContain('删除容器失败')
  })
})

describe('陈旧容器判定与清扫（#188 + 评审 B1/B2）', () => {
  /** 假 docker：`ps -aq` 返回给定容器，`inspect` 返回它们的 StartedAt 与 pid 标签。 */
  function makeFakeDocker(
    containers: Array<{ id: string; startedAt: number; pid?: number | 'no-value' }>,
  ): { docker: (args: string[]) => Promise<string>; calls: string[][] } {
    const calls: string[][] = []
    return {
      calls,
      docker: async (args: string[]) => {
        calls.push(args)
        if (args[0] === 'ps') return containers.map((c) => `${c.id}\n`).join('')
        if (args[0] === 'inspect') {
          return containers
            .map((container) => {
              const pid =
                container.pid === undefined
                  ? '<no value>'
                  : container.pid === 'no-value'
                    ? '<no value>'
                    : String(container.pid)
              return `${container.id}|${new Date(container.startedAt).toISOString()}|${pid}`
            })
            .join('\n')
        }
        return ''
      },
    }
  }

  const NOW = Date.parse('2026-09-11T12:00:00.000Z')

  it('pid 仍活着的容器一律不碰（同 worktree 并发运行，评审 B2 的回归判据）', async () => {
    const fake = makeFakeDocker([{ id: 'alive', startedAt: NOW - 3_600_000, pid: 4242 }])
    const stale = await findStaleContainers({
      docker: fake.docker,
      now: () => NOW,
      isPidAlive: (pid) => pid === 4242,
      scope: 'test-scope',
    })
    // 即便它已经跑了一小时也不删：pid 活着 = 那次运行还在跑。
    expect(stale).toEqual([])
    const removed = await sweepStaleContainers({
      docker: fake.docker,
      log: () => {},
      now: () => NOW,
      isPidAlive: (pid) => pid === 4242,
      scope: 'test-scope',
    })
    expect(removed).toBe(0)
    expect(fake.calls.some((c) => c[0] === 'rm')).toBe(false)
  })

  it('年龄超过上限时一律算残留，即使 pid 标签指向一个活着的进程（pid 复用兜底，评审 R2）', async () => {
    // 判据：pid 复用会让「恰好活着」的无关 pid 永久豁免该容器（评审实测把时钟拨到 30 天后
    // 仍判为「运行中」）→ 容器与匿名卷永留。年龄上限必须压过 pid 判定。
    const fake = makeFakeDocker([
      { id: 'old-but-pid-alive', startedAt: NOW - 7 * 60 * 60_000, pid: 4242 },
    ])
    const stale = await findStaleContainers({
      docker: fake.docker,
      now: () => NOW,
      isPidAlive: () => true, // pid「活着」
      scope: 'test-scope',
    })
    expect(stale).toEqual(['old-but-pid-alive'])
  })

  it('pid 标签为 0 / 1 这类非法值时退回宽限期判定（不是「活着」）', async () => {
    const fake = makeFakeDocker([{ id: 'weird-pid', startedAt: NOW - 3_600_000, pid: 0 }])
    const stale = await findStaleContainers({
      docker: fake.docker,
      now: () => NOW,
      isPidAlive: () => true,
      graceMs: 600_000,
      scope: 'test-scope',
    })
    expect(stale).toEqual(['weird-pid'])
  })

  it('pid 已死 = 那次运行结束了 → 清掉，且带 -v 回收匿名卷', async () => {
    const fake = makeFakeDocker([{ id: 'orphan', startedAt: NOW - 60_000, pid: 9999 }])
    const removed = await sweepStaleContainers({
      docker: fake.docker,
      log: () => {},
      now: () => NOW,
      isPidAlive: () => false,
      scope: 'test-scope',
    })
    expect(removed).toBe(1)
    expect(fake.calls.filter((c) => c[0] === 'rm')).toEqual([['rm', '-f', '-v', 'orphan']])
  })

  it('无 pid 标签的容器按宽限期判定：年轻的不碰、够老的清掉', async () => {
    const young = makeFakeDocker([{ id: 'young', startedAt: NOW - 60_000, pid: 'no-value' }])
    expect(
      await findStaleContainers({
        docker: young.docker,
        now: () => NOW,
        isPidAlive: () => true,
        graceMs: 600_000,
        scope: 'test-scope',
      }),
    ).toEqual([])

    const old = makeFakeDocker([{ id: 'old', startedAt: NOW - 3_600_000, pid: 'no-value' }])
    expect(
      await findStaleContainers({
        docker: old.docker,
        now: () => NOW,
        isPidAlive: () => true,
        graceMs: 600_000,
        scope: 'test-scope',
      }),
    ).toEqual(['old'])
  })

  it('筛选用的是 scope 标签（并行 worktree 隔离），并一次 inspect 拿全部事实', async () => {
    const fake = makeFakeDocker([])
    await findStaleContainers({ docker: fake.docker, scope: 'wt-scope', now: () => NOW })
    expect(fake.calls[0]).toEqual(['ps', '-aq', '--filter', 'label=whalepod.e2e-scope=wt-scope'])
  })

  it('批量 inspect 部分失败时保住 stdout 的部分结果继续判（评审 O1/N1）', async () => {
    // 形态：ps 列出两个容器，inspect 时其中一个已消失（兄弟运行的正常 stop() 就能在 20ms
    // 窗口里造成）→ 真实 docker 输出**部分** stdout 并以非零退出，execFile 形态的 rejection
    // 对象带 .stdout。修好之前这里整轮清扫放弃（removed=0、WARN），残留要等下一轮。
    const docker = async (args: string[]): Promise<string> => {
      if (args[0] === 'ps') return 'gone\nalive\n'
      if (args[0] === 'inspect') {
        const error = Object.assign(new Error('Command failed: docker inspect …'), {
          stdout: `alive|${new Date(Date.parse('2026-09-11T11:00:00.000Z')).toISOString()}|999999\n`,
          stderr: 'Error: No such object: gone\n',
        })
        throw error
      }
      return ''
    }
    const removed = await sweepStaleContainers({
      docker,
      log: () => {},
      now: () => Date.parse('2026-09-11T12:00:00.000Z'),
      isPidAlive: () => false, // alive 那条的 pid「已死」→ 应被清掉
      scope: 'test-scope',
    })
    expect(removed).toBe(1)
  })

  it('docker ps 抖动时只告警、不抛错（清扫是尽力而为，不该挡住启动）', async () => {
    const logged: string[] = []
    const removed = await sweepStaleContainers({
      docker: async () => {
        throw new Error('docker daemon not running')
      },
      log: (message: string) => logged.push(message),
      scope: 'test-scope',
    })
    expect(removed).toBe(0)
    expect(logged.join('\n')).toContain('清扫陈旧容器失败')
  })

  it('inspect 的 StartedAt 解析不出来（时间戳为 0）时判为残留（保守选择）', async () => {
    const fake = makeFakeDocker([{ id: 'weird', startedAt: 0, pid: 'no-value' }])
    const stale = await findStaleContainers({
      docker: fake.docker,
      now: () => NOW,
      graceMs: 600_000,
      isPidAlive: () => true,
      scope: 'test-scope',
    })
    // 断言与标题一致：解析不出的时间戳（0 = 1970）远早于宽限期 → **判为残留**（保守：
    // 宁可多清一次可再生的临时库，也不留永久孤儿卷）。真实 Docker 产不出这种输入
    //（StartedAt 是 RFC3339Nano，Date.parse 实测可解析），故这里是防未来改动的兜底。
    expect(stale).toEqual(['weird'])
  })
})
