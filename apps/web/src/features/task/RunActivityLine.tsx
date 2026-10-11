import { useSyncExternalStore, type ReactNode } from 'react'
import type { RunEventItem, RunStatus } from '../../shared/api/types.js'
import { RUN_PHASE_LABEL } from '../../shared/format.js'
import { usePageVisible } from '../../shared/usePageVisible.js'
import {
  getConnectionStatus,
  subscribeConnectionStatus,
} from '../../shared/realtime/connection-store.js'
import ThoughtLine from '../../vendor/react-bits-micro/ThoughtLine.js'

const IDLE_LABEL: Readonly<Partial<Record<RunStatus, string>>> = {
  queued: '排队中，等待运行',
  dispatching: '派发中，等待运行时就绪',
  waiting_approval: '等待责任人审批',
  cancel_requested: '正在取消',
  completed: '本次运行已完成',
  failed: '本次运行失败',
  cancelled: '本次运行已取消',
  lost: '运行已丢失，结果未知',
}

/** Only the Hub's public phase projection reaches ThoughtLine. Never forward event payloads. */
export function RunActivityLine({
  runId,
  status,
  events,
  pending,
  failed,
}: {
  runId: string
  status: RunStatus
  events: readonly RunEventItem[]
  pending: boolean
  failed: boolean
}): ReactNode {
  const connection = useSyncExternalStore(subscribeConnectionStatus, getConnectionStatus)
  const visible = usePageVisible()
  let label = '运行状态未知'
  let working = false
  if (status !== 'running') {
    if (Object.hasOwn(IDLE_LABEL, status)) label = IDLE_LABEL[status]!
  } else if (connection !== 'open') {
    label = connection === 'reconnecting' ? '连接中断，活动信息待同步' : '连接建立中，等待活动更新'
  } else if (failed) {
    label = '活动信息读取失败，请稍后重试'
  } else if (pending) {
    label = '正在读取活动信息…'
  } else {
    label = '运行中，等待活动更新'
    // Parent supplies ordered, deduplicated events. An unknown newest phase must not revive an old phase.
    const latest = events.findLast(
      (item) =>
        item.runId === runId && item.audience === 'project' && item.event['type'] === 'run.phase',
    )
    const phase = latest?.event['phase']
    if (phase === 'thinking' || phase === 'tool' || phase === 'finalizing') {
      label = RUN_PHASE_LABEL[phase]
      working = visible
    }
  }
  return <ThoughtLine label={label} working={working} />
}
