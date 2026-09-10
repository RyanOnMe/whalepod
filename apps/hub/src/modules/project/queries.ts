import type { ProjectRow } from '@whalepod/db'
import { getProject, listProjects } from '@whalepod/db'
import type { DbHandle } from '@whalepod/db'

/** Project 的 JSON 视图（03 §2.2；时间为 ISO 字符串）。 */
export interface ProjectView {
  id: string
  name: string
  description: string
  createdBy: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export function toProjectView(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdBy: row.createdBy,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function getProjectView(
  handle: DbHandle,
  id: string,
): Promise<ProjectView | undefined> {
  const row = await getProject(handle, id)
  return row === undefined ? undefined : toProjectView(row)
}

export async function listProjectViews(handle: DbHandle): Promise<ProjectView[]> {
  return (await listProjects(handle)).map(toProjectView)
}
