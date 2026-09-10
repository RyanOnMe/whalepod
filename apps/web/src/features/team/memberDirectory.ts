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
import { useCallback } from 'react'
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
  /** userId → `显示名（@用户名）`；不在名录里给「未知成员」。 */
  nameOf: (userId: string) => string
}

export function useMemberDirectory(): MemberDirectory {
  const query = useQuery({
    queryKey: queryKeys.teamMembers,
    queryFn: () => api.get<TeamMemberView[]>('/team/members'),
  })
  const members = query.data ?? []
  const nameOf = useCallback((userId: string) => resolveMemberName(members, userId), [members])
  return { members, nameOf }
}
