import { useId, useState, type ReactNode } from 'react'
import { TimelineFold } from '../vendor/collectui/collectui.js'
import { REVEAL_EXIT_MS } from './motion.js'
import { usePresence } from './usePresence.js'

/** Host-owned disclosure state keeps content mounted and closing content inert. */
export function MotionDisclosure({
  label,
  count,
  children,
  className = '',
  testId,
}: {
  label: string
  count?: number
  children: ReactNode
  className?: string
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  const presence = usePresence(open ? true : null, REVEAL_EXIT_MS)
  const id = useId()
  return (
    <TimelineFold
      label={label}
      {...(count === undefined ? {} : { count })}
      open={open}
      present={presence.value !== null}
      onToggle={() => setOpen((value) => !value)}
      id={id}
      className={className}
      {...(testId === undefined ? {} : { testId })}
    >
      {children}
    </TimelineFold>
  )
}
