/**
 * 连续对话读模型（P1-393；ADR-0019 决定 1/5）。
 *
 * 执行区要回答的是「这个任务到现在发生过什么、结果是什么、产出在哪」，所以把
 * 现有指令、运行、事件与交付物派生为一段按时间连续阅读的对话（不新增服务端读模型）：
 *
 * - **段序**沿用服务端运行顺序（Hub `listRunsByTask` 的 `createdAt ASC`），本模块不再排序；
 * - **段内**事件按 `seq` 顺序（`orderedRunEvents` 的身份去重 + 排序），指令按服务端创建时间
 *   插进这条流（协议没有逐条回复关联，不伪造追问与回复的一一对应）；
 * - **回复**只从 `assistant.message` 与 `run.completed` 的持久化文本派生；**只合并同一运行
 *   末尾相同的最终回复**（最后一帧与上一帧 trim 后相同才合并——owner 的
 *   `assistant.message` 与 `run.completed` 常是同一句话），不跨运行按文本去重；
 * - **窗口**是最近 N 次运行（`CONVERSATION_WINDOW`），更早的记录按步长加载；窗口外运行上
 *   的指令不渲染（等加载），**无所属运行的拒绝指令**按创建时间保留在主对话里；
 * - **交付物**按 `runId` 归到对应段（可见性由调用方先筛过）。
 */
import type {
  InstructionView,
  RunEventItem,
  TaskRoomArtifact,
  TaskRoomRun,
} from '../../shared/api/types.js'
import { ACTIVE_RUN } from './run-states.js'
import { runOrdinalLabels } from './runLabels.js'
import { eventIdentity, orderedRunEvents } from './tool-call-state.js'

/** 首屏展示的运行段数；「加载更早记录」每次再加一段步长。 */
export const CONVERSATION_WINDOW = 20
export const CONVERSATION_WINDOW_STEP = 20

/** 段内的一条 Agent 回复（持久化文本；直播文本不在这里——它另有流式区）。 */
export interface ConversationReplyItem {
  readonly kind: 'reply'
  readonly key: string
  readonly text: string
  readonly occurredAt: string
  readonly seq: number
}

/** 段内的一条指令（含被拒的追问：拒绝理由与状态同列，长期可读）。 */
export interface ConversationInstructionItem {
  readonly kind: 'instruction'
  readonly key: string
  readonly instruction: InstructionView
}

export type ConversationItem = ConversationReplyItem | ConversationInstructionItem

export interface ConversationSegment {
  readonly run: TaskRoomRun
  /** 「第 N 次运行」——N 按服务端全序，窗口滑动不改变既有段的序号。 */
  readonly label: string
  readonly items: readonly ConversationItem[]
  readonly replies: readonly ConversationReplyItem[]
  readonly artifacts: readonly TaskRoomArtifact[]
}

export interface ConversationRunEntry {
  readonly kind: 'run'
  readonly key: string
  readonly createdAt: string
  readonly segment: ConversationSegment
}

/** 无所属运行的指令（例如来源已不存在的拒绝指令）：按时间留在主对话里。 */
export interface ConversationInstructionEntry {
  readonly kind: 'instruction'
  readonly key: string
  readonly createdAt: string
  readonly instruction: InstructionView
}

export type ConversationEntry = ConversationRunEntry | ConversationInstructionEntry

export interface ConversationModel {
  readonly entries: readonly ConversationEntry[]
  readonly visibleRuns: number
  readonly hiddenRuns: number
}

export interface ConversationInput {
  readonly runs: readonly TaskRoomRun[]
  readonly instructions: readonly InstructionView[]
  /** 已按可见性筛选过的交付物（candidate 只含本人）。 */
  readonly artifacts: readonly TaskRoomArtifact[]
  /** runId → 该运行的事件（分页读取的当前结果；缺 = 还在读，段内就没有回复）。 */
  readonly eventsByRun: ReadonlyMap<string, readonly RunEventItem[]>
  /** 显示最近多少段运行。 */
  readonly window: number
}

function hasRun(runId: string | null): runId is string {
  return runId !== null && runId !== ''
}

/** 一条事件是否携带可呈现的持久化回复文本；返回 trim 后的文本或 null。 */
function replyTextOf(item: RunEventItem): string | null {
  const type = item.event['type']
  const text =
    type === 'assistant.message'
      ? item.event['text']
      : type === 'run.completed'
        ? item.event['finalText']
        : null
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

const isFinalReply = (item: RunEventItem): boolean => item.event['type'] === 'run.completed'

/**
 * 段内回复：身份去重（`orderedRunEvents`）后按 `seq` 顺序取持久化文本；
 * 只在**末尾的最终回复**与上一条 trim 后相同时合并（同一运行内），不跨运行去重。
 */
export function runReplies(
  events: readonly RunEventItem[],
  runId: string,
): readonly ConversationReplyItem[] {
  const replies: ConversationReplyItem[] = []
  for (const item of orderedRunEvents(events, runId)) {
    const text = replyTextOf(item)
    if (text === null) continue
    const previous = replies.at(-1)
    if (previous !== undefined && isFinalReply(item) && previous.text.trim() === text) continue
    replies.push({
      kind: 'reply',
      key: `reply-${eventIdentity(item)}`,
      text,
      occurredAt: item.occurredAt,
      seq: item.seq,
    })
  }
  return replies
}

/**
 * 段内条目：事件流保持 `seq` 顺序，指令按服务端创建时间插进来（同刻指令在前）。
 * 指令在服务端已按 `(createdAt ASC, id ASC)` 排好；这里再排一次只作防御，不改变口径。
 */
export function segmentItems(
  instructions: readonly InstructionView[],
  replies: readonly ConversationReplyItem[],
): readonly ConversationItem[] {
  const ordered = [...instructions].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt),
  )
  const items: ConversationItem[] = []
  let cursor = 0
  for (const reply of replies) {
    while (cursor < ordered.length && ordered[cursor]!.createdAt <= reply.occurredAt) {
      const instruction = ordered[cursor]!
      items.push({ kind: 'instruction', key: `instruction-${instruction.id}`, instruction })
      cursor += 1
    }
    items.push(reply)
  }
  while (cursor < ordered.length) {
    const instruction = ordered[cursor]!
    items.push({ kind: 'instruction', key: `instruction-${instruction.id}`, instruction })
    cursor += 1
  }
  return items
}

/**
 * 可见运行窗口：服务端运行顺序的**末尾** N 段（最新在最后）。
 * `hiddenRuns` 是更早（未加载）的运行数——「加载更早记录」据此显示还剩多少。
 */
export function visibleRunWindow(
  runs: readonly TaskRoomRun[],
  window: number,
): { visible: readonly TaskRoomRun[]; hidden: number } {
  const visible = window >= runs.length ? runs : runs.slice(-window)
  return { visible, hidden: runs.length - visible.length }
}

/**
 * 派生连续对话。窗口取服务端运行顺序的**末尾** N 段（最新在最后）；
 * 指令只有在「不属于任何已知运行」时才作为独立条目出现——属于更早（未加载）运行的指令
 * 等那次加载再渲染，不提前泄漏进首屏。
 */
export function buildConversation(input: ConversationInput): ConversationModel {
  const runIds = new Set(input.runs.map((run) => run.id))
  const { visible, hidden } = visibleRunWindow(input.runs, input.window)
  const labels = runOrdinalLabels(input.runs)
  const artifactsByRun = new Map<string, TaskRoomArtifact[]>()
  for (const artifact of input.artifacts) {
    if (!runIds.has(artifact.runId)) continue
    const list = artifactsByRun.get(artifact.runId)
    if (list === undefined) artifactsByRun.set(artifact.runId, [artifact])
    else list.push(artifact)
  }
  const instructionsByRun = new Map<string, InstructionView[]>()
  const standalone: InstructionView[] = []
  for (const instruction of input.instructions) {
    if (!hasRun(instruction.runId) || !runIds.has(instruction.runId)) {
      standalone.push(instruction)
      continue
    }
    const list = instructionsByRun.get(instruction.runId)
    if (list === undefined) instructionsByRun.set(instruction.runId, [instruction])
    else list.push(instruction)
  }

  const entries: ConversationEntry[] = []
  const runs = visible.map<ConversationEntry>((run) => {
    const replies = runReplies(input.eventsByRun.get(run.id) ?? [], run.id)
    const segment: ConversationSegment = {
      run,
      label: labels.get(run.id) ?? '运行',
      items: segmentItems(instructionsByRun.get(run.id) ?? [], replies),
      replies,
      artifacts: artifactsByRun.get(run.id) ?? [],
    }
    return { kind: 'run', key: `run-${run.id}`, createdAt: run.createdAt, segment }
  })
  const orphans = standalone
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    )
    .map<ConversationEntry>((instruction) => ({
      kind: 'instruction',
      key: `instruction-${instruction.id}`,
      createdAt: instruction.createdAt,
      instruction,
    }))
  // 两段已排序的序列按时间归并（同刻：独立指令在前——它没有段承载）。
  let runCursor = 0
  let orphanCursor = 0
  while (runCursor < runs.length || orphanCursor < orphans.length) {
    const runEntry = runs[runCursor]
    const orphanEntry = orphans[orphanCursor]
    if (
      orphanEntry !== undefined &&
      (runEntry === undefined || orphanEntry.createdAt <= runEntry.createdAt)
    ) {
      entries.push(orphanEntry)
      orphanCursor += 1
    } else if (runEntry !== undefined) {
      entries.push(runEntry)
      runCursor += 1
    }
  }
  return { entries, visibleRuns: visible.length, hiddenRuns: hidden }
}

/**
 * 对话「底部」的稳定签名：只包含末段与末条目的身份。
 * 加载更早记录只改变对话上方的内容，这个签名不变——滚动跟随据此判断「有没有新内容在底部」。
 */
export function conversationBottomKey(model: ConversationModel): string {
  const last = model.entries.at(-1)
  if (last === undefined) return ''
  if (last.kind !== 'run') return last.key
  const lastItem = last.segment.items.at(-1)
  return `${last.key}|${lastItem?.key ?? ''}`
}

/**
 * 运行读取顺序（ADR-0019 决定 5）：优先活跃运行，其余按最新在前——
 * 首屏最先要读到的是「最新的回复」，不是最早的记录。
 */
export function conversationReadOrder(runs: readonly TaskRoomRun[]): readonly string[] {
  const active = runs.filter((run) => ACTIVE_RUN.has(run.status)).map((run) => run.id)
  const activeSet = new Set(active)
  const rest = [...runs]
    .reverse()
    .map((run) => run.id)
    .filter((id) => !activeSet.has(id))
  return [...active, ...rest]
}
