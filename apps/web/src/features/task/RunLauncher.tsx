/**
 * P1-13 Task Room 的 Run 启动器（03 §4 POST /tasks/:taskId/runs）。
 *
 * 责任人（已接受指派）选 Agent + Revision（快照语义：选定即固定 digest，
 * 04 G4-06 的「运行中改设定不动本次 Run」由 Revision 不可变保证）、
 * 自己的在线设备与该设备下的 Workspace，附 prompt 发起。凭据槽位随所选
 * Revision 走（credentialSlot 在 Hub 侧快照进 run.start 载荷，UI 不碰凭据）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { isApiError } from '../../shared/api/errors.js'
import { queryKeys } from '../../app/query-client.js'
import type {
  AgentDetailView,
  AgentView,
  DeviceView,
  RunView,
  TaskView,
  WorkspaceView,
} from '../../shared/api/types.js'
import type { Session } from '../../shared/api/types.js'

export interface RunLauncherProps {
  task: TaskView
  session: Session
  /** 当前已有活跃 Run（一任务一活跃，03 §3.2）时不渲染。 */
  hasActiveRun: boolean
}

const TERMINAL_TASK: ReadonlySet<string> = new Set(['done', 'cancelled'])

export function RunLauncher({ task, session, hasActiveRun }: RunLauncherProps): ReactNode {
  const queryClient = useQueryClient()
  const [agentId, setAgentId] = useState('')
  const [profileRevisionId, setProfileRevisionId] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [prompt, setPrompt] = useState('')

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => api.get<AgentView[]>('/agents'),
  })
  const agentDetailQuery = useQuery({
    queryKey: queryKeys.agentDetail(agentId),
    queryFn: () => api.get<AgentDetailView>(`/agents/${agentId}`),
    enabled: agentId !== '',
  })
  const devicesQuery = useQuery({
    queryKey: queryKeys.devices,
    queryFn: () => api.get<DeviceView[]>('/devices'),
  })
  const workspacesQuery = useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: () => api.get<WorkspaceView[]>('/workspaces'),
  })

  // Revision 缺省 = Agent 当前 Revision；显式选择则是「为这次 Run 钉住快照」。
  const revisions = agentDetailQuery.data?.revisions ?? []
  const effectiveRevisionId =
    profileRevisionId !== '' ? profileRevisionId : (agentDetailQuery.data?.currentRevisionId ?? '')

  const deviceWorkspaces = useMemo(
    () => (workspacesQuery.data ?? []).filter((ws) => ws.deviceId === deviceId && ws.available),
    [workspacesQuery.data, deviceId],
  )

  const start = useMutation({
    mutationFn: () =>
      api.mutate<RunView>(`/tasks/${task.id}/runs`, {
        body: { agentId, profileRevisionId: effectiveRevisionId, deviceId, workspaceId, prompt },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskRoom(task.id) })
      setPrompt('')
    },
  })

  // 只有已接受指派的责任人、非终态任务、无活跃 Run 时可启动（03 §3.2 前置守卫；
  // Hub 侧仍有完整校验，这里是诚实呈现而非安全边界）。
  if (
    session.userId !== task.assigneeUserId ||
    task.assignmentStatus !== 'accepted' ||
    TERMINAL_TASK.has(task.status) ||
    hasActiveRun
  ) {
    return null
  }

  const ready =
    agentId !== '' &&
    effectiveRevisionId !== '' &&
    deviceId !== '' &&
    workspaceId !== '' &&
    prompt.trim().length > 0

  return (
    <section className="card run-launcher" aria-labelledby="run-launcher-heading">
      <h3 id="run-launcher-heading">启动 Run</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (ready && !start.isPending) start.mutate()
        }}
      >
        <label>
          Agent
          <select
            aria-label="选择 Agent"
            value={agentId}
            onChange={(event) => {
              setAgentId(event.target.value)
              setProfileRevisionId('')
            }}
          >
            <option value="">选择 Agent…</option>
            {(agentsQuery.data ?? [])
              .filter((agent) => agent.archivedAt === null)
              .map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Revision（选定即快照）
          <select
            aria-label="选择 Revision"
            value={effectiveRevisionId}
            onChange={(event) => setProfileRevisionId(event.target.value)}
            disabled={agentId === ''}
          >
            {agentId === '' ? <option value="">先选 Agent…</option> : null}
            {revisions.map((revision) => (
              <option key={revision.id} value={revision.id}>
                r{revision.revision} — {revision.provider}/{revision.model}
                {revision.id === agentDetailQuery.data?.currentRevisionId ? '（当前）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          设备
          <select
            aria-label="选择设备"
            value={deviceId}
            onChange={(event) => {
              setDeviceId(event.target.value)
              setWorkspaceId('')
            }}
          >
            <option value="">选择设备…</option>
            {(devicesQuery.data ?? []).map((device) => (
              <option key={device.id} value={device.id} disabled={device.status !== 'online'}>
                {device.name}（{device.status === 'online' ? '在线' : '离线'}）
              </option>
            ))}
          </select>
        </label>
        <label>
          Workspace
          <select
            aria-label="选择 Workspace"
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
            disabled={deviceId === ''}
          >
            <option value="">{deviceId === '' ? '先选设备…' : '选择 Workspace…'}</option>
            {deviceWorkspaces.map((ws) => (
              <option key={ws.workspaceId} value={ws.workspaceId}>
                {ws.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Prompt
          <textarea
            aria-label="Run prompt"
            value={prompt}
            maxLength={20_000}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="这次 Run 要做什么（任务上下文由 Hub 注入）…"
            rows={4}
          />
        </label>
        {start.isError && isApiError(start.error) ? (
          <p className="mutation-error" role="alert">
            {start.error.message}（{start.error.code}）
          </p>
        ) : null}
        <button
          type="submit"
          className="button button-primary"
          disabled={!ready || start.isPending}
        >
          {start.isPending ? '启动中…' : '启动 Run'}
        </button>
      </form>
    </section>
  )
}
