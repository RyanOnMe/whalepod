import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { api } from '../../shared/api/client.js'
import { SelectMenu } from '../../shared/SelectMenu.js'
import { queryKeys } from '../../app/query-client.js'
import type {
  AgentDetailView,
  AgentView,
  InstructionDriverView,
  RunView,
  Session,
  TaskRoomRun,
  TaskView,
} from '../../shared/api/types.js'
import {
  InstructionComposer,
  type ApprovalPreview,
  type InstructionOutcome,
} from './InstructionComposer.js'
import { RunLauncher } from './RunLauncher.js'
import { ACTIVE_RUN, TERMINAL_RUN } from './run-states.js'
import { runOrdinalLabels } from './runLabels.js'

type Mode = 'new' | 'followup' | 'resume'

/** 模式与来源属于草稿意图：后台状态变化只阻塞，不替用户改投。 */
export function ExecutionComposer({
  task,
  session,
  runs,
  approvalPreview,
}: {
  task: TaskView
  session: Session
  runs: TaskRoomRun[]
  approvalPreview: ApprovalPreview
}): ReactNode {
  const active = runs.find((run) => ACTIVE_RUN.has(run.status))
  const terminal = runs.filter((run) => TERMINAL_RUN.has(run.status))
  const [lastOutcome, setLastOutcome] = useState<InstructionOutcome | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<Mode>(active === undefined ? 'new' : 'followup')
  const [sourceId, setSourceId] = useState(active?.id ?? terminal.at(-1)?.id ?? '')
  const isAssignee = task.assigneeUserId === session.userId
  const grants = useQuery({
    queryKey: queryKeys.instructionGrants(task.id),
    queryFn: () => api.get<InstructionDriverView[]>(`/tasks/${task.id}/instruction-grants`),
    enabled: !isAssignee,
  })
  const allowed =
    isAssignee || (grants.isSuccess && grants.data.some((row) => row.userId === session.userId))
  const source = useQuery({
    queryKey: queryKeys.run(sourceId),
    queryFn: () => api.get<RunView>(`/runs/${sourceId}`),
    enabled: allowed && mode !== 'new' && sourceId !== '',
  })
  const agents = useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => api.get<AgentView[]>('/agents'),
    enabled: allowed,
  })
  const sourceAgent = useQuery({
    queryKey: queryKeys.agentDetail(source.data?.agentId ?? ''),
    queryFn: () => api.get<AgentDetailView>(`/agents/${source.data!.agentId}`),
    enabled: allowed && mode === 'resume' && source.isSuccess,
  })
  const revision = sourceAgent.data?.revisions.find(
    (row) => row.id === source.data?.profileRevisionId,
  )
  const sourcePlacement = runs.find((run) => run.id === sourceId)
  const sourceLabel = runOrdinalLabels(runs).get(sourceId) ?? '所选执行'
  let reason: string | null = null
  if (!isAssignee && grants.isPending) reason = '正在确认操作权限…'
  else if (!isAssignee && grants.isError) reason = '暂时无法确认权限，请重试。'
  else if (!allowed) reason = '只有责任人和已授权成员可以发送指令；你仍可在讨论区协作。'
  else if (task.assignmentStatus !== 'accepted') reason = '责任人接受任务后才能开始执行。'
  else if (task.status === 'done' || task.status === 'cancelled')
    reason = '任务已结束，不能继续执行。'
  else if (mode === 'new' && active !== undefined)
    reason = '已有执行进行中，请明确选择发送追问，或等它结束后开始新执行。'
  else if (mode === 'followup' && (active === undefined || active.id !== sourceId))
    reason = '所选执行已结束或发生变化。草稿仍保留，请选择继续会话或开始新执行。'
  else if (mode === 'resume' && active !== undefined)
    reason = '已有执行进行中，结束后才能继续会话。'
  else if (mode !== 'new' && sourceId === '') reason = '请先选择来源执行。'
  else if (mode !== 'new' && source.isError) reason = '无法读取来源执行，请重试。'
  else if (mode !== 'new' && !source.isSuccess) reason = '正在读取来源执行…'
  else if (mode === 'resume' && source.data?.ownerUserId !== task.assigneeUserId)
    reason = '来源执行属于此前的责任人，请基于已发布交接材料开始新执行。'
  else if (mode === 'resume' && source.data?.dshSessionId === null)
    reason = '这次执行没有可续接的会话，请开始新执行。'
  else if (mode === 'resume' && sourceAgent.isError) reason = '无法读取来源配置版本，请重试。'
  else if (mode === 'resume' && sourceAgent.isSuccess && revision === undefined)
    reason = '来源配置版本已不可用，请开始新执行。'
  else if (mode === 'resume' && revision === undefined) reason = '正在确认来源配置版本…'
  const policy: ApprovalPreview =
    mode === 'resume'
      ? revision === undefined
        ? null
        : {
            policy: task.approvalPolicy ?? revision.approvalPolicy,
            source: task.approvalPolicy === null ? 'revision_default' : 'task_override',
          }
      : approvalPreview
  const started = (outcome: InstructionOutcome): void => {
    setLastOutcome(outcome)
    if (outcome.outcome === 'started_run' && outcome.runId !== null) {
      setMode('followup')
      setSourceId(outcome.runId)
    }
  }
  return (
    <div className="execution-composer" data-testid="execution-composer">
      <SelectMenu
        id={`execution-mode-${task.id}`}
        label="执行方式"
        value={mode}
        options={[
          { value: 'new', label: '开始新执行（不接旧会话）', disabled: false },
          {
            value: 'followup',
            label: '发送追问（指定活跃执行）',
            disabled: active === undefined && mode !== 'followup',
          },
          { value: 'resume', label: '继续会话（创建新执行记录）', disabled: terminal.length === 0 },
        ]}
        onChange={(next) => {
          setMode(next as Mode)
          if (next === 'followup' && active !== undefined) setSourceId(active.id)
          if (next === 'resume' && !terminal.some((run) => run.id === sourceId))
            setSourceId(terminal.at(-1)?.id ?? '')
        }}
      />
      {mode === 'resume' ? (
        <SelectMenu
          id={`execution-source-${task.id}`}
          label="来源执行"
          value={sourceId}
          placeholder="选择要继续的会话…"
          options={terminal.map((run) => ({
            value: run.id,
            label: runOrdinalLabels(runs).get(run.id) ?? '历史执行',
            disabled: false,
          }))}
          onChange={setSourceId}
        />
      ) : null}
      {mode !== 'new' ? (
        <p className="mutation-hint" data-testid="execution-context">
          接收 Agent：
          {agents.data?.find((agent) => agent.id === source.data?.agentId)?.name ??
            (agents.isError ? '名称暂不可用' : '读取中')}{' '}
          · 来源：{sourceLabel}
          {mode === 'resume'
            ? ` · 沿用来源配置版本${revision === undefined ? '' : ` r${revision.revision}（${revision.provider}/${revision.model}）`}与执行环境，创建新记录（${sourcePlacement?.deviceName ?? '来源设备'}${sourcePlacement?.workspaceName ? ` · ${sourcePlacement.workspaceName}` : ''}）`
            : ' · 追问只发往该执行'}
        </p>
      ) : null}
      {reason !== null ? (
        <p className="mutation-hint" role="status" data-testid="execution-blocker">
          {reason}
        </p>
      ) : null}
      {!isAssignee ? (
        <p className="mutation-hint">执行使用责任人的环境与凭据，审批仍由责任人处理。</p>
      ) : null}
      {!allowed ? (
        <Link to={`/tasks/${task.id}/permissions`}>查看谁能驱动这个任务的 Agent</Link>
      ) : null}
      {grants.isError || source.isError || sourceAgent.isError ? (
        <button
          type="button"
          className="button"
          onClick={() => {
            void grants.refetch()
            if (sourceId !== '') void source.refetch()
            if (source.data !== undefined) void sourceAgent.refetch()
          }}
        >
          重新确认
        </button>
      ) : null}
      {(allowed &&
        task.assignmentStatus === 'accepted' &&
        task.status !== 'done' &&
        task.status !== 'cancelled') ||
      draft !== '' ? (
        <fieldset disabled={reason !== null} style={{ border: 0, padding: 0, margin: 0 }}>
          {mode === 'new' ? (
            <RunLauncher
              task={task}
              session={session}
              hasActiveRun={active !== undefined}
              embedded
              onOutcome={setLastOutcome}
              draft={draft}
              onDraftChange={setDraft}
              onStarted={(runId) => {
                setMode('followup')
                setSourceId(runId)
              }}
            />
          ) : (
            <InstructionComposer
              key={`${task.id}-${mode}-${sourceId}`}
              initialOutcome={
                mode === 'followup' && lastOutcome?.runId === sourceId ? lastOutcome : null
              }
              taskId={task.id}
              hasActiveRun={mode === 'followup'}
              target={null}
              draft={draft}
              onDraftChange={setDraft}
              approvalPreview={policy}
              intent={{ kind: mode, runId: sourceId }}
              onOutcome={started}
            />
          )}
        </fieldset>
      ) : null}
    </div>
  )
}
