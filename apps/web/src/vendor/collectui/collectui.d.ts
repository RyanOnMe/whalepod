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

export function SidebarProfile(props: { name: string; role: string; title?: string; children: ReactNode }): ReactNode
export function CommandFrame(props: { search: ReactNode; children: ReactNode; footer: ReactNode }): ReactNode
export function EmptyPanel(props: { title: string; description?: ReactNode; icon: ReactNode; action?: ReactNode; compact?: boolean; heading?: 'h2' | 'h3' }): ReactNode
export function SheetHeading(props: { title: ReactNode; icon: ReactNode; close: ReactNode }): ReactNode
export function ActivityFrame(props: { label: string; working: boolean; status: string }): ReactNode
export function ToolCallFrame(props: { name: string; status: string; label: string; icon: ReactNode }): ReactNode
