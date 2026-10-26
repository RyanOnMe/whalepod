import { useSyncExternalStore, type ReactNode } from 'react'
import type { RunEventItem, RunStatus } from '../../shared/api/types.js'
import { usePageVisible } from '../../shared/usePageVisible.js'
import {
  getConnectionStatus,
  subscribeConnectionStatus,
} from '../../shared/realtime/connection-store.js'
import { ActivityFrame, AgentStateCore } from '../../vendor/collectui/collectui.js'
import { deriveRunActivity } from './run-activity-state.js'

/** Only the Hub's public phase projection reaches the presentation. Never forward event payloads. */
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
  const { state, label, working } = deriveRunActivity({
    runId,
    status,
    events,
    pending,
    failed,
    connection,
    visible,
  })
  return (
    <ActivityFrame
      label={label}
      working={working}
      status={status}
      core={<AgentStateCore key={runId} state={state} active={working} />}
    />
  )
}
