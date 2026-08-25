/**
 * 未知 command/event fail-closed（03-领域模型与运行协议.md §11；02 Task 3 Step 5）。
 *
 * 拒绝而不是忽略：未知 type 与 protocolVersion 不符 → PROTOCOL_MISMATCH；
 * 已知 type 但载荷畸形 → VALIDATION_FAILED。Node 对未知 command 不执行；
 * Web 对未知 Client event 记录后触发 resync，不执行状态变更（解析层先行拒绝）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ProtocolError, parseClientFrame, parseNodeFrame, parseRuntimeFrame } from '../src/index.js'
import type { ProtocolErrorCode } from '../src/index.js'

const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url))

function readFixture(dir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_ROOT, dir, name), 'utf8'))
}

/** vitest 4 没有 jest 式 toThrowErrorMatchingObject；显式捕获后断言 code。 */
function expectProtocolError(fn: () => unknown, code: ProtocolErrorCode): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ProtocolError)
  expect((caught as ProtocolError).code).toBe(code)
  expect((caught as ProtocolError).message.length).toBeGreaterThan(0)
}

describe('fail-closed frame parsing', () => {
  it('rejects a protocol mismatch before command dispatch', () => {
    const frame = { ...readFixture('node-downstream', 'run.start.json'), protocolVersion: 2 }
    expectProtocolError(() => parseNodeFrame(frame, 'downstream'), 'PROTOCOL_MISMATCH')
  })

  it('rejects unknown node command types instead of executing them', () => {
    const frame = { ...readFixture('node-downstream', 'run.start.json'), type: 'run.launch' }
    expectProtocolError(() => parseNodeFrame(frame, 'downstream'), 'PROTOCOL_MISMATCH')
  })

  it('rejects unknown node upstream types instead of applying state changes', () => {
    const frame = { ...readFixture('node-upstream', 'run.event.json'), type: 'run.teleport' }
    expectProtocolError(() => parseNodeFrame(frame, 'upstream'), 'PROTOCOL_MISMATCH')
  })

  it('rejects unknown runtime command types', () => {
    const frame = { ...readFixture('runtime-command', 'run.prompt.json'), type: 'run.exfiltrate' }
    expectProtocolError(() => parseRuntimeFrame(frame, 'command'), 'PROTOCOL_MISMATCH')
  })

  it('rejects unknown runtime output types so the run can be failed explicitly', () => {
    const frame = { ...readFixture('runtime-output', 'agent.status.json'), type: 'agent.magic' }
    expectProtocolError(() => parseRuntimeFrame(frame, 'output'), 'PROTOCOL_MISMATCH')
  })

  it('rejects unknown client frame kinds', () => {
    const frame = { ...readFixture('client-frame', 'live.json'), kind: 'push' }
    expectProtocolError(() => parseClientFrame(frame), 'PROTOCOL_MISMATCH')
  })

  it('rejects unknown persistent client event types (web records and resyncs)', () => {
    const frame = readFixture('client-frame', 'persistent.json')
    const mutated = {
      ...frame,
      event: { ...(frame.event as Record<string, unknown>), type: 'task.magic' },
    }
    expectProtocolError(() => parseClientFrame(mutated), 'VALIDATION_FAILED')
  })

  it('rejects malformed payloads of a known type with VALIDATION_FAILED', () => {
    const frame = readFixture('node-downstream', 'run.start.json')
    const broken = {
      ...frame,
      payload: { ...(frame.payload as Record<string, unknown>), prompt: '' },
    }
    expectProtocolError(() => parseNodeFrame(broken, 'downstream'), 'VALIDATION_FAILED')
  })

  it('rejects non-object frames', () => {
    for (const junk of [null, 42, 'run.start', []]) {
      expectProtocolError(() => parseNodeFrame(junk, 'downstream'), 'VALIDATION_FAILED')
    }
  })

  it('throws ProtocolError instances carrying a machine-readable wire code', () => {
    try {
      parseRuntimeFrame({ protocolVersion: 1, type: 'run.explode' }, 'command')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe('PROTOCOL_MISMATCH')
    }
  })
})
