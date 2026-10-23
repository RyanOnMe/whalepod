/** Personal, read-only action projection; never an authorization receipt. */
import { z } from 'zod'
export const ATTENTION_LIMIT = 12
export const AttentionKindSchema = z.enum([
  'decide_approval',
  'confirm_handoff',
  'accept_assignment',
  'reassign_task',
  'inspect_candidate',
  'complete_task',
])
export const AttentionItemSchema = z
  .strictObject({
    kind: AttentionKindSchema,
    taskId: z.uuid(),
    taskTitle: z.string().min(1).max(200),
    projectName: z.string().min(1).max(120),
    objectId: z.uuid(),
    runId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .refine((item) => {
    if (item.kind === 'decide_approval' || item.kind === 'inspect_candidate') {
      return item.runId !== null
    }
    // 交接事项的对象是 receipt（不是 Task），但永远不指向一个 Run。
    if (item.kind === 'confirm_handoff') return item.runId === null
    return item.objectId === item.taskId && item.runId === null
  }, 'action identity must match its kind')
export const AttentionViewSchema = z.strictObject({
  items: z
    .array(AttentionItemSchema)
    .max(ATTENTION_LIMIT)
    .refine(
      (items) => new Set(items.map((i) => `${i.kind}:${i.objectId}`)).size === items.length,
      'duplicate action',
    ),
  hasMore: z.boolean(),
})
export type AttentionItem = z.infer<typeof AttentionItemSchema>
export type AttentionView = z.infer<typeof AttentionViewSchema>
