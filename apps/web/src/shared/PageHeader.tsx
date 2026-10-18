import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { WorkspaceIcon } from './WorkspaceIcon.js'

export function PageHeader({
  title,
  id,
  description,
  actions,
  back,
}: {
  title: ReactNode
  id?: string
  description?: ReactNode
  actions?: ReactNode
  back?: { to: string; label: string }
}) {
  return (
    <header className="page-header">
      <div className="page-header-identity">
        {back ? (
          <Link className="icon-button" to={back.to} aria-label={back.label} title={back.label}>
            <WorkspaceIcon name="返回" />
          </Link>
        ) : null}
        <div className="page-header-titles">
          <h1 id={id}>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  )
}
