import { describe, expect, it } from 'vitest'
import { AttentionViewSchema } from '../src/index.js'
const id = 'aaaaaaaa-0000-4000-8000-000000000001'
const item = {
  kind: 'accept_assignment',
  taskId: id,
  taskTitle: 'task',
  projectName: 'project',
  objectId: id,
  runId: null,
  createdAt: '2026-10-15T00:00:00.000Z',
}
describe('personal attention contract', () => {
  it('accepts bounded viewer-filtered action identities', () => {
    expect(AttentionViewSchema.parse({ items: [item], hasMore: true }).items).toEqual([item])
  })
  it('rejects private fields, duplicate objects, oversized and mismatched identities', () => {
    for (const items of [
      [{ ...item, preview: { command: 'private' } }],
      [item, item],
      Array.from({ length: 13 }, () => item),
      [{ ...item, kind: 'decide_approval' }],
      [{ ...item, objectId: 'bbbbbbbb-0000-4000-8000-000000000002' }],
    ])
      expect(AttentionViewSchema.safeParse({ items, hasMore: false }).success).toBe(false)
  })
})
