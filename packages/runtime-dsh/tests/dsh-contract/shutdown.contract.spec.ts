/**
 * 探针 9/10 —— sessions.flush 与 dispose（02 Task 11 Step 7）：
 * 完成事件前 session 已持久化；dispose 按 cancel→flush→dispose 顺序收敛且幂等。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
} from './helpers/replay-runtime.js'

/** 在 DSH home 下找持久化的 session JSONL（dsh-session-persistence-jsonl 落盘）。 */
function findPersistedLogs(dshHomePath: string): string[] {
  const sessionsDir = join(dshHomePath, 'sessions')
  if (!existsSync(sessionsDir)) return []
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full)
    }
  }
  walk(sessionsDir)
  return found
}

describe('probe: flush and dispose', () => {
  it('persists the session log before run.completed (flush contract)', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hello' }))
      await runtime.until('run.completed')

      // flush 契约：run.completed 到达时，durable session log 已落盘且含本 turn 的
      // assistant/message（证据：持久化文件，不是进程内状态）。
      const logs = findPersistedLogs(spec.dshHomePath)
      expect(logs.length).toBeGreaterThan(0)
      const contents = logs.map((file) => readFileSync(file, 'utf8')).join('\n')
      expect(contents).toContain('assistant/message')
      expect(contents).toContain('Hello from replay.')
    } finally {
      await runtime.dispose()
    }
  })

  it('runtime.shutdown disposes the agent and the tree; dispose is idempotent', async () => {
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'hello' }))
      await runtime.until('run.completed')

      await runtime.send(commandFrame('runtime.shutdown', { runId: spec.runId }))
      // dispose 后 runtime 不再产出任何帧；重复 dispose 不得抛错。
      const count = runtime.outputs.length
      await runtime.dispose()
      await runtime.dispose()
      expect(runtime.outputs.length).toBe(count)
    } finally {
      await runtime.dispose()
    }
  })
})
