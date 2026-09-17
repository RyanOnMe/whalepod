/**
 * 任务级权限页（切片⑥e）：`/tasks/:taskId/permissions`。
 *
 * 为什么单独一页而不是塞进任务房间（用户 2026-09-15 的原型反馈：「权限页独立」）：
 * 授权是**低频、且常在有争议时**才被翻出来看的东西（"这句到底谁能让 Agent 动起来"），
 * 常驻在执行栏里会与高频操作抢注意力；独立成页后可以从任务房间、成员页两处进入，
 * 也便于将来把审计列表挂在这里（当前**没有**审计读取接口，故本片不含审计）。
 */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { api } from '../shared/api/client.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { useSession } from '../app/session.js'
import { queryKeys } from '../app/query-client.js'
import type { TaskRoomView } from '../shared/api/types.js'
import { InstructionDrivers } from '../features/task/InstructionDrivers.js'

export function TaskPermissionsPage(): ReactNode {
  const { taskId } = useParams()
  const session = useSession()
  const query = useQuery({
    queryKey: queryKeys.taskRoom(taskId ?? ''),
    queryFn: () => api.get<TaskRoomView>(`/tasks/${taskId ?? ''}`),
    enabled: taskId !== undefined,
  })

  if (taskId === undefined) {
    return (
      <div className="card error-state" role="alert">
        <h1>任务地址无效</h1>
        <p>
          <Link to="/">返回项目列表</Link>
        </p>
      </div>
    )
  }
  if (query.isPending) return <p className="mutation-hint">正在加载任务…</p>
  if (query.isError) {
    return (
      <div className="task-room-error">
        <ErrorBanner error={query.error} />
        <button type="button" className="button" onClick={() => void query.refetch()}>
          重试
        </button>
      </div>
    )
  }
  if (session === null) return null

  const { task } = query.data
  return (
    <div className="page-grid">
      <div className="task-permissions">
        <h1>{task.title} · 权限</h1>
        <p className="mutation-hint">
          <Link to={`/tasks/${task.id}`}>← 回到任务房间</Link>
        </p>
        <InstructionDrivers task={task} sessionUserId={session.userId} />
      </div>
    </div>
  )
}
