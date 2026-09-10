/**
 * vendored from deepseek-ai/deepseek-harness packages/client/ui-primitives/src/ConnectionIndicator.tsx
 * @ c291e7961a515f6d7af9304e7fd1d257929aef26（MIT，见同目录 LICENSE）
 * 本仓改动分两类：①工程口径（图标 import 改指本目录 `./icons.js`，且按上游该文件的写法
 * 不带 `.tsx`/`.ts` 后缀（上游混用两种写法，本文件是裸路径那种）；②可测性（两个渲染分支
 * 都新增根属性 `data-vendored="connection-indicator"`、允许调用方覆写 `data-testid`）。
 * ②是 API 面的改动而不是纯格式差异——**视觉与行为未改**，但同步上游时它属于要保留的改动。
 * 上游这一版**完全没有 import clsx**（实测：文件里 clsx 零命中，类名是模板字符串拼的），
 * 与首批 6 个原语不同，故本文件不涉及 `clsx` → `./cx.js` 这处工程口径改动。
 */
import { IconCheckOutline16, IconWarningOutline16 } from './icons.js'
import css from './ConnectionIndicator.module.css'

/** Visual state rendered by {@link ConnectionIndicator}. */
export type ConnectionIndicatorState =
  | 'disconnected'
  | 'connecting'
  | 'recovered'

/**
 * Render an inline connection-recovery control.
 * @param props.state - visible outage, retry-attempt, or recovered state.
 * @param props.disconnectedLabel - localized outage text.
 * @param props.reconnectLabel - localized action text shown on hover or focus.
 * @param props.connectingLabel - localized retry text followed by the attempt dots.
 * @param props.recoveredLabel - localized recovery confirmation.
 * @param props.reconnectActionLabel - accessible label for the outage action.
 * @param props.restartActionLabel - accessible label for replacing an active attempt.
 * @param props.onReconnect - request an immediate reconnect attempt.
 * @returns the indicator, or null when no connection feedback is active.
 */
export function ConnectionIndicator({
  state,
  disconnectedLabel,
  reconnectLabel,
  connectingLabel,
  recoveredLabel,
  reconnectActionLabel,
  restartActionLabel,
  onReconnect,
  'data-testid': dataTestId,
}: {
  state: ConnectionIndicatorState | undefined
  disconnectedLabel: string
  reconnectLabel: string
  connectingLabel: string
  recoveredLabel: string
  reconnectActionLabel: string
  restartActionLabel: string
  onReconnect: () => void
  /** 本仓新增：调用方可覆写的稳定测试锚点（Q5 判「样式真的生效」时用）。 */
  'data-testid'?: string | undefined
}) {
  if (state === undefined) return null
  const sizeLabels = (
    <>
      <span className={css.sizeLabel} aria-hidden="true">{disconnectedLabel}</span>
      <span className={css.sizeLabel} aria-hidden="true">{reconnectLabel}</span>
      <span className={css.sizeLabel} aria-hidden="true">
        {connectingLabel}<span className={css.dots}>...</span>
      </span>
      <span className={css.sizeLabel} aria-hidden="true">{recoveredLabel}</span>
    </>
  )
  if (state === 'recovered') {
    // `data-vendored="connection-indicator"` 是本仓新增的稳定锚（两个分支都带）：
    // 类名被 CSS Modules hash 掉，测试只该锚属性，不该猜 hash。
    return (
      <div
        className={`${css.indicator} ${css.success}`}
        role="status"
        aria-label={recoveredLabel}
        data-vendored="connection-indicator"
        data-testid={dataTestId}
      >
        <span className={css.icon} aria-hidden="true"><IconCheckOutline16 size={14} /></span>
        <span className={css.label}>
          {sizeLabels}
          <span className={css.stateLabel}>{recoveredLabel}</span>
        </span>
      </div>
    )
  }

  const connecting = state === 'connecting'
  return (
    <button
      type="button"
      className={`${css.indicator} ${css.warning}`}
      data-phase={state}
      data-vendored="connection-indicator"
      data-testid={dataTestId}
      aria-label={connecting ? restartActionLabel : reconnectActionLabel}
      onClick={onReconnect}
    >
      <span className={css.icon} aria-hidden="true"><IconWarningOutline16 size={14} /></span>
      <span className={css.label}>
        {sizeLabels}
        <span className={css.stateLabel}>
          {connecting
            ? (
              <>
                {connectingLabel}
                <span className={css.dots} aria-hidden="true">
                  <span>.</span>
                  <span className={css.secondDot}>.</span>
                  <span className={css.thirdDot}>.</span>
                </span>
              </>
            )
            : disconnectedLabel}
        </span>
        <span className={css.hoverLabel}>{reconnectLabel}</span>
      </span>
    </button>
  )
}
