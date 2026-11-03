/**
 * ADR-0028 §9（RD-03c2）：机器 Run 的 Mandate 实时失效原因。
 *
 * 只描述「为什么失效」，不含正文、路径、凭据；Hub 入队、Node 透传、
 * Runtime 复核共用同一枚举，避免三侧各写一套字符串。
 */
import { z } from 'zod'

export const MandateInvalidationReasonSchema = z.enum([
  /** 责任人暂停了 Mandate（版本递增，work 指针切到新版本）。 */
  'mandate_paused',
  /** 责任人撤销了 Mandate。 */
  'mandate_revoked',
  /** Mandate 到期（周期清扫发现 expiresAt 已过）。 */
  'mandate_expired',
  /** 同一 Work 切换到新 Mandate 版本（如恢复后新版本）。 */
  'mandate_changed',
  /** Work retired / Task 改派或不再可执行。 */
  'work_unavailable',
])
export type MandateInvalidationReason = z.infer<typeof MandateInvalidationReasonSchema>
