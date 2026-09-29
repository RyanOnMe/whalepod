/**
 * 确认对话框（#229 批次③）：vendored Modal（headless）的应用层封装。
 *
 * 替换原生 window.confirm（阻塞主线程、无法样式化、键盘/焦点行为与产品形态
 * 脱节）。焦点管理照 RunConsole 的口径（S2/S3/S4 评审结论）：
 *   打开即聚焦确认钮；卸载时焦点还给触发元素；
 *   Tab 循环留在对话框内（aria-modal 说到做到）；
 *   Esc / 遮罩点击 = 取消（Modal 自带）。
 * headless 模式让内容自绘——Tab 陷阱必须挂在真正包含焦点元素的容器上。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Modal } from '../vendor/dsh-ui/index.js'

export interface ConfirmDialogProps {
  open: boolean
  /** 对话框标题（如「取消任务？」）。 */
  title: string
  /** 支撑说明（后果、影响范围）。 */
  body: string
  /** 确认钮文案——带「确认」前缀（如「确认取消任务」），与页面行动钮区分。 */
  confirmLabel: string
  /** 取消钮文案，默认「返回」。 */
  cancelLabel?: string
  /** 危险行动：确认钮用 danger 样式。 */
  danger?: boolean
  /** 确认动作执行中：两钮禁用，防重复。 */
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = '返回',
  danger = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  // 还焦目标在打开那一刻定格（Modal 走 portal，卸载时机由 open 控制）。
  const triggerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    triggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 打开即进对话框（portal 挂载后的一帧）。
    requestAnimationFrame(() => confirmRef.current?.focus())
    return () => {
      triggerRef.current?.focus()
    }
  }, [open])

  return (
    // headless 分支不收 closeLabel（无头部关闭钮，Esc/遮罩已覆盖取消）。
    <Modal open={open} onClose={onCancel} title={title} headless={true}>
      <div
        className="confirm-dialog"
        ref={panelRef}
        onKeyDown={(event) => {
          // Tab 陷阱（RunConsole S4 同款）：aria-modal 声明了模态，Tab 就得留在里面。
          if (event.key !== 'Tab') return
          const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          )
          if (focusables === undefined || focusables.length === 0) return
          const first = focusables[0]!
          const last = focusables[focusables.length - 1]!
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <h2 className="confirm-dialog-title">{title}</h2>
        <p className="confirm-dialog-body">{body}</p>
        <div className="confirm-dialog-actions">
          <button type="button" className="button" disabled={pending} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button ${danger ? 'button-danger' : 'button-primary'}`}
            disabled={pending}
            ref={confirmRef}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
