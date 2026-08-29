/**
 * Admin Plugin Settings（02 Task 17 Step 7）：curated catalog 审核摘要 + 已安装
 * 列表 + 安装动作。
 *
 * - 只展示 curated catalog（GET /plugins/catalog）：每条展示精确 version、
 *   integrity 短摘要（title 给全值）、license、review commit 短 sha 与 review
 *   时间、declared capabilities、capabilityClass（legacy_unrestricted 视觉警示）
 *   与 review.status；local-development 包整卡标红。
 * - 安装（POST /plugins/installations）按钮仅 Owner/Admin 可见；Member 只读
 *   （角色取自根 loader 的 session，与 AgentList 同一获取方式）。
 * - 安装成功不自动修改任何已有 Agent Revision：UI 只提示「只对之后新建的
 *   Pack / Revision 生效」（验收点，不做任何静默联动）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import type {
  PluginCapability,
  PluginCapabilityClass,
  PluginCatalogEntryView,
  PluginInstallationView,
  PluginInstallRequest,
  PluginReviewStatus,
  PluginStatus,
} from '@project311/protocol'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { formatIso, shortDigest, shortSha } from '../../shared/format.js'
import type { Session } from '../../shared/api/types.js'
import { queryKeys } from '../../app/query-client.js'

export interface PluginSettingsProps {
  session: Session | null
}

export function PluginSettings({ session }: PluginSettingsProps): ReactNode {
  const queryClient = useQueryClient()
  const canManage = session !== null && (session.role === 'owner' || session.role === 'admin')
  const [notice, setNotice] = useState<string | null>(null)

  const catalogQuery = useQuery({
    queryKey: queryKeys.pluginCatalog,
    queryFn: () => api.get<PluginCatalogEntryView[]>('/plugins/catalog'),
  })
  const installationsQuery = useQuery({
    queryKey: queryKeys.pluginInstallations,
    queryFn: () => api.get<PluginInstallationView[]>('/plugins/installations'),
  })

  const install = useMutation({
    mutationFn: (request: PluginInstallRequest) =>
      api.mutate<PluginInstallationView>('/plugins/installations', { body: request }),
    onSuccess: (installation) => {
      setNotice(
        `${installation.packageName}@${installation.packageVersion} 安装成功：不影响已有 Agent Revision——该插件只对之后新建的 Pack / Revision 生效。`,
      )
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstallations })
    },
    onError: () => {
      setNotice(null)
    },
  })

  // 已安装（status=installed）的 name@version 集合：目录内的同包同版本显示已安装。
  const installedKeys = new Set(
    installationsQuery.isSuccess
      ? installationsQuery.data
          .filter((row) => row.status === 'installed')
          .map((row) => `${row.packageName}@${row.packageVersion}`)
      : [],
  )

  return (
    <section className="plugins-layout" aria-labelledby="plugin-settings-heading">
      <h2 id="plugin-settings-heading">插件目录</h2>
      {canManage ? null : (
        <p className="mutation-hint">
          你是 {session?.role}，插件目录只读；仅 Owner/Admin 可安装插件或创建 Pack。
        </p>
      )}
      {notice !== null ? (
        <div className="success-banner" role="status">
          <p>{notice}</p>
        </div>
      ) : null}
      {install.isError ? <ErrorBanner error={install.error} /> : null}

      {catalogQuery.isPending ? <p className="mutation-hint">正在加载插件目录…</p> : null}
      {catalogQuery.isError ? <ErrorBanner error={catalogQuery.error} /> : null}
      {catalogQuery.isSuccess && catalogQuery.data.length === 0 ? (
        <p className="empty-state">curated 目录暂无插件。</p>
      ) : null}
      {catalogQuery.isSuccess && catalogQuery.data.length > 0 ? (
        <ul className="plugin-list" role="list">
          {catalogQuery.data.map((entry) => {
            const installed = installedKeys.has(`${entry.name}@${entry.version}`)
            return (
              <li key={`${entry.name}@${entry.version}`}>
                <CatalogCard
                  entry={entry}
                  installed={installed}
                  canManage={canManage}
                  installPending={install.isPending}
                  onInstall={() => {
                    setNotice(null)
                    install.mutate({ name: entry.name, version: entry.version })
                  }}
                />
              </li>
            )
          })}
        </ul>
      ) : null}

      <h2>已安装插件</h2>
      {installationsQuery.isPending ? <p className="mutation-hint">正在加载安装列表…</p> : null}
      {installationsQuery.isError ? <ErrorBanner error={installationsQuery.error} /> : null}
      {installationsQuery.isSuccess && installationsQuery.data.length === 0 ? (
        <p className="empty-state">尚未安装任何插件。</p>
      ) : null}
      {installationsQuery.isSuccess && installationsQuery.data.length > 0 ? (
        <ul className="plugin-list" role="list">
          {installationsQuery.data.map((row) => (
            <li key={row.id}>
              <InstallationCard installation={row} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/** 目录条目卡：审核摘要全要素；local-development 整卡标红。 */
function CatalogCard(props: {
  entry: PluginCatalogEntryView
  installed: boolean
  canManage: boolean
  installPending: boolean
  onInstall: () => void
}): ReactNode {
  const { entry, installed, canManage, installPending, onInstall } = props
  const isLocal = entry.review.status === 'local-development'
  return (
    <article
      className={`plugin-card${isLocal ? ' plugin-card-local' : ''}`}
      aria-label={`${entry.name} ${entry.version}`}
    >
      <div className="plugin-card-head">
        <span className="plugin-name">{entry.name}</span>
        <span className="plugin-version">{entry.version}</span>
        <ReviewStatusBadge status={entry.review.status} />
        <CapabilityClassBadge capabilityClass={entry.capabilityClass} />
      </div>
      <dl className="revision-meta">
        <div>
          <dt>Integrity</dt>
          <dd>
            <code className="plugin-digest" title={entry.integrity}>
              {shortDigest(entry.integrity)}
            </code>
          </dd>
        </div>
        <div>
          <dt>License</dt>
          <dd>{entry.license}</dd>
        </div>
        <div>
          <dt>Review</dt>
          <dd>
            <code title={entry.review.commit}>{shortSha(entry.review.commit)}</code> ·{' '}
            <time dateTime={entry.review.at}>{formatIso(entry.review.at)}</time>
          </dd>
        </div>
        <div>
          <dt>依赖闭包 Digest</dt>
          <dd>
            <code className="plugin-digest" title={entry.dependencyLockDigest}>
              {shortDigest(entry.dependencyLockDigest)}
            </code>
          </dd>
        </div>
      </dl>
      <CapabilityList capabilities={entry.capabilities} />
      {isLocal ? (
        <p className="plugin-local-warning">
          本地开发包（local-development）：未经完整审核，仅在 Hub 显式开启 dev mode
          时可安装；不能进入普通 Pack。
        </p>
      ) : null}
      {canManage ? (
        <div className="form-actions">
          <button
            type="button"
            className="button button-primary"
            aria-label={`安装 ${entry.name}`}
            disabled={installPending || installed}
            onClick={onInstall}
          >
            {installed ? '已安装' : '安装'}
          </button>
        </div>
      ) : null}
    </article>
  )
}

/** 安装行卡（plugin_installation 视图，capabilities 为安装时 manifest 快照）。 */
function InstallationCard({ installation }: { installation: PluginInstallationView }): ReactNode {
  const statusLabel: Readonly<Record<PluginStatus, string>> = {
    installed: '已安装',
    disabled: '已停用',
    failed: '安装失败',
  }
  return (
    <article
      className="plugin-card"
      aria-label={`已安装 ${installation.packageName} ${installation.packageVersion}`}
    >
      <div className="plugin-card-head">
        <span className="plugin-name">{installation.packageName}</span>
        <span className="plugin-version">{installation.packageVersion}</span>
        <span className={`badge badge-plugin-status-${installation.status}`}>
          {statusLabel[installation.status]}
        </span>
        <span className="badge">{installation.trust}</span>
        <CapabilityClassBadge capabilityClass={installation.capabilityClass} />
      </div>
      <dl className="revision-meta">
        <div>
          <dt>Integrity</dt>
          <dd>
            <code className="plugin-digest" title={installation.integrity}>
              {shortDigest(installation.integrity)}
            </code>
          </dd>
        </div>
        <div>
          <dt>依赖闭包 Digest</dt>
          <dd>
            <code className="plugin-digest" title={installation.dependencyLockDigest}>
              {shortDigest(installation.dependencyLockDigest)}
            </code>
          </dd>
        </div>
        <div>
          <dt>安装时间</dt>
          <dd>
            <time dateTime={installation.createdAt}>{formatIso(installation.createdAt)}</time>
          </dd>
        </div>
      </dl>
      <CapabilityList capabilities={installation.capabilities} />
    </article>
  )
}

const REVIEW_STATUS_LABEL: Readonly<Record<PluginReviewStatus, string>> = {
  reviewed: 'reviewed（已审核）',
  unreviewed: 'unreviewed（未审核）',
  'local-development': 'local-development（本地开发）',
}

function ReviewStatusBadge({ status }: { status: PluginReviewStatus }): ReactNode {
  return (
    <span className={`badge badge-plugin-review-${status}`}>{REVIEW_STATUS_LABEL[status]}</span>
  )
}

const CAPABILITY_CLASS_LABEL: Readonly<Record<PluginCapabilityClass, string>> = {
  declared: 'declared（能力已声明）',
  // 02 Step 7：legacy_unrestricted 必须有视觉警示（文字 + 危险色，不只靠颜色）。
  legacy_unrestricted: 'legacy_unrestricted：未声明能力，运行不受限',
}

function CapabilityClassBadge({
  capabilityClass,
}: {
  capabilityClass: PluginCapabilityClass
}): ReactNode {
  return (
    <span
      className={`badge${capabilityClass === 'legacy_unrestricted' ? ' badge-plugin-legacy' : ''}`}
    >
      {CAPABILITY_CLASS_LABEL[capabilityClass]}
    </span>
  )
}

function CapabilityList({
  capabilities,
}: {
  capabilities: readonly PluginCapability[]
}): ReactNode {
  if (capabilities.length === 0) {
    return <p className="field-hint">未声明能力。</p>
  }
  return (
    <div className="plugin-capabilities-row">
      <span className="plugin-capabilities-label">声明能力</span>
      <ul className="plugin-capabilities" role="list">
        {capabilities.map((capability) => (
          <li key={capability} className="badge">
            {capability}
          </li>
        ))}
      </ul>
    </div>
  )
}
