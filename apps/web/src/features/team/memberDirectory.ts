/**
 * 成员名录（#152）：把 userId 解析成「显示名（@用户名）」的唯一入口。
 *
 * 起因（实测截图）：项目卡把 `shortId(project.createdBy)` 当创建者名，屏上写着
 * `by 01a08c11`——半截 UUID 既不是名字也不是可读标识。成员列表
 * （GET /team/members → **裸数组** `TeamMemberView[]`）是唯一权威来源；解析不到
 * 时给人话（「未知成员」），**不**退回短 UUID。
 *
 * 用同一 `queryKeys.teamMembers` 与「创建任务」的责任人下拉、成员页共享一份缓存：
 * 一次请求，多处解析（本 hook 被调用多次也只发一次 HTTP）。
 */
import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TeamMemberView } from '@whalepod/protocol'
import { api } from '../../shared/api/client.js'
import { queryKeys } from '../../app/query-client.js'

/**
 * 名录里查不到这个人时的呈现。成员可能已停用或被移除，姓名宁缺毋滥：给出
 * 一句人话，让人知道「这里本该有个名字，但我们认不出来」。
 */
export const UNKNOWN_MEMBER_LABEL = '未知成员'

/** 成员的展示名：`显示名（@用户名）`——显示名可能重名，用户名唯一，两个都给。 */
export function memberLabel(member: TeamMemberView): string {
  return `${member.displayName}（@${member.username}）`
}

/** 纯函数：名录 + userId → 展示文案（不在名录里给「未知成员」）。 */
export function resolveMemberName(members: readonly TeamMemberView[], userId: string): string {
  const member = members.find((candidate) => candidate.userId === userId)
  return member === undefined ? UNKNOWN_MEMBER_LABEL : memberLabel(member)
}

export interface MemberDirectory {
  members: TeamMemberView[]
  /** 名册首次加载中（表单用它区分「正在加载成员…」与「没有可选成员」）。 */
  isPending: boolean
  isError: boolean
  error: unknown
  /** userId → `显示名（@用户名）`；不在名录里给「未知成员」。 */
  nameOf: (userId: string) => string
}

export function useMemberDirectory(): MemberDirectory {
  const query = useQuery({
    queryKey: queryKeys.teamMembers,
    queryFn: () => api.get<TeamMemberView[]>('/team/members'),
    /**
     * 名册按「每次挂载都核对」处理（`staleTime: 0`）：成员会因为邀请/加入/停用而
     * 变化，而 Hub 目前**不**扇出成员事件（`shared/realtime/event-router` 的键表
     * 里没有 member.*），所以缓存里那份名册没有任何失效来源。默认 15s 的 staleTime
     * 会导致「刚加入的人在责任人下拉里缺席、任务列表把责任人显示成『未知成员』」
     * ——#152 的 p1-07 e2e 实测抓到（页面在 Bob 加入前已经取过一次名册）。
     * 名册是团队级小数据，重取的代价远小于把新人显示成陌生人。
     */
    staleTime: 0,
  })
  // query.data 未就绪时给稳定空数组：调用方的 useEffect 依赖不会每帧变化。
  const members = useMemo(() => query.data ?? [], [query.data])
  const nameOf = useCallback((userId: string) => resolveMemberName(members, userId), [members])
  return {
    members,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    nameOf,
  }
}
