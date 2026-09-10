/**
 * #137 项目任务列表（Web 面）：离开 Task Room 后真人能找回任务。
 *
 * 判据（Issue #137）：「建两个任务 → 返回项目页 → 列表看到两条 → 点第二条进 Task Room」。
 * 断言面：列表只呈现本项目任务（跨项目隔离由 Hub 保证，本 spec 只验 UI 不重排、不伪造）、
 * 责任人显示名走 #136 成员列表（不是短 UUID）、点击进入对应 Task Room。
 * #152 追加：项目卡的创建者同样走成员名录（不写截断 UUID），时间给相对文案。
 */
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ProjectView } from '../src/shared/api/types.js'
import {
  ALICE,
  BOB,
  loggedInHandlers,
  makeMember,
  makeTask,
  ok,
  projectsHandler,
  taskRoomHandler,
  teamMembersHandler,
  type MockHandler,
} from './fixtures.js'
import { renderApp } from './render.jsx'

const PROJECT: ProjectView = {
  id: '11111111-0000-4000-8000-000000000001',
  name: '潮汐观测站',
  description: '',
  createdBy: ALICE.userId,
  archivedAt: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}

describe('#137 项目任务列表', () => {
  it('展开后列出本项目任务：状态中文、责任人显示名、点击进入 Task Room', async () => {
    const first = makeTask({
      projectId: PROJECT.id,
      title: '起草验收报告',
      updatedAt: '2026-08-25T00:00:00.000Z',
    })
    const second = makeTask({
      projectId: PROJECT.id,
      title: '补 API 使用示例',
      status: 'in_review',
      assigneeUserId: ALICE.userId,
      updatedAt: '2026-08-26T00:00:00.000Z',
    })
    // 顺序由 Hub 保证（updatedAt DESC）——UI 不重排，按服务端给什么渲染什么
    const handlers = [
      projectsHandler([PROJECT]),
      teamMembersHandler(),
      {
        method: 'GET',
        url: new RegExp(`/api/v1/projects/${PROJECT.id}/tasks$`),
        respond: () => ok([second, first]),
      },
      taskRoomHandler(first),
      taskRoomHandler(second),
    ]
    const user = userEvent.setup()
    renderApp('/', [...loggedInHandlers(ALICE, handlers)])

    // 初始不加载列表：只有点了「任务列表」才发请求（不预取无关数据）
    expect(screen.queryByRole('list', { name: '项目任务列表' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: '任务列表' }))

    const list = await screen.findByRole('list', { name: '项目任务列表' })
    expect(list).toBeVisible()
    const items = screen.getAllByRole('listitem').filter((li) => li.className === 'task-list-item')
    expect(items).toHaveLength(2)
    // 服务端顺序原样呈现（第二条是最近更新的那条）
    expect(items[0]?.textContent).toContain('补 API 使用示例')
    expect(items[1]?.textContent).toContain('起草验收报告')
    // 状态用中文标签，责任人用成员显示名（#136），不出现裸 UUID
    expect(items[0]?.textContent).toContain('验收中')
    expect(items[0]?.textContent).toContain('Alice（@alice）')
    expect(items[1]?.textContent).toContain('未开始')
    expect(items[1]?.textContent).toContain('Bob（@bob）')
    expect(screen.queryByText(new RegExp(BOB.userId))).not.toBeInTheDocument()

    // 点第二条（起草验收报告）→ 进入该 Task 的 Task Room
    await user.click(screen.getByRole('button', { name: '起草验收报告' }))
    expect(await screen.findByRole('heading', { name: '起草验收报告' })).toBeVisible()
  })

  it('空项目：明确空态而不是空白或报错', async () => {
    const handlers = [
      projectsHandler([PROJECT]),
      teamMembersHandler(),
      {
        method: 'GET',
        url: new RegExp(`/api/v1/projects/${PROJECT.id}/tasks$`),
        respond: () => ok([]),
      },
    ]
    const user = userEvent.setup()
    renderApp('/', [...loggedInHandlers(ALICE, handlers)])
    await user.click(await screen.findByRole('button', { name: '任务列表' }))
    expect(await screen.findByText('这个项目还没有任务。')).toBeVisible()
  })
})

/**
 * #152 项目卡创建者姓名：实测截图里写着 `by 01a08c11`（截断 UUID 当人名）。
 * 判据：成员在册 → 「显示名（@用户名）」；不在册 → 一句人话「未知成员」；
 * 两种情况都不得出现截断 UUID。
 */
describe('#152 项目卡：创建者姓名解析', () => {
  it('创建者在册：显示「Alice（@alice）」，不出现截断 UUID', async () => {
    renderApp('/', loggedInHandlers(ALICE, [projectsHandler([PROJECT]), teamMembersHandler()]))
    const card = (await screen.findByText(PROJECT.name)).closest('li') as HTMLElement
    expect(within(card).getByText(/Alice（@alice）/)).toBeVisible()
    expect(card.textContent).not.toContain(ALICE.userId.slice(0, 8))
    expect(card.textContent).not.toContain(' by ')
  })

  it('创建者不在名录里：显示「未知成员」，不退回短 UUID', async () => {
    renderApp(
      '/',
      loggedInHandlers(ALICE, [
        projectsHandler([PROJECT]),
        // 名录里只有 Bob：创建者 Alice 查不到（例如已被移出团队）
        teamMembersHandler([makeMember({ ...BOB, role: 'member' })]),
      ]),
    )
    const card = (await screen.findByText(PROJECT.name)).closest('li') as HTMLElement
    expect(within(card).getByText(/未知成员/)).toBeVisible()
    expect(card.textContent).not.toContain(ALICE.userId.slice(0, 8))
  })

  it('创建时间给相对文案，title 保留绝对时刻', async () => {
    renderApp('/', loggedInHandlers(ALICE, [projectsHandler([PROJECT]), teamMembersHandler()]))
    const card = (await screen.findByText(PROJECT.name)).closest('li') as HTMLElement
    const time = card.querySelector('time')
    expect(time?.getAttribute('title')).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
    expect(time?.getAttribute('dateTime')).toBe(PROJECT.createdAt)
  })
})

/**
 * #152 名册新鲜度：项目卡现在会在页面挂载时就取名册（为了显示创建者姓名），
 * 若名册一直吃 15s 的 staleTime，就会在「刚有人加入」之后把新人显示成陌生人。
 * p1-07 真实 e2e 抓到的正是这一条：Alice 建项目时名册里只有她自己，Bob 加入后
 * 「创建任务」的责任人下拉里没有 Bob（`did not find some options`）。
 * 判据：挂载后名册变了 → 打开创建任务/展开任务列表时要重新核对名册。
 */
describe('#152 名册新鲜度：挂载后加入的成员必须出现在责任人相关界面', () => {
  /** 可变名册：respond 时按当前 members 返回，模拟「挂载后又有人加入」。 */
  function statefulMembers(initial: ReturnType<typeof makeMember>[]): {
    handler: MockHandler
    add: (member: ReturnType<typeof makeMember>) => void
    calls: () => number
  } {
    let members = [...initial]
    let calls = 0
    return {
      handler: {
        method: 'GET',
        url: /\/api\/v1\/team\/members$/,
        respond: () => {
          calls += 1
          return ok([...members])
        },
      },
      add: (member) => {
        members = [...members, member]
      },
      calls: () => calls,
    }
  }

  it('页面挂载后 Bob 才加入：责任人下拉里能看到 Bob（不是只吃缓存）', async () => {
    const membership = statefulMembers([makeMember()])
    const user = userEvent.setup()
    renderApp(
      '/',
      loggedInHandlers(ALICE, [
        projectsHandler([PROJECT]),
        membership.handler,
        {
          method: 'GET',
          url: new RegExp(`/api/v1/projects/${PROJECT.id}/tasks$`),
          respond: () => ok([]),
        },
      ]),
    )
    // 页面挂载完成：此刻服务端名册里只有 Alice（项目卡的创建者解析已取过一次）
    await screen.findByText(PROJECT.name)
    expect(membership.calls()).toBeGreaterThan(0)
    const callsAfterMount = membership.calls()

    // Bob 加入（服务端事实变化）
    membership.add(makeMember({ ...BOB, role: 'member' }))

    // 打开「创建任务」：责任人下拉必须重新核对名册
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    expect(await screen.findByRole('option', { name: /Bob（@bob）/ })).toBeVisible()
    expect(membership.calls()).toBeGreaterThan(callsAfterMount)
  })

  it('页面挂载后 Bob 才加入：任务列表的责任人显示名跟着刷新', async () => {
    const membership = statefulMembers([makeMember()])
    const task = makeTask({ projectId: PROJECT.id, title: '起草验收报告' })
    const user = userEvent.setup()
    renderApp(
      '/',
      loggedInHandlers(ALICE, [
        projectsHandler([PROJECT]),
        membership.handler,
        {
          method: 'GET',
          url: new RegExp(`/api/v1/projects/${PROJECT.id}/tasks$`),
          respond: () => ok([task]),
        },
      ]),
    )
    await screen.findByText(PROJECT.name)
    membership.add(makeMember({ ...BOB, role: 'member' }))
    await user.click(screen.getByRole('button', { name: '任务列表' }))
    const list = await screen.findByRole('list', { name: '项目任务列表' })
    await waitFor(() => {
      expect(list.textContent).toContain('责任人 Bob（@bob）')
    })
  })
})
