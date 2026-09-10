/**
 * vendored from deepseek-ai/deepseek-harness packages/client/ui-primitives/src/icons/props.ts
 * 与 packages/client/ui-primitives/src/icons/index.tsx 的 `IconChevronDownOutline14`
 * @ c291e7961a515f6d7af9304e7fd1d257929aef26（MIT，见同目录 LICENSE）
 *
 * 本仓改动：上游把 100+ 个图标塞在一个 119KB 的 `icons/index.tsx` 里，本切片只用到
 * DisclosureRow 需要的那一个 `ic_ds_chevron_down_outline_14`，故只取该符号与其
 * `IconProps` 类型（路径数据逐字节照抄，未改 `viewBox`/`fill`/默认 size）。其余图标
 * 不 vendored —— 用到时按同一份 manifest 追加。
 */
/** Shared props for every ic_ds_* icon component. */
export interface IconProps {
  /** Square edge in px; defaults to the glyph's own drawn size. */
  size?: number | undefined
  /** Extra class for layout placement; color rides currentColor.
   * (`| undefined` for exactOptionalPropertyTypes: callers forward their own optional prop.) */
  className?: string | undefined
}

/** ic_ds_chevron_down_outline_14 */
export const IconChevronDownOutline14 = ({ size = 14, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 14 14"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
      fill="currentColor"
    />
  </svg>
)
