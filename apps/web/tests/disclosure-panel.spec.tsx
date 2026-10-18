import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DisclosurePanel } from '../src/shared/DisclosurePanel.js'
import GlideSelect from '../src/vendor/react-bits-micro/GlideSelect.js'

describe('设置浮层的原生与 portal 交互', () => {
  it('关闭保留字段，Tab 进入设置，Escape 还焦，外点不抢焦点', async () => {
    const user = userEvent.setup()
    render(
      <>
        <DisclosurePanel portal label="设置" contentLabel="参数" icon={<span>⚙</span>}>
          <input aria-label="工作目录名" />
        </DisclosurePanel>
        <button type="button">外部</button>
      </>,
    )
    const trigger = screen.getByLabelText('设置')
    const field = screen.getByLabelText('工作目录名')
    expect(field).not.toBeVisible()
    await user.click(trigger)
    await user.tab()
    expect(field).toHaveFocus()
    await user.type(field, 'project')
    await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
    expect(field).not.toBeVisible()
    await user.click(trigger)
    expect(screen.getByLabelText('工作目录名')).toBe(field)
    expect(field).toHaveValue('project')
    await user.click(screen.getByRole('button', { name: '外部' }))
    expect(field).not.toBeVisible()
    expect(screen.getByRole('button', { name: '外部' })).toHaveFocus()
  })

  it('嵌套 portal 菜单选择不关闭设置，内外 Escape 分层处理，busy 禁用字段', async () => {
    const user = userEvent.setup()
    const change = vi.fn()
    const child = (
      <GlideSelect
        id="mode"
        label="执行方式"
        value="new"
        display="新执行"
        options={[{ value: 'new', label: '新执行', disabled: false }]}
        onChange={change}
      />
    )
    const view = render(
      <DisclosurePanel portal label="设置" contentLabel="参数" icon={<span>⚙</span>}>
        {child}
      </DisclosurePanel>,
    )
    await user.click(screen.getByLabelText('设置'))
    await user.click(screen.getByRole('button', { name: '执行方式' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('region', { name: '参数' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '执行方式' }))
    await user.click(screen.getByRole('menuitem', { name: '新执行' }))
    expect(change).toHaveBeenCalledOnce()
    expect(screen.getByRole('region', { name: '参数' })).toBeVisible()
    view.rerender(
      <DisclosurePanel portal label="设置" contentLabel="参数" icon={<span>⚙</span>} disabled>
        {child}
      </DisclosurePanel>,
    )
    expect(screen.getByRole('button', { name: '执行方式' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(screen.getByLabelText('设置')).toHaveFocus()
  })
})
