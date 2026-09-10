/**
 * 设备页（#142）：签发一次性配对码 + 本团队设备列表（02 Task 7 Step 5；03 §2.4/§4）。
 *
 * 此前这里只有 CLI 教学文案，第二步写着「生成一次性配对码（后续版本提供）」——
 * 真人读到这一步没有控件可点，只能开 DevTools 手搓 fetch 才拿得到码（alpha.4
 * 演示实录）。现在这三件事都在页面上：
 * - 「生成配对码」→ POST /devices/pairing-codes：明文（六组 base32）+ 10 分钟
 *   倒计时 + 一键复制，并明说「此码只显示一次」（Hub 只存 SHA-256，与 CLI 的
 *   shown once 同语义）；过期后明文撤下、给出重新生成入口；
 * - 设备列表 → GET /devices（queryKeys.devices）：名称/在线状态/最后心跳。配对
 *   成功后 Hub 扇出 device.changed，event-router 失效 ['devices'] → 新设备无需
 *   刷新即出现在本页；
 * - 失败一律走统一 ErrorBanner（Hub 的 message + requestId），不把裸错误码搬上屏。
 *
 * 已知缺口（不在本页伪造入口）：Hub 没有「撤销未使用配对码」接口（03 §4 只有
 * DELETE /devices/:deviceId 撤销设备），已签发未使用的码只能等 10 分钟自然过期。
 *
 * #138：设备状态的呈现改用 vendored DSH 原语（src/vendor/dsh-ui 的 StateDot + Tag）。
 * 只换渲染层，文案仍是 DEVICE_STATUS_LABEL 的「在线/离线/已撤销」（#142 的用例按文本
 * 断言），配色语义与替换前一一对应：online 绿 / offline 琥珀 / revoked 红。
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../shared/api/client.js'
import { ErrorBanner } from '../app/ErrorBanner.js'
import { queryKeys } from '../app/query-client.js'
import { DEVICE_STATUS_LABEL, formatCountdown, formatIso } from '../shared/format.js'
import { StateDot, Tag, type StateDotState, type TagTone } from '../vendor/dsh-ui/index.js'
import type { DeviceView, PairingCodeView } from '../shared/api/types.js'

/**
 * 设备状态 → 原语语义（#138）。两个表分开写：StateDot 的状态语义（done/warning/
 * error）与 Tag 的色调（success/warning/danger）不是同一套词表，硬凑成一个映射会让
 * 以后换色调时看起来像在改状态判定。
 */
const DEVICE_STATE_DOT: Readonly<Record<DeviceView['status'], StateDotState>> = {
  online: 'done',
  offline: 'warning',
  revoked: 'error',
}

const DEVICE_STATE_TONE: Readonly<Record<DeviceView['status'], TagTone>> = {
  online: 'success',
  offline: 'warning',
  revoked: 'danger',
}

/**
 * 状态标记：色块（StateDot，aria-hidden）+ 文字（Tag）。
 * 两者都给，不能只靠颜色传达状态——StateDot 自身对读屏不可见，语义由 Tag 的文案承担。
 *
 * `data-testid="device-status"` 是本处稳定锚点（Q5 定位「这行状态」用）；**不在这里重复
 * 挂 `data-vendored`**：两个 vendored 组件各自在根元素上带 `data-vendored="state-dot"` /
 * `"tag"`，外层再挂一次会让 `[data-vendored="tag"]` 一行匹配到两个元素（Playwright
 * strict 模式直接判失败），也分不清命中的是不是真带 hash 类名的那个元素。
 *
 * `device-status-<status>` 修饰类只做一件事：把该状态的语义 token 局部重映射到上游 900
 * 档深色，让 vendored 组件自己解析到满足 WCAG AA 的颜色（为什么与实测对比度见
 * global.css 的「AA 重映射」注释）。基类与修饰类都在外层挂，两个 vendored 组件一个字不改。
 */
function DeviceStatus({ status }: { status: DeviceView['status'] }): ReactNode {
  return (
    <span className={`device-status device-status-${status}`} data-testid="device-status">
      <StateDot state={DEVICE_STATE_DOT[status]} />
      <Tag tone={DEVICE_STATE_TONE[status]}>{DEVICE_STATUS_LABEL[status]}</Tag>
    </span>
  )
}

export function DevicesPage(): ReactNode {
  const listQuery = useQuery({
    queryKey: queryKeys.devices,
    queryFn: () => api.get<DeviceView[]>('/devices'),
  })
  const [issued, setIssued] = useState<PairingCodeView | null>(null)
  const issue = useMutation({
    mutationFn: () => api.mutate<PairingCodeView>('/devices/pairing-codes'),
    onSuccess: (pairingCode) => setIssued(pairingCode),
  })

  return (
    <div className="devices-page">
      <h1>设备</h1>
      <PairingCodePanel
        issued={issued}
        issuing={issue.isPending}
        error={issue.isError ? issue.error : null}
        onIssue={() => issue.mutate()}
      />
      <section className="card devices-list" aria-labelledby="devices-list-heading">
        <h2 id="devices-list-heading">已配对设备</h2>
        {listQuery.isPending ? <p className="mutation-hint">正在加载设备…</p> : null}
        {listQuery.isError ? <ErrorBanner error={listQuery.error} /> : null}
        {listQuery.isSuccess && listQuery.data.length === 0 ? (
          <p className="empty-state">
            还没有设备——先点上方「生成配对码」，再按下方 CLI
            步骤在成员本机完成配对；配对成功后设备会自动出现在这里，不用刷新。
          </p>
        ) : null}
        {listQuery.isSuccess && listQuery.data.length > 0 ? (
          <ul className="device-list" role="list">
            {listQuery.data.map((device) => (
              <li key={device.id} className="device-item">
                <div className="device-item-head">
                  <h3>{device.name}</h3>
                  <DeviceStatus status={device.status} />
                </div>
                <dl className="device-meta">
                  <div>
                    <dt>平台</dt>
                    <dd>{device.platform}</dd>
                  </div>
                  <div>
                    <dt>最后心跳</dt>
                    <dd>{formatIso(device.lastSeenAt)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <CliSteps />
    </div>
  )
}

function PairingCodePanel({
  issued,
  issuing,
  error,
  onIssue,
}: {
  issued: PairingCodeView | null
  issuing: boolean
  error: unknown
  onIssue: () => void
}): ReactNode {
  return (
    <section className="card devices-pairing" aria-labelledby="devices-pairing-heading">
      <h2 id="devices-pairing-heading">配对码</h2>
      {issued === null ? (
        <>
          <p className="field-hint">
            一次性配对码 10 分钟过期且只能用一次，明文只在生成时显示一次。
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={issuing}
              onClick={onIssue}
            >
              {issuing ? '生成中…' : '生成配对码'}
            </button>
          </div>
        </>
      ) : (
        <IssuedPairingCode issued={issued} issuing={issuing} onRegenerate={onIssue} />
      )}
      {error !== null ? <ErrorBanner error={error} /> : null}
    </section>
  )
}

/**
 * 已签发的配对码：明文只在有效期内呈现（过期即撤下，避免一个用不了的码继续
 * 看着像可用），并如实给出复制成败——不伪造「已复制」。
 */
function IssuedPairingCode({
  issued,
  issuing,
  onRegenerate,
}: {
  issued: PairingCodeView
  issuing: boolean
  onRegenerate: () => void
}): ReactNode {
  const remainingMs = usePairingCountdown(issued.expiresAt)
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const expired = remainingMs <= 0
  const copy = (): void => {
    setCopied('idle')
    const clipboard = navigator.clipboard
    if (clipboard === undefined) {
      // 剪贴板不可用：明文仍在上屏（可手动抄），不假装复制成功。
      setCopied('failed')
      return
    }
    clipboard
      .writeText(issued.code)
      .then(() => setCopied('copied'))
      .catch(() => setCopied('failed'))
  }

  if (expired) {
    return (
      <>
        <p className="device-pairing-expired" role="status">
          配对码已过期，请重新生成。
        </p>
        <p className="field-hint">
          过期或已被使用的码都不能再用。重新生成会请 Hub
          签发一个新码；旧码若仍在有效期内依旧可用——Hub 目前不提供撤销未使用配对码的接口。
        </p>
        <div className="form-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={issuing}
            onClick={onRegenerate}
          >
            {issuing ? '生成中…' : '重新生成配对码'}
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <p className="device-pairing-code" data-testid="pairing-code">
        <code>{issued.code}</code>
      </p>
      <p className="field-hint" role="note">
        此码只显示一次，请立即复制（离开本页或重新生成后，Hub 不再提供明文）。
      </p>
      <p className="device-pairing-countdown" role="timer">
        有效期剩余 {formatCountdown(remainingMs)}
      </p>
      <div className="form-actions">
        <span className="copy-value">
          <button
            type="button"
            className="button button-primary"
            aria-label="复制配对码"
            onClick={copy}
          >
            复制
          </button>
          {copied === 'copied' ? <span role="status">已复制</span> : null}
          {copied === 'failed' ? <span role="status">复制失败，请手动复制配对码</span> : null}
        </span>
        <button
          type="button"
          className="button button-quiet"
          disabled={issuing}
          onClick={onRegenerate}
        >
          {issuing ? '生成中…' : '重新生成配对码'}
        </button>
      </div>
    </>
  )
}

/** 剩余有效期（毫秒）：每秒重算一次，归零后停在 0（不出现负数倒计时）。 */
function usePairingCountdown(expiresAt: string): number {
  const [remainingMs, setRemainingMs] = useState(() => remainingOf(expiresAt))
  useEffect(() => {
    const tick = (): void => setRemainingMs(remainingOf(expiresAt))
    tick() // 首帧与 effect 之间可能已过时间：挂载即对齐一次
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [expiresAt])
  return remainingMs
}

function remainingOf(expiresAt: string): number {
  const deadline = new Date(expiresAt).getTime()
  // 解析不出时间戳就不把码当有效（fail-closed）：Hub 一律回 ISO，出现异常值宁可
  // 让用户重新生成，也不呈现一个有效期未知的码。
  if (Number.isNaN(deadline)) return 0
  return Math.max(0, deadline - Date.now())
}

function CliSteps(): ReactNode {
  return (
    <section className="card devices-cli" aria-labelledby="devices-cli-heading">
      <h2 id="devices-cli-heading">CLI 安装与配对</h2>
      <ol className="cli-steps">
        <li>
          在成员本机安装 CLI：
          <pre>
            <code>npm install -g whalepod-node</code>
          </pre>
        </li>
        <li>
          用上方「生成配对码」拿到一次性码后，在成员本机执行：
          <pre>
            <code>whalepod-node pair --hub &lt;hub-url&gt; --code &lt;code&gt;</code>
          </pre>
        </li>
        <li>
          启动节点守护进程：
          <pre>
            <code>whalepod-node start</code>
          </pre>
        </li>
      </ol>
      <p className="field-hint">
        配对码 10
        分钟过期且只能使用一次；设备凭据只保存在成员本机。配对成功后设备会自动出现在上面的列表里，不用刷新。
      </p>
    </section>
  )
}
