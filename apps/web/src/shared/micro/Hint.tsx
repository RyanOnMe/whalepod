/**
 * #308 提示层的应用内适配（React Bits WarmTooltip）。
 *
 * 只有一种用法被允许：**可见文案够不着真目标的可聚焦控件**。
 * 例：按钮上写「复制」，但真正复制的是「邀请链接」还是「配对码」只有 aria-label 知道；
 * 运行列表项只显示序号，完整 Run id 只存在于原生 title 里（键盘用户根本读不到）。
 *
 * 所以这里只做三件事：给全壳一个共享 `HintGroup`（这样相邻目标的第二次悬停是即时的，
 * 也就是上游说的 "warm"）、把提示层默认放在上方、把「静态标签」写进判据。
 * 不给非焦点元素（纯展示的 span/h3）加提示——那会把只读文案变成 tab 停靠点，
 * 是另一件事，不在本切片。
 */
import WarmHint, {
  HintGroup as WarmHintGroup,
  type HintGroupProps,
  type HintProps,
} from '../../vendor/react-bits-micro/WarmTooltip.js'

export type { HintGroupProps, HintProps }

export const HintGroup = WarmHintGroup
export const Hint = WarmHint
