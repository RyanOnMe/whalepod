/**
 * 一键复制按钮（P1-17 从 PluginPackEditor 抽出，供 #141 邀请链接复用）。
 *
 * navigator.clipboard 不可用或写入失败时明确报失败并指向手动复制入口
 * （取值本身始终在页面上可见），**不伪造「已复制」**——复制失败与成功是两种
 * 可区分的用户可见状态（六原语·观测）。
 */
import { useState, type ReactNode } from 'react'

export interface CopyButtonProps {
  /** 要写入剪贴板的完整值。 */
  value: string
  /** 无障碍名称（按钮可访问名，如「复制邀请链接」）。 */
  label: string
  /** 失败提示里指明要手动复制的东西（如「插件组合摘要」「邀请链接」）。 */
  valueLabel?: string
  /** 按钮文本（默认「复制」）；邀请场景给更明确的动作词。 */
  children?: ReactNode
}

export function CopyButton({
  value,
  label,
  // 默认值改成中性措辞（原先写死「完整 digest」）。**如实说明现状**：现有调用点都显式
  // 传了 valueLabel（`MembersPage` 的邀请链接传「邀请链接」、PluginPackEditor 传
  // 「Pack ID」/「插件组合摘要」），所以这个默认值今天**不会**被用在邀请链路上——
  // 它是防御性的：默认值带业务语义，将来新增调用点漏传时就会给出错名的失败提示。
  // 这是 #167 一审的整改（评审指出我原先把它写成了"已存在的 bug"，与事实不符）。
  valueLabel = '这个值',
  children,
}: CopyButtonProps): ReactNode {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = (): void => {
    setCopied('idle')
    navigator.clipboard
      .writeText(value)
      .then(() => setCopied('copied'))
      .catch(() => setCopied('failed'))
  }
  return (
    <span className="copy-value">
      <button type="button" className="button button-quiet" aria-label={label} onClick={copy}>
        {children ?? '复制'}
      </button>
      {copied === 'copied' ? <span role="status">已复制</span> : null}
      {copied === 'failed' ? <span role="status">复制失败，请手动复制{valueLabel}</span> : null}
    </span>
  )
}
