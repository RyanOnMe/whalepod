/**
 * 相对时间（#152）：**所有用户可见时间**统一走这个组件——正文是相对文案
 * （刚刚 / N 分钟前 / N 小时前 / 昨天 HH:mm / 日期），`title` 保留绝对时间
 * （悬停即可核对准确时刻），`dateTime` 保留机器可读值（无障碍与自动化判据）。
 *
 * 为什么做成组件而不是让 20 多处各写一遍：`title` 一旦漏写，用户就再也拿不到
 * 准确时刻——把「相对显示 + 绝对 title」钉在一个地方，漏不掉。
 */
import type { ReactNode } from 'react'
import { formatIso, formatRelativeTime } from './format.js'

export interface RelativeTimeProps {
  /** ISO 时间；null 呈现占位符（不伪装成「刚刚」）。 */
  iso: string | null
}

export function RelativeTime({ iso }: RelativeTimeProps): ReactNode {
  if (iso === null) return <>—</>
  const absolute = formatIso(iso)
  // 非法串：formatIso 原样返回，这里同样不套 <time>（不给出一个假的时间语义）。
  if (Number.isNaN(new Date(iso).getTime())) return <>{absolute}</>
  return (
    <time dateTime={iso} title={absolute}>
      {formatRelativeTime(iso)}
    </time>
  )
}
