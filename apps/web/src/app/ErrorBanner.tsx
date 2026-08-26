/**
 * 通用错误横幅（mutation/查询失败可见反馈，02 Task 7 Step 6）。
 * 会话类失败（AUTH_REQUIRED/SESSION_EXPIRED）提供回登录入口；
 * 其余失败展示 Hub 的 message + requestId（requestId 缺失时省略）。
 */
import { isApiError, isSessionError } from '../shared/api/errors.js'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

export interface ErrorBannerProps {
  error: unknown
  /** 可选：给会话失效场景一个明确入口。 */
  reloginHref?: string
}

export function ErrorBanner({ error, reloginHref = '/login' }: ErrorBannerProps): ReactNode {
  const message = isApiError(error) ? error.message : '发生未知错误，请稍后重试'
  const requestId = isApiError(error) ? error.requestId : ''
  const sessionExpired = isSessionError(error)
  return (
    <div className="error-banner" role="alert">
      <p>
        {message}
        {requestId !== '' ? `（requestId: ${requestId}）` : ''}
      </p>
      {sessionExpired ? (
        <p>
          登录状态已失效，请 <Link to={reloginHref}>重新登录</Link>。
        </p>
      ) : null}
    </div>
  )
}
