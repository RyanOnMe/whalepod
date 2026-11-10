/**
 * Outbox 派发 worker（02-第一阶段实施计划.md Task 10 Step 4；03 §2.6）。
 *
 * 以 dispatch_outbox 表为事实来源：claim 已按退避推远 next_attempt_at，
 * worker 崩溃（不 ack）时退避到期后会被重新 claim——commandId 不变，
 * Node 按 commandId 幂等返回旧 ack（R7）。进程重启后继续扫表（R8）；
 * NOTIFY 唤醒属 P1-09 连接层优化，本 worker 只依赖扫描。
 *
 * send 成功不 ack 行：acked_at 由 Node command.ack 上行时写入
 * （RunOrchestrator.ingestNodeEvent）。行只在「永远不会被接受」时 fail：
 * 帧过不了协议 schema（编程错误）或对端报永久错误；离线等瞬时错误留待退避重投。
 */
import { randomUUID } from 'node:crypto'
import type { ClaimedCommand, Outbox } from '@whalepod/db'
import { NodeDownstreamSchema } from '@whalepod/protocol'
import type { ManagedDraftTransport } from '../draft-share/dispatch.js'
import type { DeviceGateway } from './device-gateway.js'

export interface OutboxWorkerDeps {
  outbox: Outbox
  gateway: DeviceGateway
  managedDraftTransport?: ManagedDraftTransport
  now?: () => Date
  /**
   * ADR-0027 §3：`run.start` 发送前的复核钩子。返回 false 表示命令已由钩子
   * 作废（Run 走 failed(CONTEXT_UNAVAILABLE)），worker 不再发送。
   */
  beforeDispatch?: (command: ClaimedCommand) => Promise<boolean>
}

export interface DispatchResult {
  claimed: number
  sent: number
  /** 永久失败（已置 failed_at，不再重投）。 */
  failed: number
}

/** 错误分类（02 Step 4 classifyDispatchError）：默认瞬时，显式 permanent 才终态。 */
export function isPermanentDispatchError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { permanent?: unknown }).permanent === true
  )
}

export class OutboxWorker {
  private readonly outbox: Outbox
  private readonly gateway: DeviceGateway
  private readonly managedDraftTransport: ManagedDraftTransport | undefined
  private readonly nowFn: () => Date
  private readonly beforeDispatch: ((command: ClaimedCommand) => Promise<boolean>) | undefined

  constructor(deps: OutboxWorkerDeps) {
    this.outbox = deps.outbox
    this.gateway = deps.gateway
    this.managedDraftTransport = deps.managedDraftTransport
    this.nowFn = deps.now ?? (() => new Date())
    this.beforeDispatch = deps.beforeDispatch
  }

  /** 扫描并派发一批（至多 50 条）。组合根（P1-05）负责定时驱动本方法。 */
  async dispatchOnce(limit?: number): Promise<DispatchResult> {
    const claimed = await this.outbox.claim(limit)
    let sent = 0
    let failed = 0
    for (const command of claimed) {
      if (
        command.type === 'run.start' &&
        this.beforeDispatch !== undefined &&
        !(await this.beforeDispatch(command))
      ) {
        // 钩子已在同一事务里作废 Run 与该 outbox 行；这里幂等再 fail 一次兜底。
        await this.outbox.fail(command.id)
        failed += 1
        continue
      }
      const frame = this.buildFrame(command)
      const parsed = NodeDownstreamSchema.safeParse(frame)
      if (!parsed.success) {
        // 表里的行构造不出合法协议帧：编程错误，热重投无意义。
        await this.outbox.fail(command.id)
        failed += 1
        continue
      }
      try {
        if (parsed.data.type === 'managed_draft.start') {
          if (
            this.managedDraftTransport === undefined ||
            !(await this.managedDraftTransport.send(command.deviceId, parsed.data, this.gateway))
          ) {
            await this.outbox.fail(command.id)
            failed += 1
          } else sent += 1
          continue
        }
        await this.gateway.send(command.deviceId, parsed.data)
        // ADR-0027 §3：首次发送成功后落 sent_at；预派发复核只对「从未发出」的
        // run.start 生效，避免 ack 丢失重投时把已在执行的 Run 误判失败。
        await this.outbox.markSent(command.id)
        sent += 1
      } catch (error) {
        if (isPermanentDispatchError(error)) {
          await this.outbox.fail(command.id)
          failed += 1
        }
        // 瞬时错误（设备离线等）：行已被 claim 按退避推远，等下一轮重投。
      }
    }
    return { claimed: claimed.length, sent, failed }
  }

  /** 组装下行帧：messageId/sentAt 每次新发，commandId 由 payload 保持稳定。 */
  private buildFrame(command: ClaimedCommand): unknown {
    return {
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: this.nowFn().toISOString(),
      type: command.type,
      payload: command.payload,
    }
  }
}
