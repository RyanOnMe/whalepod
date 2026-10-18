/**
 * 已知事件类型 → 单行呈现（P1-393 从 RunLivePanel 拆出，做成段/Console 共用的一份解读）。
 *
 * 返回 null 表示未知类型（调用方只显示类型名——不猜载荷形状，fail-closed 呈现）。
 * 同一份协议不该有两套解读：连续对话的「工具与运行记录」与 Run Console 都取这里。
 */
import type { RunEventItem, RunPhase } from '../../shared/api/types.js'
import { RUN_PHASE_LABEL } from '../../shared/format.js'

export function describeEvent(item: RunEventItem): string | null {
  const event = item.event as { type?: unknown }
  switch (event.type) {
    case 'runtime.ready':
      return 'DSH 运行时就绪'
    case 'run.phase': {
      const phase = (item.event as { phase?: unknown }).phase
      // 取值表是协议枚举的全集（Record<RunPhase, string>，协议加阶段这里编译红）；
      // wire 上仍可能来未知值——原样呈现，不猜、不丢。
      const label = typeof phase === 'string' ? RUN_PHASE_LABEL[phase as RunPhase] : undefined
      return `阶段：${label ?? (typeof phase === 'string' ? phase : '未知')}`
    }
    case 'assistant.message': {
      const text = (item.event as { text?: unknown }).text
      return typeof text === 'string' ? text : null
    }
    case 'tool.started': {
      const name = (item.event as { toolName?: unknown }).toolName
      return `工具开始：${typeof name === 'string' ? name : '未知工具'}`
    }
    case 'tool.finished': {
      const outcome = (item.event as { outcome?: unknown }).outcome
      const label =
        outcome === 'succeeded'
          ? '成功'
          : outcome === 'failed'
            ? '失败'
            : outcome === 'cancelled'
              ? '已取消'
              : null
      return label === null ? null : `工具结束：${label}`
    }
    case 'approval.requested': {
      const reason = (item.event as { approval?: { reason?: unknown } }).approval?.reason
      // project 行 reason 恒为空（03 §8）：呈现固定文案，不显示空框。
      return typeof reason === 'string' && reason !== '' ? `请求批准：${reason}` : '等待责任人批准'
    }
    case 'approval.decided': {
      const status = (item.event as { status?: unknown }).status
      if (typeof status !== 'string') return null
      const label =
        status === 'allowed_once'
          ? '已批准一次'
          : status === 'rejected'
            ? '已拒绝'
            : status === 'expired'
              ? '已过期（按拒绝处理）'
              : status === 'cancelled'
                ? '已取消'
                : status
      return `审批决定：${label}`
    }
    case 'run.completed': {
      const finalText = (item.event as { finalText?: unknown }).finalText
      return typeof finalText === 'string' && finalText !== '' ? `完成：${finalText}` : '完成'
    }
    case 'run.failed': {
      const code = (item.event as { code?: unknown }).code
      return `失败：${typeof code === 'string' ? code : '未知错误'}`
    }
    case 'run.cancelled':
      return '已取消'
    default:
      return null
  }
}
