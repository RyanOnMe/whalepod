/** #442: real Office reader, candidate privacy, explicit publication and member review. */
import { createHash } from 'node:crypto'
import { expect, type Locator, type Page } from '@playwright/test'
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
  status: 'none' | 'ready' | 'failed'
  sourceSha256: string | null
  mediaType: string | null
  byteSize: number | null
  failureReason: string | null
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

/** Observe the exact Blob used by the visible reader, not a separate successful API read. */
async function readerFact(frame: Locator) {
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute('src', /^blob:/)
  return frame.evaluate(async (element) => {
    if (!(element instanceof HTMLIFrameElement)) throw new Error('PDF reader is not an iframe')
    const response = await fetch(element.src)
    if (!response.ok) throw new Error('PDF reader Blob cannot be read')
    const bytes = new Uint8Array(await response.arrayBuffer())
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const rect = element.getBoundingClientRect()
    return {
      visible: rect.width > 0 && rect.height > 0,
      sourceScheme: 'blob:',
      mediaType: response.headers.get('content-type')?.split(';')[0],
      byteSize: bytes.length,
      signature: new TextDecoder().decode(bytes.subarray(0, 5)),
      sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    }
  })
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

  const previewInfo = async () => {
    const result = await hubApi(aliceCookie, 'GET', `/artifacts/${artifactId}/preview-info`)
    expect(result.status).toBe(200)
    return result.data as PreviewInfo
  }
  await expect.poll(async () => (await previewInfo()).status, { timeout: 150_000 }).toBe('ready')
  const info = await previewInfo()
  expect(info.artifactId).toBe(artifactId)
  expect(info.sourceSha256).toBe(artifact!.sha256)
  expect(info.mediaType).toBe('application/pdf')
  expect(info.failureReason).toBeNull()
  const privateOriginal = await readBytes(bobCookie, `/artifacts/${artifactId}/content`)
  const privatePreview = await readBytes(bobCookie, `/artifacts/${artifactId}/preview`)
  const privateInfo = await hubApi(bobCookie, 'GET', `/artifacts/${artifactId}/preview-info`)
  expect(privateOriginal.status).toBe(404)
  expect(privatePreview.status).toBe(404)
  expect(privateInfo.status).toBe(404)

  await alice.goto(path)
  const ownerOffice = alice.getByTestId('office-preview')
  await ownerOffice.getByRole('button', { name: '查看 Office 预览', exact: true }).click()
  const ownerReader = await readerFact(ownerOffice.locator('iframe'))
  expect(ownerReader.visible).toBe(true)
  expect(ownerReader.signature).toBe('%PDF-')
  expect(ownerReader.mediaType).toBe('application/pdf')
  expect(ownerReader.byteSize).toBeGreaterThan(0)
  expect(ownerReader.byteSize).toBe(info.byteSize)
  const ownerPdf = await readBytes(aliceCookie, `/artifacts/${artifactId}/preview`)
  expect(ownerPdf.status).toBe(200)
  expect(ownerPdf.signature).toBe('%PDF-')
  expect(ownerReader.sha256).toBe(ownerPdf.sha256)

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
  await memberOffice.getByRole('button', { name: '查看 Office 预览', exact: true }).click()
  const memberReader = await readerFact(memberOffice.locator('iframe'))
  expect(memberReader.signature).toBe('%PDF-')
  expect(memberReader.sha256).toBe(ownerReader.sha256)
  const memberOriginal = await readBytes(bobCookie, `/artifacts/${artifactId}/content`)
  const memberPdf = await readBytes(bobCookie, `/artifacts/${artifactId}/preview`)
  expect(memberOriginal.status).toBe(200)
  expect(memberPdf.status).toBe(200)
  expect(memberOriginal.sha256).toBe(artifact!.sha256)
  expect(memberPdf.sha256).toBe(ownerPdf.sha256)
  await expect(bob.getByTestId('review-unsupported')).toContainText('Office 预览只供阅读')
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
    artifactId,
    taskId,
    runId: artifact!.runId,
    sourceSha: artifact!.sha256,
    previewSourceSha: info.sourceSha256,
    previewByteSize: info.byteSize,
    finalArtifactId: finalReview.artifact.id,
    finalArtifactSha: finalReview.artifact.sha256,
    expectedReviewerUserId: (member.data as { userId: string }).userId,
    statusBeforePublish: artifact!.status,
    statusAfterPublish: finalReview.artifact.status,
    previewStatus: info.status,
    original,
    ownerReader,
    ownerPdf,
    privacy: {
      original: privateOriginal.status,
      preview: privatePreview.status,
      info: privateInfo.status,
    },
    memberReader,
    memberOriginal,
    memberPdf,
    commentId: recorded!.id,
    comment,
    commentKind: recorded!.kind,
    commentAuthorUserId: recorded!.authorUserId,
    commentArtifactId: recorded!.artifactId,
    commentAnchor: recorded!.anchor,
    commentParentCommentId: recorded!.parentCommentId,
  }
}
