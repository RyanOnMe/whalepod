/**
 * Plugin Pack 组装（02 Task 17 Step 7）：从已安装列表勾选组装不可变 Pack。
 *
 * - GET /plugin-packs 展示现有 Pack（entries 与 packDigest 短摘要）；长标识（Pack ID
 *   与摘要）**一律**短码展示 + title 给全值 + 一键复制，供 Agent Revision 表单按 Pack
 *   选用（复制失败如实报错，不伪造「已复制」）。#167 之前这里只有 Pack ID 是这套范式，
 *   摘要还额外铺了一行 64 位十六进制当正文（截图实测一行 64 个字符）。
 * - POST /plugin-packs 创建（Owner/Admin 才有表单；Member 只读）；空选择禁止
 *   提交（按钮禁用），请求体与 protocol 的 PluginPackCreateRequest 对齐；
 * - Pack 创建后不修改任何已有 Agent Revision：指引去 Agent 管理为已有 Agent
 *   新建 Revision 并选择该 Pack（/agents 详情页提供「新建 Revision」入口，链接直达）；
 * - 未审核（trust=unreviewed）或未完成安装的插件不能进入普通 Pack（03 §2.5），
 *   勾选框禁用并给出原因，不伪造可选项。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import type {
  PluginInstallationView,
  PluginPackCreateRequest,
  PluginPackView,
} from '@whalepod/protocol'
import { api } from '../../shared/api/client.js'
import { CopyButton } from '../../shared/CopyButton.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { shortDigest, shortId } from '../../shared/format.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import type { Session } from '../../shared/api/types.js'
import { queryKeys } from '../../app/query-client.js'

export interface PluginPackEditorProps {
  session: Session | null
}

export function PluginPackEditor({ session }: PluginPackEditorProps): ReactNode {
  const queryClient = useQueryClient()
  const canManage = session !== null && (session.role === 'owner' || session.role === 'admin')
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)

  const packsQuery = useQuery({
    queryKey: queryKeys.pluginPacks,
    queryFn: () => api.get<PluginPackView[]>('/plugin-packs'),
  })
  const installationsQuery = useQuery({
    queryKey: queryKeys.pluginInstallations,
    queryFn: () => api.get<PluginInstallationView[]>('/plugins/installations'),
  })

  const createPack = useMutation({
    mutationFn: (request: PluginPackCreateRequest) =>
      api.mutate<PluginPackView>('/plugin-packs', { body: request }),
    onSuccess: (pack) => {
      setName('')
      setSelected(new Set())
      setNotice(
        `Pack「${pack.name}」已创建：不影响已有 Agent Revision——请在 Agent 管理打开目标 Agent 详情，点「新建 Revision」，并在表单中选择该 Pack。`,
      )
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginPacks })
    },
    onError: () => {
      setNotice(null)
    },
  })

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (createPack.isPending || selected.size === 0) return
    setNotice(null)
    createPack.mutate({ name: name.trim(), installationIds: [...selected] })
  }

  return (
    <section className="plugins-layout" aria-labelledby="plugin-packs-heading">
      <h2 id="plugin-packs-heading">插件组合（Pack）</h2>

      {packsQuery.isPending ? <p className="mutation-hint">正在加载 Packs…</p> : null}
      {packsQuery.isError ? <ErrorBanner error={packsQuery.error} /> : null}
      {packsQuery.isSuccess && packsQuery.data.length === 0 ? (
        <p className="empty-state">还没有 Pack。创建后可在 Agent Revision 中选择。</p>
      ) : null}
      {packsQuery.isSuccess && packsQuery.data.length > 0 ? (
        <ul className="plugin-list" role="list">
          {packsQuery.data.map((pack) => (
            <li key={pack.id}>
              <PackCard pack={pack} />
            </li>
          ))}
        </ul>
      ) : null}

      {canManage ? (
        <form className="card plugin-pack-form" onSubmit={submit} aria-label="新建 Plugin Pack">
          <h3>新建插件组合</h3>
          {installationsQuery.isPending ? (
            <p className="mutation-hint">正在加载已安装插件…</p>
          ) : null}
          {installationsQuery.isError ? <ErrorBanner error={installationsQuery.error} /> : null}
          {installationsQuery.isSuccess && installationsQuery.data.length === 0 ? (
            <p className="empty-state">
              尚无已安装插件：先在「已安装插件」里安装一个精选（curated）包——只有已安装且已审核的包才能进
              Pack。
            </p>
          ) : null}
          {installationsQuery.isSuccess && installationsQuery.data.length > 0 ? (
            <fieldset className="plugin-pick-fieldset">
              <legend>选择已安装插件</legend>
              <ul className="plugin-pick-list" role="list">
                {installationsQuery.data.map((row) => {
                  const selectable = row.status === 'installed' && row.trust === 'curated'
                  return (
                    <li key={row.id} className="plugin-pick">
                      <label className="plugin-pick-label">
                        <input
                          type="checkbox"
                          checked={selected.has(row.id)}
                          disabled={!selectable || createPack.isPending}
                          onChange={() => toggle(row.id)}
                        />
                        <span className="plugin-name">
                          {row.packageName}@{row.packageVersion}
                        </span>
                      </label>
                      {selectable ? null : (
                        <span className="plugin-pick-reason">
                          {row.status !== 'installed'
                            ? '未完成安装，不能进入 Pack'
                            : '未审核（unreviewed）包不能进入普通 Pack'}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </fieldset>
          ) : null}
          <div className="field">
            <label htmlFor="plugin-pack-name">Pack 名称</label>
            <input
              id="plugin-pack-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={80}
            />
          </div>
          <div className="form-actions">
            <button
              type="submit"
              className="button button-primary"
              disabled={createPack.isPending || selected.size === 0}
            >
              {createPack.isPending ? '创建中…' : '创建 Pack'}
            </button>
            {selected.size === 0 ? (
              <span className="field-hint">至少勾选一个已安装插件。</span>
            ) : null}
          </div>
          {notice !== null ? (
            <div className="success-banner" role="status">
              <p>{notice}</p>
              <p>
                <Link to="/agents">去 Agent 管理新建 Revision</Link>
              </p>
            </div>
          ) : null}
          {createPack.isError ? <ErrorBanner error={createPack.error} /> : null}
        </form>
      ) : null}
    </section>
  )
}

/**
 * Pack 卡：长标识（Pack ID / Pack Digest）一律短码展示 + title 全值 + 一键复制；
 * 成员插件展开列出。
 *
 * #167：原来「Pack Digest」与「完整 Digest」是两行——后者把 64 位十六进制整串当正文
 * 铺在卡里（截图实测一行 64 个字符）。现在合并成一行：正文只留短摘要，全值走 title
 * 与复制入口。为什么保留全值入口而不是直接删掉：摘要的用途是**核对**（和 node/runtime
 * 日志里的 digest 对比），少了这条路排障就只能靠肉眼数字符；可见性由 title（悬停即得）
 * 与复制按钮承担，不再占用正文。
 */
function PackCard({ pack }: { pack: PluginPackView }): ReactNode {
  return (
    <article className="plugin-card" aria-label={`Pack ${pack.name}`}>
      <div className="plugin-card-head">
        <span className="plugin-name">{pack.name}</span>
        <span className="badge">{pack.entries.length} 个插件</span>
      </div>
      <dl className="revision-meta">
        <div>
          <dt>Pack ID</dt>
          <dd className="plugin-digest-row">
            <code className="plugin-digest" title={pack.id}>
              {shortId(pack.id)}
            </code>
            <CopyValueButton
              value={pack.id}
              label={`复制 ${pack.name} Pack ID`}
              valueLabel="Pack ID"
            />
          </dd>
        </div>
        <div>
          <dt>插件组合摘要（Pack Digest）</dt>
          <dd className="plugin-digest-row">
            <code className="plugin-digest" title={pack.packDigest}>
              {shortDigest(pack.packDigest)}
            </code>
            <CopyValueButton
              value={pack.packDigest}
              label={`复制 ${pack.name} 插件组合摘要`}
              valueLabel="插件组合摘要"
            />
          </dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>
            <RelativeTime iso={pack.createdAt} />
          </dd>
        </div>
      </dl>
      {pack.entries.length > 0 ? (
        <div className="plugin-pack-entries">
          <span className="plugin-capabilities-label">成员插件</span>
          <ul className="plugin-pack-entry-list" role="list">
            {pack.entries.map((pair) => (
              <li key={pair.installation.id} className="plugin-version">
                {pair.entry.name}@{pair.entry.version}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="field-hint">空 Pack（无插件）。</p>
      )}
    </article>
  )
}

/**
 * 一键复制按钮：navigator.clipboard 不可用或写入失败时明确报失败并指向手动
 * 复制入口（#167 起全值在 title 中，正文只有短码），不伪造「已复制」。
 * valueLabel 指明要复制的取值名称（Pack ID / 插件组合摘要），失败提示里会用到。
 * 实现已在 shared/CopyButton（#141 邀请链接复用同一行为与文案）。
 */
function CopyValueButton({
  value,
  label,
  valueLabel,
}: {
  value: string
  label: string
  valueLabel: string
}): ReactNode {
  return <CopyButton value={value} label={label} valueLabel={valueLabel} />
}
