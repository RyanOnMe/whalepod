/**
 * #152 成员名录解析（unit project：纯函数）。
 *
 * 判据来自实测截图：项目卡写着 `by 01a08c11`——截断 UUID 被当成人名。名录里有就
 * 给「显示名（@用户名）」，名录里没有就给一句人话「未知成员」，**任何情况下都不
 * 退回短 UUID**（半截 UUID 既不是名字，用户也无从对照）。
 */
import { describe, expect, it } from 'vitest'
import type { TeamMemberView } from '@whalepod/protocol'
import {
  UNKNOWN_MEMBER_LABEL,
  memberLabel,
  resolveMemberName,
} from '../src/features/team/memberDirectory.js'
import { ALICE, BOB, makeMember } from './fixtures.js'

describe('#152 成员姓名解析', () => {
  it('成员在册：显示名（@用户名）', () => {
    const members = [makeMember(), makeMember({ ...BOB, role: 'member' })]
    expect(resolveMemberName(members, ALICE.userId)).toBe('Alice（@alice）')
    expect(resolveMemberName(members, BOB.userId)).toBe('Bob（@bob）')
  })

  it('成员不在册：给人话「未知成员」，不退回短 UUID', () => {
    const members = [makeMember()]
    const stranger = '99999999-0000-4000-8000-000000000009'
    const name = resolveMemberName(members, stranger)
    expect(name).toBe(UNKNOWN_MEMBER_LABEL)
    expect(name).not.toContain(stranger.slice(0, 8))
    expect(name).not.toMatch(/[0-9a-f]{8}/)
  })

  it('空名录也不崩：任何 userId 都得到同一句人话', () => {
    expect(resolveMemberName([], ALICE.userId)).toBe(UNKNOWN_MEMBER_LABEL)
    expect(resolveMemberName([], '')).toBe(UNKNOWN_MEMBER_LABEL)
  })

  it('已停用成员仍有名字：停用只挡选择器，不该把姓名一起抹掉', () => {
    const disabled: TeamMemberView = makeMember({ enabled: false })
    expect(resolveMemberName([disabled], ALICE.userId)).toBe('Alice（@alice）')
  })

  it('显示名重名时靠 @用户名 区分（标签同时给两个）', () => {
    const members = [
      makeMember({ userId: 'id-1', displayName: '张伟', username: 'zhangwei' }),
      makeMember({ userId: 'id-2', displayName: '张伟', username: 'zhangwei2' }),
    ]
    expect(resolveMemberName(members, 'id-1')).toBe('张伟（@zhangwei）')
    expect(resolveMemberName(members, 'id-2')).toBe('张伟（@zhangwei2）')
  })

  it('memberLabel 就是「显示名（@用户名）」的组合，解析走同一实现', () => {
    const member = makeMember({ displayName: 'Carol', username: 'carol' })
    expect(memberLabel(member)).toBe('Carol（@carol）')
    expect(resolveMemberName([member], member.userId)).toBe(memberLabel(member))
  })
})
