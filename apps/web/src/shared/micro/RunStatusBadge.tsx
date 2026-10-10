import { useSyncExternalStore, type ReactNode } from 'react'
import type { RunStatus } from '../api/types.js'
import { RUN_STATUS_LABEL } from '../format.js'
import { getConnectionStatus, subscribeConnectionStatus } from '../realtime/connection-store.js'
import StatusMark, { type StatusMarkStatus } from '../../vendor/react-bits-micro/StatusMark.js'

const MARK: Readonly<Record<RunStatus, StatusMarkStatus>> = {
  queued: 'pending',
  dispatching: 'pending',
  running: 'running',
  waiting_approval: 'pending',
  cancel_requested: 'pending',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  lost: 'failed',
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
const isVisible = (): boolean => document.visibilityState === 'visible'

/** 订阅只作用于小徽标；连接更新不触发整个运行列表/直播区重渲染。 */
export function RunStatusBadge({ status }: { status: RunStatus }): ReactNode {
  const connection = useSyncExternalStore(subscribeConnectionStatus, getConnectionStatus)
  const visible = useSyncExternalStore(subscribeVisibility, isVisible)
  return (
    <span className={`badge badge-run badge-run-${status}`}>
      <StatusMark
        status={MARK[status]}
        label={RUN_STATUS_LABEL[status]}
        active={status === 'running' && connection === 'open' && visible}
        paused={status === 'waiting_approval' || status === 'cancel_requested'}
      />
    </span>
  )
}
