/**
 * Node 连接注册表（每进程单例）：deviceId → 唯一活跃连接。
 * 不变量：同一 Device 只允许一条连接，新连接以 4008 替换旧连接（02 Task 9 Step 4）；
 * 撤销时下发 node.token_revoked 并以 4008 关闭（Step 6）。
 */
import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { AuthenticatedDevice } from '../run/device-gateway.js'
import { NodePreparationCheckSchema, SourcePermissionCheckSchema } from '@whalepod/protocol'
import type {
  NodePreparationResult,
  NodeDownstream,
  SourcePermissionCheckPayload,
  SourcePermissionResultPayload,
} from '@whalepod/protocol'

export interface NodeConnection extends AuthenticatedDevice {
  readonly socket: WebSocket
}

/** 瞬时错误（离线等）：OutboxWorker 按退避重投，不置终态。 */
export class NodeOfflineError extends Error {
  constructor(message = 'node connection is not online') {
    super(message)
    this.name = 'NodeOfflineError'
  }
}

function envelope(type: NodeDownstream['type'], payload: unknown): NodeDownstream {
  // 下行帧构造与 OutboxWorker.buildFrame 同形；此处 payload 已是协议形状。
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  } as NodeDownstream
}

export interface PreparationSnapshot {
  readonly facts: NodePreparationResult
  /** 只留在进程内；HTTP返回前再次确认收到结果的连接仍有效。 */
  isCurrent(): boolean
}

/** ADR-0024 §5：绑定/恢复前的只读权限检查结果。 */
export interface SourcePermissionSnapshot {
  readonly result: SourcePermissionResultPayload['result']
  readonly appKey?: string
  readonly upstreamVersion?: string
  /** 只留在进程内；写库前再次确认结果来自当前连接。 */
  isCurrent(): boolean
}

export type SourcePermissionCheckInput = Omit<SourcePermissionCheckPayload, 'requestId'>

export class NodeConnectionRegistry {
  private readonly byDevice = new Map<string, NodeConnection>()
  private readonly preparation = new Map<
    string,
    {
      deviceId: string
      socket: WebSocket
      timer: ReturnType<typeof setTimeout>
      resolve: (result: NodePreparationResult) => void
      reject: (error: Error) => void
    }
  >()
  private readonly sourcePermissions = new Map<
    string,
    {
      deviceId: string
      socket: WebSocket
      timer: ReturnType<typeof setTimeout>
      resolve: (result: Omit<SourcePermissionSnapshot, 'isCurrent'>) => void
      reject: (error: Error) => void
    }
  >()

  private rejectPending(socket: WebSocket): void {
    for (const [id, pending] of this.preparation) {
      if (pending.socket !== socket) continue
      clearTimeout(pending.timer)
      this.preparation.delete(id)
      pending.reject(new NodeOfflineError('preparation connection changed'))
    }
    for (const [id, pending] of this.sourcePermissions) {
      if (pending.socket !== socket) continue
      clearTimeout(pending.timer)
      this.sourcePermissions.delete(id)
      pending.reject(new NodeOfflineError('source permission connection changed'))
    }
  }

  /** 有界只读请求；不进 Outbox。只接受同一 Device 的同一活跃连接回报。 */
  requestPreparation(
    deviceId: string,
    input: { workspaceId: string; provider: string; credentialSlot: string },
    timeoutMs = 5_000,
  ): Promise<PreparationSnapshot> {
    const connection = this.byDevice.get(deviceId)
    if (connection === undefined || !this.isOnline(deviceId))
      return Promise.reject(new NodeOfflineError())
    if (
      this.preparation.size >= 128 ||
      [...this.preparation.values()].filter((row) => row.deviceId === deviceId).length >= 8
    )
      return Promise.reject(new NodeOfflineError('preparation busy'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.preparation.delete(requestId)
        reject(new NodeOfflineError('preparation timed out'))
      }, timeoutMs)
      this.preparation.set(requestId, {
        deviceId,
        socket: connection.socket,
        timer,
        resolve: (facts) =>
          resolve({
            facts,
            isCurrent: () => this.byDevice.get(deviceId) === connection && this.isOnline(deviceId),
          }),
        reject,
      })
      try {
        this.send(
          deviceId,
          NodePreparationCheckSchema.parse(
            envelope('node.preparation_check', { requestId, ...input }),
          ),
        )
      } catch {
        clearTimeout(timer)
        this.preparation.delete(requestId)
        reject(new NodeOfflineError())
      }
    })
  }

  deliverPreparation(deviceId: string, socket: WebSocket, result: NodePreparationResult): boolean {
    const pending = this.preparation.get(result.requestId)
    if (
      pending === undefined ||
      pending.deviceId !== deviceId ||
      pending.socket !== socket ||
      this.byDevice.get(deviceId)?.socket !== socket
    )
      return false
    clearTimeout(pending.timer)
    this.preparation.delete(result.requestId)
    pending.resolve(result)
    return true
  }

  /**
   * ADR-0024 §5：绑定/恢复前的有界只读权限检查；不进 Outbox、不启动 Runtime。
   * 只发给已在 hello 里声明 sourceCapabilities 的 Node（由调用方先判定）。
   */
  requestSourcePermission(
    deviceId: string,
    input: SourcePermissionCheckInput,
    timeoutMs = 5_000,
  ): Promise<SourcePermissionSnapshot> {
    const connection = this.byDevice.get(deviceId)
    if (connection === undefined || !this.isOnline(deviceId))
      return Promise.reject(new NodeOfflineError())
    if (
      this.sourcePermissions.size >= 128 ||
      [...this.sourcePermissions.values()].filter((row) => row.deviceId === deviceId).length >= 8
    )
      return Promise.reject(new NodeOfflineError('source permission busy'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sourcePermissions.delete(requestId)
        reject(new NodeOfflineError('source permission timed out'))
      }, timeoutMs)
      this.sourcePermissions.set(requestId, {
        deviceId,
        socket: connection.socket,
        timer,
        resolve: (result) =>
          resolve({
            ...result,
            isCurrent: () => this.byDevice.get(deviceId) === connection && this.isOnline(deviceId),
          }),
        reject,
      })
      try {
        this.send(
          deviceId,
          SourcePermissionCheckSchema.parse(
            envelope('source.permission_check', { requestId, ...input }),
          ),
        )
      } catch {
        clearTimeout(timer)
        this.sourcePermissions.delete(requestId)
        reject(new NodeOfflineError())
      }
    })
  }

  deliverSourcePermission(
    deviceId: string,
    socket: WebSocket,
    result: SourcePermissionResultPayload,
  ): boolean {
    const pending = this.sourcePermissions.get(result.requestId)
    if (
      pending === undefined ||
      pending.deviceId !== deviceId ||
      pending.socket !== socket ||
      this.byDevice.get(deviceId)?.socket !== socket
    )
      return false
    clearTimeout(pending.timer)
    this.sourcePermissions.delete(result.requestId)
    pending.resolve({
      result: result.result,
      ...(result.appKey !== undefined ? { appKey: result.appKey } : {}),
      ...(result.upstreamVersion !== undefined ? { upstreamVersion: result.upstreamVersion } : {}),
    })
    return true
  }

  /** 注册新连接；同 Device 旧连接以 4008 替换。返回是否为新挂载。 */
  attach(connection: NodeConnection): void {
    const previous = this.byDevice.get(connection.deviceId)
    if (previous !== undefined && previous.socket !== connection.socket) {
      this.rejectPending(previous.socket)
      previous.socket.close(4008, 'replaced by a newer connection')
    }
    this.byDevice.set(connection.deviceId, connection)
    connection.socket.once('close', () => {
      this.rejectPending(connection.socket)
      if (this.byDevice.get(connection.deviceId)?.socket === connection.socket) {
        this.byDevice.delete(connection.deviceId)
      }
    })
  }

  detach(deviceId: string, socket: WebSocket): void {
    this.rejectPending(socket)
    if (this.byDevice.get(deviceId)?.socket === socket) this.byDevice.delete(deviceId)
  }

  isOnline(deviceId: string): boolean {
    const connection = this.byDevice.get(deviceId)
    return connection !== undefined && connection.socket.readyState === connection.socket.OPEN
  }

  /** 下发任意合法下行帧；离线抛瞬时错误由调用方分类。 */
  send(deviceId: string, frame: NodeDownstream): void {
    const connection = this.byDevice.get(deviceId)
    if (connection === undefined || connection.socket.readyState !== connection.socket.OPEN) {
      throw new NodeOfflineError()
    }
    connection.socket.send(JSON.stringify(frame))
  }

  /** 撤销推送（03 §6.3 node.token_revoked）：先发帧再以 4008 断开并摘除。 */
  pushTokenRevokedAndClose(deviceId: string, reason: string): boolean {
    const connection = this.byDevice.get(deviceId)
    if (connection === undefined) return false
    try {
      connection.socket.send(JSON.stringify(envelope('node.token_revoked', { reason })))
    } catch {
      // 发送失败不阻碍关闭。
    }
    this.rejectPending(connection.socket)
    connection.socket.close(4008, 'token revoked')
    this.byDevice.delete(deviceId)
    return true
  }
}

/** 进程级单例：HTTP revoke 路由与 WS 层共享同一份连接事实。 */
export const nodeConnections = new NodeConnectionRegistry()
