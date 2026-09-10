/**
 * SelectMenu（#158）：原生 `<select>` 在应用层的替代品，落在 vendored `Menu` 原语上。
 *
 * 为什么要有这一层，而不是各页直接写 `<Menu>`：
 * 1. `Menu` 是**受控的锚点 + 列表**（上游行为）：`open` 由调用方持有，它只上报
 *    `onSelect` / `onClose`。7 个落页点各写一遍 useState + 触发器 + items 映射，
 *    键盘与 aria 细节会各走各的；包一层才能把「触发器长什么样、键盘怎么走」
 *    变成一处可测的契约。
 * 2. vendored 目录不许改（ADR-0008 §3），所以触发器样式只能写在应用层：见
 *    `styles/global.css` 的 `.select-menu` 段，取值全部来自 L1 白名单 `--dsw-*`。
 *
 * 与原生 `<select>` 的对应关系（逐条对齐，别当成等价物）：
 * - `id` 放**触发器按钮**上：既有的 `#invite-role` / `#task-assignee-*` 仍能定位到
 *   那个控件本身（标签也仍然用 `htmlFor` 指向它），只是元素从 `<select>` 变成
 *   `<button>`——测试里 `selectOption()` 这类**只有原生 select 才有的 API** 必须改走
 *   真人路径（点开菜单 → 点选项），这正是 #158 要求同步更新的部分；
 * - `value` → `Menu` 的 `selectedId`；`onChange(value)` → `onSelect(id)`；
 * - 禁用项：`<option disabled>` → `MenuItem.disabled`（Menu 的项本身是
 *   `<button type="button">`，被 disable 后既不响应指针也不进键盘序列，与原生一致）；
 * - **`required` 没有对应物**：按钮不是表单可校验元素，原生 `required` 的「不选就不
 *   放行」在浏览器层消失了。7 个落页点的宿主表单本来就有「值为空则提交按钮禁用」的
 *   守卫（PackSelect / ProjectsPage 的 `disabled={…}`、RunLauncher 的 `ready`），迁移后
 *   该守卫就是**唯一**的拦截，不要删。所以这里改成 `aria-required="true"` 如实告知
 *   读屏，而不是假装还有浏览器校验。
 *
 * 键盘路径（`autoFocus` 打开即聚焦首项，两条都是 vendored `Menu` 自带的实现，本层不重复）：
 * Tab 到触发器 → Enter/Space 打开（原生 button 行为）→ 方向键 / Home / End 在项间移动 →
 * Enter/Space 选中并关闭 → Esc 关闭并把焦点还给触发器。本层只负责把
 * `aria-haspopup="menu"` 与 `aria-expanded` 如实标出——后者与 #152 折叠入口同一套语义。
 */
import { useCallback, useId, useState, type ReactNode } from 'react'
import { Menu } from '../vendor/dsh-ui/Menu.js'
import type { MenuEntry } from '../vendor/dsh-ui/Menu.js'
// 图标不走原语桶：`icons.tsx` 是 vendored 子目录里的**支撑文件**（只含被原语用到的几个
// 符号），不是 L2 原语导出面（DisclosureRow.tsx 也是这么直接引的）。本层只借这一个
// chevron，不为触发器另画图标。
import { IconChevronDownOutline14 } from '../vendor/dsh-ui/icons.js'

/**
 * 触发器取值所用的 L1 token（#158 的视觉判据锚在这里）。
 *
 * 为什么要导出：这条契约有两个消费者，分居两侧——单测
 * （`tests/select-menu.spec.tsx`）在 CSS 文本里钉「这条规则只吃这些 token」，
 * Q5 在真实浏览器里钉「computed style 等于这些 token 的解析值」
 * （`tests/e2e/helpers.ts` 的 `assertMenuTriggerTokens`）。两边**必须锚同一组名字**：
 * 各写一份就会漂移成"单测管 A、浏览器管 B"——把 `--dsw-alias-bg-layer-1` 换成
 * `-2` 这种既有测试全都绿的改动就漏过去了（实测：两者浅色下取值相同）。
 */
export const SELECT_TRIGGER_BACKGROUND_TOKEN = '--dsw-alias-bg-layer-1'
export const SELECT_TRIGGER_BORDER_TOKEN = '--dsw-alias-border-l4'

/** 与原生 `<option>` 对齐的一项；`disabled` 的项在列表里不可点、键盘也跳不过去。 */
export interface SelectMenuOption {
  value: string
  /**
   * 选项文案。给 `ReactNode` 是为了承接原 `<option>` 里的富文本（如
   * 「r3 — deepseek/deepseek-chat（当前）」是多个文本节点拼的）。
   */
  label: ReactNode
  /** 必填，不用可选字段：`exactOptionalPropertyTypes` 下 `disabled?: boolean` 的
   *  `boolean | undefined` 传不进 `MenuItem.disabled`，显式写反而更清楚。 */
  disabled: boolean
}

export interface SelectMenuProps {
  /** 触发器按钮的 id：沿用原 `<select>` 的 id，接口面与 e2e 定位不退化。 */
  id: string
  /** 可见标签文案；渲染成 `<label htmlFor={id}>`，与原来一样是触发器的可访问名来源。 */
  label: string
  /**
   * 可访问名与可见标签不一致时用它（默认用 `label`）。RunLauncher 的四处沿用原
   * `<select aria-label="选择 Agent">` 的措辞：e2e 与单测按「选择 Agent」定位，
   * 而屏上标签是「Agent」——名字不改，只把承载者从 `<select>` 换成按钮。
   */
  ariaLabel?: string
  value: string
  /**
   * 空值 placeholder：`value` 为空时显示它，且它在列表里是**禁用项**
   * （对应原生 `<option value="" disabled>` 那种「提示不是选项」的写法）。
   */
  placeholder?: string
  options: readonly SelectMenuOption[]
  onChange: (value: string) => void
  disabled?: boolean
  /**
   * 字段下方的说明文字（如「先选设备…」），承接原 `<option>` 里的引导文案。
   * 类型里显式写 `| undefined`：`exactOptionalPropertyTypes` 下调用方把
   * `cond ? '文案' : undefined` 直接传进来是常态，不写就得在每处调用点绕 spread。
   */
  hint?: string | undefined
}

export function SelectMenu({
  id,
  label,
  ariaLabel,
  value,
  placeholder,
  options,
  onChange,
  disabled = false,
  hint,
}: SelectMenuProps): ReactNode {
  const [open, setOpen] = useState(false)
  const labelId = useId()
  const hintId = useId()

  // 选中项被禁用时不认这个 value（例如 placeholder 自身）：原生 `<select>` 的 value
  // 同样不会落在 disabled option 上，保持一致，免得界面出现「选中了一个不能选的项」。
  const selected = options.find((option) => option.value === value && !option.disabled)
  const display = selected?.label ?? placeholder ?? '未选择'

  const items: MenuEntry[] = [
    ...(placeholder === undefined
      ? []
      : [{ id: '', label: placeholder, disabled: true } satisfies MenuEntry]),
    ...options.map((option): MenuEntry => ({
      id: option.value,
      label: option.label,
      disabled: option.disabled,
    })),
  ]

  // 受控：Menu 自己不写 open，选中/点外/Esc 都只上报意图，由这里落状态。
  const close = useCallback(() => {
    setOpen(false)
  }, [])
  const select = useCallback(
    (next: string) => {
      setOpen(false)
      onChange(next)
    },
    [onChange],
  )

  return (
    <>
      <label id={labelId} htmlFor={id} className="select-menu-label">
        {label}
      </label>
      <Menu
        open={open}
        // 打开即聚焦首项：这是 Menu 里方向键导航与「Esc 后焦点回触发器」的**前提**
        // （上游 autoFocus 为 false 时那两条都不生效）。真人从键盘进来的路径必须留着。
        autoFocus
        align="start"
        className="select-menu"
        items={items}
        {...(value === '' ? {} : { selectedId: value })}
        onSelect={select}
        onClose={close}
        data-testid={`${id}-menu`}
        anchor={
          <button
            type="button"
            id={id}
            className="select-menu-trigger"
            aria-haspopup="menu"
            aria-expanded={open}
            // 可访问名**只挂标签**，不拼当前值：原生 select 的 accname 同样只有标签
            // （值另有自己的暴露通道，读屏会读当前项）。实测踩过：把 `-value` 也写进
            // aria-labelledby 后，可访问名变成「责任人 Bob（@bob）· 你」，
            // `getByLabelText('责任人')` 全站失配——既有测试与 e2e 都按标签定位控件，
            // 名字里混进值等于把「控件身份」和「控件状态」焊死在一起。
            // 调用方给了 ariaLabel 就用它，此时不再挂 aria-labelledby
            // （两条同时存在时 aria-labelledby 胜出，留着只会让人以为它生效）。
            {...(ariaLabel === undefined
              ? { 'aria-labelledby': labelId }
              : { 'aria-label': ariaLabel })}
            // 说明文字挂到控件上（原生 select 没有对应通道，这是按钮形态的补强）：
            // 只在真有 hint 时挂，免得 aria-describedby 指向一个不存在的 id。
            {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
            // 与 #152 折叠入口同一套语义：展开态如实标出。
            aria-required="true"
            disabled={disabled}
            onClick={() => {
              setOpen(!open)
            }}
          >
            <span
              id={`${id}-value`}
              className="select-menu-value"
              data-placeholder={selected === undefined ? 'true' : undefined}
            >
              {display}
            </span>
            <IconChevronDownOutline14 className="select-menu-chevron" />
          </button>
        }
      />
      {hint === undefined ? null : (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
    </>
  )
}
