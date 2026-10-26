/** #430: 真人浏览器路径；只通过正式 HTTP 读面取证。模型出口为确定性 replay。 */
import { expect, type Page } from '@playwright/test'
import type {
  ArtifactRevisionRoundView,
  ArtifactReviewView,
  ArtifactDeliveryBasis,
} from '@whalepod/protocol'
import {
  env,
  hubApi,
  nodeControl,
  selectFromMenu,
  setRuntimeFixture,
  waitForRunStatus,
} from './helpers.js'

type Input = {
  alice: Page
  bob: Page
  aliceCookie: string
  bobCookie: string
  taskId: string
  sourceArtifactId: string
  sourceSha256: string
  sourceRunId: string
  reviewerUserId: string
}
const COMMENT = '补充登录失败的状态码与重试提示'
const LATE = '冻结之后补充的性能意见'
const DIRECTION = '明确错误处理约定'
export async function driveDeliveryReviewLoop(input: Input): Promise<Record<string, unknown>> {
  const {
    alice,
    bob,
    aliceCookie,
    bobCookie,
    taskId,
    sourceArtifactId,
    sourceSha256,
    sourceRunId,
  } = input
  const path = `/tasks/${taskId}/review/${sourceArtifactId}`
  const rounds = async () => {
    const result = await hubApi(aliceCookie, 'GET', `/tasks/${taskId}/artifact-revision-rounds`)
    expect(result.status).toBe(200)
    return result.data as ArtifactRevisionRoundView[]
  }
  await alice.goto(path)
  await expect(alice.getByTestId('review-text')).toContainText('E2E 验收交付物')
  await expect(alice.getByRole('heading', { name: '成果依据' })).toBeVisible()
  const basisRead = await hubApi(bobCookie, 'GET', `/artifacts/${sourceArtifactId}/delivery-basis`)
  expect(basisRead.status).toBe(200)
  const basis = basisRead.data as ArtifactDeliveryBasis
  expect(basis.sourceRun?.id).toBe(sourceRunId)
  expect(basis.agreement.revision?.revisionNumber).toBe(1)
  await alice.getByRole('checkbox', { name: /Bob/ }).check()
  await alice.getByLabel('请重点看什么（可选）').fill('请核对错误处理约定')
  await alice.getByRole('button', { name: '发送审阅邀请' }).click()
  await expect(alice.getByText('邀请已发出。', { exact: false })).toBeVisible()
  await bob.goto(path)
  await bob.getByLabel('对整件文件的评论').fill(COMMENT)
  await bob.getByRole('button', { name: '发表整件批注' }).click()
  await expect(bob.getByTestId('review-comments')).toContainText(COMMENT)
  await bob.getByRole('button', { name: '提交本轮意见', exact: true }).click()
  await expect(bob.getByText(/已提交意见（/)).toBeVisible()
  const review = await hubApi(aliceCookie, 'GET', `/artifacts/${sourceArtifactId}/review`)
  expect(review.status).toBe(200)
  const commentId = (review.data as ArtifactReviewView).comments.find(
    (row) => row.body === COMMENT,
  )!.id
  await alice.reload()
  await alice.getByRole('button', { name: '整理本轮修订' }).click()
  const organizer = alice.getByTestId('revision-round-organizer')
  await organizer.getByRole('checkbox', { name: COMMENT, exact: true }).check()
  await organizer.getByLabel('本轮修订方向').fill(DIRECTION)
  await organizer.getByRole('button', { name: '固定本轮意见' }).click()
  await expect.poll(async () => (await rounds()).length).toBe(1)
  const frozen = (await rounds())[0]!
  expect(frozen.comments.map((row) => row.commentId)).toEqual([commentId])
  await bob.getByLabel('对整件文件的评论').fill(LATE)
  await bob.getByRole('button', { name: '发表整件批注' }).click()
  await expect(bob.getByTestId('review-comments')).toContainText(LATE)
  await setRuntimeFixture('delivery-revision')
  const panel = alice.getByTestId(`revision-round-${frozen.id}`)
  await panel.getByRole('button', { name: '开始新执行', exact: true }).click()
  await expect(panel.getByRole('button', { name: '开始修订', exact: true })).toBeEnabled()
  await panel.getByRole('button', { name: '开始修订', exact: true }).click()
  const dialog = alice.getByRole('dialog')
  if (await dialog.isVisible().catch(() => false))
    await dialog.getByRole('button', { name: /确认以完全权限启动/ }).click()
  await expect.poll(async () => (await rounds())[0]?.runId, { timeout: 30_000 }).not.toBeNull()
  const revisionRunId = (await rounds())[0]!.runId!
  await waitForRunStatus(revisionRunId, 'completed')
  const events = await hubApi(aliceCookie, 'GET', `/runs/${revisionRunId}/events?limit=200`)
  const output = (
    events.data as { events: Array<{ event: { type: string; finalText?: string } }> }
  ).events.find((row) => row.event.type === 'run.completed')!.event.finalText!
  expect(output).toContain(COMMENT)
  expect(output).toContain(DIRECTION)
  const observed = await nodeControl<{ runId: string; context: string }>('/execution-context', {
    runId: revisionRunId,
  })
  expect(observed.runId).toBe(revisionRunId)
  const runtimeContext = observed.context
  for (const expected of [sourceArtifactId, sourceSha256, commentId, COMMENT, DIRECTION])
    expect(runtimeContext).toContain(expected)
  expect(runtimeContext).not.toContain(LATE)
  const downloaded = await nodeControl<{
    copied: Array<{
      artifactId: string
      sha256: string
      fileSha256: string | null
      byteSize: number
    }>
  }>('/input-manifest', { runId: revisionRunId })
  const sourceCopy = downloaded.copied.find((row) => row.artifactId === sourceArtifactId)
  expect(sourceCopy).toBeDefined()
  expect(sourceCopy!.sha256).toBe(sourceSha256)
  expect(sourceCopy!.fileSha256).toBe(sourceSha256)
  expect(sourceCopy!.byteSize).toBe(frozen.sourceArtifact.byteSize)

  await alice.reload()
  await selectFromMenu(panel.getByRole('button', { name: '选择本轮新版候选' }), '修订后的接口报告')
  await panel.getByRole('button', { name: '关联为本轮新版' }).click()
  await expect(panel.getByRole('button', { name: '检查后发布新版' })).toBeVisible()
  const linked = (await rounds())[0]!
  const candidateId = linked.candidate!.artifactId
  const memberRound = await hubApi(bobCookie, 'GET', `/artifact-revision-rounds/${frozen.id}`)
  expect((memberRound.data as ArtifactRevisionRoundView).candidate).toBeNull()
  const hidden = await fetch(`${env().hubOrigin}/api/v1/artifacts/${candidateId}/content`, {
    headers: { cookie: bobCookie },
  })
  expect(hidden.status).toBe(404)
  await panel.getByRole('button', { name: '检查后发布新版' }).click()
  await alice.getByRole('dialog').getByRole('button', { name: '确认发布新版', exact: true }).click()
  await expect(panel.getByRole('button', { name: '查看原稿与新版' })).toBeVisible()
  await bob.reload()
  const bobPanel = bob.getByTestId(`revision-round-${frozen.id}`)
  await bobPanel.getByRole('button', { name: '查看原稿与新版' }).click()
  await expect(bob.getByTestId('revision-original-text')).toContainText('E2E 验收交付物')
  await expect(bob.getByTestId('revision-new-text')).toContainText('登录失败返回 401')
  await expect(bobPanel.getByText('待人工复核', { exact: true })).toBeVisible()
  const beforeHumanResolutions = (await rounds())[0]!.resolutions
  expect(beforeHumanResolutions).toEqual([])
  await bobPanel.getByRole('button', { name: '确认已解决' }).click()
  await expect(bobPanel.getByText(/^已解决 ·/)).toBeVisible()
  const finalRound = (await rounds())[0]!
  expect(finalRound.resolutions[0]?.status).toBe('resolved')
  const content = await fetch(`${env().hubOrigin}/api/v1/artifacts/${candidateId}/content`, {
    headers: { cookie: bobCookie },
  })
  expect(content.status).toBe(200)
  const room = await hubApi(aliceCookie, 'GET', `/tasks/${taskId}`)
  const candidate = (
    room.data as { artifacts: Array<{ id: string; sha256: string }> }
  ).artifacts.find((row) => row.id === candidateId)!
  expect(candidate.sha256).not.toBe(sourceSha256)
  return {
    sourceArtifactId,
    sourceSha256,
    sourceRunId,
    reviewerUserId: input.reviewerUserId,
    beforeHumanResolutions,
    commentId,
    comment: COMMENT,
    direction: DIRECTION,
    lateComment: LATE,
    round: finalRound,
    runtimeContext,
    sourceCopy,
    revisionRunId,
    output,
    candidateId,
    candidateSha256: candidate.sha256,
    privateContentStatus: hidden.status,
    hiddenCandidate: (memberRound.data as ArtifactRevisionRoundView).candidate,
    publishedContentStatus: content.status,
    basis,
  }
}
