/**
 * 路由判定（P1-UX-13 / #259）：一条通知的「已读」与「不打扰」都以「用户是不是
 * 正开着这个任务房间」为准，判定只依赖 pathname，所以单独成函数、可单测。
 *
 * 只认 `/tasks/:id`（任务房间）。`/tasks/:id/permissions`（权限页）不算——那页
 * 看不到运行轨迹，不该替人把未读抹掉。
 */
const TASK_ROUTE = /^\/tasks\/([^/]+)$/

export function matchTaskRoute(pathname: string): string | null {
  return TASK_ROUTE.exec(pathname)?.[1] ?? null
}
