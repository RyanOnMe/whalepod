import { useSyncExternalStore, type ReactNode } from 'react'
import type { RunEventItem, RunStatus } from '../../shared/api/types.js'
import {
  getConnectionStatus,
  subscribeConnectionStatus,
} from '../../shared/realtime/connection-store.js'
import {
  IconCheckOutline16,
  IconCloseOutline16,
  IconWarningOutline16,
} from '../../vendor/dsh-ui/icons.js'
import CallChip from '../../vendor/react-bits-micro/CallChip.js'
import { toolPresentation } from './tool-call-state.js'

/** 仅读取 toolName 和匹配的 outcome；preview/参数/原始日志没有传入视觉原语。 */
export function ToolEventChip({
  item,
  results,
  runStatus,
  eventsError = false,
}: {
  item: RunEventItem
  results: ReadonlyMap<string, unknown>
  runStatus: RunStatus | undefined
  eventsError?: boolean
}): ReactNode {
  const connection = useSyncExternalStore(subscribeConnectionStatus, getConnectionStatus)
  const presentation = toolPresentation(item, results, runStatus, connection, eventsError)
  const name = typeof item.event['toolName'] === 'string' ? item.event['toolName'] : '未知工具'
  const icon =
    presentation.status === 'unknown' ? (
      <IconWarningOutline16 size={14} />
    ) : (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path
          d="m3 4 3 3-3 3M8 10h3"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  return (
    <CallChip
      name={name}
      status={presentation.status}
      label={presentation.label}
      icon={icon}
      doneIcon={<IconCheckOutline16 size={14} />}
      errorIcon={<IconCloseOutline16 size={14} />}
    />
  )
}
