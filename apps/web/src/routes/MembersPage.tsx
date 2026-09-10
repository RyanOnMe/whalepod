/**
 * 成员与邀请（#141）：从主导航「成员」进入。
 *
 * - GET /team/members 列成员（显示名/@用户名/角色/是否停用；#136 的协议 schema 钉死字段最小集，
 *   `data` 即数组），受邀加入的人在这一页看见自己进队；
 * - 所有者/管理员可在此生成一次性邀请链接（POST /invites，角色 member/admin），
 *   生成后**明文链接只在本次响应里出现一次**，页面必须把它完整显示出来并给一键复制，
 *   同时说清有效期（Hub 侧 72 小时）；
 * - 成员只读：不给表单，明说只有所有者/管理员能邀请（不伪造可点击的入口）；
 *
 * #152：角色文案统一走 format.ts 的 ROLE_LABEL（徽标、下拉、复制按钮同一套措辞），
 * 页内不再自己写一份英文枚举标签。
 * - 复制失败如实报错，不伪造「已复制」（shared/CopyButton 统一行为）。
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { CreateInviteRequest, TeamMemberView } from '@whalepod/protocol'
import { api } from '../shared/api/client.js'
import { CopyButton } from '../shared/CopyButton.js'
import { SelectMenu } from '../shared/SelectMenu.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { queryKeys } from '../app/query-client.js'
import { useSession } from '../app/session.js'
import { RelativeTime } from '../shared/RelativeTime.js'
import { ROLE_LABEL } from '../shared/format.js'
import { takeFlash } from '../shared/flash.js'

interface CreatedInviteView {
  inviteId: string
  token: string
  role: 'admin' | 'member'
  expiresAt: string
}

export function MembersPage(): ReactNode {
  const session = useSession()
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

      <div className="page-grid">
        <div className="page-col">
          <section className="card" aria-labelledby="members-list-heading">
            <h2 id="members-list-heading">团队成员</h2>
            {membersQuery.isPending ? (
              <p className="mutation-hint">正在加载成员名单…</p>
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
        </div>

        {/* #152：宽屏把邀请面板放到侧列（原来挤在名单下方，右侧半屏空着）。 */}
        <div className="page-col">
          <section className="card members-invite" aria-labelledby="members-invite-heading">
            <h2 id="members-invite-heading">邀请成员</h2>
            {canInvite ? (
              <>
                <p className="page-lead">
                  选一个角色生成邀请链接。链接只能使用一次，72
                  小时后失效；生成后请立即复制发给他——Token 只出现这一次。
                </p>
                <form className="inline-form" onSubmit={submit}>
                  <div className="field">
                    {/* #158：角色选择从原生 <select> 换成 vendored Menu 的包装
                        （shared/SelectMenu）。id 仍是 #invite-role，可访问名仍是
                        「角色」——名字不变，承载元素从 select 变成 button。 */}
                    <SelectMenu
                      id="invite-role"
                      label="角色"
                      value={role}
                      options={[
                        { value: 'member', label: '成员', disabled: false },
                        {
                          value: 'admin',
                          label: '管理员（可管理插件与邀请）',
                          disabled: false,
                        },
                      ]}
                      onChange={(next) => {
                        setRole(next === 'admin' ? 'admin' : 'member')
                      }}
                    />
                    <p className="field-hint">不能邀请所有者：所有者只能由初始化流程创建。</p>
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
                        label={`复制${ROLE_LABEL[created.role]}邀请链接`}
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
                          <RelativeTime iso={created.expiresAt} />
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
                只有所有者或管理员能邀请成员。需要加人时，请联系团队所有者生成邀请链接。
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
