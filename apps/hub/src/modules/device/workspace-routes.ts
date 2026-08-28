/**
 * GET /api/v1/workspaces（P1-12；03 §4：当前 Member 的不透明 Workspace 投影）。
 * 不含 canonical_path/任何本地路径——路径只存在于 Node 本地（03 §2.4）。
 */
import type { FastifyInstance } from 'fastify'
import type { Database } from '@project311/db'
import { listWorkspacesByOwner } from '@project311/db'
import type { RequireActor } from '../auth/session.js'

export interface WorkspaceRouteDeps {
  readonly database: Database
  readonly requireActor: RequireActor
}

export function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRouteDeps): void {
  app.get('/workspaces', async (request) => {
    const actor = await deps.requireActor(request)
    const rows = await listWorkspacesByOwner(deps.database.db, actor.userId)
    return {
      ok: true,
      data: rows.map((row) => ({
        workspaceId: row.id,
        // P1-13 Run Launcher 需要 workspace→device 配对（StartRun 两个 id 都要）；
        // deviceId 是不透明标识，不是本地路径，03 §2.4 边界不破。
        deviceId: row.deviceId,
        name: row.name,
        kind: row.kind,
        capabilities: row.capabilities,
        available: row.available,
        lastCheckedAt: row.lastCheckedAt.toISOString(),
      })),
    }
  })
}
