/**
 * 登录（03 §4 POST /auth/login）：成功后 Hub 下发 Session Cookie，进入
 * Project 列表；INVALID_CREDENTIALS 展示统一错误文案。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { LoginRequest } from '@whalepod/protocol'
import { useNavigate } from 'react-router'
import { api } from '../shared/api/client.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { isApiError } from '../shared/api/errors.js'
import { queryKeys } from '../app/query-client.js'

export function LoginPage(): ReactNode {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
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
      navigate('/', { replace: true })
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
