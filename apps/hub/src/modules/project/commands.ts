import type { Database } from '@project311/db'
import { appendTeamEvent, insertProject, transactCommand, unwrapPgError } from '@project311/db'
import { ApiError } from '../shared/http-error.js'
import { uuidv7 } from '../shared/uuid.js'
import { toProjectView } from './queries.js'
import type { ProjectView } from './queries.js'

export interface CreateProjectInput {
  name: string
  description?: string
  createdBy: string
  idempotencyKey: string
}

/**
 * 创建 Project（02 Task 6 Step 3）：幂等创建 + Team Event 同事务提交。
 * 03 §4 权限 = Member（由 requireActor 保证）；name 唯一冲突映射 409 CONFLICT。
 */
export async function createProject(
  database: Database,
  input: CreateProjectInput,
): Promise<ProjectView> {
  const id = uuidv7()
  try {
    return await transactCommand(database, `project.create:${input.idempotencyKey}`, async (tx) => {
      const row = await insertProject(tx, {
        id,
        name: input.name,
        description: input.description ?? '',
        createdBy: input.createdBy,
      })
      await appendTeamEvent(tx, {
        type: 'project.changed',
        payload: { projectId: row.id, name: row.name },
      })
      return toProjectView(row)
    })
  } catch (error) {
    const pg = unwrapPgError(error)
    if (pg?.code === '23505' && (pg.constraintName ?? '').includes('project_name')) {
      throw new ApiError(409, 'CONFLICT', 'project name already taken')
    }
    throw error
  }
}
