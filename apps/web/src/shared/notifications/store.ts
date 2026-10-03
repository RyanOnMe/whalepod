/**
 * 运行完成通知的已读水位（P1-UX-13 / #259）。
 *
 * CursorStore（shared/realtime/cursor-store.ts）是**纯内存**的：页面每次加载都从 0
 * 重放 24 小时保留窗口。通知若不做持久去重，刷新一次就把窗口内早已跑完的 Run 再
 * 「恭喜」一遍。所以水位落 localStorage：
 *   - `known`：见过的终态 runId（FIFO 上限 300，防无限增长）；
 *   - `unseen`：还没读的终态运行（上限 50）——tab 标题徽标数它，进任务房间清它。
 *
 * 读写全 try/catch：隐私模式/配额满时降级为「本次会话内有效」，不抛给用户。
 * 多标签页无锁、各自计数（localStorage 没有跨标签协调）——已知限制，不引服务端未读。
 */
export type TerminalRunStatus = 'completed' | 'failed' | 'cancelled' | 'lost'

export interface UnseenRun {
  readonly runId: string
  readonly taskId: string
  readonly status: TerminalRunStatus
}

const STORAGE_KEY = 'whalepod.notifications.v1'
const KNOWN_LIMIT = 300
const UNSEEN_LIMIT = 50

interface NotificationState {
  readonly known: readonly string[]
  readonly unseen: readonly UnseenRun[]
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const EMPTY: NotificationState = { known: [], unseen: [] }

/** undefined = 内存态未读（下次访问从 localStorage 重建）。 */
let state: NotificationState | undefined

type Listener = () => void
const listeners = new Set<Listener>()

export function isTerminalRunStatus(value: unknown): value is TerminalRunStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'lost'
}

export function getUnseenRuns(): readonly UnseenRun[] {
  return load().unseen
}

export function subscribeNotifications(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 记一个终态 Run。首次见到返回 true（真事件），已见过返回 false（重放/重复，调用方
 * 不该再有任何动作）。`keepUnread=false`（用户正开着该任务房间）只记去重、不进徽标。
 */
export function recordTerminalRun(run: UnseenRun, keepUnread: boolean): boolean {
  const current = load()
  if (current.known.includes(run.runId)) return false
  commit({
    known: [...current.known, run.runId].slice(-KNOWN_LIMIT),
    unseen: keepUnread ? [...current.unseen, run].slice(-UNSEEN_LIMIT) : current.unseen,
  })
  return true
}

/** 读过某任务的终态（进任务房间/点通知）：该任务的未读清零；没有变化就不打扰订阅者。 */
export function clearTaskNotifications(taskId: string): void {
  const current = load()
  const unseen = current.unseen.filter((item) => item.taskId !== taskId)
  if (unseen.length === current.unseen.length) return
  commit({ known: current.known, unseen })
}

/**
 * 测试隔离：**只丢内存态**，不清存储——这样「刷新重放」用例可以如实模拟
 * 「模块重建但 localStorage 还在」，而不是把两条路径一起抹掉。
 */
export function resetNotificationStoreForTest(): void {
  state = undefined
  listeners.clear()
}

function load(): NotificationState {
  if (state === undefined) state = parse(storage()?.getItem(STORAGE_KEY) ?? null)
  return state
}

function commit(next: NotificationState): void {
  state = next
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 存储不可写（隐私模式/配额）：内存态仍然正确，本次会话内通知可用。
  }
  for (const listener of listeners) listener()
}

function storage(): StorageLike | undefined {
  try {
    // 访问器本身在部分环境会抛（隐私模式），所以连取 window.localStorage 都要兜。
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** 不合形（手改/历史版本/半截 JSON）一律当空状态：宁可多数一次，不能整块卡死。 */
function parse(raw: string | null): NotificationState {
  if (raw === null) return EMPTY
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return EMPTY
  }
  if (typeof value !== 'object' || value === null) return EMPTY
  const record = value as { known?: unknown; unseen?: unknown }
  return {
    known: Array.isArray(record.known)
      ? record.known.filter((id): id is string => typeof id === 'string')
      : [],
    unseen: Array.isArray(record.unseen) ? record.unseen.filter(isUnseenRun) : [],
  }
}

function isUnseenRun(value: unknown): value is UnseenRun {
  if (typeof value !== 'object' || value === null) return false
  const run = value as { runId?: unknown; taskId?: unknown; status?: unknown }
  return (
    typeof run.runId === 'string' &&
    typeof run.taskId === 'string' &&
    isTerminalRunStatus(run.status)
  )
}
