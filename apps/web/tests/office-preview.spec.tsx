import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeQueryClient } from '../src/app/query-client.js'
import { OfficePreview } from '../src/features/task/OfficePreview.js'
import { installFetch, ok, type MockHandler } from './fixtures.js'

const ID = '00000000-0000-4000-8000-000000000441'
const SHA = 'a'.repeat(64)
const artifact = {
  id: ID,
  title: '方案.docx',
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sha256: SHA,
}

function preview(status: 'none' | 'ready' | 'failed', overrides: Record<string, unknown> = {}) {
  return {
    artifactId: ID,
    status,
    sourceSha256: status === 'none' ? null : SHA,
    converter: status === 'none' ? null : 'libreoffice',
    mediaType: status === 'ready' ? 'application/pdf' : null,
    byteSize: status === 'ready' ? 30 : null,
    failureReason: status === 'failed' ? 'CONVERTER_UNAVAILABLE' : null,
    updatedAt: status === 'none' ? null : '2026-10-26T01:00:00.000Z',
    ...overrides,
  }
}

function mount(info: () => unknown, extra: MockHandler[] = []) {
  const fetchMock = installFetch([
    { method: 'GET', url: /\/preview-info$/, respond: () => ok(info()) },
    ...extra,
  ])
  const queryClient = makeQueryClient({ retry: false })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <OfficePreview artifact={artifact} />
    </QueryClientProvider>,
  )
  return { ...result, queryClient, fetchMock }
}

afterEach(() => vi.restoreAllMocks())

describe('OfficePreview', () => {
  it('历史 none 说明没有预览，保留原件入口；刷新后可读取转换结果', async () => {
    let info = preview('none')
    const { fetchMock } = mount(() => info)
    expect(await screen.findByText(/尚无在线预览/)).toBeVisible()
    expect(screen.getByRole('link', { name: '下载原件' })).toHaveAttribute(
      'href',
      `/api/v1/artifacts/${ID}/content`,
    )
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/preview'))).toBe(false)
    info = preview('ready')
    await userEvent.click(screen.getByRole('button', { name: '刷新预览状态' }))
    expect(await screen.findByRole('button', { name: '查看 Office 预览' })).toBeEnabled()
  })

  it('缺少转换器显示可理解的失败原因，未知原因不会泄漏服务端原文', async () => {
    let info = preview('failed')
    const { queryClient } = mount(() => info)
    expect(await screen.findByText(/未配置 Office 转换组件/)).toBeVisible()
    info = preview('failed', { failureReason: '/private/workspace/secret.docx' })
    await act(() => queryClient.invalidateQueries({ queryKey: ['artifact-review', ID] }))
    expect(await screen.findByText(/无法读取预览状态/)).toBeVisible()
    expect(screen.queryByText(/private\/workspace/)).not.toBeInTheDocument()
  })

  it('isolation suspension explains the download and comment fallback without requesting PDF', async () => {
    const { fetchMock } = mount(() =>
      preview('failed', { failureReason: 'ISOLATION_REQUIRED', converter: 'unknown' }),
    )
    expect(await screen.findByText(/Office 隔离转换尚未开放/)).toBeVisible()
    expect(screen.getByRole('link', { name: '下载原件' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '查看 Office 预览' })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/preview'))).toBe(false)
  })

  it('ready 按需从受控接口加载 PDF，并释放阅读副本', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:office-preview')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const { fetchMock, unmount } = mount(
      () => preview('ready'),
      [
        {
          method: 'GET',
          url: /\/preview$/,
          respond: () =>
            new Response('%PDF-1.7\npreview', { headers: { 'content-type': 'application/pdf' } }),
        },
      ],
    )
    await userEvent.click(await screen.findByRole('button', { name: '查看 Office 预览' }))
    expect(await screen.findByTitle('方案.docx 的只读 PDF 预览')).toHaveAttribute(
      'src',
      'blob:office-preview',
    )
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/artifacts/${ID}/preview`,
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(create).toHaveBeenCalledOnce()
    expect(screen.getByText(/只读阅读副本/)).toBeVisible()
    unmount()
    expect(revoke).toHaveBeenCalledWith('blob:office-preview')
  })

  it.each([
    ['没有读取权限', () => new Response('', { status: 403 })],
    [
      '返回非 PDF 内容',
      () => new Response('<html>错误</html>', { headers: { 'content-type': 'text/html' } }),
    ],
  ])('%s时不嵌入内容，保留下载与重试', async (_name, response) => {
    mount(() => preview('ready'), [{ method: 'GET', url: /\/preview$/, respond: response }])
    await userEvent.click(await screen.findByRole('button', { name: '查看 Office 预览' }))
    expect(await screen.findByText(/预览读取失败/)).toBeVisible()
    expect(screen.queryByTitle(/只读 PDF 预览/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '下载原件' })).toBeVisible()
    expect(screen.getByRole('button', { name: '重试读取预览' })).toBeEnabled()
  })

  it('元数据与当前原件版本不一致时拒绝显示', async () => {
    mount(() => preview('ready', { sourceSha256: 'b'.repeat(64) }))
    expect(await screen.findByText(/无法读取预览状态/)).toBeVisible()
    expect(screen.queryByRole('button', { name: '查看 Office 预览' })).not.toBeInTheDocument()
  })

  it('超出预览上限的元数据不触发内容读取', async () => {
    const { fetchMock } = mount(() => preview('ready', { byteSize: 52_428_801 }))
    expect(await screen.findByText(/无法读取预览状态/)).toBeVisible()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('预览信息拒绝访问时不请求 PDF', async () => {
    const fetchMock = installFetch([
      {
        method: 'GET',
        url: /\/preview-info$/,
        respond: () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: { code: 'NOT_FOUND', message: 'not found', requestId: 'test' },
            }),
            { status: 404 },
          ),
      },
    ])
    const queryClient = makeQueryClient({ retry: false })
    render(
      <QueryClientProvider client={queryClient}>
        <OfficePreview artifact={artifact} />
      </QueryClientProvider>,
    )
    expect(await screen.findByText(/无法读取预览状态/)).toBeVisible()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('非 Office 不增加请求或替代文本预览', async () => {
    const fetchMock = installFetch([])
    const queryClient = makeQueryClient({ retry: false })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <OfficePreview artifact={{ ...artifact, mediaType: 'text/markdown' }} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
