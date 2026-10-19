import { describe, expect, it } from 'vitest'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
} from './helpers/replay-runtime.js'

describe('#396 实际模型请求消费上下文', () => {
  it('new 与 persisted resume 均实际消费当前版本（回放内容依赖真实请求）', async () => {
    const first = runtimeSpec({
      executionContext: 'CTX_CONFIRMED CTX_HANDOFF CTX_UNDERSTANDING CURRENT_REVISION=1',
    })
    const runtime = await startReplayRuntime('context', first, { keepTempDirs: true })
    let sessionId = ''
    try {
      await runtime.send(initializeCommand(first))
      const ready = await runtime.until('runtime.ready')
      sessionId = ready.payload.dshSessionId
      await runtime.send(commandFrame('run.prompt', { runId: first.runId, text: '开始工作' }))
      await runtime.until('run.completed')
      expect(
        JSON.stringify(runtime.outputs.filter((frame) => frame.type === 'session.event')),
      ).toContain('实际请求：CTX_CONFIRMED / CTX_HANDOFF / CTX_UNDERSTANDING')
    } finally {
      await runtime.dispose()
    }
    const second = runtimeSpec({
      workspacePath: first.workspacePath,
      dshHomePath: first.dshHomePath,
      resumeSessionId: sessionId,
      executionContext: 'CTX_CONFIRMED CTX_HANDOFF CTX_UNDERSTANDING CURRENT_REVISION=2',
    })
    const resumed = await startReplayRuntime('context', second)
    try {
      await resumed.send(initializeCommand(second))
      await resumed.until('runtime.ready')
      await resumed.send(commandFrame('run.prompt', { runId: second.runId, text: '继续工作' }))
      await resumed.until('run.completed')
      expect(
        JSON.stringify(resumed.outputs.filter((frame) => frame.type === 'session.event')),
      ).toContain('实际请求：CTX_CONFIRMED / CTX_HANDOFF / CTX_UNDERSTANDING / CURRENT_REVISION=2')
    } finally {
      await resumed.dispose()
    }
  })
})
