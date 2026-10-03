/**
 * 一次性提示条（#141）：显示 shared/flash 里刚写入的「已加入 <团队名>」这类事实，
 * 显示一次即清除（同一标签页内跨路由存活，刷新不复活）。
 *
 * 刻意**不**用 role="status"：多处既有用例用可访问名 `findByRole('status')` 等
 * 局部反馈（复制成功提示），根布局常驻一个 status 会让那些断言先命中提示条而变脆。
 * 视觉上仍是绿底确认条，文案本身可被文本查询断言。
 *
 * #267：**渲染期只读（peek），提交后再清（effect）**。曾经的 `takeFlash()` 写在
 * `useState` 初始化器里——那是渲染期，而 React 可以丢弃渲染（并发渲染被导航打断时
 * 就会）；消息被吃在渲染期、这次渲染又没提交，用户就什么都没看到（CI 偶发红）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { clearFlash, peekFlash } from '../shared/flash.js'

export function FlashBanner(): ReactNode {
  const [message] = useState<string | null>(() => peekFlash())
  // 显示已提交 → 现在才清（一次性语义不变：显示一次就没了）。
  // 渲染被丢弃时不会走到这里，消息留给下一次挂载——这正是 #267 要的。
  useEffect(() => {
    if (message !== null) clearFlash()
  }, [message])
  if (message === null) return null
  return (
    <p className="success-banner app-flash" aria-live="polite">
      {message}
    </p>
  )
}
