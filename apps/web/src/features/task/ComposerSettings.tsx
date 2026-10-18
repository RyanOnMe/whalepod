import type { ReactNode } from 'react'
import { DisclosurePanel } from '../../shared/DisclosurePanel.js'
import { WorkspaceIcon } from '../../shared/WorkspaceIcon.js'

export interface SettingsDisclosure {
  open: boolean
  onChange: (open: boolean) => void
}

export function ComposerSettings({
  children,
  disclosure,
  disabled = false,
}: {
  children: ReactNode
  disclosure?: SettingsDisclosure
  disabled?: boolean
}) {
  return (
    <DisclosurePanel
      label="执行设置"
      icon={<WorkspaceIcon name="设置" />}
      className="execution-settings"
      portal
      contentLabel="执行参数"
      disabled={disabled}
      {...(disclosure === undefined
        ? {}
        : { open: disclosure.open, onOpenChange: disclosure.onChange })}
    >
      <h3>执行设置</h3>
      {children}
    </DisclosurePanel>
  )
}
