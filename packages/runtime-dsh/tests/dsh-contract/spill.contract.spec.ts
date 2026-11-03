/**
 * ADR-0027 §6（PC-05b-3）：spill 根固定在受管 Run home 下。
 *
 * 判定基线（真 boot 栈：dsh-base → whalepod bundle → replay，与生产同一路径）：
 * - fixture 的 bash 输出 > 50KB，确实触发 rc.8 spill；
 * - spill 文件落在 `<dshHomePath>/spill/session-<hash>/...`，正文可读；
 * - OS tmpdir 下没有新建的默认 `dsh-spill-*` 根持有本次正文（负控）。
 *
 * 只断言"spill 目录不存在"不足以证明根配置正确（spill 可能根本没触发），
 * 所以正向判据同时要求正文与字节数。默认根是 spill-local 的进程级单例，
 * 不随 Runtime 退出删除；只凭目录存在会与测试自身临时目录混淆，故负控按
 * **正文 marker** 判定。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
} from './helpers/replay-runtime.js'

const MARKER = 'ADR0027_SPILL_MARKER'

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

function defaultSpillRoots(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith('dsh-spill-'))
    .map((name) => join(tmpdir(), name))
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ADR-0027 §6: oversized tool output spills under the managed DSH home', () => {
  it('>50KB bash output lands in <dshHomePath>/spill with the body, not the OS tmpdir', async () => {
    const spec = {
      ...runtimeSpec(),
      approvalPolicy: 'full_access' as const,
    }
    tempDirs.push(spec.dshHomePath, spec.workspacePath)
    // 本次运行的新文件必须晚于这个时刻；旧默认根里同 marker 的历史文件不参与负控
    // （测试进程的 spill-local 默认根是模块级单例，可能早就存在）。
    const startedAt = Date.now() - 5_000
    const runtime = await startReplayRuntime('spill', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(
        commandFrame('run.prompt', {
          runId: spec.runId,
          text: 'emit more than the inline spill budget',
        }),
      )
      await runtime.until('run.completed')

      const spillRoot = join(spec.dshHomePath, 'spill')
      expect(existsSync(spillRoot), 'spill 根没有落在受管 home 下').toBe(true)
      const files = filesUnder(spillRoot)
      expect(files.length, 'spill 目录没有任何正文文件').toBeGreaterThan(0)
      const bodies = files.map((file) => readFileSync(file, 'utf8'))
      expect(
        bodies.some((body) => body.includes(MARKER)),
        'spill 文件不含工具输出正文',
      ).toBe(true)
      expect(
        files.some((file) => statSync(file).size > 50_000),
        'spill 文件未承载完整 >50KB 输出',
      ).toBe(true)

      // 负控：如果 rc.8 默认 mkdtemp(tmpdir()/dsh-spill-*) 生效，本次正文会落到
      // 默认根里。扫描**全部**默认根，但只认本次运行写入的新文件（mtime + marker），
      // 避免被历史残留或并行用例干扰。
      const leaked = defaultSpillRoots()
        .flatMap(filesUnder)
        .filter((file) => {
          try {
            return (
              statSync(file).mtimeMs >= startedAt && readFileSync(file, 'utf8').includes(MARKER)
            )
          } catch {
            return false
          }
        })
      expect(leaked, '正文泄漏到 OS tmpdir 的默认 spill 根').toEqual([])
    } finally {
      await runtime.dispose()
    }
  })
})
