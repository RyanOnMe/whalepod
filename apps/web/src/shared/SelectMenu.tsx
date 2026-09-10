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
 *   `<button type="button">`，被 disable 后既不响应指针也不进键盘序列，与原生一致）。
 *
 * **已知缺口（评审追出，别再"顺手补一句 aria"）**：
 * 1. **`required` 没有对应物，而且 `aria-required` 也补不上**。按钮不是表单可校验元素，
 *    原生 `required` 的「不选就不放行」在浏览器层消失；而 ARIA 1.2 的 `aria-required`
 *    Used-in-Roles 白名单是 checkbox / combobox / gridcell / listbox / radiogroup /
 *    spinbutton / textbox（+tree），**不含 button** —— 挂在触发器上 AT 不会按必填播报，
 *    写了等于自欺。所以本层**不挂**该属性，"必填"只剩应用层的守卫：宿主表单必须自己
 *    「值为空则禁用提交」（PackSelect 的两个宿主表单、RunLauncher 的 `ready`、
 *    ProjectsPage 的空值守卫；**MembersPage 的角色选择本来就没有 required**——有默认值，
 *    不要为了"统一"给它加必填）。谁删这些守卫，谁就把校验整条拆掉了。
 *    要真正表意得把触发器改成 `aria-haspopup="listbox"` + 列表项 `role="option"` +
 *    `aria-required`，那是**偏离 vendored Menu 的 role=menu/menuitem** 的一层额外映射，
 *    本切片不自行拍板。
 * 2. **选中态对 AT 不可见**：vendored `Menu` 的选中项只有一个尾随 check 图标，没有
 *    `aria-checked` / `aria-selected`，读屏拿不到"当前选的是哪个"（上游原语缺口，
 *    已登记到 `docs/agent/dsh-ui-vendoring-batch2.md`）。选中的**文字**仍会渲染在触发器
 *    上，所以视觉与键盘用户不受影响。
 *
 * 键盘路径（`autoFocus` 打开即聚焦首项，两条都是 vendored `Menu` 自带的实现，本层不重复）：
 * Tab 到触发器 → Enter/Space 打开（原生 button 行为）→ 方向键 / Home / End 在项间移动 →
 * Enter/Space 选中并关闭 → Esc 关闭并把焦点还给触发器。本层只负责把
 * `aria-haspopup="menu"` 与 `aria-expanded` 如实标出——后者与 #152 折叠入口同一套语义——
 * 并在**选中后自己把焦点收回触发器**（`Menu` 只在 Esc 且 `autoFocus` 时回焦，选中路径
 * 不回；不补的话键盘用户每选一个字段就要从文档头重新 Tab，见下面的 `triggerRef`）。
 */
import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { Menu } from '../vendor/dsh-ui/Menu.js'
import type { MenuEntry } from '../vendor/dsh-ui/Menu.js'
// 图标不走原语桶：`icons.tsx` 是 vendored 子目录里的**支撑文件**（只含被原语用到的几个
// 符号），不是 L2 原语导出面（DisclosureRow.tsx 也是这么直接引的）。本层只借这一个
// chevron，不为触发器另画图标。
import { IconChevronDownOutline14 } from '../vendor/dsh-ui/icons.js'

// 触发器取值所用的 L1 token 与判定函数住在 `./select-trigger-tokens.js`：那里是**零运行时
// 依赖**的纯模块，Q5 的 e2e 进程与单测都能直接 load（本文件带 Menu/图标/CSS 模块，e2e
// 侧反向 import 进来会拖 CSS 模块，见该文件头注释）。这里原样再导出，保证
// `shared/SelectMenu.js` 的对外面不变。
export {
  SELECT_TRIGGER_BACKGROUND_TOKEN,
  SELECT_TRIGGER_BORDER_TOKEN,
} from './select-trigger-tokens.js'

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
  //
  // S3（评审追出）：**关闭时把焦点收回触发器**。vendored `Menu` 只在「Esc 且 autoFocus」
  // 时回焦（Menu.tsx 的 keydown 分支），选中路径完全不管焦点——实测 jsdom 下选中后
  // `document.activeElement` 是 `<body>`（那条断言见 tests/select-menu.spec.tsx 的键盘
  // 全路径用例）。后果是键盘用户在 RunLauncher 的四个字段之间每选一次都得从文档头重新
  // Tab，等于键盘路径只兑现了一半。触发器 ref 由应用层持有（不去改 vendored 文件）：
  // 焦点本来就该落在被操作的控件上，与 Esc 的行为一致。
  //
  // 为什么放在 `close` 而不是塞进 `select`：三条关闭路径（选中 / Esc / 点外面）都该回焦，
  // 写一处比写两处少一个漂移点。点触发器自己收起时回焦到它本身是 no-op（焦点本来就在）。
  const triggerRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])
  const select = useCallback(
    (next: string) => {
      close()
      onChange(next)
    },
    [close, onChange],
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
            ref={triggerRef}
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
            // 这里**刻意不挂 aria-required**：`role=button` 不在 ARIA 1.2 的
            // aria-required 白名单里（见文件头「已知缺口」第 1 条），挂了也不会被播报，
            // 只是把"必填"这件事伪装成已表达。必填由宿主表单的提交守卫兜（各落页点各自
            // 一条，别删）。
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
