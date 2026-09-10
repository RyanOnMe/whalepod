/**
 * vendored from deepseek-ai/deepseek-harness packages/client/ui-primitives/src/Pill.tsx
 * @ c291e7961a515f6d7af9304e7fd1d257929aef26（MIT，见同目录 LICENSE）
 * 本仓改动（仅工程口径，未动视觉与行为）：`clsx` → `./cx.js`；import 后缀 `.tsx` → `.js`。
 */
// Pill: capsule at the 24px text-line size, selectable when given `onClick`
// (view switcher tabs, filters) and a static span otherwise — TerminalBlock's
// exit status is the read-only case. The 11px read-only badge is `Tag`; size
// separates the two as much as interactivity does.

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx.js'
import css from './Pill.module.css'

/**
 * Render a pill chip. Interactive when onClick is supplied (renders a button);
 * otherwise a static span.
 * @param props.active - selected/active visual state.
 * @returns pill element.
 */
export function Pill({ active = false, className, children, onClick, ...rest }: {
  active?: boolean
  // `| undefined` so a caller can forward an optional class straight through
  // under exactOptionalPropertyTypes (a CSS-module lookup is string|undefined).
  className?: string | undefined
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  if (!onClick) {
    return <span className={cx(css.pill, active && css.active, className)}>{children}</span>
  }
  return (
    <button
      type="button"
      className={cx(css.pill, css.interactive, active && css.active, className)}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  )
}
