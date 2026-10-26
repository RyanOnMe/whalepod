/** #442: deny unisolated Office previews while preserving original publication and review. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, type Page } from '@playwright/test'
import type { ArtifactReviewView } from '@whalepod/protocol'
import { env, hubApi } from './helpers.js'

type Input = {
  alice: Page
  bob: Page
  aliceCookie: string
  bobCookie: string
  taskId: string
  artifactId: string
}
type Artifact = {
  id: string
  title: string
  mediaType: string
  sha256: string
  status: string
  runId: string
}
type PreviewInfo = {
  artifactId: string
  status: string
  sourceSha256: string | null
  converter: string | null
  mediaType: string | null
  byteSize: number | null
  failureReason: string | null
  updatedAt: string | null
}

async function readBytes(cookie: string, path: string) {
  const response = await fetch(`${env().hubOrigin}/api/v1${path}`, {
    headers: { cookie },
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    mediaType: response.headers.get('content-type')?.split(';')[0],
    byteSize: bytes.length,
    signature: bytes.subarray(0, 5).toString('ascii'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

async function downloadOriginal(page: Page, artifactId: string) {
  const path = `/api/v1/artifacts/${artifactId}/content`
  const link = page.getByTestId('review-download')
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', path)
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
  expect(await download.failure()).toBeNull()
  const file = await download.path()
  if (file === null) throw new Error('original download did not produce a file')
  const bytes = await readFile(file)
  const urlPath = new URL(download.url()).pathname
  await download.delete()
  return {
    urlPath,
    byteSize: bytes.length,
    signature: bytes.subarray(0, 5).toString('ascii'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

export async function driveOfficePreviewLoop(input: Input): Promise<Record<string, unknown>> {
  const { alice, bob, aliceCookie, bobCookie, taskId, artifactId } = input
  const path = `/tasks/${taskId}/review/${artifactId}`
  const room = await hubApi(aliceCookie, 'GET', `/tasks/${taskId}`)
  expect(room.status).toBe(200)
  const artifact = (room.data as { artifacts: Artifact[] }).artifacts.find(
    (row) => row.id === artifactId,
  )
  expect(artifact).toBeDefined()
  expect(artifact!.title).toBe('Office 预览样本')
  expect(artifact!.mediaType).toBe(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  )
  expect(artifact!.status).toBe('candidate')
  expect(artifact!.sha256).toMatch(/^[a-f0-9]{64}$/)
  const original = await readBytes(aliceCookie, `/artifacts/${artifactId}/content`)
  expect(original.status).toBe(200)
  expect(original.signature.startsWith('PK')).toBe(true)
  expect(original.sha256).toBe(artifact!.sha256)

  const previewInfo = async (cookie: string) => {
    const result = await hubApi(cookie, 'GET', `/artifacts/${artifactId}/preview-info`)
    expect(result.status).toBe(200)
    const info = result.data as PreviewInfo
    expect(info).toEqual({
      artifactId,
      status: 'failed',
      sourceSha256: artifact!.sha256,
      converter: 'unknown',
      mediaType: null,
      byteSize: null,
      failureReason: 'ISOLATION_REQUIRED',
      updatedAt: null,
    })
    return info
  }
  const deniedPreview = async (cookie: string) => {
    const response = await fetch(`${env().hubOrigin}/api/v1/artifacts/${artifactId}/preview`, {
      headers: { cookie },
    })
    const envelope = (await response.json()) as { ok: boolean; error?: { code?: string } }
    expect(response.status).toBe(404)
    expect(envelope.ok).toBe(false)
    expect(envelope.error?.code).toBe('PREVIEW_UNAVAILABLE')
    return { status: response.status, code: envelope.error?.code }
  }
  const ownerInfo = await previewInfo(aliceCookie)
  const privateOriginal = await readBytes(bobCookie, `/artifacts/${artifactId}/content`)
  const privatePreview = await readBytes(bobCookie, `/artifacts/${artifactId}/preview`)
  const privateInfo = await hubApi(bobCookie, 'GET', `/artifacts/${artifactId}/preview-info`)
  expect(privateOriginal.status).toBe(404)
  expect(privatePreview.status).toBe(404)
  expect(privateInfo.status).toBe(404)
  await alice.goto(path)
  const ownerOffice = alice.getByTestId('office-preview')
  await expect(ownerOffice).toContainText('隔离转换尚未开放')
  const ownerIframeCount = await ownerOffice.locator('iframe').count()
  expect(ownerIframeCount).toBe(0)
  const ownerFallbackVisible = await ownerOffice.getByText(/隔离转换尚未开放/).isVisible()
  const ownerPreview = await deniedPreview(aliceCookie)
  const ownerDownload = await downloadOriginal(alice, artifactId)
  expect(ownerDownload.sha256).toBe(artifact!.sha256)

  // Publication is a member action on the task file card, never an API shortcut.
  await alice.goto(`/tasks/${taskId}#artifact-${artifactId}`)
  const card = alice.locator(`#artifact-${artifactId}`)
  await expect(card).toContainText('Office 预览样本')
  await card.getByRole('button', { name: '发布', exact: true }).click()
  await alice
    .getByRole('dialog')
    .getByRole('button', { name: '确认发布给团队', exact: true })
    .click()
  await expect
    .poll(async () => {
      const result = await hubApi(aliceCookie, 'GET', `/tasks/${taskId}`)
      expect(result.status).toBe(200)
      return (result.data as { artifacts: Artifact[] }).artifacts.find(
        (row) => row.id === artifactId,
      )?.status
    })
    .toBe('published')

  await bob.goto(path)
  const memberOffice = bob.getByTestId('office-preview')
  await expect(memberOffice).toContainText('隔离转换尚未开放')
  const memberIframeCount = await memberOffice.locator('iframe').count()
  expect(memberIframeCount).toBe(0)
  const memberFallbackVisible = await memberOffice.getByText(/隔离转换尚未开放/).isVisible()
  const memberInfo = await previewInfo(bobCookie)
  const memberPreview = await deniedPreview(bobCookie)
  const memberDownload = await downloadOriginal(bob, artifactId)
  expect(memberDownload.sha256).toBe(artifact!.sha256)
  const memberOriginal = await readBytes(bobCookie, `/artifacts/${artifactId}/content`)
  expect(memberOriginal.status).toBe(200)
  expect(memberOriginal.sha256).toBe(artifact!.sha256)
  const comment = 'Office 阅读后复核：请补充表格边界条件。'
  await bob.getByLabel('对整件文件的评论').fill(comment)
  await bob.getByRole('button', { name: '发表整件批注', exact: true }).click()
  await expect(bob.getByTestId('review-comments')).toContainText(comment)
  const review = await hubApi(bobCookie, 'GET', `/artifacts/${artifactId}/review`)
  expect(review.status).toBe(200)
  const finalReview = review.data as ArtifactReviewView
  expect(finalReview.artifact.id).toBe(artifactId)
  expect(finalReview.artifact.sha256).toBe(artifact!.sha256)
  expect(finalReview.artifact.status).toBe('published')
  const recorded = finalReview.comments.find((row) => row.body === comment)
  expect(recorded?.artifactId).toBe(artifactId)
  expect(recorded?.kind).toBe('whole')
  expect(recorded?.parentCommentId).toBeNull()
  expect(recorded?.anchor).toBeNull()
  const member = await hubApi(bobCookie, 'GET', '/auth/session')
  expect(member.status).toBe(200)
  expect(recorded?.authorUserId).toBe((member.data as { userId: string }).userId)
  return {
    component: 'web.office-preview-loop',
    source: 'production-hub-node-runtime',
    policy: 'isolation-required',
    artifactId,
    taskId,
    runId: artifact!.runId,
    sourceSha: artifact!.sha256,
    finalArtifactId: finalReview.artifact.id,
    finalArtifactSha: finalReview.artifact.sha256,
    expectedReviewerUserId: (member.data as { userId: string }).userId,
    statusBeforePublish: artifact!.status,
    statusAfterPublish: finalReview.artifact.status,
    original,
    ownerDownload,
    ownerInfo,
    ownerPreview,
    ownerIframeCount,
    ownerFallbackVisible,
    privacy: {
      original: privateOriginal.status,
      preview: privatePreview.status,
      info: privateInfo.status,
    },
    memberDownload,
    memberInfo,
    memberPreview,
    memberIframeCount,
    memberFallbackVisible,
    memberOriginal,
    commentId: recorded!.id,
    comment,
    commentKind: recorded!.kind,
    commentAuthorUserId: recorded!.authorUserId,
    commentArtifactId: recorded!.artifactId,
    commentAnchor: recorded!.anchor,
    commentParentCommentId: recorded!.parentCommentId,
  }
}
