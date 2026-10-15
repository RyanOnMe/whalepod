import type { FastifyInstance } from 'fastify'
import type { Database } from '@whalepod/db'
import { getAgent, getDeviceById, getProfileRevision, getTask, schema } from '@whalepod/db'
import { eq } from 'drizzle-orm'
import {
  ExecutionPreparationRequestSchema,
  ExecutionPreparationViewSchema,
} from '@whalepod/protocol'
import type { RequireActor } from '../auth/session.js'
import { RunCommandError } from '../run/errors.js'
import { resolveRunTarget } from '../run/instruction-target.js'
import { ApiError } from '../shared/http-error.js'
import { nodeConnections } from './connection-registry.js'

export function registerPreparationRoutes(
  app: FastifyInstance,
  deps: { database: Database; requireActor: RequireActor },
): void {
  app.post('/tasks/:taskId/preparation-check', async (request, reply) => {
    const actor = await deps.requireActor(request)
    const { taskId } = request.params as { taskId: string }
    const task = await getTask(deps.database.db, taskId)
    if (task === undefined) throw new ApiError(404, 'NOT_FOUND', 'task not found')
    if (task.assigneeUserId !== actor.userId)
      throw new ApiError(403, 'FORBIDDEN', '仅责任人可检查自己的执行现场')
    const input = ExecutionPreparationRequestSchema.parse(request.body)
    const agent = await getAgent(deps.database.db, input.agentId)
    const revision = await getProfileRevision(deps.database.db, input.profileRevisionId)
    if (
      agent === undefined ||
      agent.archivedAt !== null ||
      revision === undefined ||
      revision.agentId !== agent.id
    )
      throw new ApiError(409, 'CONFLICT', '所选Agent配置版本不可用，请重新选择')
    let target
    try {
      target = await resolveRunTarget(deps.database.db, {
        taskId,
        assigneeUserId: actor.userId,
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      })
    } catch (error) {
      if (error instanceof RunCommandError)
        throw new ApiError(
          error.code === 'FORBIDDEN' ? 403 : 409,
          error.code,
          '无法检查所选现场：请确认归属、连接和工作目录',
        )
      throw error
    }
    if (target === undefined)
      throw new ApiError(
        409,
        'DEVICE_OFFLINE',
        '尚无在线且可用的执行现场，请在设备页完成配对和目录登记',
      )
    const device = await getDeviceById(deps.database.db, target.deviceId)
    const [workspace] = await deps.database.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, target.workspaceId))
    if (
      device?.ownerUserId !== actor.userId ||
      workspace?.ownerUserId !== actor.userId ||
      workspace.deviceId !== device.id
    )
      throw new ApiError(403, 'FORBIDDEN', '只能检查本人设备和工作目录')
    let snapshot
    try {
      snapshot = await nodeConnections.requestPreparation(device.id, {
        workspaceId: workspace.id,
        provider: revision.provider,
        credentialSlot: revision.credentialSlot,
      })
    } catch {
      throw new ApiError(
        503,
        'DEVICE_OFFLINE',
        '暂时无法确认本机准备条件：请检查连接或执行服务版本，再重试',
      )
    }
    const currentTask = await getTask(deps.database.db, taskId)
    const currentDevice = await getDeviceById(deps.database.db, device.id)
    if (
      currentTask?.assigneeUserId !== actor.userId ||
      currentDevice?.revokedAt !== null ||
      !snapshot.isCurrent()
    )
      throw new ApiError(409, 'CONFLICT', '责任人或设备状态已变化，请重新检查')
    return reply.header('cache-control', 'no-store').send({
      ok: true,
      data: ExecutionPreparationViewSchema.parse({
        checkedAt: new Date().toISOString(),
        profileRevisionId: revision.id,
        deviceId: device.id,
        workspaceId: workspace.id,
        deviceName: device.name,
        workspaceName: workspace.name,
        modelCall: 'not_tested',
        workspace: snapshot.facts.workspace,
        credential: snapshot.facts.credential,
      }),
    })
  })
}
