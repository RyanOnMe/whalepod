import type { RunEventItem, RunStatus } from '../../shared/api/types.js'
import type { ConnectionStatus } from '../../shared/realtime/connection-store.js'
import type { CallChipStatus } from '../../vendor/react-bits-micro/CallChip.js'
import { TERMINAL_RUN } from './run-states.js'

export function eventIdentity(item: RunEventItem): string {
  return JSON.stringify([item.runId, item.audience, item.seq])
}

/** 同一查询的重复帧按受众/序号去重；不接受别的 Run 的结果或数组顺序作为因果关系。 */
export function orderedRunEvents(events: RunEventItem[], runId: string): RunEventItem[] {
  const unique = new Map<string, RunEventItem>()
  for (const item of events) {
    if (item.runId !== runId || !Number.isSafeInteger(item.seq) || item.seq <= 0) continue
    const key = eventIdentity(item)
    if (!unique.has(key)) unique.set(key, item)
  }
  return [...unique.values()].sort((a, b) => a.seq - b.seq)
}

/** 保留首次结束事实：一个工具的终态不会因重复/冲突结束事件复活或换结果。 */
export function toolResults(events: RunEventItem[]): ReadonlyMap<string, unknown> {
  const starts = new Map<string, string>()
  const results = new Map<string, unknown>()
  for (const item of events) {
    const callId = item.event['callId']
    if (typeof callId !== 'string' || callId === '') continue
    const call = JSON.stringify([item.runId, item.audience, callId])
    if (item.event['type'] === 'tool.started' && !starts.has(call))
      starts.set(call, eventIdentity(item))
    if (item.event['type'] !== 'tool.finished') continue
    const start = starts.get(call)
    if (start !== undefined && !results.has(start)) results.set(start, item.event['outcome'])
  }
  return results
}

export function toolPresentation(
  item: RunEventItem,
  results: ReadonlyMap<string, unknown>,
  runStatus: RunStatus | undefined,
  connection: ConnectionStatus,
  eventsError: boolean,
): { status: CallChipStatus; label: string } {
  const identity = eventIdentity(item)
  const outcome = results.get(identity)
  if (outcome === 'succeeded') return { status: 'done', label: '成功' }
  if (outcome === 'failed') return { status: 'error', label: '失败' }
  if (outcome === 'cancelled') return { status: 'cancelled', label: '已取消' }
  if (
    results.has(identity) ||
    typeof item.event['callId'] !== 'string' ||
    item.event['callId'] === '' ||
    runStatus === undefined ||
    TERMINAL_RUN.has(runStatus)
  )
    return { status: 'unknown', label: '结果未知' }
  if (eventsError) return { status: 'unknown', label: '事件读取失败' }
  if (connection !== 'open')
    return { status: 'unknown', label: connection === 'reconnecting' ? '连接中断' : '正在连接' }
  if (runStatus === 'waiting_approval') return { status: 'paused', label: '等待审批' }
  if (runStatus === 'cancel_requested') return { status: 'paused', label: '正在取消' }
  return runStatus === 'running'
    ? { status: 'running', label: '执行中' }
    : { status: 'unknown', label: '结果未知' }
}
