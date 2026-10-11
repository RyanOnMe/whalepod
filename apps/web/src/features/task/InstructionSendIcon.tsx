import type { ReactNode } from 'react'
import { IconCheckOutline16, IconWarningOutline16 } from '../../vendor/dsh-ui/icons.js'

export type SendFeedback =
  | 'idle'
  | 'pending'
  | 'failed'
  | 'started_run'
  | 'followup'
  | 'queued'
  | 'rejected'

/** Request acceptance only; never claims that the Run or Task has succeeded. */
export function InstructionSendIcon({ feedback }: { feedback: SendFeedback }): ReactNode {
  const icon =
    feedback === 'failed' || feedback === 'rejected' ? (
      <IconWarningOutline16 size={16} />
    ) : feedback === 'started_run' || feedback === 'followup' ? (
      <IconCheckOutline16 size={16} />
    ) : feedback === 'pending' || feedback === 'queued' ? (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ) : (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
        <path
          d="M8 12V4m-3 3 3-3 3 3"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  return (
    <span className="instruction-send-icon" aria-hidden="true">
      {icon}
    </span>
  )
}
