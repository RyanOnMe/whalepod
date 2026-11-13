import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type SetStateAction,
} from 'react'

export type ExecutionMode = 'new' | 'followup' | 'resume' | 'review'
/** #548：底部输入的接收方。与草稿同一份页面会话内存，不写 URL、不写浏览器持久存储。 */
export type MessageRecipient = 'team' | 'assistant'
/**
 * 草稿的来源标记（ADR-0019 决定 4）：'auto' = 默认规则给的（还会随运行状态更新），
 * 'user' = 用户明确选择过模式/来源（默认规则不再改写）。只有空白、未调整当前模式设置、
 * 未发送的自动草稿才跟随默认（判据在 execution-defaults.ts 的 followsDefaultMode）。
 */
export type ExecutionModeOrigin = 'auto' | 'user'
export interface ExecutionSettings {
  agentId: string
  profileRevisionId: string
  deviceId: string
  workspaceId: string
}
export const EMPTY_EXECUTION_SETTINGS: ExecutionSettings = {
  agentId: '',
  profileRevisionId: '',
  deviceId: '',
  workspaceId: '',
}
export interface ExecutionMaterialRequest {
  taskId: string
  artifactId: string
  nonce: string
}
export type InstructionIntentKey = { signature: string; key: string }
export type InstructionIntentKeyRef = { current: InstructionIntentKey | null }
/**
 * #548：团队留言草稿与它尚未确认的幂等键。
 * 与执行草稿同一份页面会话内存——切换接收方、进出详情或去设备页返回都还原；
 * 刷新/退出/换身份不承诺还在，也不进 URL 或浏览器持久存储。
 */
export interface TeamMessageDraft {
  body: string
  /** 同一份未确认请求重试时沿用；内容变了或成功后才换/清。 */
  pending: InstructionIntentKey | null
}
export const EMPTY_TEAM_MESSAGE_DRAFT: TeamMessageDraft = { body: '', pending: null }
export interface ExecutionDraft {
  ownerId: string
  text: string
  mode: ExecutionMode
  modeOrigin: ExecutionModeOrigin
  sourceId: string
  reviewArtifactIds: string[]
  revisionContext: ExecutionMaterialRequest | null
  /** #548：落笔那一刻的接收 Agent（null = 当时没有 Agent，必须由人再选）。 */
  agentSnapshot?: string | null
  launch: { key: string; settings: ExecutionSettings }
  sending: boolean
}
interface Entry {
  snapshot: ExecutionDraft
  intentKey: InstructionIntentKeyRef
  listeners: Set<() => void>
}
interface TeamEntry {
  snapshot: TeamMessageDraft
  listeners: Set<() => void>
}
/** One AppShell instance owns this memory. No persistence, transport or global singleton. */
class ExecutionDraftStore {
  private readonly entries = new Map<string, Entry>()
  private readonly recipients = new Map<string, MessageRecipient>()
  private readonly teamDrafts = new Map<string, TeamEntry>()
  constructor(readonly userId: string) {}
  recipientOf(taskId: string): MessageRecipient | undefined {
    return this.recipients.get(taskId)
  }
  setRecipient(taskId: string, recipient: MessageRecipient): void {
    this.recipients.set(taskId, recipient)
  }
  teamEntry(taskId: string): TeamEntry {
    let entry = this.teamDrafts.get(taskId)
    if (!entry) {
      entry = { snapshot: EMPTY_TEAM_MESSAGE_DRAFT, listeners: new Set() }
      this.teamDrafts.set(taskId, entry)
    }
    return entry
  }
  updateTeam(entry: TeamEntry, change: SetStateAction<TeamMessageDraft>): void {
    const next = typeof change === 'function' ? change(entry.snapshot) : change
    if (Object.is(next, entry.snapshot)) return
    entry.snapshot = next
    for (const listener of entry.listeners) listener()
  }
  /**
   * #548：迟到回执只能清「它自己那份」请求。判据必须在 store 的当前快照上取，
   * 不能用发起组件的 ref——组件可能已经因离开任务页而卸载、store 里已换成新草稿。
   */
  clearTeamIfPending(taskId: string, key: string): boolean {
    const entry = this.teamDrafts.get(taskId)
    if (!entry || entry.snapshot.pending?.key !== key) return false
    entry.snapshot = EMPTY_TEAM_MESSAGE_DRAFT
    for (const listener of entry.listeners) listener()
    return true
  }
  teamPendingKey(taskId: string): string | null {
    return this.teamDrafts.get(taskId)?.snapshot.pending?.key ?? null
  }
  ensure(taskId: string, initial: () => ExecutionDraft): Entry {
    let entry = this.entries.get(taskId)
    if (!entry) {
      entry = { snapshot: initial(), intentKey: { current: null }, listeners: new Set() }
      this.entries.set(taskId, entry)
    }
    return entry
  }
  has(taskId: string): boolean {
    return this.entries.has(taskId)
  }
  update(entry: Entry, change: SetStateAction<ExecutionDraft>): void {
    const next = typeof change === 'function' ? change(entry.snapshot) : change
    if (Object.is(next, entry.snapshot)) return
    entry.snapshot = next
    for (const listener of entry.listeners) listener()
  }
}
const DraftContext = createContext<ExecutionDraftStore | null>(null)
export function ExecutionDraftProvider({
  userId,
  children,
}: {
  userId: string
  children: ReactNode
}): ReactNode {
  const store = useMemo(() => new ExecutionDraftStore(userId), [userId])
  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>
}
export function useExecutionDraft(taskId: string, userId: string, initial: () => ExecutionDraft) {
  const store = useContext(DraftContext)
  if (!store || store.userId !== userId)
    throw new Error('Execution draft requires the current authenticated shell')
  const entry = store.ensure(taskId, initial)
  const subscribe = useCallback(
    (listener: () => void) => {
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
      }
    },
    [entry],
  )
  const getSnapshot = useCallback(() => entry.snapshot, [entry])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const update = useCallback(
    (change: SetStateAction<ExecutionDraft>) => store.update(entry, change),
    [store, entry],
  )
  const clear = useCallback(
    (next: ExecutionDraft) => {
      if (entry.snapshot.sending) return
      entry.intentKey.current = null
      store.update(entry, next)
    },
    [store, entry],
  )
  return { snapshot, update, clear, intentKey: entry.intentKey }
}

/** A copied URL alone cannot manufacture a setup-return context in another shell. */
export function useHasExecutionTask(taskId: string | null): boolean {
  const store = useContext(DraftContext)
  return taskId !== null && store !== null && store.has(taskId)
}

/**
 * #548：同一页面会话内进出任务/详情后恢复上次选的接收方。
 * 只存在 AppShell 的内存里（按登录身份隔离）；刷新、退出或换身份后不承诺还在。
 */
export function useTaskMessageRecipient(
  taskId: string,
  userId: string | null,
): {
  remembered: MessageRecipient | undefined
  remember: (recipient: MessageRecipient) => void
} {
  const store = useContext(DraftContext)
  const usable = store !== null && userId !== null && store.userId === userId
  return {
    remembered: usable ? store.recipientOf(taskId) : undefined,
    remember: (recipient) => {
      if (usable) store.setRecipient(taskId, recipient)
    },
  }
}

/**
 * #548：团队留言的未发送文字与待确认幂等键。
 * 与接收方记忆同一份页面会话边界；没有 AppShell（组件级夹具）时退回组件内 state。
 */
export function useTeamMessageDraft(
  taskId: string,
  userId: string | null,
): {
  draft: TeamMessageDraft
  update: (change: SetStateAction<TeamMessageDraft>) => void
  /** 仅当 store 里仍是这把键时清空；返回是否真的清了（迟到回执的安全闸）。 */
  clearIfPending: (key: string) => boolean
  /** 当前待确认键是否仍是这一把（失败回执是否还属于当前草稿）。 */
  isPending: (key: string) => boolean
} {
  const store = useContext(DraftContext)
  const usableStore = store !== null && userId !== null && store.userId === userId ? store : null
  const entry = usableStore?.teamEntry(taskId) ?? null
  const subscribe = useCallback(
    (listener: () => void) => {
      if (entry === null) return () => {}
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
      }
    },
    [entry],
  )
  const getSnapshot = useCallback(() => entry?.snapshot ?? EMPTY_TEAM_MESSAGE_DRAFT, [entry])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [local, setLocal] = useState<TeamMessageDraft>(EMPTY_TEAM_MESSAGE_DRAFT)
  const localRef = useRef(local)
  localRef.current = local
  if (usableStore !== null && entry !== null) {
    return {
      draft: snapshot,
      update: (change) => usableStore.updateTeam(entry, change),
      clearIfPending: (key) => usableStore.clearTeamIfPending(taskId, key),
      isPending: (key) => usableStore.teamPendingKey(taskId) === key,
    }
  }
  return {
    draft: local,
    update: (change) => setLocal((old) => (typeof change === 'function' ? change(old) : change)),
    clearIfPending: (key) => {
      if (localRef.current.pending?.key !== key) return false
      setLocal(EMPTY_TEAM_MESSAGE_DRAFT)
      return true
    },
    isPending: (key) => localRef.current.pending?.key === key,
  }
}
