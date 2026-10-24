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

export function ResourceCard(props: { title: string; meta: ReactNode; description?: string; icon: ReactNode; actions: ReactNode; children: ReactNode }): ReactNode
export function TaskRow(props: { title: string; meta: ReactNode; status: ReactNode; onOpen: () => void }): ReactNode
export function DiscussionMessage(props: { author: string; time: ReactNode; children: ReactNode }): ReactNode
export function DiscussionComposer(props: { children: ReactNode; controls: ReactNode; action: ReactNode }): ReactNode
export function SettingsSection(props: { title: string; children: ReactNode }): ReactNode
export function InboxFrame(props: { title: ReactNode; count?: string; actions: ReactNode; filters?: ReactNode; children: ReactNode }): ReactNode
export function InboxRow(props: { icon: ReactNode; children: ReactNode; meta: ReactNode }): ReactNode
export function EnterItem(props: { id?: string; className?: string; index?: number; children: ReactNode }): ReactNode
export function ExpandPanel(props: { id?: string; label: string; open: boolean; children: ReactNode }): ReactNode

export function AdminPanel(props: { id?: string; title: string; count?: number; actions?: ReactNode; children: ReactNode; className?: string }): ReactNode
export function MemberIdentity(props: { name: string; handle: string; role: ReactNode; status: ReactNode }): ReactNode
export function IntegrationTile(props: { label: string; name: string; version?: ReactNode; icon: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; local?: boolean }): ReactNode
export function ChoiceCard(props: { name: string; description?: string; icon: ReactNode; selected: boolean; onSelect: () => void; buttonRef?: (node: HTMLButtonElement | null) => void }): ReactNode
export function AdminDetailHeading(props: { title: string; icon: ReactNode; action: ReactNode }): ReactNode
export function DeviceIdentity(props: { name: string; platform: string; status: ReactNode; seen: ReactNode; icon: ReactNode }): ReactNode

export function TimelineFold(props: {label:string; count?:number; open:boolean; present:boolean; onToggle:()=>void; children:ReactNode; id:string; className?:string; testId?:string}): ReactNode
export function ArtifactPreviewFrame(props: {title:string; action:ReactNode; children:ReactNode}): ReactNode
export function PairingSteps(props: {current:number}): ReactNode
export function ToolOutputFrame(props: {filters:ReactNode; meta:ReactNode; children:ReactNode}): ReactNode
export function FileCollectionMark(props: {count:number}): ReactNode
export function DepthSurface(props: {children:ReactNode}): ReactNode
