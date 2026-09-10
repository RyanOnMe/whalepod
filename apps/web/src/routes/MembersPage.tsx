/**
 * 成员与邀请（#141）：从主导航「成员」进入。
 *
 * - GET /team/members 列成员（显示名/@用户名/角色/是否停用；#136 的协议 schema 钉死字段最小集，
 *   `data` 即数组），受邀加入的人在这一页看见自己进队；
 * - Owner/Admin 可在此生成一次性邀请链接（POST /invites，角色 member/admin），
 *   生成后**明文链接只在本次响应里出现一次**，页面必须把它完整显示出来并给一键复制，
 *   同时说清有效期（Hub 侧 72 小时）；
 * - Member 只读：不给表单，明说只有 Owner/Admin 能邀请（不伪造可点击的入口）；
 * - 复制失败如实报错，不伪造「已复制」（shared/CopyButton 统一行为）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { CreateInviteRequest, TeamMemberView } from '@whalepod/protocol'
import { api } from '../shared/api/client.js'
import { CopyButton } from '../shared/CopyButton.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { queryKeys } from '../app/query-client.js'
import { useSession } from '../app/session.js'
import { formatIso } from '../shared/format.js'
import { takeFlash } from '../shared/flash.js'
import type { Role } from '../shared/api/types.js'

/** Hub 侧 invite.expires_at 默认 72 小时（03 §2.1，apps/hub 的 INVITE_TTL_MS）。 */
const INVITE_TTL_MS = 72 * 60 * 60 * 1000

const ROLE_LABEL: Readonly<Record<Role, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
}

interface CreatedInviteView {
  inviteId: string
  token: string
  role: 'admin' | 'member'
  expiresAt: string
}

export function MembersPage(): ReactNode {
  const session = useSession()
  const queryClient = useQueryClient()
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [created, setCreated] = useState<CreatedInviteView | null>(null)
  // 加入成功的一次性提示（跳转回来时仍在同一标签页的 sessionStorage 里）。
  const [flash] = useState<string | null>(() => takeFlash())
  const canInvite = session !== null && (session.role === 'owner' || session.role === 'admin')

  const membersQuery = useQuery({
    queryKey: queryKeys.teamMembers,
    queryFn: () => api.get<TeamMemberView[]>('/team/members'),
  })

  const createInvite = useMutation({
    mutationFn: () => {
      const body: CreateInviteRequest = { role }
      return api.mutate<CreatedInviteView>('/invites', { body })
    },
    onSuccess: (invite) => {
      setCreated(invite)
    },
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (createInvite.isPending) return
    createInvite.reset()
    createInvite.mutate()
  }

  const inviteUrl = created === null ? null : `${window.location.origin}/invites/${created.token}`
  const members = membersQuery.data ?? []

  return (
    <div className="members-page">
      <h1>成员</h1>
      <p className="page-lead">
        把同事加进这个团队：生成一次性邀请链接发给他，他在浏览器里打开即可加入。
      </p>
      {flash !== null ? (
        <p className="success-banner" role="status">
          {flash}
        </p>
      ) : null}

      <section className="card" aria-labelledby="members-list-heading">
        <h2 id="members-list-heading">团队成员</h2>
        {membersQuery.isPending ? (
          <p className="mutation-hint">加载成员名单…</p>
        ) : membersQuery.isError ? (
          <ErrorBanner error={membersQuery.error} />
        ) : members.length === 0 ? (
          <p className="empty-state">还没有成员记录。</p>
        ) : (
          <ul className="member-list" role="list">
            {members.map((member) => (
              <li key={member.userId} className="member-item">
                <span className="member-name">{member.displayName}</span>
                <span className="member-handle">@{member.username}</span>
                <span className="badge">{ROLE_LABEL[member.role]}</span>
                {member.enabled ? null : (
                  <span className="badge badge-member-disabled">已停用</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card members-invite" aria-labelledby="members-invite-heading">
        <h2 id="members-invite-heading">邀请成员</h2>
        {canInvite ? (
          <>
            <p className="page-lead">
              选一个角色生成邀请链接。链接只能使用一次，72 小时后失效；生成后请立即复制发给他
              ——Token 只出现这一次。
            </p>
            <form className="inline-form" onSubmit={submit}>
              <div className="field">
                <label htmlFor="invite-role">角色</label>
                <select
                  id="invite-role"
                  value={role}
                  onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'member')}
                >
                  <option value="member">Member（普通成员）</option>
                  <option value="admin">Admin（可管理插件与邀请）</option>
                </select>
                <p className="field-hint">不能邀请 Owner：Owner 只能由初始化流程创建。</p>
              </div>
              <div className="form-actions">
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={createInvite.isPending}
                >
                  {createInvite.isPending ? '生成中…' : '生成邀请链接'}
                </button>
              </div>
            </form>
            {createInvite.isError ? <ErrorBanner error={createInvite.error} /> : null}
            {created !== null && inviteUrl !== null ? (
              <div className="invite-result">
                <h3>把这条链接发给他</h3>
                <p className="invite-link-row">
                  <code className="invite-link">{inviteUrl}</code>
                  <CopyButton
                    value={inviteUrl}
                    label={`复制邀请 ${created.role} 的链接`}
                    valueLabel="邀请链接"
                  >
                    复制链接
                  </CopyButton>
                </p>
                <dl className="revision-meta">
                  <div>
                    <dt>角色</dt>
                    <dd>{ROLE_LABEL[created.role]}</dd>
                  </div>
                  <div>
                    <dt>有效期至</dt>
                    <dd>
                      <time dateTime={created.expiresAt}>{formatIso(created.expiresAt)}</time>
                      <span className="field-hint">（72 小时）</span>
                    </dd>
                  </div>
                </dl>
                <p className="field-hint">
                  链接是一次性的：他加入成功后即失效；重复打开会提示「已被使用」，请重新生成。
                </p>
              </div>
            ) : null}
          </>
        ) : (
          <p className="empty-state">
            只有 Owner 或 Admin 能邀请成员。需要加人时，请联系团队 Owner 生成邀请链接。
          </p>
        )}
      </section>
    </div>
  )
}
