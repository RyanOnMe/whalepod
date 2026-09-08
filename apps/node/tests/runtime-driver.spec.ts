/**
 * DshRuntimeDriver 宿主韧性（#107）：对已死子进程的 stdin 写不得掀掉宿主
 * Node 进程（CI 实录：Q2 里未处理 EPIPE 经 uncaughtException 杀宿主）。
 * RuntimeHandle.send 的 doc 契约本就承诺「stdin 已关闭时静默丢弃」——
 * 本文件把承诺落成机器判据。
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DshRuntimeDriver, type RuntimeStartSpec } from '../src/runtime-driver.js'

function makeSpec(): RuntimeStartSpec {
  return {
    runId: randomUUID(),
    nonce: randomUUID(),
    workspaceId: randomUUID(),
    prompt: 'p',
    agent: {
      id: randomUUID(),
      profileRevisionId: randomUUID(),
      persona: 'p',
      provider: 'deepseek-official',
      model: 'm',
      credentialSlot: 'slot',
    },
    expectedProfileDigest: 'a'.repeat(64),
    expectedPluginPackDigest: 'b'.repeat(64),
  }
}

function shutdownFrame(runId: string) {
  return {
    protocolVersion: 1 as const,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type: 'runtime.shutdown' as const,
    payload: { runId },
  }
}

describe('DshRuntimeDriver 宿主韧性（#107）', () => {
  it('腿①（猝死+管道积压，CI 实录形态）：EPIPE 不掀宿主，归因进 stderr 取证环', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p311-driver-'))
    const entry = join(dir, 'runtime.js')
    // 从不读 stdin，50ms 后猝死——洪泛写在内核管道里积压，exit 时冲刷失败 ⟹ EPIPE。
    writeFileSync(entry, 'setTimeout(() => process.exit(1), 50)\n')
    const driver = new DshRuntimeDriver({ runtimeEntry: entry })
    const stderrChunks: string[] = []
    const spec = makeSpec()
    const handle = await driver.spawn(spec, {
      cwd: dir,
      env: {},
      onStdout: () => {},
      onStderr: (chunk) => stderrChunks.push(chunk),
      onExit: () => {},
    })

    const uncaught: unknown[] = []
    const trap = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', trap)
    try {
      // 洪泛：管道 64KiB 缓冲写满后用户态积压，子进程一猝死 pending 写全体 EPIPE。
      for (let i = 0; i < 2000; i++) handle.send?.(shutdownFrame(spec.runId))
      await handle.exitPromise
      await new Promise((r) => setTimeout(r, 200)) // 异步错误落窗
    } finally {
      process.off('uncaughtException', trap)
    }
    expect(uncaught).toEqual([]) // 修前：uncaughtException 掀宿主进程
    expect(stderrChunks.join('')).toContain('stdin') // 归因留证
  })

  it('腿②（干净退出已被本端感知）：写已销毁流只经回调报错——同样归因、不掀宿主', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p311-driver-'))
    const entry = join(dir, 'runtime.js')
    writeFileSync(entry, 'process.exit(0)\n')
    const driver = new DshRuntimeDriver({ runtimeEntry: entry })
    const stderrChunks: string[] = []
    const handle = await driver.spawn(makeSpec(), {
      cwd: dir,
      env: {},
      onStdout: () => {},
      onStderr: (chunk) => stderrChunks.push(chunk),
      onExit: () => {},
    })
    await handle.exitPromise
    await new Promise((r) => setTimeout(r, 100)) // 等流销毁完成（close 先于断言）

    const uncaught: unknown[] = []
    const trap = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', trap)
    try {
      handle.send?.(shutdownFrame(randomUUID()))
      await new Promise((r) => setTimeout(r, 100))
    } finally {
      process.off('uncaughtException', trap)
    }
    expect(uncaught).toEqual([])
    expect(stderrChunks.join('')).toContain('stdin')
  })

  it('子进程活着时 send 真到达（正向：帧没被误吞）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p311-driver-'))
    const entry = join(dir, 'runtime.js')
    writeFileSync(
      entry,
      "let buf='';process.stdin.setEncoding('utf8');process.stdin.on('data',(c)=>{buf+=c;const i=buf.indexOf('\\n');if(i>=0){console.log('GOT '+JSON.parse(buf.slice(0,i)).type);buf=buf.slice(i+1)}})\n",
    )
    const driver = new DshRuntimeDriver({ runtimeEntry: entry })
    const lines: string[] = []
    const spec = makeSpec()
    const handle = await driver.spawn(spec, {
      cwd: dir,
      env: {},
      onStdout: (line) => lines.push(line),
      onStderr: () => {},
      onExit: () => {},
    })
    handle.send?.(shutdownFrame(spec.runId))
    const deadline = Date.now() + 5_000
    while (!lines.some((l) => l === 'GOT runtime.shutdown')) {
      if (Date.now() > deadline) throw new Error(`子进程未收到帧：stdout=${JSON.stringify(lines)}`)
      await new Promise((r) => setTimeout(r, 25))
    }
    await driver.terminate(handle)
    await handle.exitPromise
  })
})
