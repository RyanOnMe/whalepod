import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TaskSpecContentSchema, type TaskSpecContent } from '@whalepod/protocol'
import { api } from '../../shared/api/client.js'
import { queryKeys } from '../../app/query-client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'
import type {
  Session,
  TaskRoomView,
  TaskSpecRevisionView,
  TaskView,
} from '../../shared/api/types.js'
import { RunLauncher } from './RunLauncher.js'

const ACTIVE = new Set(['queued', 'dispatching', 'running', 'waiting_approval', 'cancel_requested'])

/** Agent 提案沿既有私有 Artifact 通道；采用和真人确认分开，绝不自动覆盖草稿。 */
export function AgreementAgentDraft({
  task,
  session,
  draft,
  pending,
  onAdopt,
}: {
  task: TaskView
  session: Session
  draft: TaskSpecRevisionView | null
  pending: boolean
  onAdopt: (content: TaskSpecContent, expectedDraftVersion?: number) => void
}): ReactNode {
  const [prompt, setPrompt] = useState(
    `请把以下需求整理成任务约定，不执行业务修改。输出严格 JSON，字段为 goal、constraints、acceptance、openQuestions（均为字符串，各最多10000字）；有歧义的内容放入 openQuestions，不擅自确认。将 JSON 文件通过 publish_artifact 提交为 application/json 的私有候选，供责任人检查。\n${task.title}\n${task.description.slice(0, 8000)}${task.description.length > 8000 ? '\n（描述已截断，起草前请补充必要信息）' : ''}`,
  )
  const [selected, setSelected] = useState<{ content: TaskSpecContent; version?: number } | null>(
    null,
  )
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)
  const room = useQuery({
    queryKey: queryKeys.taskRoom(task.id),
    queryFn: () => api.get<TaskRoomView>(`/tasks/${task.id}`),
  })
  const runs = room.data?.runs ?? []
  const helperRuns = new Set(
    runs
      .filter((run) => run.purpose === 'agreement_draft' && run.status === 'completed')
      .map((run) => run.id),
  )
  const candidates = (room.data?.artifacts ?? []).filter(
    (item) =>
      helperRuns.has(item.runId) &&
      item.ownerUserId === session.userId &&
      item.status === 'candidate' &&
      item.mediaType.split(';')[0]?.trim() === 'application/json' &&
      item.byteSize <= 48_000,
  )
  const inspect = async (artifactId: string): Promise<void> => {
    setLoading(true)
    setError(null)
    setSelected(null)
    const version = draft?.draftVersion
    try {
      const response = await fetch(`/api/v1/artifacts/${artifactId}/content`, {
        credentials: 'include',
      })
      if (!response.ok) throw new Error('无法读取约定候选，请重试')
      const text = await response.text()
      if (new TextEncoder().encode(text).length > 48_000) throw new Error('约定候选超过大小上限')
      const content = TaskSpecContentSchema.parse(JSON.parse(text))
      setSelected({ content, ...(version === undefined ? {} : { version }) })
    } catch (failure) {
      setError(failure)
    } finally {
      setLoading(false)
    }
  }
  return (
    <div data-testid="agreement-agent-draft">
      <p>使用你选择的 Agent 与本机环境起草，会调用模型。产出仅你可见，采用后仍需真人确认。</p>
      {room.isError ? <ErrorBanner error={room.error} /> : null}
      <RunLauncher
        embedded
        blocked={
          room.isPending ||
          room.isError ||
          task.assignmentStatus !== 'accepted' ||
          task.status === 'done' ||
          task.status === 'cancelled'
        }
        task={task}
        session={session}
        hasActiveRun={runs.some((run) => ACTIVE.has(run.status))}
        purpose="agreement_draft"
        draft={prompt}
        onDraftChange={setPrompt}
        buttonLabel="启动约定起草"
      />
      {candidates.map((item) => (
        <button
          type="button"
          className="button"
          key={item.id}
          disabled={loading || pending}
          onClick={() => void inspect(item.id)}
        >
          检查约定候选：{item.title}
        </button>
      ))}
      {error !== null ? <ErrorBanner error={error} /> : null}
      {selected !== null ? (
        <div data-testid="agreement-agent-preview">
          <pre>{JSON.stringify(selected.content, null, 2)}</pre>
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() => onAdopt(selected.content, selected.version)}
          >
            采用为约定草稿
          </button>
        </div>
      ) : null}
      <p>起草失败不会修改约定；没有 JSON 候选时可在执行记录中查看原因或手工起草。</p>
    </div>
  )
}
