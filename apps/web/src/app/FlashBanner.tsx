/**
 * 一次性提示条（#141）：显示 shared/flash 里刚写入的「已加入 <团队名>」这类事实，
 * 显示一次即清除（同一标签页内跨路由存活，刷新不复活）。
 *
 * 刻意**不**用 role="status"：多处既有用例用可访问名 `findByRole('status')` 等
 * 局部反馈（复制成功提示），根布局常驻一个 status 会让那些断言先命中提示条而变脆。
 * 视觉上仍是绿底确认条，文案本身可被文本查询断言。
 */
import { useState, type ReactNode } from 'react'
import { takeFlash } from '../shared/flash.js'

export function FlashBanner(): ReactNode {
  const [message] = useState<string | null>(() => takeFlash())
  if (message === null) return null
  return (
    <p className="success-banner app-flash" aria-live="polite">
      {message}
    </p>
  )
}
