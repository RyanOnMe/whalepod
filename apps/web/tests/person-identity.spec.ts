/**
 * #162 判据内核的红→绿基线。
 *
 * 这些用例里的「旧文本」不是编的：它们逐字取自本 Issue 记录的改动前实现
 * （`git show 26fa7e1:apps/web/src/features/task/AssignmentPanel.tsx` 等），
 * userId 用 fixtures.ts 的真实取值——`shortId()` 就是取前 8 字符，所以
 * `aaaaaaaa-0000-…` 的短 id 是 `aaaaaaaa`、`bbbbbbbb-…` 是 `bbbbbbbb`。
 *
 * 判据的**正向证据**（旧文本判红）与**反向证据**（新文案判绿）都在这里；
 * 浏览器层面的同一判据由 e2e（e2e/task-room.spec.ts）执行。
 */
import { describe, expect, it } from 'vitest'
import {
  FORMER_MEMBER_LABEL,
  UNKNOWN_MEMBER_LABEL,
  memberLabel,
} from '../src/features/team/memberDirectory.js'
import { ALICE, BOB, makeMember } from './fixtures.js'
import {
  FALLBACK_LABELS,
  PERSON_SLOTS,
  VIEWPOINT_LABELS,
  personRosterFromMembers,
  personSlotProblems,
  personSlotVerdict,
} from './person-identity.js'

const ALICE_MEMBER = makeMember({
  userId: ALICE.userId,
  username: 'alice-1a2b3c4d',
  displayName: 'Alice',
})
const BOB_MEMBER = makeMember({
  userId: BOB.userId,
  username: 'bob-1a2b3c4d',
  displayName: 'Bob',
})
const ROSTER = personRosterFromMembers([ALICE_MEMBER, BOB_MEMBER])

/** 直接照 shortId 的语义取短 id（前 8 字符），不在测试里另写一份实现。 */
const short = (id: string): string => id.slice(0, 8)
const BOB_SHORT = short(BOB.userId)
const ALICE_SHORT = short(ALICE.userId)

describe('#162 判据内核：指人的位置不得出现短 id', () => {
  it('改动前的四处文本全部判红，并指出是哪个 id、期望什么', () => {
    // 改动前（26fa7e1）逐字文本：TaskHeader:57 / AssignmentPanel:90 / CommentComposer:30。
    const legacy = [
      ['顶部「当前责任人」的值', BOB_SHORT, BOB_SHORT],
      ['任务分配说明里的责任人', `此任务分配给 ${BOB_SHORT}，等待其接受。`, BOB_SHORT],
      ['留言作者', ALICE_SHORT, ALICE_SHORT],
    ] as const
    for (const [what, text, expectedId] of legacy) {
      const verdict = personSlotVerdict(text, ROSTER)
      expect(verdict, `旧文本「${text}」必须判红（${what}）`).not.toBeNull()
      // 失败信息要能自己定位：说清实测文本、是哪个 id、期望什么。
      expect(verdict).toContain(`「${expectedId}」`)
      expect(verdict).toContain('期望成员显示名')
      expect(verdict).toContain(UNKNOWN_MEMBER_LABEL)
    }
  })

  it('改动后的文本全部判绿（显示名、视角词、兜底文案）', () => {
    const current = [
      memberLabel(BOB_MEMBER),
      '你',
      `此任务分配给 ${memberLabel(BOB_MEMBER)}，等待其接受。`,
      FORMER_MEMBER_LABEL,
    ]
    for (const text of current) {
      expect(personSlotVerdict(text, ROSTER), `新文本「${text}」不该判红`).toBeNull()
    }
  })

  it('名册未落定（「未知成员」）判红：判定不了就不算通过（fail-closed）', () => {
    // 「未知成员」是首帧/名册取失败时的兜底；此时这一格该写谁无从核对。
    // 它**不是**「人已离开」——后者呈现为「已离开的成员」，判绿（上一例）。
    const verdict = personSlotVerdict(UNKNOWN_MEMBER_LABEL, ROSTER)
    expect(verdict).toContain('名册未落定')
    expect(
      personSlotVerdict(`此任务分配给 ${UNKNOWN_MEMBER_LABEL}，等待其接受。`, ROSTER),
    ).toContain('名册未落定')
  })

  it('槽位没匹配到任何元素也是问题：空样本不得当通过（内核自带，不靠调用方纪律）', () => {
    const problems = personSlotProblems([{ slot: PERSON_SLOTS.assignee, texts: [] }], ROSTER)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('判据没覆盖到任何元素')
    expect(problems[0]).toContain('[data-testid="task-assignee"]')
  })

  it('假红守门：用户名里的 8 位十六进制 tag 不算泄漏', () => {
    // e2e 自己的用户名带 8 位随机 tag（`bob-1a2b3c4d`）：合法标识，不能判红。
    expect(personSlotVerdict('Bob（@bob-1a2b3c4d）', ROSTER)).toBeNull()
    expect(personSlotVerdict('@bob-1a2b3c4d', ROSTER)).toBeNull()
    expect(personSlotVerdict('bob-1a2b3c4d', ROSTER)).toBeNull()
    // 反面：短 id 与合法用户名拼在一起时，短 id 仍要被抓出来（不是「含用户名就放过」）。
    expect(personSlotVerdict('Bob（@bob-1a2b3c4d） 01a08c11', ROSTER)).toContain('01a08c11')
  })

  it('没人名也没兜底文案的位置判红（防止把 id 换成一串别的机器话）', () => {
    expect(personSlotVerdict('—', ROSTER)).toContain('没能说出「是谁」')
  })

  it('兜底文案白名单与产品常量一致（改了产品文案而没改判据，这里必须红）', () => {
    expect([...FALLBACK_LABELS]).toEqual([UNKNOWN_MEMBER_LABEL, FORMER_MEMBER_LABEL])
    expect([...VIEWPOINT_LABELS]).toEqual(['你'])
  })

  it('批量判定一次列出全部问题，并带上槽位描述（能自己定位失败）', () => {
    const problems = personSlotProblems(
      [
        { slot: PERSON_SLOTS.assignee, texts: ['你', ALICE_SHORT] },
        { slot: PERSON_SLOTS.commentAuthor, texts: [BOB_SHORT] },
      ],
      ROSTER,
    )
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('顶部「当前责任人」的值')
    expect(problems[0]).toContain('[data-testid="task-assignee"] 第 2 个')
    expect(problems[0]).toContain(ALICE_SHORT)
    expect(problems[1]).toContain('留言作者')
    expect(problems[1]).toContain(BOB_SHORT)
  })

  it('名册为空时「已离开的成员」仍判绿（人不在册是人话兜底，不是判定不了）', () => {
    expect(personSlotVerdict(FORMER_MEMBER_LABEL, personRosterFromMembers([]))).toBeNull()
  })
})
