/**
 * 任务级「谁能驱动 Agent」名单（切片⑥e；权限页）。
 *
 * 这里只做**一件事**：让协作的人看得见"谁在驱动这个任务"，并让**责任人**能授予/撤销。
 * 三条边界写死在界面与文案里（ADR-0009 决策 4 + ④ 片的红线）：
 *   ① 责任人**永远**可驱动，不是一条可撤销的授权；
 *   ② 审批决定权**不可授予**（审批仍只认 Run 的 owner，也就是责任人）；
 *   ③ 讨论区**不受授权影响**（任何成员都能评论，讨论永不触发运行）。
 *
 * 写路径只有责任人（服务端亦然：被授权成员不能自我复制、团队管理员也不行），所以非责任人
 * 看到的是**只读名单**——不是"按钮被禁用"，而是根本不呈现写入口，避免让人以为"点一下就行"。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { queryKeys } from '../../app/query-client.js'
import type { InstructionDriverView, TaskView } from '../../shared/api/types.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import { SelectMenu } from '../../shared/SelectMenu.js'

export interface InstructionDriversProps {
  task: TaskView
  sessionUserId: string
}

export function InstructionDrivers({ task, sessionUserId }: InstructionDriversProps): ReactNode {
  const queryClient = useQueryClient()
  const [grantee, setGrantee] = useState('')
  const [error, setError] = useState<unknown>(null)

  const driversQuery = useQuery({
    queryKey: queryKeys.instructionGrants(task.id),
    queryFn: () => api.get<InstructionDriverView[]>(`/tasks/${task.id}/instruction-grants`),
  })
  // 名册状态必须渲染出来（S3）：加载中/失败时下拉只剩"选择成员…"，那不是"团队里没人"，
  // 而是"名册没拿到"。用 `useMemberDirectory()` 暴露的状态，与其它表单同一口径。
  const directoryState = useMemberDirectory()

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.instructionGrants(task.id) })
  }

  const grant = useMutation({
    mutationFn: (userId: string) =>
      api.mutate<InstructionDriverView[]>(`/tasks/${task.id}/instruction-grants`, {
        body: { userId },
      }),
    onSuccess: () => {
      setGrantee('')
      setError(null)
      invalidate()
    },
    onError: setError,
  })

  const revoke = useMutation({
    mutationFn: (userId: string) =>
      api.remove<{ revoked: boolean }>(`/tasks/${task.id}/instruction-grants/${userId}`),
    onSuccess: () => {
      setError(null)
      invalidate()
    },
    onError: setError,
  })

  // 责任人判定：写路径只有他能用（服务端同样只认他）。
  const isAssignee = task.assigneeUserId === sessionUserId
  const drivers = driversQuery.data ?? []
  const grantedIds = new Set(drivers.map((driver) => driver.userId))
  const candidates = directoryState.members.filter(
    // 停用成员不进下拉（S2）：服务端不拦（只查 team_members 有没有这行），所以这里漏了就会
    // **真的落库**，名单上多一个永远登不进来的人——正是本文件要避免的"幽灵名单"。
    // 同仓先例：ProjectsPage 的责任人选择器同样过滤 `enabled`。
    (member) => member.enabled && !grantedIds.has(member.userId),
  )

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (grantee === '' || grant.isPending) return
    setError(null)
    grant.mutate(grantee)
  }

  return (
    <section className="card" aria-labelledby="drivers-heading">
      <h2 id="drivers-heading">谁能驱动这个任务的 Agent</h2>
      <p className="mutation-hint">
        执行区由<b>责任人</b>与<b>被授权成员</b>驱动；讨论区不受此名单影响，任何人都能评论。
      </p>

      {driversQuery.isPending ? <p className="mutation-hint">正在加载名单…</p> : null}
      {driversQuery.isError ? <ErrorBanner error={driversQuery.error} /> : null}

      {driversQuery.data === undefined ? null : (
        <ul className="driver-list" role="list">
          {drivers.map((driver) => (
            <li key={driver.userId} className="driver-item" data-testid="driver-item">
              <span className="driver-name">{directoryState.personOf(driver.userId)}</span>
              {driver.reason === 'assignee' ? (
                <span className="driver-reason" data-testid="driver-reason">
                  责任人 · 永远可驱动
                </span>
              ) : driver.reason === 'granted' ? (
                <span className="driver-reason" data-testid="driver-reason">
                  被授权
                  {driver.grantedAt === undefined ? null : (
                    <span className="mono">
                      {' '}
                      · 由 {directoryState.personOf(driver.grantedBy ?? '')} 于{' '}
                      {driver.grantedAt.slice(0, 10)}
                    </span>
                  )}
                </span>
              ) : (
                // 未知 reason **不**静默落进"被授权"（复核 O1 的 fail-open）：标注必须可追溯，
                // 服务端加了第三种 reason 时这里要说"未知"而不是替它编一个意思。
                <span className="driver-reason" data-testid="driver-reason">
                  未知来源（{String(driver.reason)}）——请联系维护者
                </span>
              )}
              {/* 授权行可撤销；责任人那一行**不给**撤销入口（他不是被授权者）。 */}
              {isAssignee && driver.reason === 'granted' ? (
                <button
                  type="button"
                  className="button driver-revoke"
                  data-testid="driver-revoke"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(driver.userId)}
                >
                  撤销
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {isAssignee ? (
        <form className="driver-grant" onSubmit={submit}>
          {/* 必须用 vendored SelectMenu：apps/web/src 全树**禁止原生 `<select>`**
              （#158 的判据，七处旧下拉已迁完）。我第一版写了原生 select，Q0 直接打红。 */}
          <SelectMenu
            id={`grantee-${task.id}`}
            label="授权给"
            value={grantee}
            placeholder="选择成员…"
            options={candidates.map((member) => ({
              value: member.userId,
              label: member.displayName,
              disabled: false,
            }))}
            onChange={setGrantee}
          />
          <button
            type="submit"
            className="button button-primary"
            disabled={grantee === '' || grant.isPending}
          >
            {grant.isPending ? '授权中…' : '授权'}
          </button>
        </form>
      ) : (
        <p className="mutation-hint" data-testid="drivers-readonly">
          只有责任人能改这份名单。你需要驱动这个任务时，请他把你加进来。
        </p>
      )}

      {error !== null ? <ErrorBanner error={error} /> : null}
      {/* 名册加载中/失败要显式说（不能只剩下拉里的"选择成员…"） */}
      {isAssignee && directoryState.isPending ? (
        <p className="mutation-hint" data-testid="drivers-members-loading">
          正在加载团队成员…
        </p>
      ) : null}
      {isAssignee && directoryState.isError ? <ErrorBanner error={directoryState.error} /> : null}

      {/* 两条不可让渡的边界（写出来，避免"既然能授权，那审批是不是也能代劳"的误解）。 */}
      <ul className="driver-redlines">
        <li>审批决定权不可授予：审批只认这条 Run 的责任人。</li>
        <li>执行永远用责任人的设备与凭据，被授权成员不是"换个人跑"。</li>
      </ul>
    </section>
  )
}
