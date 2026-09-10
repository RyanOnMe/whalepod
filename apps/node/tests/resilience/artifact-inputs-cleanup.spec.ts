/**
 * #62（P1-15 评审跟进）：Reviewer 输入副本清理覆盖全部终态路径。
 *
 * 背景：stateDir/runtime-inputs/<runId> 的下载副本原先只在「终态帧投影」一条
 * 路径清理；协议违例、退出归因（cancelled_forced/runtime_lost）、supervisor
 * lost（runtime_timeout/orphaned_after_node_restart）四条终态路径不调 → 残留。
 *
 * 判定基线（真实文件系统断言，不看回调记录）：RunManager 的每一条终态路径——
 *   1. 终态帧投影（run.completed / run.cancelled / runtime.fatal）
 *   2. 协议违例 fail-closed（§11 非 JSON stdout）
 *   3. 退出归因（cancelled_forced / runtime_lost）
 *   4. supervisor lost（runtime_timeout / orphaned_after_node_restart）
 * ——都必须清掉输入副本目录；目录残留即失败。每条用例同时断言该路径的终态
 * 事实（投影事件 / lost 快照），确认走的是「哪条路」（归因，不只看目录消失）。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  makeResilienceHarness,
  cancelFrame,
  runStartFrame,
  runtimeReadyLine,
  RUN_ID,
  type ResilienceHarness,
} from './harness.js'

let current: ResilienceHarness | undefined
let root: string
let inputsRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-inputs-cleanup-'))
  inputsRoot = join(root, 'runtime-inputs')
})

afterEach(async () => {
  await current?.cleanup()
  current = undefined
  await rm(root, { recursive: true, force: true })
})

function inputDir(): string {
  return join(inputsRoot, RUN_ID)
}

/**
 * 真实文件系统版的输入准备/清理：prepare 落一个真实副本文件，cleanup rm -rf
 * （与生产 ArtifactInputsManager 同形：目录 = inputsRoot/<runId>，文件落盘）。
 */
function realInputsDeps(): Record<string, unknown> {
  return {
    prepareArtifactInputs: async (runId: string) => {
      const dir = join(inputsRoot, runId)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, '01905f7c-0000-7000-8000-000000000901'), '# reviewer input copy\n')
      return {
        dir,
        entries: [
          {
            artifactId: '01905f7c-0000-7000-8000-000000000901',
            title: 'Builder report',
            mediaType: 'text/markdown',
            byteSize: 22,
            sha256: 'c'.repeat(64),
          },
        ],
      }
    },
    cleanupArtifactInputs: async (runId: string) => {
      await rm(join(inputsRoot, runId), { recursive: true, force: true })
    },
  }
}

/** 清理是 best-effort 异步（void promise）：轮询到目录消失或超时。 */
async function awaitDirGone(dir: string, deadlineMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    if (!existsSync(dir)) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 轮询等待条件成立（异步归因链路：退出事件 → 投影 → 上行非同步可见）。 */
async function waitFor(condition: () => boolean, deadlineMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Reviewer Run 启动（前置断言：副本目录已真实落盘）。 */
async function startReviewerRun(
  options: Parameters<typeof makeResilienceHarness>[0] = {},
): Promise<ResilienceHarness> {
  const harness = await makeResilienceHarness({
    ...options,
    managerDeps: { ...realInputsDeps(), ...(options.managerDeps ?? {}) },
  })
  current = harness
  await harness.manager.handleFrame(runStartFrame(harness.workspaceId))
  expect(harness.runtimes).toHaveLength(1)
  expect(existsSync(inputDir())).toBe(true)
  return harness
}

function runEventsOf(harness: ResilienceHarness): Array<Record<string, unknown>> {
  return harness.runEvents().map((event) => event.event as unknown as Record<string, unknown>)
}

function snapshotFramesOf(harness: ResilienceHarness): Array<Record<string, unknown>> {
  return harness
    .sentFrames()
    .filter((frame) => frame.type === 'run.snapshot')
    .map((frame) => frame.payload)
}

function terminalFrame(
  type: 'run.completed' | 'run.cancelled' | 'runtime.fatal',
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload: { runId: RUN_ID, ...payload },
  })
}

describe('#62：全部终态路径清理 Reviewer 输入副本（真实文件系统）', () => {
  // ---- 终态帧投影（既有路径，回归守护）----

  it('终态帧 run.completed → 副本目录被清', async () => {
    const h = await startReviewerRun()
    h.runtimes[0]?.emitStdout(runtimeReadyLine(RUN_ID))
    h.runtimes[0]?.emitStdout(terminalFrame('run.completed', { dshSessionId: 'session-1' }))
    expect(runEventsOf(h).some((e) => e.type === 'run.completed')).toBe(true)
    expect(await awaitDirGone(inputDir())).toBe(true)
  })

  it('终态帧 runtime.fatal → 副本目录被清', async () => {
    const h = await startReviewerRun()
    h.runtimes[0]?.emitStdout(
      terminalFrame('runtime.fatal', { code: 'INTERNAL_ERROR', summary: 'bridge exploded' }),
    )
    expect(runEventsOf(h).some((e) => e.type === 'run.failed')).toBe(true)
    expect(await awaitDirGone(inputDir())).toBe(true)
  })

  it('终态帧 run.cancelled → 副本目录被清', async () => {
    const h = await startReviewerRun()
    h.runtimes[0]?.emitStdout(terminalFrame('run.cancelled', {}))
    expect(runEventsOf(h).some((e) => e.type === 'run.cancelled')).toBe(true)
    expect(await awaitDirGone(inputDir())).toBe(true)
  })

  // ---- 协议违例 fail-closed（§11）----

  it('协议违例（非 JSON stdout）→ run.failed 终态且副本目录被清', async () => {
    const h = await startReviewerRun()
    h.runtimes[0]?.emitStdout('this is not json')
    const failed = runEventsOf(h).find((e) => e.type === 'run.failed') as
      | { code?: string }
      | undefined
    expect(failed?.code).toBe('INTERNAL_ERROR')
    expect(await awaitDirGone(inputDir())).toBe(true)
  })

  // ---- 退出归因（P1-16 exit-classifier 路径）----

  it('退出归因 runtime_lost（无终态帧退出）→ run.failed(RUNTIME_LOST) 且副本目录被清', async () => {
    const h = await startReviewerRun()
    h.runtimes[0]?.exitWith(1, null)
    const failed = runEventsOf(h).filter((e) => e.type === 'run.failed')
    expect(failed).toHaveLength(2) // owner + project
    expect((failed[0] as { code?: string }).code).toBe('RUNTIME_LOST')
    expect(await awaitDirGone(inputDir())).toBe(true)
  })

  it('退出归因 cancelled_forced（取消未确认 Runtime 即死）→ run.cancelled(forced) 且副本目录被清', async () => {
    const h = await startReviewerRun()
    await h.manager.handleFrame(cancelFrame())
    h.runtimes[0]?.exitWith(null, 'SIGKILL')
    const cancelled = runEventsOf(h).find((e) => e.type === 'run.cancelled') as
      | { forced?: boolean }
      | undefined
    expect(cancelled?.forced).toBe(true)
    expect(await awaitDirGone(inputDir())).toBe(true)
  })

  // ---- supervisor lost（onLost 回调路径）----

  it('supervisor lost：runtime_timeout 回收 → run.failed(RUNTIME_LOST) 且副本目录被清', async () => {
    const h = await startReviewerRun({ runtimeTimeoutMs: 40 })
    h.runtimes[0]?.emitStdout(runtimeReadyLine(RUN_ID))
    // wall-clock 超限回收是真实计时器：先等终态投影出现（归因到位），再等目录消失。
    expect(
      await waitFor(() => runEventsOf(h).filter((e) => e.type === 'run.failed').length === 2),
    ).toBe(true)
    const failed = runEventsOf(h).filter((e) => e.type === 'run.failed')
    expect((failed[0] as { code?: string }).code).toBe('RUNTIME_LOST')
    expect(await awaitDirGone(inputDir())).toBe(true)
  })

  it('supervisor lost：orphaned_after_node_restart（recoverOrphans）→ lost 快照且副本目录被清', async () => {
    const h = await startReviewerRun()
    // 孤儿恢复：状态库里有在管行 → recoverOrphans 逐条上报 lost
    // （脚本化 Runtime 的 pid 非真实进程 → 探测 verdict=dead，绝不发信号）。
    await h.supervisor.recoverOrphans()
    const snapshot = snapshotFramesOf(h).find((frame) => frame['status'] === 'lost') as
      | { failureCode?: string }
      | undefined
    expect(snapshot?.failureCode).toBe('RUNTIME_LOST')
    expect(await awaitDirGone(inputDir())).toBe(true)
  })
})
