/**
 * vendored from deepseek-ai/deepseek-harness packages/client/ui-primitives/src/index.ts
 * @ c291e7961a515f6d7af9304e7fd1d257929aef26（MIT，见同目录 LICENSE）
 *
 * 本仓改动：上游 index 是整包桶文件（43 是 `packages/client/ui-*` 的**包数**；
 * `ui-primitives/src` 顶层 29 个 `.tsx` / 桶文件导出 30 个原语）；本仓只导出已 vendored
 * 的原语与其类型——首批 6 个 + #138 L2 第二批 4 个（Input/Menu/ConnectionIndicator/Modal）
 * = 10 个，import 后缀按本仓 NodeNext 口径写 `.js`。
 * 上游首行自述「Cordis-free React primitives styled only through --dsw-* tokens」
 * —— 这是选它做 L2 起点的原因：零 cordis、零业务依赖。
 */

export { Button } from './Button.js'
export type { ButtonVariant } from './Button.js'
export { Pill } from './Pill.js'
export { Tag } from './Tag.js'
export type { TagTone } from './Tag.js'
export { StateDot } from './StateDot.js'
export type { StateDotState } from './StateDot.js'
export { DisclosureRow } from './DisclosureRow.js'
export type { DisclosureRowProps } from './DisclosureRow.js'
export { Switch } from './Switch.js'
// #138 L2 第二批（四个都整取，未经裁剪——逐个的可移植性判断与实测见
// docs/agent/dsh-ui-vendoring-batch2.md；Menu 的运行时依赖 pointer-grace 也一并导出，
// 因为调用方需要在锚点 pointerenter/leave 上自己 arm/cancel 时才用得到）。
export { Input } from './Input.js'
export { Menu } from './Menu.js'
export type { MenuItem, MenuSeparator, MenuLabel, MenuEntry } from './Menu.js'
export { ConnectionIndicator } from './ConnectionIndicator.js'
export type { ConnectionIndicatorState } from './ConnectionIndicator.js'
export { Modal } from './Modal.js'
export { usePointerGrace, POINTER_GRACE_MS } from './pointer-grace.js'
export type { PointerGrace } from './pointer-grace.js'
// `cx` 是**本仓新增代码**（Apache-2.0，非上游 MIT），不是上游导出；在此显式导出以便
// 原语级单测直接验它的入参子集（本目录之外的业务代码不要用它，业务侧类名拼接请自便）。
export { cx } from './cx.js'

