/**
 * 首次初始化（02 Task 7 Step 3 / 03 §4 POST /setup）：
 * Setup Token + Team 名称 + Owner 账号。成功后 Hub 下发 Session Cookie，
 * 直接进入 Project 列表；失败展示 requestId。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { SetupRequest } from '@project311/protocol'
import { useNavigate } from 'react-router'
import { api } from '../shared/api/client.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { queryKeys } from '../app/query-client.js'

interface SetupSuccess {
  teamId: string
  userId: string
}

export function SetupPage(): ReactNode {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [values, setValues] = useState({
    setupToken: '',
    teamName: '',
    username: '',
    displayName: '',
    password: '',
  })
  const [error, setError] = useState<unknown>(null)

  const mutation = useMutation({
    mutationFn: () => {
      const body: SetupRequest = {
        setupToken: values.setupToken.trim(),
        teamName: values.teamName.trim(),
        username: values.username.trim(),
        displayName: values.displayName.trim(),
        password: values.password,
      }
      return api.mutate<SetupSuccess>('/setup', { body })
    },
    onSuccess: () => {
      // setup 完成会翻转 /setup/status；这里清掉 setup-status 缓存
      // （loader 以 staleTime: Infinity 缓存），否则 root loader 会读到旧的
      // initialized=false 并弹回 /setup。
      queryClient.removeQueries({ queryKey: queryKeys.setupStatus })
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

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <h1>初始化团队</h1>
        <p className="page-lead">第一次访问：用 Setup Token 创建团队与 Owner 账号。</p>
        <div className="field">
          <label htmlFor="setup-token">Setup Token</label>
          <input
            id="setup-token"
            type="password"
            autoComplete="off"
            value={values.setupToken}
            onChange={(event) => set('setupToken')(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="team-name">团队名称</label>
          <input
            id="team-name"
            value={values.teamName}
            onChange={(event) => set('teamName')(event.target.value)}
            required
            maxLength={80}
          />
        </div>
        <div className="field">
          <label htmlFor="setup-username">用户名</label>
          <input
            id="setup-username"
            value={values.username}
            onChange={(event) => set('username')(event.target.value)}
            required
            pattern="[a-z0-9][a-z0-9._-]{2,31}"
            title="3–32 位，小写字母/数字开头，可含 . _ -"
          />
        </div>
        <div className="field">
          <label htmlFor="setup-display-name">显示名</label>
          <input
            id="setup-display-name"
            value={values.displayName}
            onChange={(event) => set('displayName')(event.target.value)}
            required
            maxLength={80}
          />
        </div>
        <div className="field">
          <label htmlFor="setup-password">密码</label>
          <input
            id="setup-password"
            type="password"
            autoComplete="new-password"
            value={values.password}
            onChange={(event) => set('password')(event.target.value)}
            required
          />
        </div>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={mutation.isPending}>
            {mutation.isPending ? '创建中…' : '创建团队'}
          </button>
        </div>
        {error !== null ? <ErrorBanner error={error} /> : null}
      </form>
    </div>
  )
}
