import type { ReactNode } from 'react'

/** Host-owned slots: all form state and network actions stay in the application. */
export function PromptFrame(props: {
  children: ReactNode
  controls?: ReactNode
  action: ReactNode
}): ReactNode

export function ApprovalFrame(props: {
  id: string
  title: ReactNode
  meta: ReactNode
  children: ReactNode
  footer: ReactNode
}): ReactNode

export function FileCard(props: {
  title: string
  subtitle: ReactNode
  icon: ReactNode
  onOpen?: () => void
  label?: string
}): ReactNode
