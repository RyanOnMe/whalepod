import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import GlideSelect from '../src/vendor/react-bits-micro/GlideSelect.js'
import SpringCheck from '../src/vendor/react-bits-micro/SpringCheck.js'
import SquishSwitch from '../src/vendor/react-bits-micro/SquishSwitch.js'

const options = [
  { value: 'a', label: 'Alpha', disabled: false },
  { value: 'b', label: 'Blocked', disabled: true },
  { value: 'c', label: 'Charlie', disabled: false },
]

describe('工作区 Micro 控件契约', () => {
  it('选择菜单支持方向键、首字母、禁用跳过与 Enter，值仍由调用方确认', async () => {
    const user = userEvent.setup()
    const change = vi.fn()
    render(
      <GlideSelect
        id="agent"
        label="Agent"
        display="Alpha"
        value="a"
        options={options}
        onChange={change}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Agent' })
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Charlie' })).toHaveFocus()
    await user.keyboard('{Home}c{Enter}')
    expect(change.mock.calls).toEqual([['c']])
    expect(trigger).toHaveTextContent('Alpha')
    expect(trigger).toHaveFocus()
    await user.keyboard('{Enter}{End}{Enter}')
    expect(change.mock.calls).toEqual([['c'], ['c']])
  })

  it('选择菜单在全部禁用时仍能 Escape；外点或宿主禁用都会收起', async () => {
    const user = userEvent.setup()
    const change = vi.fn()
    const props = {
      id: 'agent',
      label: 'Agent',
      display: 'Alpha',
      value: 'a',
      options,
      onChange: change,
    }
    const { rerender } = render(
      <GlideSelect {...props} options={options.map((option) => ({ ...option, disabled: true }))} />,
    )
    const trigger = screen.getByRole('button', { name: 'Agent' })
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
    rerender(<GlideSelect {...props} />)
    await user.click(trigger)
    await user.click(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    await user.click(trigger)
    rerender(<GlideSelect {...props} disabled />)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(change).not.toHaveBeenCalled()
  })

  it('材料勾选保留原生键盘和 fieldset 禁用，受控值不会自行变为已确认', async () => {
    const user = userEvent.setup()
    const change = vi.fn()
    const { rerender } = render(<SpringCheck checked={false} label="复核材料" onChange={change} />)
    const checkbox = screen.getByRole('checkbox', { name: '复核材料' })
    checkbox.focus()
    await user.keyboard(' ')
    expect(change).toHaveBeenCalledWith(true)
    expect(checkbox).not.toBeChecked()
    rerender(
      <fieldset disabled>
        <SpringCheck checked label="复核材料" onChange={change} />
      </fieldset>,
    )
    const locked = screen.getByRole('checkbox', { name: '复核材料' })
    expect(locked).toBeChecked()
    expect(locked).toBeDisabled()
    await user.click(screen.getByText('复核材料'))
    expect(change).toHaveBeenCalledTimes(1)
  })

  it('开关 pending 原生禁用且不乐观切换，失败后可再次请求', async () => {
    const user = userEvent.setup()
    const change = vi.fn()
    const props = { checked: false, label: '约定流程', onChange: change }
    const { rerender } = render(<SquishSwitch {...props} />)
    const toggle = screen.getByRole('switch', { name: '约定流程' })
    await user.click(toggle)
    expect(change).toHaveBeenCalledWith(true)
    expect(toggle).not.toBeChecked()
    rerender(<SquishSwitch {...props} busy />)
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-busy', 'true')
    await user.click(toggle)
    expect(change).toHaveBeenCalledTimes(1)
    rerender(<SquishSwitch {...props} />)
    toggle.focus()
    await user.keyboard(' ')
    expect(change).toHaveBeenCalledTimes(2)
    expect(toggle).not.toBeChecked()
    rerender(<SquishSwitch {...props} checked />)
    expect(toggle).toBeChecked()
  })
})
