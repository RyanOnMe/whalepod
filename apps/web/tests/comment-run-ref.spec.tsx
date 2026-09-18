/**
 * 讨论里引用某次运行（切片⑥f）。
 *
 * 这一片的价值全在**边界**上：引用是正文里的纯文本 token，所以判据要回答的不是"chip 画出来了吗"，
 * 而是"什么时候**不该**画成 chip"：
 *   ① 只在**本任务**的运行里解析——别处复制来的短号不能在别的任务里变成引用（会指错）；
 *   ② 解析不到就**保持纯文本**，绝不做死链（删掉的运行不该留一个点不动的按钮）；
 *   ③ 窄匹配——正文里的"运行"二字、裸的 8 位十六进制都不是引用；
 *   ④ 点 chip 真的打开那次运行的 Console（页面级，证明接线通）。
 */
import { screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { formatRunReference, parseRunReferences } from '../src/features/task/runReference.js'
import type { TaskRoomRun } from '../src/shared/api/types.js'

function run(id: string, over: Partial<TaskRoomRun> = {}): TaskRoomRun {
  return {
    id,
    status: 'running',
    createdAt: '2026-09-16T02:00:00.000Z',
    startedAt: '2026-09-16T02:00:05.000Z',
    finishedAt: null,
    rerunOfRunId: null,
    ...over,
  }
}

const RUN_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const RUN_B = 'bbbbbbbb-2222-4222-8222-222222222222'

describe('运行引用的解析（纯函数）', () => {
  it('短号解析到本任务的运行 → 切成引用片段，文本包含「运行 R-xxxxxxxx」', () => {
    const body = `先按 ${formatRunReference(RUN_A)} 的结果改`
    const segments = parseRunReferences(body, [run(RUN_A)])
    expect(segments.map((segment) => segment.runId)).toEqual([null, RUN_A, null])
    expect(segments[1]?.text).toBe('运行 R-aaaaaaaa')
  })

  it('**解析不到**就保持纯文本（删掉的运行、别处复制的短号都不做死链）', () => {
    const body = '参考 运行 R-deadbeef 与 运行 R-bbbbbbbb'
    // 只把 RUN_B 交给它：RUN_B 应当解析到，deadbeef 不应当
    const segments = parseRunReferences(body, [run(RUN_B)])
    const refs = segments.filter((segment) => segment.runId !== null)
    expect(refs).toHaveLength(1)
    expect(refs[0]?.runId).toBe(RUN_B)
    // deadbeef 那段必须还在文本里（没被吞掉）
    expect(segments.map((segment) => segment.text).join('')).toContain('R-deadbeef')
  })

  it('窄匹配：只说「运行」、或只有裸的 8 位十六进制，都不算引用', () => {
    for (const body of ['这次运行很慢', '看 aaaaaaaa 这段', 'R-AAAAAAA1 大写不算']) {
      const segments = parseRunReferences(body, [run(RUN_A)])
      expect(segments).toHaveLength(1)
      expect(segments[0]?.runId).toBeNull()
    }
  })

  it('短号**碰撞**时不算引用（不静默指向第一条——宁可不算，也不指错）', () => {
    // 评审 S3：短号是截断值，两条运行短号相同时 `find` 取第一条就是**静默指错**。
    // 生产 id 是 UUIDv4（前 8 位 32 位随机），但仓库夹具 nextId() 造出的 run 前 8 位全是 00000000。
    const twinA = '00000000-1111-4111-8111-111111111111'
    const twinB = '00000000-2222-4222-8222-222222222222'
    const body = `按 ${formatRunReference(twinA)} 继续`
    const segments = parseRunReferences(body, [run(twinA), run(twinB)])
    expect(segments).toEqual([{ text: body, runId: null }])
    // 只剩其中一条时就能解析（证明上面不是因为别的原因没解析）。
    // 注意取**引用段**而不是第 0 段——第 0 段是前导文本（我第一版就取错了）。
    const resolved = parseRunReferences(body, [run(twinA)]).find(
      (segment) => segment.runId !== null,
    )
    expect(resolved?.runId).toBe(twinA)
  })

  it('左边必须有边界、右边不许跟十六进制（`xR-…` 与 `R-…A` 都不算引用）', () => {
    // 评审 O1/O2：`(?![0-9a-f])` 漏了大写（R-aaaaaaaaA 会被切出 chip），`R-` 左边无断言。
    // 大小写前缀都要挡（复核实测：只写 [0-9a-z] 时 `XR-`/`AR-` 仍会切出 chip）
    for (const body of [
      '前缀xR-aaaaaaaa',
      '0R-aaaaaaaa',
      'XR-aaaaaaaa',
      'AR-aaaaaaaa',
      'R-aaaaaaaaA',
      'R-aaaaaaaa1',
    ]) {
      const segments = parseRunReferences(body, [run(RUN_A)])
      expect(segments, body).toEqual([{ text: body, runId: null }])
    }
  })

  it('两个**裸** token 紧邻时只认第一个（有意收窄：宁可少认，不从长串中间切）', () => {
    // 复核指出的方向性收窄，这里钉住它——免得下次有人"顺手放宽左边界"变成从长 token 中间切。
    const glued = parseRunReferences(`R-aaaaaaaaR-bbbbbbbb`, [run(RUN_A), run(RUN_B)])
    expect(glued.filter((segment) => segment.runId !== null)).toHaveLength(1)
    // 但空格分隔（组合框插入的形态）必须是两个引用
    const spaced = parseRunReferences(`${formatRunReference(RUN_A)} ${formatRunReference(RUN_B)}`, [
      run(RUN_A),
      run(RUN_B),
    ])
    expect(spaced.filter((segment) => segment.runId !== null)).toHaveLength(2)
  })

  it('正文里没有引用时原样返回（不改变任何普通留言的渲染）', () => {
    const body = '我先看一下，稍后回复。'
    expect(parseRunReferences(body, [run(RUN_A)])).toEqual([{ text: body, runId: null }])
  })

  it('同一段里多个引用都能解析（各自指向不同的运行）', () => {
    const body = `${formatRunReference(RUN_A)} 与 ${formatRunReference(RUN_B)} 对比`
    const segments = parseRunReferences(body, [run(RUN_A), run(RUN_B)])
    expect(
      segments.filter((segment) => segment.runId !== null).map((segment) => segment.runId),
    ).toEqual([RUN_A, RUN_B])
  })
})

describe('「引用运行」入口（S1：此前源码与浏览器两侧都零判据）', () => {
  it('**有**运行时入口在，选中一次会把可识别 token 插进草稿', async () => {
    const user = userEvent.setup()
    const { BOB, loggedInHandlers, makeRun, makeTask, teamMembersHandler } =
      await import('./fixtures.js')
    const { renderApp } = await import('./render.jsx')
    const { selectOption } = await import('./select-menu.js')
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () =>
            new Response(
              JSON.stringify({
                ok: true,
                data: {
                  task,
                  comments: [],
                  instructions: [],
                  runs: [makeRun({ id: RUN_A, status: 'running' })],
                  artifacts: [],
                },
              }),
              { status: 200 },
            ),
        },
        teamMembersHandler([]),
      ]),
    )
    // 变异 M4（删掉"没有运行就不渲染"判断）不会红这条，但下面的空态用例会——两条合起来才钉住。
    await selectOption(user, '引用运行', '第 1 次运行')
    // 变异 M5（选中后什么都不插入）**必须**让这条红：草稿里要真的出现可识别 token。
    expect(await screen.findByLabelText('留言')).toHaveValue('运行 R-aaaaaaaa')
  })

  it('**没有**运行时不渲染这个入口（不是给一个空菜单）', async () => {
    const { BOB, loggedInHandlers, makeTask, teamMembersHandler } = await import('./fixtures.js')
    const { renderApp } = await import('./render.jsx')
    const task = makeTask({ assigneeUserId: BOB.userId })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () =>
            new Response(
              JSON.stringify({
                ok: true,
                data: { task, comments: [], instructions: [], runs: [], artifacts: [] },
              }),
              { status: 200 },
            ),
        },
        teamMembersHandler([]),
      ]),
    )
    // 留言输入框在（证明页面确实渲染了），但引用入口不在。
    expect(await screen.findByLabelText('留言')).toBeVisible()
    expect(screen.queryByLabelText('引用运行')).toBeNull()
  })
})

describe('讨论列表里的引用 chip（页面级）', () => {
  it('点引用 chip 打开那次运行的 Console', async () => {
    const user = userEvent.setup()
    const { BOB, loggedInHandlers, makeRun, makeTask, teamMembersHandler, makeComment } =
      await import('./fixtures.js')
    const { renderApp } = await import('./render.jsx')
    const task = makeTask({ assigneeUserId: BOB.userId })
    // **两条运行**（评审 S2：只有一条时"打开被引用那一次"与"打开 runs[0]"不可区分——
    // 变异把它改成 runs[0] 仍 6/6 全绿）。两条留言各引一条，点第二条。
    const firstRun = makeRun({
      id: RUN_A,
      status: 'completed',
      finishedAt: '2026-09-16T03:00:00.000Z',
    })
    const secondRun = makeRun({ id: RUN_B, status: 'running' })
    renderApp(
      `/tasks/${task.id}`,
      loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: new RegExp(`/api/v1/tasks/${task.id}$`),
          respond: () =>
            new Response(
              JSON.stringify({
                ok: true,
                data: {
                  task,
                  comments: [
                    makeComment({ body: `先看 ${formatRunReference(RUN_A)} 的结果` }),
                    makeComment({ body: `再看 ${formatRunReference(RUN_B)} 的结果` }),
                  ],
                  instructions: [],
                  runs: [firstRun, secondRun],
                  artifacts: [],
                },
              }),
              { status: 200 },
            ),
        },
        {
          method: 'GET',
          url: new RegExp(`/api/v1/runs/${RUN_B}$`),
          respond: () =>
            new Response(
              JSON.stringify({ ok: true, data: { ...secondRun, projectId: task.projectId } }),
              { status: 200 },
            ),
        },
        {
          method: 'GET',
          url: /\/events$/,
          respond: () =>
            new Response(JSON.stringify({ ok: true, data: { events: [] } }), { status: 200 }),
        },
        teamMembersHandler([]),
      ]),
    )
    // 有两个 chip：选**第二条**（指向 RUN_B），而不是第一个/随便一个。
    // `data-testid` 在所有 chip 上重名，所以按 `data-run-id` 定位。
    const chips = await screen.findAllByTestId('comment-run-ref')
    expect(chips).toHaveLength(2)
    const secondChip = chips.find((chip) => chip.getAttribute('data-run-id') === RUN_B)
    expect(secondChip, '预期能找到指向第二次运行的 chip').toBeDefined()
    expect(secondChip).toHaveTextContent('运行 R-bbbbbbbb')
    await user.click(secondChip!)
    // 打开的是**被引用的那一次**（第 2 次），不是 runs[0]（第 1 次）
    expect(await screen.findByTestId('run-console')).toBeVisible()
    expect(screen.getByRole('dialog')).toHaveAccessibleName(/第 2 次运行/)
  })
})
