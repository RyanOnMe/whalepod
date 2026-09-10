/**
 * vendored from deepseek-ai/deepseek-harness packages/client/ui-primitives/src/Modal.tsx
 * @ c291e7961a515f6d7af9304e7fd1d257929aef26（MIT，见同目录 LICENSE）
 * 本仓改动分两类：①工程口径（`clsx` → `./cx.js`；图标 import 改指本目录 `./icons.js`，
 * 本目录只 vendored 用到的符号；两个上游 import 带 `.tsx` 后缀，本仓按 NodeNext 口径
 * 改成 `.js`）；
 * ②可测性（新增可选属性 `data-testid`：调用方给了就落在 role="dialog" 的卡片上，
 * 没给则完全不输出该属性，故**不改变既有渲染**）。
 *
 * 两处**必须知道的**上游事实（不是本仓改的，迁移页面时要按它设计）：
 *   1. 走 `createPortal(..., document.body)`，所以弹层**不在调用方的 DOM 子树里**——
 *      用 @testing-library 的 `within(container)` 找不到它，要查 `document.body`，
 *      或者在真实界面里按 role 定位（role="dialog"）。本目录**只有 Modal 与 Menu**
 *      两个文件 import `react-dom`（都是为 createPortal）。
 *   2. `useEffect` 里挂 document 级 keydown 监听实现 ESC 关闭；`onClose` 换了身份会重挂
 *      监听（上游如此，本仓未改）。mask 点击也触发 `onClose`，mask 是独立的兄弟节点
 *      而不是 dialog 本体，所以点 mask 关闭、点卡片内部不关闭。
 */
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx.js'
import { IconCloseOutline16 } from './icons.js'
import css from './Modal.module.css'

interface ModalBaseProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
}

type ModalProps = ModalBaseProps & (
  | { headless: true; closeLabel?: never }
  | { headless?: false; closeLabel: string }
) & {
  /** 本仓新增：调用方可覆写的稳定测试锚点（Q5 定位用；不传则不上屏）。 */
  'data-testid'?: string | undefined
}

/**
 * Render a centered, body-portaled modal over a blurred page mask.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - Escape or mask click.
 * @param props.title - dialog heading (aria-label in every mode).
 * @param props.closeLabel - localized accessible close-button label.
 * @param props.description - optional supporting sentence under the title.
 * @param props.children - body (inputs, etc.).
 * @param props.footer - action row (Cancel / Create).
 * @param props.contentClassName - optional class for a scrollable content region.
 * @param props.headless - render children directly in the card (no default
 * header/close/body chrome); mask, card, Escape, and aria-label remain.
 * @returns null when closed; otherwise the overlay tree.
 */
export function Modal({
  open, onClose, title, closeLabel, description, children, footer, className, contentClassName, headless = false, 'data-testid': dataTestId,
}: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, onClose])

  if (!open) return null

  return createPortal((
    <div className={css.root} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div
        className={cx(css.dialog, className)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={dataTestId}
      >
        {headless
          ? children
          : (
            <>
              <div className={cx(css.content, contentClassName)}>
                <div className={css.header}>
                  <h2 className={css.title}>{title}</h2>
                  <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
                    <IconCloseOutline16 size={14} />
                  </button>
                </div>
                {description !== undefined && description !== '' && (
                  <p className={css.description}>{description}</p>
                )}
                {children !== undefined && <div className={css.body}>{children}</div>}
              </div>
              {footer !== undefined && <div className={css.footer}>{footer}</div>}
            </>
          )}
      </div>
    </div>
  ), document.body)
}
