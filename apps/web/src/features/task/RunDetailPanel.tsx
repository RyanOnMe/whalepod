/**
 * 运行详情（P1-393；ADR-0019 决定 2）。
 *
 * 主界面不再常驻运行列表：每段的入口把这里打开。详情内可切换历史运行，看到
 * 设备、时间、时长、血缘、审批档与约定绑定，查看输入快照与交接草稿，并把这次运行
 * 「放大看」（Console 覆盖层）；这次运行的**行动面**（取消 / 继续此会话 / 重跑此 Run）
 * 也在这一处——段上只留一个简短状态与一个入口，低频操作收进详情（ADR-0019 决定 2）。
 *
 * 切换运行只改详情面板自己的选中，不改底部输入框的发送目标（ADR-0019 决定 2）。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../shared/api/client.js'
import { queryKeys } from '../../app/query-client.js'
import { SelectMenu } from '../../shared/SelectMenu.js'
import { RelativeTime } from '../../shared/RelativeTime.js'
import { RUN_PHASE_LABEL } from '../../shared/format.js'
import type { RunView, Session, TaskRoomRun, TaskView } from '../../shared/api/types.js'
import { RunActions } from '../run/RunActions.js'
import { RunHandoffDraft } from './RunHandoffDraft.js'
import { RunInputManifest } from './RunInputManifest.js'
import { runDurationText } from './runDuration.js'
import { rerunLineageLabel, resumeLineageLabel, runOrdinalLabels } from './runLabels.js'
import { ACTIVE_RUN, TERMINAL_RUN } from './run-states.js'

/** #248：活跃运行的「已耗时」每 30 秒自跳一次（只有活跃已开始的运行才挂定时器）。 */
const DURATION_TICK_MS = 30_000

const PURPOSE_LABEL: Readonly<Record<TaskRoomRun['purpose'], string>> = {
  business: '业务运行',
  agreement_draft: '任务约定草稿',
  handoff_draft: '交接草稿',
}

export interface RunDetailPanelProps {
  task: TaskView
  session: Session | null
  runs: readonly TaskRoomRun[]
  selectedRunId: string | undefined
  onSelectRun: (runId: string) => void
  onOpenConsole: (runId: string) => void
  /** 「继续此会话」：把来源交给底部统一输入框，并把详情收回（入口就在这一处）。 */
  onContinueSession: (runId: string) => void
}

export function RunDetailPanel({
  task,
  session,
  runs,
  selectedRunId,
  onSelectRun,
  onOpenConsole,
  onContinueSession,
}: RunDetailPanelProps): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  const ordinal = useMemo(() => runOrdinalLabels(runs), [runs])
  const run = runs.find((row) => row.id === selectedRunId) ?? runs.at(-1)
  if (run === undefined) {
    return <p className="empty-state">还没有 Run。开始执行后可查看输入与交接草稿。</p>
  }
  // #248：「活跃显已耗时」是随时间走的读数，快照一次会把时长冻在打开详情的那一刻
  //（面板常驻挂载，只切 hidden，不会自己重挂）。只有活跃且已开始的运行才挂定时器。
  const ticking = ACTIVE_RUN.has(run.status) && run.startedAt !== null
  useEffect(() => {
    if (!ticking) return
    const timer = window.setInterval(() => setNow(Date.now()), DURATION_TICK_MS)
    return () => window.clearInterval(timer)
  }, [ticking])
  // 行动面要的是 RunView（重跑提交体带 agentId/deviceId/workspaceId，段与详情都从
  // 同一个 ['run', id] 读面取——与段共享缓存，不额外打接口）。
  const view = useQuery({
    queryKey: queryKeys.run(run.id),
    queryFn: () => api.get<RunView>(`/runs/${run.id}`),
    enabled: session !== null,
  })
  const duration = runDurationText(run, now)
  const phase = run.lastPhase?.phase
  const phaseLabel = phase === undefined ? undefined : RUN_PHASE_LABEL[phase]
  return (
    <div className="run-detail" data-testid="run-detail">
      <SelectMenu
        appearance="glide"
        id={`run-detail-switch-${task.id}`}
        label="切换运行"
        value={run.id}
        options={runs.map((row) => ({
          value: row.id,
          label: ordinal.get(row.id) ?? '运行',
          disabled: false,
        }))}
        onChange={onSelectRun}
      />
      <dl className="run-detail-meta" data-testid="run-detail-meta">
        {/* #211 B1：落点（显示名，不是 id）。null = 未知设备——不编造、不画 id。 */}
        <div>
          <dt>落点</dt>
          <dd data-testid="run-placement">
            {run.deviceName ?? '未知设备'}
            {run.workspaceName === null ? '' : ` · ${run.workspaceName}`}
          </dd>
        </div>
        <div>
          <dt>创建</dt>
          <dd>
            <RelativeTime iso={run.createdAt} />
          </dd>
        </div>
        <div>
          <dt>开始</dt>
          <dd>
            <RelativeTime iso={run.startedAt} />
          </dd>
        </div>
        <div>
          <dt>结束</dt>
          <dd>
            <RelativeTime iso={run.finishedAt} />
          </dd>
        </div>
        {duration === null ? null : (
          <div>
            <dt>时长</dt>
            <dd data-testid="run-duration">{duration}</dd>
          </div>
        )}
        <div>
          <dt>审批</dt>
          <dd data-testid="run-approval-policy">
            {run.approvalPolicy === 'full_access' ? '完全权限（工具调用未逐次批准）' : '逐次批准'}
          </dd>
        </div>
        <div>
          <dt>用途</dt>
          <dd data-testid="run-purpose">{PURPOSE_LABEL[run.purpose]}</dd>
        </div>
        <div>
          <dt>约定版本</dt>
          <dd data-testid="run-spec-revision">
            {run.specRevision === null ? '未绑定' : `v${run.specRevision.revisionNumber}`}
          </dd>
        </div>
        {/* #261：运行中的阶段（终态与等待审批不画——那是撒谎）。 */}
        {run.status === 'running' && phaseLabel !== undefined ? (
          <div>
            <dt>阶段</dt>
            <dd data-testid="run-phase">{phaseLabel}</dd>
          </div>
        ) : null}
      </dl>
      {run.rerunOfRunId === null ? null : (
        <p className="run-lineage" data-testid="run-lineage" title={run.rerunOfRunId}>
          {rerunLineageLabel(ordinal.get(run.rerunOfRunId))}
        </p>
      )}
      {run.resumeFromRunId === null ? null : (
        <p className="run-lineage" data-testid="run-lineage" title={run.resumeFromRunId}>
          {resumeLineageLabel(ordinal.get(run.resumeFromRunId))}
        </p>
      )}
      {session === null ? null : (
        <button
          type="button"
          className="button"
          data-testid="open-run-console"
          onClick={() => onOpenConsole(run.id)}
        >
          打开 Console
        </button>
      )}
      {session === null || view.data === undefined ? null : (
        <RunActions
          run={view.data}
          session={session}
          onContinueSession={() => onContinueSession(run.id)}
        />
      )}
      <RunInputManifest key={run.id} runId={run.id} taskId={task.id} runLabels={ordinal} />
      {session === null ? null : (
        <RunHandoffDraft
          key={`handoff-draft-${run.id}`}
          runId={run.id}
          task={task}
          session={session}
          runTerminal={TERMINAL_RUN.has(run.status)}
        />
      )}
    </div>
  )
}
