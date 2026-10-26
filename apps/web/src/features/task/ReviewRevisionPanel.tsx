/** #430: published review threads -> immutable round -> existing Run -> explicit candidate -> human resolution. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import {
  ArtifactRevisionRoundViewSchema,
  type ArtifactCommentView,
  type ArtifactRevisionRoundView,
} from '@whalepod/protocol'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import { queryKeys } from '../../app/query-client.js'
import { SelectMenu } from '../../shared/SelectMenu.js'
import { ConfirmDialog } from '../../shared/ConfirmDialog.js'
import { useMemberDirectory } from '../team/memberDirectory.js'
import { RunLauncher, type RevisionLaunchInput } from './RunLauncher.js'
import { EMPTY_EXECUTION_SETTINGS, type ExecutionSettings } from './execution-drafts.js'
import { ACTIVE_RUN } from './run-states.js'
import { isTextPreviewable } from './artifactPreview.js'
import type { RunView, Session, TaskRoomView, TaskRoomArtifact } from '../../shared/api/types.js'

export interface ReviewResolutionState {
  resolved: Set<string>
  pending: Set<string>
  ready: boolean
}
export function ReviewRevisionPanel({
  taskId,
  artifactId,
  comments,
  session,
  onResolutionState,
}: {
  taskId: string
  artifactId: string
  comments: ArtifactCommentView[]
  session: Session
  onResolutionState: (state: ReviewResolutionState) => void
}): ReactNode {
  const queryClient = useQueryClient()
  const [organizing, setOrganizing] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [references, setReferences] = useState<string[]>([])
  const [direction, setDirection] = useState('')
  const createKey = useRef<{ signature: string; key: string } | null>(null)
  const room = useQuery({
    queryKey: queryKeys.taskRoom(taskId),
    queryFn: () => api.get<TaskRoomView>(`/tasks/${taskId}`),
  })
  const rounds = useQuery({
    queryKey: ['artifact-revision-rounds', taskId],
    queryFn: async () =>
      ArtifactRevisionRoundViewSchema.array().parse(
        await api.get(`/tasks/${taskId}/artifact-revision-rounds`),
      ),
  })
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['artifact-revision-rounds', taskId] })
    void queryClient.invalidateQueries({ queryKey: ['artifact-review', artifactId] })
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(taskId) })
    void queryClient.invalidateQueries({ queryKey: ['attention'] })
  }, [queryClient, taskId, artifactId])
  const relevant = (rounds.data ?? []).filter((row) => row.sourceArtifact.artifactId === artifactId)
  useEffect(() => {
    const resolved = new Set<string>()
    const pending = new Set<string>()
    for (const row of relevant) {
      for (const comment of row.comments) {
        const resolution = row.resolutions.find((item) => item.commentId === comment.commentId)
        if (resolution?.status === 'resolved') resolved.add(comment.commentId)
        else resolved.delete(comment.commentId)
        if (
          row.candidate?.publishedAt !== null &&
          row.candidate?.publishedAt !== undefined &&
          resolution === undefined
        )
          pending.add(comment.commentId)
        else pending.delete(comment.commentId)
      }
    }
    onResolutionState({ resolved, pending, ready: rounds.isSuccess })
  }, [rounds.data, rounds.isSuccess, artifactId, onResolutionState])
  const create = useMutation({
    mutationFn: () => {
      const body = {
        sourceArtifactId: artifactId,
        commentIds: selected,
        ...(references.length ? { referenceArtifactIds: references } : {}),
        ...(direction.trim() ? { direction: direction.trim() } : {}),
      }
      const signature = JSON.stringify(body)
      if (createKey.current?.signature !== signature)
        createKey.current = { signature, key: crypto.randomUUID() }
      return api.mutate<ArtifactRevisionRoundView>(`/tasks/${taskId}/artifact-revision-rounds`, {
        body,
        idempotencyKey: createKey.current.key,
      })
    },
    onSuccess: () => {
      createKey.current = null
      setOrganizing(false)
      setSelected([])
      setReferences([])
      setDirection('')
      invalidate()
    },
  })
  if (room.isError || rounds.isError)
    return (
      <section className="review-revision">
        <ErrorBanner error={room.error ?? rounds.error} />
        <button
          type="button"
          onClick={() => {
            void room.refetch()
            void rounds.refetch()
          }}
        >
          重新读取修订记录
        </button>
      </section>
    )
  if (room.data === undefined || rounds.data === undefined)
    return <p role="status">正在读取修订记录…</p>
  const task = room.data.task
  if (task.id !== taskId) return <p role="alert">修订任务身份不一致，请返回任务重新进入。</p>
  const owner = task.assigneeUserId === session.userId
  const terminal = task.status === 'done' || task.status === 'cancelled'
  const threads = comments.filter((row) => row.parentCommentId === null)
  const publishedReferences = room.data.artifacts.filter(
    (row) => row.status === 'published' && row.id !== artifactId,
  )
  return (
    <section className="review-revision" aria-label="修订与复核">
      <h2>修订与复核</h2>
      {owner && !terminal ? (
        <button type="button" className="button" onClick={() => setOrganizing((value) => !value)}>
          整理本轮修订
        </button>
      ) : null}
      {organizing && owner && !terminal ? (
        <div data-testid="revision-round-organizer" className="review-round-organizer">
          <p>明确选择本轮意见；固定后新增意见与回复不进入本轮。固定意见不会启动 Agent。</p>
          {threads.map((row) => (
            <label key={row.id} className="review-round-option">
              <input
                type="checkbox"
                checked={selected.includes(row.id)}
                disabled={create.isPending || (selected.length >= 50 && !selected.includes(row.id))}
                onChange={(event) =>
                  setSelected((old) =>
                    event.target.checked ? [...old, row.id] : old.filter((id) => id !== row.id),
                  )
                }
              />
              {row.body}
            </label>
          ))}
          <label className="review-field">
            <span>本轮修订方向</span>
            <textarea
              className="input"
              aria-label="本轮修订方向"
              maxLength={10000}
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
            />
          </label>
          {publishedReferences.length ? (
            <fieldset>
              <legend>参考材料（已发布）</legend>
              {publishedReferences.map((row) => (
                <label key={row.id} className="review-round-option">
                  <input
                    type="checkbox"
                    checked={references.includes(row.id)}
                    onChange={(event) =>
                      setReferences((old) =>
                        event.target.checked ? [...old, row.id] : old.filter((id) => id !== row.id),
                      )
                    }
                  />
                  {row.title}
                </label>
              ))}
            </fieldset>
          ) : null}
          <button
            type="button"
            className="button button-primary"
            disabled={!selected.length || create.isPending}
            onClick={() => create.mutate()}
          >
            固定本轮意见
          </button>
          {create.isError ? <ErrorBanner error={create.error} /> : null}
        </div>
      ) : null}
      {relevant.map((row) => (
        <RevisionRound
          key={row.id}
          round={row}
          room={room.data}
          session={session}
          invalidate={invalidate}
        />
      ))}
      {!relevant.length ? (
        <p className="mutation-hint">还没有修订批次。责任人选择意见后再明确开始执行。</p>
      ) : null}
    </section>
  )
}

function RevisionRound({
  round,
  room,
  session,
  invalidate,
}: {
  round: ArtifactRevisionRoundView
  room: TaskRoomView
  session: Session
  invalidate: () => void
}): ReactNode {
  const [candidateId, setCandidateId] = useState('')
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [compare, setCompare] = useState(false)
  const owner = room.task.assigneeUserId === session.userId
  const candidate = room.artifacts.find((row) => row.id === round.candidate?.artifactId)
  const choices = room.artifacts.filter(
    (row) =>
      row.runId === round.runId &&
      ['candidate', 'published'].includes(row.status) &&
      row.ownerUserId === session.userId,
  )
  const run = room.runs.find((row) => row.id === round.runId)
  const link = useMutation({
    mutationFn: () =>
      api.mutate(`/artifact-revision-rounds/${round.id}/candidates`, {
        body: { candidateArtifactId: candidateId },
      }),
    onSuccess: invalidate,
  })
  const publish = useMutation({
    mutationFn: () => api.mutate(`/artifacts/${round.candidate!.artifactId}/publish`),
    onSuccess: () => {
      setConfirmPublish(false)
      invalidate()
    },
  })
  const published =
    round.candidate?.publishedAt !== null && round.candidate?.publishedAt !== undefined
  return (
    <article
      id={`revision-round-${round.id}`}
      className="revision-round"
      data-testid={`revision-round-${round.id}`}
      tabIndex={-1}
    >
      <h3>修订批次 · {new Date(round.createdAt).toLocaleString()}</h3>
      <p>
        {round.runId === null
          ? round.status === 'starting'
            ? '正在确认启动结果，请刷新后继续；不会另建执行。'
            : '意见已固定，尚未开始执行。'
          : `本轮执行：${run?.status ?? '正在读取状态'}`}
      </p>
      <p>
        <a href={`/api/v1/artifacts/${round.sourceArtifact.artifactId}/content`}>
          原稿：{round.sourceArtifact.title}
        </a>{' '}
        · 已固定发布版本
      </p>
      {round.direction ? <p>本轮方向：{round.direction}</p> : null}
      <details>
        <summary>本轮固定意见与回复（{round.comments.length} 条）</summary>
        <ul>
          {round.comments.map((row) => (
            <li key={row.commentId}>
              {row.body}
              {row.replies.map((reply) => (
                <p key={reply.commentId}>回复：{reply.body}</p>
              ))}
            </li>
          ))}
        </ul>
      </details>
      {owner && round.runId === null && round.status !== 'cancelled' ? (
        <RoundLauncher round={round} room={room} session={session} invalidate={invalidate} />
      ) : null}
      {round.runId !== null ? (
        <Link to={`/tasks/${room.task.id}#task-execution`}>查看执行与产出</Link>
      ) : null}
      {owner && round.runId !== null && round.candidate === null && choices.length ? (
        <div className="revision-candidate-picker">
          <SelectMenu
            id={`revision-candidate-${round.id}`}
            label="本轮新版候选"
            ariaLabel="选择本轮新版候选"
            value={candidateId}
            placeholder="请选择，不能按文件名自动关联"
            options={choices.map((row) => ({ value: row.id, label: row.title, disabled: false }))}
            onChange={setCandidateId}
            disabled={link.isPending}
          />
          <button
            type="button"
            className="button"
            disabled={!candidateId || link.isPending}
            onClick={() => link.mutate()}
          >
            关联为本轮新版
          </button>
        </div>
      ) : null}
      {link.isError ? <ErrorBanner error={link.error} /> : null}
      {round.candidate === null || !published ? (
        <p>尚无已发布新版；不能确认意见已解决。</p>
      ) : (
        <>
          <p>本轮新版已发布，Agent 的说明仍需人工核对。</p>
          <button type="button" className="button" onClick={() => setCompare((value) => !value)}>
            查看原稿与新版
          </button>
          {compare ? (
            <VersionComparison
              source={round.sourceArtifact}
              candidateId={round.candidate!.artifactId}
              candidate={candidate}
            />
          ) : null}
        </>
      )}
      {owner &&
      round.candidate !== null &&
      !published &&
      candidate?.ownerUserId === session.userId ? (
        <>
          <p>已关联候选，仅拥有者可见。请先检查再发布。</p>
          <a href={`/api/v1/artifacts/${candidate.id}/content`}>下载检查候选</a>
          <button type="button" className="button" onClick={() => setConfirmPublish(true)}>
            检查后发布新版
          </button>
          <ConfirmDialog
            open={confirmPublish}
            title="发布本轮新版给团队？"
            body={`发布「${candidate.title}」后团队可见；发布不会自动确认批注已解决。`}
            confirmLabel="确认发布新版"
            pending={publish.isPending}
            onConfirm={() => publish.mutate()}
            onCancel={() => setConfirmPublish(false)}
          />
        </>
      ) : null}
      {publish.isError ? <ErrorBanner error={publish.error} /> : null}
      {published ? (
        <ul className="revision-resolution-list">
          {round.comments.map((row) => (
            <Resolution
              key={row.commentId}
              round={round}
              comment={row}
              session={session}
              owner={owner}
              invalidate={invalidate}
            />
          ))}
        </ul>
      ) : null}
    </article>
  )
}

function RoundLauncher({
  round,
  room,
  session,
  invalidate,
}: {
  round: ArtifactRevisionRoundView
  room: TaskRoomView
  session: Session
  invalidate: () => void
}): ReactNode {
  const [mode, setMode] = useState<'resume' | 'new'>('resume')
  const [sending, setSending] = useState(false)
  const [settings, setSettings] = useState<ExecutionSettings>({ ...EMPTY_EXECUTION_SETTINGS })
  const [prompt, setPrompt] = useState(
    `请按本轮冻结的意见修订「${round.sourceArtifact.title}」，生成新的交付物，并说明每项意见的处理方式。`,
  )
  const initialized = useRef(false)
  const source = useQuery({
    queryKey: queryKeys.run(round.sourceArtifact.runId),
    queryFn: () => api.get<RunView>(`/runs/${round.sourceArtifact.runId}`),
  })
  useEffect(() => {
    if (initialized.current || source.data === undefined) return
    initialized.current = true
    if (source.data.ownerUserId === session.userId)
      setSettings({
        ...EMPTY_EXECUTION_SETTINGS,
        agentId: source.data.agentId,
        profileRevisionId: source.data.profileRevisionId,
        deviceId: source.data.deviceId,
        workspaceId: source.data.workspaceId,
      })
  }, [source.data, session.userId])
  const sameSource =
    source.data?.ownerUserId === session.userId &&
    source.data.dshSessionId !== null &&
    settings.agentId === source.data.agentId &&
    settings.profileRevisionId === source.data.profileRevisionId &&
    settings.deviceId === source.data.deviceId &&
    settings.workspaceId === source.data.workspaceId
  const launch = async (input: RevisionLaunchInput, idempotencyKey: string) => {
    if (!input.deviceId || !input.workspaceId) throw new Error('请明确选择本轮设备和工作目录')
    const result = ArtifactRevisionRoundViewSchema.parse(
      await api.mutate(`/artifact-revision-rounds/${round.id}/start`, {
        body: {
          agentId: input.agentId,
          profileRevisionId: input.profileRevisionId,
          deviceId: input.deviceId,
          workspaceId: input.workspaceId,
          expectedApprovalPolicy: input.expectedApprovalPolicy,
          prompt: input.text,
          ...(mode === 'resume' ? { resumeFromRunId: round.sourceArtifact.runId } : {}),
        },
        idempotencyKey,
      }),
    )
    if (result.runId === null) throw new Error('尚未取得启动结果，请刷新本轮记录后重试')
    invalidate()
    return { outcome: 'started_run' as const, runId: result.runId }
  }
  return (
    <div className="revision-launch">
      <div role="group" aria-label="修订执行方式">
        <button
          type="button"
          aria-pressed={mode === 'resume'}
          disabled={sending}
          onClick={() => setMode('resume')}
        >
          续接原产出会话
        </button>
        <button
          type="button"
          aria-pressed={mode === 'new'}
          disabled={sending}
          onClick={() => setMode('new')}
        >
          开始新执行
        </button>
      </div>
      {mode === 'resume' && !sameSource ? (
        <p role="status">原产出会话暂不可续接，请确认来源可用，或明确选择开始新执行。草稿保留。</p>
      ) : null}
      <RunLauncher
        task={room.task}
        session={session}
        hasActiveRun={room.runs.some((row) => ACTIVE_RUN.has(row.status))}
        embedded
        draft={prompt}
        onDraftChange={setPrompt}
        settings={settings}
        onSettingsChange={setSettings}
        launch={launch}
        idPrefix={`revision-${round.id}`}
        launchIntent={`${round.id}:${mode}`}
        onSendingChange={setSending}
        launchTitle="开始本轮修订"
        launchDescription={
          mode === 'resume'
            ? '续接原产出会话，固定本轮原稿与意见；不会自动沿用 Reviewer。'
            : '明确开始新执行，本轮仍固定原稿与所选意见。'
        }
        requireExplicitTarget
        lockSettings={mode === 'resume'}
        blocked={
          room.task.assignmentStatus !== 'accepted' ||
          ['done', 'cancelled'].includes(room.task.status) ||
          (mode === 'resume' && !sameSource)
        }
        buttonLabel="开始修订"
      />
    </div>
  )
}

async function readText(artifactId: string): Promise<string> {
  const response = await fetch(`/api/v1/artifacts/${artifactId}/content`, {
    credentials: 'include',
  })
  if (!response.ok) throw new Error('版本内容读取失败')
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > 512 * 1024) throw new Error('内容超过页内对比上限，请下载检查')
  return new TextDecoder().decode(bytes)
}
/** A bounded linear comparison: mark the differing line range, preserving exact text. */
export function changedLineRange(
  original: string,
  newer: string,
): { old: [number, number]; next: [number, number] } {
  const oldLines = original.match(/[^\n]*\n|[^\n]+$/gu) ?? []
  const newLines = newer.match(/[^\n]*\n|[^\n]+$/gu) ?? []
  let prefix = 0
  let suffix = 0
  while (
    prefix < Math.min(oldLines.length, newLines.length) &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix++
  while (
    suffix < Math.min(oldLines.length, newLines.length) - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  )
    suffix++
  const start = oldLines.slice(0, prefix).join('').length
  return {
    old: [start, original.length - oldLines.slice(oldLines.length - suffix).join('').length],
    next: [start, newer.length - newLines.slice(newLines.length - suffix).join('').length],
  }
}
function markedText(text: string, range: [number, number], kind: 'old' | 'new'): ReactNode {
  return (
    <>
      {text.slice(0, range[0])}
      <mark className={`revision-diff-${kind}`}>{text.slice(range[0], range[1])}</mark>
      {text.slice(range[1])}
    </>
  )
}
function VersionComparison({
  source,
  candidateId,
  candidate,
}: {
  source: ArtifactRevisionRoundView['sourceArtifact']
  candidateId: string
  candidate: TaskRoomArtifact | undefined
}): ReactNode {
  const supported =
    isTextPreviewable(source.mediaType, source.byteSize) &&
    candidate !== undefined &&
    isTextPreviewable(candidate.mediaType, candidate.byteSize)
  const original = useQuery({
    queryKey: ['revision-content', source.artifactId],
    queryFn: () => readText(source.artifactId),
    enabled: supported,
  })
  const newer = useQuery({
    queryKey: ['revision-content', candidateId],
    queryFn: () => readText(candidateId),
    enabled: supported,
  })
  if (!supported)
    return (
      <p>
        该格式暂不支持文本对比。
        <a href={`/api/v1/artifacts/${source.artifactId}/content`}>下载原稿</a> ·{' '}
        <a href={`/api/v1/artifacts/${candidateId}/content`}>下载新版</a>
      </p>
    )
  if (original.isError || newer.isError)
    return (
      <div>
        <ErrorBanner error={original.error ?? newer.error} />
        <button
          type="button"
          onClick={() => {
            void original.refetch()
            void newer.refetch()
          }}
        >
          重新读取对比
        </button>
      </div>
    )
  if (original.data === undefined || newer.data === undefined)
    return <p role="status">正在读取原稿与新版…</p>
  const ranges = changedLineRange(original.data, newer.data)
  return (
    <div className="revision-comparison">
      <section>
        <h4>原稿 · {source.title}</h4>
        <pre className="review-text" data-testid="revision-original-text">
          {markedText(original.data, ranges.old, 'old')}
        </pre>
      </section>
      <section>
        <h4>
          新版 · {candidate.title} ·{' '}
          {original.data === newer.data ? '内容相同' : '标出变化范围，请逐项核对'}
        </h4>
        <pre className="review-text" data-testid="revision-new-text">
          {markedText(newer.data, ranges.next, 'new')}
        </pre>
      </section>
    </div>
  )
}

function Resolution({
  round,
  comment,
  session,
  owner,
  invalidate,
}: {
  round: ArtifactRevisionRoundView
  comment: ArtifactRevisionRoundView['comments'][number]
  session: Session
  owner: boolean
  invalidate: () => void
}): ReactNode {
  const directory = useMemberDirectory()
  const [note, setNote] = useState('')
  const existing = round.resolutions.find((row) => row.commentId === comment.commentId)
  const author = comment.authorUserId === session.userId
  const mutation = useMutation({
    mutationFn: (status: 'resolved' | 'needs_work') =>
      api.mutate(`/artifact-revision-rounds/${round.id}/resolutions`, {
        body: {
          commentId: comment.commentId,
          status,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      }),
    onSuccess: invalidate,
  })
  return (
    <li className="revision-resolution">
      <p>{comment.body}</p>
      {comment.anchor ? <blockquote>{comment.anchor.quote}</blockquote> : null}
      <p>
        {existing === undefined
          ? '待人工复核'
          : `${existing.status === 'resolved' ? '已解决' : '仍需修改'} · ${directory.personOf(existing.resolvedBy)}${existing.note ? `：${existing.note}` : ''}`}
      </p>
      {author || owner ? (
        <>
          <label className="review-field">
            <span>复核说明或代收口理由{!author ? '（必填）' : ''}</span>
            <textarea
              className="input"
              aria-label="复核说明或代收口理由"
              maxLength={10000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={mutation.isPending || (!author && !note.trim())}
            onClick={() => mutation.mutate('resolved')}
          >
            确认已解决
          </button>
          <button
            type="button"
            className="button"
            disabled={mutation.isPending || (!author && !note.trim())}
            onClick={() => mutation.mutate('needs_work')}
          >
            仍需修改
          </button>
        </>
      ) : null}
      {mutation.isError ? <ErrorBanner error={mutation.error} /> : null}
    </li>
  )
}
