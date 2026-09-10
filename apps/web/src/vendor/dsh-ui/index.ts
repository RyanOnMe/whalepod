/**
 * vendored from deepseek-ai/deepseek-harness packages/client/ui-primitives/src/index.ts
 * @ c291e7961a515f6d7af9304e7fd1d257929aef26（MIT，见同目录 LICENSE）
 *
 * 本仓改动：上游 index 是整包桶文件（43 个原语 + markdown + 全量图标）；本切片只
 * 导出已 vendored 的 6 个原语与其类型，import 后缀按本仓 NodeNext 口径写 `.js`。
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
