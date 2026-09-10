/**
 * Plugin Pack 下拉选择（P1-17）：数据源 GET /plugin-packs（Member 可读，与
 * 插件页 Pack 列表同一端点与 query key）。替代早期「手工粘贴 Pack UUID」的
 * 降级输入：选项只来自服务端已有 Pack，粘贴不存在的 UUID 无从发生。
 *
 * - 加载/失败态：没有可选项，控件禁用，文案如实说明（占位文字本身就是状态提示）；
 *   错误经 ErrorBanner 展示；
 * - 空列表：提示去插件管理先创建 Pack（链接那条 hint 一个就够，不重复两句），不伪造选项；
 * - 宿主表单以「未选 Pack 时禁用提交」兜底。
 *   **#158 起这条兜底是唯一拦截**：控件从原生 `<select required>` 换成按钮触发器
 *   （见 shared/SelectMenu.tsx 文件头「已知缺口」），按钮不是表单可校验元素，原生
 *   `required` 的浏览器校验随之消失，而 `aria-required` 在 `role=button` 上又不会被
 *   播报（ARIA 1.2 白名单不含 button）——所以既没有浏览器校验也没有读屏必填语义，
 *   只剩这条守卫。别以为 required 还在把关。
 */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { PluginPackView } from '@whalepod/protocol'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { queryKeys } from '../../app/query-client.js'
import { SelectMenu } from '../../shared/SelectMenu.js'

export interface PackSelectProps {
  id: string
  value: string
  onChange: (packId: string) => void
}

export function PackSelect({ id, value, onChange }: PackSelectProps): ReactNode {
  const packsQuery = useQuery({
    queryKey: queryKeys.pluginPacks,
    queryFn: () => api.get<PluginPackView[]>('/plugin-packs'),
  })

  const packs = packsQuery.data ?? []
  const placeholder = packsQuery.isPending
    ? '正在加载 Packs…'
    : packsQuery.isError
      ? 'Pack 列表加载失败'
      : packs.length === 0
        ? '没有可选 Pack'
        : '请选择 Pack'

  return (
    <>
      <SelectMenu
        id={id}
        // #167：标签中文优先（CONTEXT.md 的正式领域词保留在括号里）；#158 之后这个
        // label 是 PackSelect 唯一的可见文案来源（表单里不再有第二个 <label>），
        // 所以 #167 的中文化必须落在这里，而不是调用点的表单里。
        label="插件组合（Plugin Pack）"
        value={value}
        placeholder={placeholder}
        options={packs.map((pack) => ({ value: pack.id, label: pack.name, disabled: false }))}
        onChange={onChange}
        disabled={packsQuery.isPending || packsQuery.isError || packs.length === 0}
      />
      {packsQuery.isError ? <ErrorBanner error={packsQuery.error} /> : null}
      {packsQuery.isSuccess && packs.length === 0 ? (
        <p className="field-hint">
          去 <Link to="/plugins">插件管理</Link> 创建 Pack，回到这里即可选择。
        </p>
      ) : null}
    </>
  )
}
