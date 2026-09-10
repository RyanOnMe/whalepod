/**
 * vendored from deepseek-ai/deepseek-harness packages/client/ui-primitives/src/Button.tsx
 * @ c291e7961a515f6d7af9304e7fd1d257929aef26（MIT，见同目录 LICENSE）
 * 本仓改动：仅工程口径（`clsx` → `./cx.js`、import 补 `.js` 后缀）——**视觉与行为未改**。
 */
// Button: token-styled button atom. Variants map to the --dsw-alias-button-*
// fill families; no framework imports, all behavior via props.

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx.js'
import css from './Button.module.css'

/** Visual variant, each backed by its --dsw-alias-button-* token family. */
export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

/**
 * Render a button.
 * @param props.variant - visual family (default 'ghost').
 * @param props.size - 'md' 36px capsule (figma Button) or 'sm' 28px compact.
 * @param props.icon - optional leading 16px icon node.
 * @returns the button element; native button attributes pass through.
 */
export function Button({ variant = 'ghost', size = 'md', icon, className, children, ...rest }: {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
  className?: string | undefined
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={cx(css.button, css[variant], css[size], className)} {...rest}>
      {icon != null && <span className={css.icon}>{icon}</span>}
      {children}
    </button>
  )
}
