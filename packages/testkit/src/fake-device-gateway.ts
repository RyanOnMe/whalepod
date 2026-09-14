/**
 * 内存 Device Node 替身（P1-10；02-第一阶段实施计划.md Task 10 Files）。
 *
 * 模拟 03-领域模型与运行协议.md §6 里 Node 的关键语义，供 Hub 集成测试驱动
 * G4/R7/R8，不经过真实 WebSocket（真实 gateway 是 P1-09/13 的事）：
 *
 * - 本地 spool 按 commandId 幂等：重复 command 返回同一份 ack，不产生第二份
 *   副作用（R7：run.start 重发不得启动第二 Runtime）。
 * - autoAck=false 时吞掉 ack，模拟「命令已执行但 ack 丢失」。
 * - online=false 时拒绝 send，模拟 Device 断连。
 *
 * 结构上与 apps/hub 的 DeviceGateway 接口（modules/run/device-gateway.ts）兼容；
 * testkit 按边界规则不能 import apps/hub，靠 TypeScript 结构类型在装配处对齐。
 */
import type { NodeDownstream, NodeUpstream, ErrorCode } from '@whalepod/protocol'

/** Hub 侧把带 `code: 'DEVICE_OFFLINE'` 的错误归类为可重试（与 wire ErrorCode 对齐）。 */
export class FakeDeviceOfflineError extends Error {
  readonly code = 'DEVICE_OFFLINE' as const

  constructor(deviceId: string) {
    super(`device ${deviceId} is offline`)
    this.name = 'FakeDeviceOfflineError'
  }
}

export interface SentFrame {
  deviceId: string
  frame: NodeDownstream
  sentAt: Date
}

export interface FakeDeviceGatewayOptions {
  online?: boolean
  autoAck?: boolean
  now?: () => Date
  /**
   * Node 侧的**受理前置条件**（#189 的教训）：真实 Node 在 Run 未到 `runtime.ready`
   * 时会拒绝下行命令（`apps/node/src/run/run-manager.ts:392` → `INVALID_RUN_TRANSITION`），
   * 而 fake 原先对任何命令都回 `accepted=true`，于是「Hub 以为受理、Node 实际拒绝」这类
   * 缺口（③b 的 queued/dispatching 假排队）在测试里永远看不见。
   *
   * 传了它，fake 就按真实语义回 `accepted=false` + 错误码；不传保持旧行为（既有用例不受影响）。
   * 判据由调用方给（通常是「去 DB 查这个 Run 的状态」），fake 只负责拒绝。
   */
  refuseCommand?: (frame: NodeDownstream) => { code: ErrorCode; message: string } | undefined
}

export class FakeDeviceGateway {
  /** 已成功写入 Node 的下行帧（含重发），测试据此断言派发内容。 */
  readonly sent: SentFrame[] = []
  /** 每个新 run.start commandId 记一次：即「启动了一个 Runtime」。 */
  readonly startedRunIds: string[] = []
  /** 已确认停止的 Run。 */
  readonly cancelledRunIds: string[] = []

  private readonly spool = new Map<
    string,
    { accepted: boolean; code?: ErrorCode; message?: string }
  >()
  private readonly upstream: NodeUpstream[] = []
  private readonly nowFn: () => Date
  private readonly refuseCommand:
    | ((frame: NodeDownstream) => { code: ErrorCode; message: string } | undefined)
    | undefined
  private messageSeq = 0
  online: boolean
  autoAck: boolean

  constructor(options: FakeDeviceGatewayOptions = {}) {
    this.online = options.online ?? true
    this.autoAck = options.autoAck ?? true
    this.refuseCommand = options.refuseCommand
    this.nowFn = options.now ?? (() => new Date())
  }

  get runtimeStartCount(): number {
    return this.startedRunIds.length
  }

  /**
   * Hub → Node 写入。新 commandId 落 spool 并执行副作用（run.start 记一次
   * Runtime 启动）；重复 commandId 只重放旧 ack，不再执行副作用。
   * send 返回不代表 Node 已 ack——ack 经 drainUpstream() 上行，语义同真实 WS。
   */
  async send(deviceId: string, frame: NodeDownstream): Promise<{ sentAt: Date }> {
    if (!this.online) throw new FakeDeviceOfflineError(deviceId)
    const sentAt = this.nowFn()
    this.sent.push({ deviceId, frame, sentAt })
    const commandId = 'commandId' in frame.payload ? frame.payload.commandId : undefined
    if (commandId !== undefined) {
      if (!this.spool.has(commandId)) {
        // 拒收判定先于副作用：被拒的命令**不**执行（真实 Node 在 not-ready 时同样不写 stdin）。
        const refusal = this.refuseCommand?.(frame)
        this.spool.set(
          commandId,
          refusal === undefined
            ? { accepted: true }
            : { accepted: false, code: refusal.code, message: refusal.message },
        )
        if (refusal === undefined) {
          if (frame.type === 'run.start') this.startedRunIds.push(frame.payload.runId)
          if (frame.type === 'run.cancel') this.cancelledRunIds.push(frame.payload.runId)
        }
      }
      if (this.autoAck) {
        const entry = this.spool.get(commandId)
        this.upstream.push(
          this.ackFrame(commandId, entry?.accepted ?? true, entry?.code, entry?.message),
        )
      }
    }
    return { sentAt }
  }

  /** 取出 Node 待上行的帧（ack 等）；取空后清空，供测试喂给 Hub 的 ingest。 */
  drainUpstream(): NodeUpstream[] {
    return this.upstream.splice(0, this.upstream.length)
  }

  private ackFrame(
    commandId: string,
    accepted: boolean,
    code?: ErrorCode,
    message?: string,
  ): NodeUpstream {
    // messageId 只需是合法 uuid；fake 用计数器即可，不引入 node:crypto（包 tsconfig 无 node types）。
    this.messageSeq += 1
    return {
      protocolVersion: 1,
      messageId: `00000000-0000-4000-8000-${String(this.messageSeq).padStart(12, '0')}`,
      sentAt: this.nowFn().toISOString(),
      type: 'command.ack',
      // 与真实 Node 的 ack 同形：拒绝时带 error（切片② 定型的 wire 形状）。
      payload: {
        commandId,
        accepted,
        ...(accepted || code === undefined ? {} : { error: { code, message: message ?? code } }),
      },
    }
  }
}
