/**
 * `TaskMessageViewSchema`：Task 消息读模型的唯一真源（#210）。
 *
 * 这道门回答的问题：Hub 的 `toCommentView` 实际发出的东西，与这里的 schema
 * 还是同一形状吗？服务端多发/少发一个字段，`TaskRoomView` 的消费侧应当响——
 * "静默多出字段"是另一种漂移（`client.ts` 是 `as T`，不做运行期校验）。
 *
 * 样本就是 `toCommentView` 的输出形状（13 字段全齐 + 讨论态的 null 面）：
 * 它不是"随便编的例子"，是"服务端今天发出的东西长这样"的断言。
 */
import { describe, expect, it } from 'vitest'
import { TaskMessageViewSchema } from '../src/task-views.js'

/** `toCommentView` 发出的指令态（非空面全齐）。 */
const INSTRUCTION_SHAPE = {
  id: 'msg-1',
  taskId: 'task-1',
  authorUserId: 'user-1',
  body: '跑一遍回归',
  kind: 'instruction',
  origin: 'human',
  targetAgentId: 'agent-1',
  runId: null,
  instructionState: 'pending',
  instructionErrorCode: null,
  instructionErrorMessage: null,
  createdAt: '2026-09-18T00:00:00.000Z',
  editedAt: null,
} as const

/** `toCommentView` 发出的讨论态（执行面全 null）。 */
const DISCUSSION_SHAPE = {
  id: 'msg-2',
  taskId: 'task-1',
  authorUserId: 'user-2',
  body: '收到，我先看一下',
  kind: 'discussion',
  origin: 'human',
  targetAgentId: null,
  runId: null,
  instructionState: null,
  instructionErrorCode: null,
  instructionErrorMessage: null,
  createdAt: '2026-09-18T00:01:00.000Z',
  editedAt: null,
} as const

describe('task message view', () => {
  it('服务端今天发出的指令态能过 schema', () => {
    expect(() => TaskMessageViewSchema.parse(INSTRUCTION_SHAPE)).not.toThrow()
  })

  it('服务端今天发出的讨论态能过 schema（执行面全 null）', () => {
    expect(() => TaskMessageViewSchema.parse(DISCUSSION_SHAPE)).not.toThrow()
  })

  it('**多出字段就响**：服务端加字段而这里不同步，必须红（不是静默漂移）', () => {
    // strictObject 是故意的（task-views.ts 头注）：这条红了说明有人在服务端加了字段，
    // 正确动作是把字段收进 schema（并评估 Web 展示层要不要画），不是把这条改成宽松。
    const extra = { ...INSTRUCTION_SHAPE, someNewField: 'x' }
    expect(() => TaskMessageViewSchema.parse(extra)).toThrow()
  })

  it('**少了字段就响**：必填 13 字段缺一即红', () => {
    const { editedAt: _dropped, ...missing } = INSTRUCTION_SHAPE
    expect(() => TaskMessageViewSchema.parse(missing)).toThrow()
  })
})
