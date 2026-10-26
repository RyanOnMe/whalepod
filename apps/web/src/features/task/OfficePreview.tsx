/**
 * Office 只读阅读副本（#441）：沿用原件身份与 Session 权限，不生成新版本。
 * 只在用户展开时取 PDF；未知/失败/历史 none 均保留原件入口。
 */
import { useQuery } from '@tanstack/react-query'
import { ARTIFACT_PREVIEW_MAX_BYTES, ArtifactPreviewViewSchema } from '@whalepod/protocol'
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import './OfficePreview.css'

const OFFICE_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

export function isOfficePreviewable(mediaType: string): boolean {
  return OFFICE_TYPES.has(mediaType.toLowerCase().split(';')[0]?.trim() ?? '')
}

interface PreviewArtifact {
  id: string
  title: string
  mediaType: string
  sha256: string
}

const FAILURE_LABELS: Readonly<Record<string, string>> = {
  CONVERTER_UNAVAILABLE: '未配置 Office 转换组件，暂时无法生成预览。',
  CONVERT_TIMEOUT: 'Office 预览转换超时。',
  CONVERT_FAILED: 'Office 预览转换失败。',
  PREVIEW_TOO_LARGE: '转换后的预览过大，无法在线读取。',
}

type PdfState = { key: string; kind: 'ready'; url: string } | { key: string; kind: 'error' } | null

export function OfficePreview({ artifact }: { artifact: PreviewArtifact }): ReactNode {
  const supported = isOfficePreviewable(artifact.mediaType)
  const [expanded, setExpanded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [pdf, setPdf] = useState<PdfState>(null)
  const info = useQuery({
    // 复用 artifact.changed 的既有前缀失效，不额外订阅团队事件。
    queryKey: ['artifact-review', artifact.id, 'office-preview', artifact.sha256],
    enabled: supported,
    queryFn: async () => {
      const view = ArtifactPreviewViewSchema.parse(
        await api.get(`/artifacts/${artifact.id}/preview-info`),
      )
      if (
        view.artifactId !== artifact.id ||
        (view.status !== 'none' && view.sourceSha256 !== artifact.sha256) ||
        (view.status === 'ready' &&
          (view.mediaType !== 'application/pdf' ||
            view.byteSize === null ||
            view.byteSize < 1 ||
            view.byteSize > ARTIFACT_PREVIEW_MAX_BYTES))
      ) {
        throw new Error('preview does not match original')
      }
      return view
    },
    // 候选没有团队事件。可见页最多等待约一分钟，避免历史 none 永久轮询。
    refetchInterval: (query) =>
      query.state.data?.status === 'none' && query.state.dataUpdateCount < 12 ? 5_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  })
  const ready = supported && !info.isError && info.data?.status === 'ready'
  const key = `${artifact.id}:${artifact.sha256}:${info.data?.updatedAt ?? ''}`

  useEffect(() => {
    if (!ready || !expanded) return
    const controller = new AbortController()
    let objectUrl: string | undefined
    let disposed = false
    void (async () => {
      try {
        // 不直接给 iframe 一个可能返回登录页/错误页的 URL：先校验受控读取结果。
        const response = await fetch(`/api/v1/artifacts/${artifact.id}/preview`, {
          credentials: 'include',
          signal: controller.signal,
        })
        if (
          !response.ok ||
          response.headers.get('content-type')?.split(';')[0] !== 'application/pdf'
        ) {
          throw new Error('preview unavailable')
        }
        const blob = await response.blob()
        if (blob.size === 0 || blob.size > ARTIFACT_PREVIEW_MAX_BYTES) {
          throw new Error('preview size unavailable')
        }
        if (disposed) return
        objectUrl = URL.createObjectURL(blob)
        setPdf({ key, kind: 'ready', url: objectUrl })
      } catch {
        if (!disposed) setPdf({ key, kind: 'error' })
      }
    })()
    return () => {
      disposed = true
      controller.abort()
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
    }
  }, [artifact.id, ready, expanded, key, attempt])

  if (!supported) return null
  const current = pdf?.key === key ? pdf : null
  return (
    <section className="office-preview" aria-label="Office 只读预览" data-testid="office-preview">
      {info.isPending ? (
        <p role="status">正在查询 Office 预览…</p>
      ) : info.isError ? (
        <p role="alert">无法读取预览状态；请确认仍有文件权限，或稍后重试。</p>
      ) : info.data.status === 'none' ? (
        <p>尚无在线预览；新文件可能仍在转换，历史文件不会自动补生成。可下载原件查看。</p>
      ) : info.data.status === 'failed' ? (
        <p>
          {FAILURE_LABELS[info.data.failureReason ?? ''] ?? 'Office 预览转换失败。'}可下载原件查看。
        </p>
      ) : (
        <>
          <p className="mutation-hint">
            只读阅读副本 · 内容摘要 {artifact.sha256.slice(0, 12)}
            。批注请针对原件版本；当前支持整件批注。
          </p>
          {!expanded ? (
            <button type="button" className="button" onClick={() => setExpanded(true)}>
              查看 Office 预览
            </button>
          ) : current?.kind === 'error' ? (
            <div role="alert">
              <p>预览读取失败；请确认文件权限，或下载原件查看。</p>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setPdf(null)
                  setAttempt((value) => value + 1)
                }}
              >
                重试读取预览
              </button>
            </div>
          ) : current?.kind === 'ready' ? (
            <>
              <iframe
                className="office-preview-frame"
                title={`${artifact.title} 的只读 PDF 预览`}
                src={current.url}
              />
              <p className="mutation-hint">如果浏览器无法显示 PDF，请下载原件查看。</p>
            </>
          ) : (
            <p role="status">正在读取 Office 预览…</p>
          )}
        </>
      )}
      <div className="artifact-actions">
        <a className="button" href={`/api/v1/artifacts/${artifact.id}/content`}>
          下载原件
        </a>
        <button
          type="button"
          className="button button-quiet"
          disabled={info.isFetching}
          onClick={() => void info.refetch()}
        >
          刷新预览状态
        </button>
      </div>
    </section>
  )
}
