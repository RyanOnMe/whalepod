/**
 * Plugin Pack 下拉选择（P1-17）：数据源 GET /plugin-packs（Member 可读，与
 * 插件页 Pack 列表同一端点与 query key）。替代早期「手工粘贴 Pack UUID」的
 * 降级输入：选项只来自服务端已有 Pack，粘贴不存在的 UUID 无从发生。
 *
 * - 加载/失败态：选项为空（占位项禁用），错误经 ErrorBanner 展示；
 * - 空列表：提示去插件管理先创建 Pack，不伪造选项；
 * - 宿主表单以「未选 Pack 时禁用提交」兜底：disabled 控件不受浏览器
 *   required 约束校验，仅靠 required 拦不住加载/失败态下的误提交。
 */
import { useQuery } from '@tanstack/react-query'
import type { ChangeEvent, ReactNode } from 'react'
import { Link } from 'react-router'
import type { PluginPackView } from '@whalepod/protocol'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { queryKeys } from '../../app/query-client.js'

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

  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    onChange(event.target.value)
  }

  return (
    <>
      <select
        id={id}
        value={value}
        onChange={handleChange}
        required
        disabled={packsQuery.isPending || packsQuery.isError}
      >
        <option value="" disabled>
          {packsQuery.isPending
            ? '正在加载 Packs…'
            : packsQuery.isError
              ? 'Pack 列表加载失败'
              : '请选择 Pack'}
        </option>
        {packsQuery.isSuccess
          ? packsQuery.data.map((pack) => (
              <option key={pack.id} value={pack.id}>
                {pack.name}
              </option>
            ))
          : null}
      </select>
      {packsQuery.isError ? <ErrorBanner error={packsQuery.error} /> : null}
      {packsQuery.isSuccess && packsQuery.data.length === 0 ? (
        <p className="field-hint">
          暂无可用 Pack，请先在 <Link to="/plugins">插件管理</Link> 创建。
        </p>
      ) : null}
    </>
  )
}
