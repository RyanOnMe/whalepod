import type { RunEventItem, RunStatus } from '../../shared/api/types.js'
import type { ConnectionStatus } from '../../shared/realtime/connection-store.js'
import { RUN_PHASE_LABEL } from '../../shared/format.js'
import { orderedRunEvents } from './tool-call-state.js'

/** Presentation states are derived from public Run facts, never simulated work. */
export type RunActivityState =
  | 'queued'
  | 'dispatching'
  | 'thinking'
  | 'tool'
  | 'finalizing'
  | 'approval'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'syncing'

export interface RunActivityPresentation {
  state: RunActivityState
  label: string
  working: boolean
}

export interface RunActivityInput {
  runId: string
  status: RunStatus
  events: readonly RunEventItem[]
  pending: boolean
  failed: boolean
  connection: ConnectionStatus
  visible: boolean
}

const NON_RUNNING: Readonly<
  Record<Exclude<RunStatus, 'running'>, Pick<RunActivityPresentation, 'state' | 'label'>>
> = {
  queued: { state: 'queued', label: '排队中，等待运行' },
  dispatching: { state: 'dispatching', label: '派发中，等待运行时就绪' },
  waiting_approval: { state: 'approval', label: '等待责任人审批' },
  cancel_requested: { state: 'cancelling', label: '正在取消' },
  completed: { state: 'completed', label: '本次运行已完成' },
  failed: { state: 'failed', label: '本次运行失败' },
  cancelled: { state: 'cancelled', label: '本次运行已取消' },
  lost: { state: 'unknown', label: '运行已丢失，结果未知' },
}

/**
 * Run status outranks retained phase events. Only a complete, connected, public phase can
 * activate the working core; document visibility controls animation without rewriting facts.
 */
export function deriveRunActivity({
  runId,
  status,
  events,
  pending,
  failed,
  connection,
  visible,
}: RunActivityInput): RunActivityPresentation {
  if (status !== 'running') {
    if (Object.hasOwn(NON_RUNNING, status)) return { ...NON_RUNNING[status], working: false }
    return { state: 'unknown', label: '运行状态未知', working: false }
  }
  if (connection !== 'open')
    return {
      state: 'syncing',
      label:
        connection === 'reconnecting' ? '连接中断，活动信息待同步' : '连接建立中，等待活动更新',
      working: false,
    }
  if (failed) return { state: 'unknown', label: '活动信息读取失败，请稍后重试', working: false }
  if (pending) return { state: 'syncing', label: '正在读取活动信息…', working: false }

  // Keep the latest phase even if unknown: falling back to an older valid phase invents activity.
  const latest = orderedRunEvents(events, runId).findLast(
    (item) => item.audience === 'project' && item.event['type'] === 'run.phase',
  )
  const phase = latest?.event['phase']
  if (phase === 'thinking' || phase === 'tool' || phase === 'finalizing')
    return { state: phase, label: RUN_PHASE_LABEL[phase], working: visible }
  return { state: 'unknown', label: '运行中，等待活动更新', working: false }
}
