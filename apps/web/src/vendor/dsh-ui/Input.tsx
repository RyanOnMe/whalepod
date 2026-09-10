/**
 * vendored from deepseek-ai/deepseek-harness packages/client/ui-primitives/src/Input.tsx
 * @ c291e7961a515f6d7af9304e7fd1d257929aef26（MIT，见同目录 LICENSE）
 * 本仓改动分两类：①工程口径（`clsx` → `./cx.js`；上游本文件的两个 import 都**不带**
 * 后缀，本仓按 NodeNext 口径补 `.js`）；
 * ②可测性（wrapper span 新增根属性 `data-vendored="input"`、允许调用方覆写 `data-testid`）。
 * ②是 API 面的改动而不是纯格式差异——**视觉与行为未改**，但同步上游时它属于要保留的改动。
 * 注意原生 `<input>` 的属性一个未动：`data-testid` 落在 wrapper 上，取输入框请用
 * `within(getByTestId(...)).getByRole('textbox')`（wrapper 上另带 data-vendored 便于样式断言）。
 */
// Input: single-line text input atom (search boxes, inline forms). Composer
// textareas are NOT this atom — they live with the conversation package.

import type { InputHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx.js'
import css from './Input.module.css'

/**
 * Render a text input with an optional leading icon.
 * @param props.icon - optional 16px leading icon node.
 * @returns wrapper span containing the native input; input attributes pass through.
 */
export function Input({ icon, className, 'data-testid': dataTestId, ...rest }: {
  icon?: ReactNode
  className?: string
  /** 本仓新增：调用方可覆写的稳定测试锚点（Q5 判「样式真的生效」时用）。 */
  'data-testid'?: string | undefined
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    // `data-vendored="input"` 是本仓新增的稳定锚：类名被 CSS Modules hash 掉，
    // 测试只该锚属性，不该猜 hash。
    <span className={cx(css.wrap, className)} data-vendored="input" data-testid={dataTestId}>
      {icon != null && <span className={css.icon}>{icon}</span>}
      <input className={css.input} {...rest} />
    </span>
  )
}
