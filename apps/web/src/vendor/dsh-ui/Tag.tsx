/**
 * vendored from deepseek-ai/deepseek-harness packages/client/ui-primitives/src/Tag.tsx
 * @ c291e7961a515f6d7af9304e7fd1d257929aef26（MIT，见同目录 LICENSE）
 * 本仓改动分两类：①工程口径（`clsx` → `./cx.js`、import 补 `.js` 后缀）；
 * ②可测性（新增根属性 `data-vendored="tag"`、允许调用方覆写 `data-testid`）。
 * ②是 API 面的改动而不是纯格式差异——**视觉与行为未改**，但同步上游时它属于要保留的改动。
 */
// Tag: read-only capsule badge. The selectable capsule button is `Pill` —
// a tag takes no `onClick` and no `active`, and carries no copy of its own.

import type { ReactNode } from 'react'
import { cx } from './cx.js'
import css from './Tag.module.css'

/** Palette selector; each tone names one shipped appearance. */
export type TagTone =
  /** Hairline outline on tertiary text: the read-only default. */
  | 'outline'
  /** Inverted fill: one tag per group that names the current selection. */
  | 'solid'
  /** Platform-gray fill: a neutral fact with no status meaning. */
  | 'neutral'
  /** Text only, no fill: a fact stated more quietly than `neutral`. */
  | 'quiet'
  /** Tinted green: a healthy or enabled state. */
  | 'success'
  /** Tinted blue: informational classification, not health. */
  | 'info'
  /** Tinted amber: attention needed, not yet a failure. */
  | 'warning'
  /** Tinted red: a failure. */
  | 'danger'

/**
 * Render a read-only tag.
 * @param props.tone - which palette to use (default `outline`).
 * @param props.className - extra class for layout placement.
 * @param props.children - the localized label, owned by the render site.
 * @returns the tag element.
 */
export function Tag({ tone = 'outline', className, children, 'data-testid': dataTestId }: {
  tone?: TagTone
  // `| undefined` so a caller can forward an optional class straight through
  // under exactOptionalPropertyTypes (a CSS-module lookup is string|undefined).
  className?: string | undefined
  children?: ReactNode
  /** 本仓新增：调用方可覆写的稳定测试锚点（Q5 判「样式真的生效」时用）。 */
  'data-testid'?: string | undefined
}) {
  // `data-vendored="tag"` 是本仓新增的稳定锚：类名被 CSS Modules hash 掉，测试不该猜它。
  return <span className={cx(css.tag, className)} data-tone={tone} data-vendored="tag" data-testid={dataTestId}>{children}</span>
}
