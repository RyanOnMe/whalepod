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
  // 默认为中性措辞：这个组件被邀请链接（MembersPage）等多处复用，写死「完整 digest」
  // 会让「复制邀请链接失败」提示成「请手动复制完整 digest」——错文案（#167 一审指出）。
  // 调用方给 valueLabel 时以调用方为准；不给时只说"这个值"，不说错名。
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
