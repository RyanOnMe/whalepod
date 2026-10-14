import { describe, expect, it } from 'vitest'
import { SendInstructionRequestSchema } from '../src/http.js'
const id = '00000000-0000-4000-8000-000000000001'
describe('显式执行意图 HTTP 契约', () => {
  it('旧客户端兼容，新执行/追问/续跑表达互斥意图', () => {
    for (const body of [
      { text: 'legacy' },
      { text: 'new', agentId: id, profileRevisionId: id, intent: { kind: 'new' } },
      { text: 'followup', intent: { kind: 'followup', runId: id } },
      { text: 'resume', intent: { kind: 'resume', runId: id } },
    ]) {
      expect(SendInstructionRequestSchema.safeParse(body).success).toBe(true)
    }
  })
  it('拒绝缺接收者/缺来源/未知模式与追问续跑的目标覆盖', () => {
    for (const body of [
      { text: 'x', intent: { kind: 'new' } },
      { text: 'x', intent: { kind: 'followup' } },
      { text: 'x', intent: { kind: 'resume', runId: 'bad' } },
      { text: 'x', intent: { kind: 'auto' } },
      { text: 'x', agentId: id, intent: { kind: 'resume', runId: id } },
      { text: 'x', workspaceId: id, intent: { kind: 'followup', runId: id } },
    ]) {
      expect(SendInstructionRequestSchema.safeParse(body).success).toBe(false)
    }
  })
})
