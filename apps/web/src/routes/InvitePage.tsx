/**
 * 接受邀请（#141）：路由 `/invites/:token`。
 *
 * 被邀请人的两条腿（Issue 验收面 B）：
 * - **已登录**：显示「<团队名> 邀请你以 <角色> 加入」+「加入团队」按钮，
 *   一键 POST /invites/:token/accept（不建账号、不换 Session），成功后回项目页；
 * - **未登录**：先把「加入哪个团队、什么角色、什么时候过期」说清楚，再引导登录，
 *   或（本实例还没初始化时）去 /setup 初始化并建号——登录成功后回到本页完成加入。
 *
 * 失效链接三态都给人话，不显示裸错误码（404 NOT_FOUND / 409 CONFLICT 由预检
 * 的 details 区分「已过期」「已被使用」）；页面上不放 Token 本身之外的敏感信息，
 * URL 里的 Token 也只在页面内部用于请求。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { AcceptInviteRequest, LoginRequest } from '@whalepod/protocol'
import { Link, useNavigate, useParams, useRevalidator } from 'react-router'
import { api } from '../shared/api/client.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { isApiError } from '../shared/api/errors.js'
import { queryKeys } from '../app/query-client.js'
import { formatIso } from '../shared/format.js'
import { setFlash } from '../shared/flash.js'
import type { AcceptInviteAsMemberView, InviteDetailsView, Session } from '../shared/api/types.js'

const ROLE_LABEL: Readonly<Record<'admin' | 'member', string>> = {
  admin: 'Admin',
  member: 'Member',
}

/**
 * 失效链接的人话。优先用预检失败时 Hub 给的 details（能区分过期/已用），
 * 拿不到就按状态码给出最贴近的通用说明——**任何情况下都不把错误码丢给用户**。
 */
function failureText(error: unknown): string {
  if (isApiError(error)) {
    const details = error.details
    if (typeof details === 'object' && details !== null) {
      const flags = details as { expired?: unknown; consumed?: unknown }
      if (flags.expired === true) {
        return '这条邀请链接已经过期了。请让邀请你的人重新生成一条。'
      }
      if (flags.consumed === true) {
        return '这条邀请链接已经被使用过了。邀请是一次性的，请让邀请你的人重新生成一条。'
      }
    }
    if (error.code === 'NOT_FOUND') {
      return '这条邀请链接无效：它可能被复制时缺了字符，或者已经被作废。请让邀请你的人重新发一条。'
    }
    if (error.code === 'CONFLICT') {
      return '这条邀请链接已经失效（用过或过期）。请让邀请你的人重新生成一条。'
    }
    return `暂时无法确认这条邀请：${error.message}`
  }
  return '暂时无法确认这条邀请，请稍后重试。'
}

export interface InvitePageProps {
  /** root 引导 loader 得到的会话；未登录为 null（页面内引导登录，不跳走）。 */
  session: Session | null
  /** 实例是否已初始化：未初始化时建号入口在 /setup（那里才会创建 Team 与 Owner）。 */
  initialized: boolean
}

export function InvitePage({ session, initialized }: InvitePageProps): ReactNode {
  const { token = '' } = useParams()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // 加入成功的**当场**确认（跳到项目页之前这一帧里一定可见）；跨路由的落地横幅另走
  // shared/flash——那条是尽力而为（读取即清除），不能作为唯一的人可见确认。
  const [joined, setJoined] = useState<string | null>(null)

  const inviteQuery = useQuery({
    queryKey: queryKeys.invite(token),
    queryFn: () => api.get<InviteDetailsView>(`/invites/${encodeURIComponent(token)}`),
  })

  const accept = useMutation({
    mutationFn: () =>
      api.mutate<AcceptInviteAsMemberView>(`/invites/${encodeURIComponent(token)}/accept`),
    onSuccess: (result) => {
      // 成员名单与预检状态都变了：让下一次读取拿到真实值（不缓存过期名单）。
      void queryClient.invalidateQueries({ queryKey: queryKeys.teamMembers })
      void queryClient.invalidateQueries({ queryKey: queryKeys.invite(token) })
      const message = result.joined
        ? `已加入 ${result.teamName}`
        : `你已经在 ${result.teamName} 里了`
      setJoined(message)
      setFlash(message)
      navigate('/', { replace: true })
    },
  })

  const invite = inviteQuery.data

  return (
    <div className="auth-page">
      <div className="card auth-card invite-card">
        <h1>加入团队</h1>
        {joined !== null ? (
          <p className="success-banner" role="status">
            {joined}
          </p>
        ) : null}
        {inviteQuery.isPending ? <p className="mutation-hint">正在确认邀请…</p> : null}
        {inviteQuery.isError ? (
          <div className="error-banner" role="alert">
            <p>{failureText(inviteQuery.error)}</p>
            <p>
              已经在团队里了？<Link to="/login">去登录</Link>
              ，或让 Owner 在「成员」页重新生成一条邀请。
            </p>
          </div>
        ) : null}
        {invite !== undefined ? (
          <>
            <p className="page-lead" role="status">
              团队「{invite.teamName}」邀请你以 {ROLE_LABEL[invite.role]} 身份加入。链接有效期至{' '}
              <time dateTime={invite.expiresAt}>{formatIso(invite.expiresAt)}</time>。
            </p>
            {session === null ? (
              initialized ? (
                <InviteAuthPanel token={token} teamName={invite.teamName} />
              ) : (
                <div className="empty-state">
                  <p>这个 Hub 还没有初始化：先创建团队与 Owner 账号，再回来使用这条邀请。</p>
                  <p>
                    <Link to="/setup">去初始化团队</Link>
                  </p>
                </div>
              )
            ) : (
              <>
                <p className="field-hint">
                  你将以 {session.displayName}（@{session.username}）的身份加入。
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={accept.isPending}
                    onClick={() => {
                      accept.mutate()
                    }}
                  >
                    {accept.isPending ? '加入中…' : '加入团队'}
                  </button>
                </div>
              </>
            )}
            {accept.isError ? <ErrorBanner error={accept.error} /> : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 未登录时的两条腿（同一张卡，两个动作，不藏）：
 * - **建号加入**（默认）：被邀请人通常还没有账号，这里直接把账号建出来并加入
 *   （POST /invites/accept，token 来自链接，Session Cookie 由 Hub 下发）；
 * - **已有账号**：先登录，登录成功后清掉 session 缓存并 revalidate 路由 loader
 *   （root 引导 loader 会用新 Cookie 重取会话），页面随即换成「加入团队」按钮——
 *   加入是明确动作，不自动替他点（也避免用户在不知情的情况下进队）。
 */
function InviteAuthPanel({ token, teamName }: { token: string; teamName: string }): ReactNode {
  const [mode, setMode] = useState<'create' | 'login'>('create')
  return mode === 'create' ? (
    <InviteCreateAccountForm token={token} teamName={teamName} onSwitch={() => setMode('login')} />
  ) : (
    <InviteLoginForm onSwitch={() => setMode('create')} />
  )
}

/** 建号并加入：字段与 protocol 的 AcceptInviteRequestSchema 对齐。 */
function InviteCreateAccountForm({
  token,
  teamName,
  onSwitch,
}: {
  token: string
  teamName: string
  onSwitch: () => void
}): ReactNode {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [values, setValues] = useState({ username: '', displayName: '', password: '' })
  const [error, setError] = useState<unknown>(null)
  const [joined, setJoined] = useState(false)

  const acceptAnonymously = useMutation({
    mutationFn: () => {
      const body: AcceptInviteRequest = {
        token,
        username: values.username.trim(),
        displayName: values.displayName.trim(),
        password: values.password,
      }
      return api.mutate<{ userId: string; role: 'admin' | 'member' }>('/invites/accept', { body })
    },
    onSuccess: () => {
      // 建号即加入。Hub 的匿名接受响应不带团队名，用预检读到的团队名提示；
      // 会话缓存**先清掉再导航**：落地页的 root loader 会按新 Cookie 重取会话，
      // 否则会读到引导时缓存的 401 而把刚加入的人弹回登录页。
      void queryClient.invalidateQueries({ queryKey: queryKeys.teamMembers })
      setJoined(true)
      setFlash(`已加入 ${teamName}`)
      queryClient.removeQueries({ queryKey: queryKeys.session })
      navigate('/', { replace: true })
    },
    onError: (acceptError: unknown) => {
      setError(acceptError)
    },
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (acceptAnonymously.isPending) return
    setError(null)
    acceptAnonymously.mutate()
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      {joined ? (
        <p className="success-banner" role="status">
          已加入 {teamName}
        </p>
      ) : null}
      <p className="field-hint">填一个用户名和密码，加入的同时就把账号建好（密码至少 12 位）。</p>
      <div className="field">
        <label htmlFor="invite-signup-username">用户名</label>
        <input
          id="invite-signup-username"
          autoComplete="username"
          value={values.username}
          onChange={(event) => setValues((prev) => ({ ...prev, username: event.target.value }))}
          required
          pattern="[a-z0-9][a-z0-9._-]{2,31}"
          title="3–32 位，小写字母/数字开头，可含 . _ -"
        />
      </div>
      <div className="field">
        <label htmlFor="invite-signup-display-name">显示名</label>
        <input
          id="invite-signup-display-name"
          value={values.displayName}
          onChange={(event) => setValues((prev) => ({ ...prev, displayName: event.target.value }))}
          required
          maxLength={80}
        />
      </div>
      <div className="field">
        <label htmlFor="invite-signup-password">密码</label>
        <input
          id="invite-signup-password"
          type="password"
          autoComplete="new-password"
          value={values.password}
          onChange={(event) => setValues((prev) => ({ ...prev, password: event.target.value }))}
          required
          minLength={12}
        />
        <p className="field-hint">至少 12 位（与 Setup 同一口令政策）。</p>
      </div>
      <div className="form-actions">
        <button
          type="submit"
          className="button button-primary"
          disabled={acceptAnonymously.isPending}
        >
          {acceptAnonymously.isPending ? '加入中…' : '创建账号并加入'}
        </button>
        <button type="button" className="button button-quiet" onClick={onSwitch}>
          我已有账号
        </button>
      </div>
      {error !== null ? <ErrorBanner error={error} /> : null}
    </form>
  )
}

function InviteLoginForm({ onSwitch }: { onSwitch: () => void }): ReactNode {
  const queryClient = useQueryClient()
  const revalidator = useRevalidator()
  const [values, setValues] = useState({ username: '', password: '' })
  const [error, setError] = useState<unknown>(null)

  const login = useMutation({
    mutationFn: () => {
      const body: LoginRequest = { username: values.username.trim(), password: values.password }
      return api.mutate<{ userId: string }>('/auth/login', { body })
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.session })
      revalidator.revalidate()
    },
    onError: (loginError: unknown) => {
      setError(loginError)
    },
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (login.isPending) return
    setError(null)
    login.mutate()
  }

  const loginErrorText =
    isApiError(error) && error.code === 'INVALID_CREDENTIALS' ? '用户名或密码不正确' : null

  return (
    <form className="inline-form" onSubmit={submit}>
      <p className="field-hint">已有账号就用它登录，登录后回到本页加入团队。</p>
      <div className="field">
        <label htmlFor="invite-login-username">用户名</label>
        <input
          id="invite-login-username"
          autoComplete="username"
          value={values.username}
          onChange={(event) => setValues((prev) => ({ ...prev, username: event.target.value }))}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="invite-login-password">密码</label>
        <input
          id="invite-login-password"
          type="password"
          autoComplete="current-password"
          value={values.password}
          onChange={(event) => setValues((prev) => ({ ...prev, password: event.target.value }))}
          required
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={login.isPending}>
          {login.isPending ? '登录中…' : '登录并继续'}
        </button>
        <button type="button" className="button button-quiet" onClick={onSwitch}>
          我没有账号
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
  )
}
