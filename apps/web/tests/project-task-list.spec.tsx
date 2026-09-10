/**
 * #137 项目任务列表（Web 面）：离开 Task Room 后真人能找回任务。
 *
 * 判据（Issue #137）：「建两个任务 → 返回项目页 → 列表看到两条 → 点第二条进 Task Room」。
 * 断言面：列表只呈现本项目任务（跨项目隔离由 Hub 保证，本 spec 只验 UI 不重排、不伪造）、
 * 责任人显示名走 #136 成员列表（不是短 UUID）、点击进入对应 Task Room。
 */
import { screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ProjectView } from '../src/shared/api/types.js'
import {
  ALICE,
  BOB,
  loggedInHandlers,
  makeTask,
  ok,
  projectsHandler,
  taskRoomHandler,
  teamMembersHandler,
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

  /**
   * #158 评审 B1：责任人从原生 `<select required>` 换成按钮触发器后，浏览器侧的
   * 「不选不放行」随 required 一起消失，提交按钮的空值守卫成了**唯一**拦截。
   * 这条用例钉住它：成员列表还没落地（拿不到默认责任人）时，表单不许发出
   * `assigneeUserId: ""` 的请求——那会被协议层 z.uuid() 拒成 400。
   */
  it('#158：责任人未定时提交按钮禁用（required 消失后的唯一拦截）', async () => {
    const handlers = [
      projectsHandler([PROJECT]),
      // 成员接口一直 pending（不 resolve）：模拟成员列表未落地。
      // 返回类型显式写成 Promise<never>，否则 TS 推成 unknown 过不了 MockHandler。
      {
        method: 'GET',
        url: /\/api\/v1\/team\/members$/,
        respond: (): Promise<never> => new Promise(() => {}),
      },
    ]
    const user = userEvent.setup()
    const view = renderApp('/', [...loggedInHandlers(ALICE, handlers)])
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await user.type(await screen.findByLabelText('任务标题'), '起草验收报告')

    const assignee = await screen.findByLabelText('责任人')
    expect(assignee).toHaveAttribute('id', `task-assignee-${PROJECT.id}`)
    expect(assignee.tagName).toBe('BUTTON') // #158 反面钉：这一处不再是原生 select
    expect(assignee).toBeDisabled() // 成员未落地 → 触发器禁用

    const submit = screen.getByRole('button', { name: /创建任务/ })
    expect(submit).toBeDisabled()
    await user.click(submit)
    // 没有发出任何创建请求（POST /projects/:id/tasks 一次都不该有）
    const posted = view.fetchMock.mock.calls.filter(([input, init]) => {
      const method = init?.method ?? 'GET'
      return method === 'POST' && String(input).endsWith(`/projects/${PROJECT.id}/tasks`)
    })
    expect(posted).toHaveLength(0)
  })
})
