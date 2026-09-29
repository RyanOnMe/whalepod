/**
 * 登录（03 §4 POST /auth/login）：成功后 Hub 下发 Session Cookie，进入
 * Project 列表；INVALID_CREDENTIALS 展示统一错误文案。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { LoginRequest } from '@whalepod/protocol'
import { useNavigate, useSearchParams } from 'react-router'
import { api } from '../shared/api/client.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { FlashBanner } from '../app/FlashBanner.js'
import { isApiError } from '../shared/api/errors.js'
import { queryKeys } from '../app/query-client.js'

/**
 * #227：from 只认站内路径（以 / 开头且不以 // 开头），其余一律回落首页——
 * 登录回跳不能变成开放重定向。
 */
export function safeRedirectFrom(from: string | null): string {
  if (from !== null && from.startsWith('/') && !from.startsWith('//')) return from
  return '/'
}

export function LoginPage(): ReactNode {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const [values, setValues] = useState({ username: '', password: '' })
  const [error, setError] = useState<unknown>(null)

  const mutation = useMutation({
    mutationFn: () => {
      const body: LoginRequest = { username: values.username.trim(), password: values.password }
      return api.mutate<{ userId: string }>('/auth/login', { body })
    },
    onSuccess: () => {
      // 清掉可能残留的会话缓存，让 root loader 用真实会话重新引导
      // （fetchQuery 对 staleTime 内的缓存不重新请求）。
      queryClient.removeQueries({ queryKey: queryKeys.session })
      // #227：session 过期被送来时带 from，登录后回原路径。
      navigate(safeRedirectFrom(searchParams.get('from')), { replace: true })
    },
    onError: (mutationError: unknown) => {
      setError(mutationError)
    },
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (mutation.isPending) return
    setError(null)
    mutation.mutate()
  }

  const set =
    (field: keyof typeof values) =>
    (value: string): void => {
      setValues((prev) => ({ ...prev, [field]: value }))
    }

  const loginErrorText =
    isApiError(error) && error.code === 'INVALID_CREDENTIALS' ? '用户名或密码不正确' : null

  return (
    <div className="auth-page">
      {/* #227：session 过期自动跳来时，一次性提示挂在这里（登录页不在 AppShell 内）。 */}
      <FlashBanner />
      <form className="card auth-card" onSubmit={submit}>
        <h1>登录</h1>
        <p className="page-lead">登录后进入团队项目列表。</p>
        <div className="field">
          <label htmlFor="login-username">用户名</label>
          <input
            id="login-username"
            autoComplete="username"
            value={values.username}
            onChange={(event) => set('username')(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">密码</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={values.password}
            onChange={(event) => set('password')(event.target.value)}
            required
          />
        </div>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={mutation.isPending}>
            {mutation.isPending ? '登录中…' : '登录'}
          </button>
        </div>
        {error !== null ? (
          loginErrorText !== null ? (
            <p className="error-banner" role="alert">
              {loginErrorText}
            </p>
          ) : (
            <ErrorBanner error={error} />
          )
        ) : null}
      </form>
    </div>
  )
}
