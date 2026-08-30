/**
 * Run 失败警示（P1-16 G7-05；红线：未知副作用必须明示，不声称安全重放）。
 *
 * failed/lost 的 Run 一律警示：崩溃前可能已执行过有副作用的工具，系统不做
 * 任何自动重放/自动重跑的暗示——重跑是用户显式动作，且开始前需验证外部状态。
 * completed/cancelled 不出现（取消与正常完成不携带「未知副作用」语义）。
 */
import type { ReactNode } from 'react'
import type { RunView } from '../../shared/api/types.js'

export function RunFailureNotice({ run }: { run: RunView }): ReactNode {
  if (run.status !== 'failed' && run.status !== 'lost') return null
  const code = run.failureCode ?? run.status
  return (
    <div className="run-failure-notice" role="alert" data-testid="run-failure-notice">
      <strong>Run 异常结束（{code}）</strong>
      <p>
        这个 Run 崩溃前可能已执行过有副作用的工具（写文件、网络请求、外部系统调用等）。
        系统不会自动重放这些操作，也不会自动重启它；开始新的 Run 前，需验证外部状态。
      </p>
    </div>
  )
}
