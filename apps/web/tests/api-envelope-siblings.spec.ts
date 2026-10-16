/**
 * #312 信封顶层兄弟字段：真实 wire 里 `data` 之外还有字段（创建任务指派 Agent 时是 `drive`）。
 *
 * 本文件的判据只有一条：**兄弟字段必须与 `data` 分开交回，绝不并进 `data`**。
 * 之前前端按 `data.drive` 读（`apiRequest` 只回 `data`），于是那条「自动驱动结果」toast
 * 永远不出现，而 web 用例的 fixture 又把 drive 塞进了 data —— 两边一起绿，缺陷漏网。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/shared/api/client.js'
import { createdWithSiblings, installFetch, ok } from './fixtures.js'

const TASK_ROUTE = '/projects/p1/tasks'

describe('#312 信封顶层兄弟字段', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drive 与 data 分开交回：data 里没有它（按 data.drive 读会恒为 undefined）', async () => {
    installFetch([
      {
        method: 'POST',
        url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
        respond: () =>
          createdWithSiblings(
            { id: 'task-1', title: '写发布说明' },
            {
              drive: { outcome: 'failed', error: { code: 'DEVICE_OFFLINE', message: 'no device' } },
            },
          ),
      },
    ])
    const result = await api.mutateWithSiblings<{ id: string; title: string }>(TASK_ROUTE, {
      body: {},
    })
    expect(result.data).toEqual({ id: 'task-1', title: '写发布说明' })
    expect((result.data as Record<string, unknown>)['drive']).toBeUndefined()
    expect(result.siblings['drive']).toMatchObject({
      outcome: 'failed',
      error: { code: 'DEVICE_OFFLINE' },
    })
  })

  it('没有兄弟字段时交回空对象，不塞 undefined 占位', async () => {
    installFetch([
      {
        method: 'POST',
        url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
        respond: () => ok({ id: 'task-2' }),
      },
    ])
    const result = await api.mutateWithSiblings<{ id: string }>(TASK_ROUTE, { body: {} })
    expect(result.data).toEqual({ id: 'task-2' })
    expect(result.siblings['drive']).toBeUndefined()
    expect(Object.keys(result.siblings)).toEqual([])
  })

  it('既有调用点不受影响：api.mutate 仍只回 data', async () => {
    installFetch([
      {
        method: 'POST',
        url: /\/api\/v1\/projects\/[^/]+\/tasks$/,
        respond: () => createdWithSiblings({ id: 'task-3' }, { drive: { outcome: 'started_run' } }),
      },
    ])
    const task = await api.mutate<{ id: string }>(TASK_ROUTE, { body: {} })
    expect(task).toEqual({ id: 'task-3' })
  })
})
