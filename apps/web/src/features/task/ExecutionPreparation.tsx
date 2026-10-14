import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  ExecutionPreparationViewSchema,
  type ExecutionPreparationRequest,
} from '@whalepod/protocol'
import { NODE_CLI_COMMAND } from '../../shared/node-installation.js'
import { api } from '../../shared/api/client.js'
import { ErrorBanner } from '../../app/ErrorBanner.js'

export function ExecutionPreparation({
  taskId,
  selection,
  provider,
  credentialSlot,
  draft,
  onTrialDraft,
  onTarget,
  onBlocked,
}: {
  taskId: string
  selection: ExecutionPreparationRequest
  provider: string
  credentialSlot: string
  draft: string
  onTrialDraft: (text: string) => void
  onTarget: (target: { deviceId: string; workspaceId: string }) => void
  onBlocked: (blocked: boolean) => void
}): ReactNode {
  const signature = JSON.stringify(selection)
  const current = useRef(signature)
  current.current = signature
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const [expired, setExpired] = useState(false)
  const check = useMutation({
    mutationFn: async (input: { selection: ExecutionPreparationRequest; signature: string }) => {
      const result = ExecutionPreparationViewSchema.parse(
        await api.mutate(`/tasks/${taskId}/preparation-check`, { body: input.selection }),
      )
      if (
        result.profileRevisionId !== input.selection.profileRevisionId ||
        (input.selection.deviceId !== undefined && result.deviceId !== input.selection.deviceId) ||
        (input.selection.workspaceId !== undefined &&
          result.workspaceId !== input.selection.workspaceId)
      )
        throw new Error('检查结果与所选配置或现场不一致，请重新确认')
      return {
        result,
        originalSignature: input.signature,
        boundSignature: JSON.stringify({
          ...input.selection,
          deviceId: result.deviceId,
          workspaceId: result.workspaceId,
        }),
      }
    },
    onSuccess: (data) => {
      if (!alive.current || current.current !== data.originalSignature) return
      setExpired(false)
      onTarget({ deviceId: data.result.deviceId, workspaceId: data.result.workspaceId })
    },
  })
  const result =
    check.data?.boundSignature === signature && !expired ? check.data.result : undefined
  useEffect(() => {
    onBlocked(
      result !== undefined &&
        (result.workspace !== 'available' || result.credential !== 'configured'),
    )
    return () => onBlocked(false)
  }, [result, onBlocked])
  useEffect(() => {
    if (check.data === undefined) return
    const timer = setTimeout(() => setExpired(true), 30_000)
    return () => clearTimeout(timer)
  }, [check.data])
  // Shell 引号是显示命令的一部分，provider/slot 的任意字符不得变成命令替换。
  const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  return (
    <details className="execution-preparation" open>
      <summary>首次执行准备</summary>
      <p className="mutation-hint">
        由你在自己的电脑上准备。检查不调用模型；模型是否能调用仍需实际执行验证。
      </p>
      <ol>
        <li>
          <Link to="/devices">安装并配对执行服务</Link>
          ，保持服务启动；仅讨论和接受任务无需配置电脑。
        </li>
        <li>
          在你的电脑的 WhalePod 源码目录执行并登记工作目录（替换占位符）：
          <code>{`${NODE_CLI_COMMAND} workspace add <你的目录> --name <显示名>`}</code>
          。目录路径只留本机。
        </li>
        <li>
          本次Agent使用 {provider}。本机配置对应凭据：
          <code>{`${NODE_CLI_COMMAND} secret set ${shellQuote(provider)} ${shellQuote(credentialSlot)}`}</code>
          。按本机提示输入，网页不接收密钥。
        </li>
      </ol>
      <button
        type="button"
        className="button"
        disabled={check.isPending}
        onClick={() => check.mutate({ selection, signature })}
      >
        {check.isPending ? '正在检查本机…' : '检查本次准备条件'}
      </button>
      {result === undefined ? (
        <p className="mutation-hint" data-testid="preparation-status">
          {check.isPending
            ? '正在确认，尚未获得本机结果。'
            : expired
              ? '上次检查已过期，请重新确认本次环境。'
              : '本次准备条件尚未确认。配置或目标变化后需重新检查。'}
        </p>
      ) : (
        <div data-testid="preparation-status">
          <p className="mutation-hint">
            本次检查截至 {new Date(result.checkedAt).toLocaleTimeString()}：{result.deviceName} ·{' '}
            {result.workspaceName}。这是本次快照，启动时仍会检查。
          </p>
          <p>
            工作目录：
            {result.workspace === 'available'
              ? '已确认可用'
              : result.workspace === 'unavailable'
                ? '不可用，请在本机重新登记或修复目录'
                : '未确认，请检查本机执行服务'}
          </p>
          <p>
            模型凭据：
            {result.credential === 'configured'
              ? '本机已配置；未验证模型调用'
              : result.credential === 'unconfigured'
                ? '尚未配置，请由你在本机配置'
                : '未确认，请在本机检查凭据文件权限或配置'}
          </p>
          <p>模型调用：尚未验证。准备检查不证明模型额度、网络或插件可用。</p>
        </div>
      )}
      {check.isError ? (
        <>
          <p className="mutation-hint" role="status">
            暂时无法确认本次准备条件，请重新检查。
          </p>
          <ErrorBanner error={check.error} />
        </>
      ) : null}
      <p className="mutation-hint">
        可选试运行：填入简单指令后，由你点击“开始执行”。可能产生模型费用，沿用当前审批设置；请观察实际运行与候选结果。
      </p>
      <button
        type="button"
        className="button"
        disabled={
          draft.trim() !== '' ||
          result?.workspace !== 'available' ||
          result.credential !== 'configured'
        }
        onClick={() =>
          onTrialDraft('请用一句话确认你已收到这条试运行指令，不需要调用工具或修改文件。')
        }
      >
        填入试运行指令
      </button>
      {draft.trim() !== '' ? (
        <p className="mutation-hint">已有草稿，试运行不会覆盖。请先保存或清空草稿。</p>
      ) : null}
    </details>
  )
}
