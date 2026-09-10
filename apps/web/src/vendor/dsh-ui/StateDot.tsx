/**
 * vendored from deepseek-ai/deepseek-harness packages/client/ui-primitives/src/StateDot.tsx
 * @ c291e7961a515f6d7af9304e7fd1d257929aef26（MIT，见同目录 LICENSE）
 * 本仓改动（仅工程口径，未动视觉与行为）：`clsx` → `./cx.js`；import 后缀 `.tsx` → `.js`。
 */
import { cx } from './cx.js'
import css from './StateDot.module.css'

/**
 * State semantic: green done / amber user-attention / blue running ring /
 * red error / grey idle for a tracked subject with nothing in progress.
 */
export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

/** Outer 3x3 matrix cells (2px pixels on a 10px grid), clockwise from top-left. */
const MATRIX_CELLS: readonly (readonly [number, number])[] = [
  [0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4],
]

/**
 * Render a state dot.
 * @param props.state - which of `done`, `warning`, `ongoing`, `error`, or `idle` to show.
 * @param props.size - outer diameter in px (default 10, the figma size).
 * @param props.className - extra class for layout placement.
 * @returns the dot element (aria-hidden; pair with text for accessibility).
 */
export function StateDot({ state, size = 10, className, 'data-testid': dataTestId }: {
  state: StateDotState
  size?: number | undefined
  className?: string | undefined
  /** 本仓新增：调用方可覆写的稳定测试锚点（Q5 判「样式真的生效」时用）。 */
  'data-testid'?: string | undefined
}) {
  // `data-vendored="state-dot"` 是本仓新增的稳定锚（两个分支都带）：类名被 CSS Modules
  // hash 掉，测试只该锚属性，不该猜 hash。
  if (state === 'ongoing') {
    return (
      <svg
        className={cx(css.matrix, className)}
        data-state="ongoing"
        data-vendored="state-dot"
        data-testid={dataTestId}
        width={size}
        height={size}
        viewBox="0 0 10 10"
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        {MATRIX_CELLS.map(([x, y], index) => (
          <rect
            key={`${x}-${y}`}
            className={css.cell}
            x={x}
            y={y}
            width="2"
            height="2"
            /* Negative delay phases the chase so every cell animates from mount. */
            style={{ animationDelay: `${(index - MATRIX_CELLS.length) * 125}ms` }}
          />
        ))}
      </svg>
    )
  }
  return (
    <span
      className={cx(css.dot, className)}
      data-state={state}
      data-vendored="state-dot"
      data-testid={dataTestId}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  )
}
