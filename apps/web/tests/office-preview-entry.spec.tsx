/** #441：候选检查与已发布审阅的真实组件/路由接线，HTTP 是唯一替换面。 */
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { makeQueryClient } from '../src/app/query-client.js'
import { ArtifactList } from '../src/features/task/ArtifactList.js'
import {
  ALICE,
  BOB,
  installFetch,
  loggedInHandlers,
  makeArtifact,
  ok,
  teamMembersHandler,
} from './fixtures.js'
import { renderApp } from './render.js'

const ID = '00000000-0000-4000-8000-000000000441'
const TASK_ID = '00000000-0000-4000-8000-000000000442'
const SHA = 'a'.repeat(64)
const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const NONE = {
  artifactId: ID,
  status: 'none',
  sourceSha256: null,
  converter: null,
  mediaType: null,
  byteSize: null,
  failureReason: null,
  updatedAt: null,
}

describe('Office 预览入口', () => {
  it('拥有者候选检查显示 Office 状态和下载回退，发布仍由用户主动确认', async () => {
    installFetch([{ method: 'GET', url: /\/preview-info$/, respond: () => ok(NONE) }])
    const client = makeQueryClient({ retry: false })
    render(
      <QueryClientProvider client={client}>
        <ArtifactList
          artifacts={[
            makeArtifact({
              id: ID,
              title: '方案.docx',
              ownerUserId: ALICE.userId,
              status: 'candidate',
              mediaType: WORD,
              sha256: SHA,
            }),
          ]}
          session={ALICE}
          taskId={TASK_ID}
          runs={[]}
        />
      </QueryClientProvider>,
    )
    const candidates = screen.getByRole('list', { name: '候选交付物' })
    expect(await within(candidates).findByText(/尚无在线预览/)).toBeVisible()
    expect(within(candidates).getByRole('button', { name: '发布' })).toBeEnabled()
    expect(within(candidates).queryByText('暂不支持在线预览，请下载检查。')).not.toBeInTheDocument()
  })

  it('他人候选不显示也不查询派生件', () => {
    const fetchMock = installFetch([])
    const client = makeQueryClient({ retry: false })
    render(
      <QueryClientProvider client={client}>
        <ArtifactList
          artifacts={[
            makeArtifact({
              id: ID,
              ownerUserId: ALICE.userId,
              status: 'candidate',
              mediaType: WORD,
            }),
          ]}
          session={BOB}
          taskId={TASK_ID}
          runs={[]}
        />
      </QueryClientProvider>,
    )
    expect(screen.queryByTestId('office-preview')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    WORD,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ])('已发布 %s 在独立审阅页保留整件批注', async (mediaType) => {
    const result = renderApp(
      `/tasks/${TASK_ID}/review/${ID}`,
      loggedInHandlers(BOB, [
        {
          method: 'GET',
          url: /\/review$/,
          respond: () =>
            ok({
              artifact: {
                id: ID,
                taskId: TASK_ID,
                title: '团队交付物',
                mediaType,
                byteSize: 500,
                sha256: SHA,
                status: 'published',
                ownerUserId: ALICE.userId,
                publishedAt: '2026-10-26T01:00:00.000Z',
              },
              comments: [],
              invitations: [],
              reading: 'unsupported',
              textPreviewMaxBytes: 524288,
              capabilities: { canInvite: false, canSubmitReview: false, canComment: true },
            }),
        },
        { method: 'GET', url: /\/preview-info$/, respond: () => ok(NONE) },
        teamMembersHandler(),
      ]),
    )
    expect(await screen.findByText(/尚无在线预览/)).toBeVisible()
    expect(screen.getByTestId('review-unsupported')).toHaveTextContent('Office 预览只供阅读')
    expect(screen.getByLabelText('对整件文件的评论')).toBeEnabled()
    expect(screen.queryByLabelText('对所选文字的批注')).not.toBeInTheDocument()
    expect(result.fetchMock.mock.calls.some(([url]) => String(url).endsWith('/content'))).toBe(
      false,
    )
  })
})
