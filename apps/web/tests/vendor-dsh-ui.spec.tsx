/**
 * #138 L1+L2：vendored DSH 原语（apps/web/src/vendor/dsh-ui）的行为契约与真实接线。
 *
 * 四块：
 * A. 十个原语各自的语义契约——role / aria / data-* 钩子 + 受控回调，逐个最小用例
 *    （首批 6 个 + #138 L2 第二批 4 个：Input / Menu / ConnectionIndicator / Modal）。
 *    断言的是读屏与键盘能看到的表面，**不锚 hash 类名**（vitest 默认不处理 CSS，
 *    类名在测试里没有意义，锚它只会得到一条假绿）。
 * B. 真实界面接线：/devices 的设备状态改用 vendored StateDot + Tag 渲染，文案仍是
 *    「在线/离线/已撤销」（#142 的用例按文本断言，这里同时钉住 data-state/data-tone）。
 * C. vendored 子树的静态纪律：零 @deepseek-ai/*、零第三方 import（react / react-dom 除外）、
 *    每个文件带出处注释、引用的 --dsw-* 变量在 L1 白名单里有定义（四个 --dsh-* 例外
 *    列明且必须带 fallback）、manifest.json 覆盖口径。
 * D. 设备状态配色的 WCAG 2.1 AA 门（审查回归）：三个状态的文字/色块对比度实测复算。
 *
 * 没验的（如实说明）：①间距/深色一套的视觉（vitest 不处理 CSS，要真实浏览器才谈得上；
 * 颜色本身在 D 里按 CSS 文本算过，e2e 另按浏览器实测值再算一遍）；②与上游的逐像素一致性；
 * ③L3 运行视图（不在本切片）；④第二批新增原语**在本仓页面上的真实接线**——本切片是
 * pure additive vendoring，一个页面都没改（页面迁移由主协调者另行安排），所以第二批
 * 四个原语只有原语级用例，没有像 B 那样的真实界面用例。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { renderApp, renderUi } from './render.js'
import { ALICE, devicesHandler, loggedInHandlers, makeDevice } from './fixtures.js'
import {
  WHITE,
  contrastOnTint,
  contrastRatio,
  parseCssColor,
  readTokenValue,
  readToneTintPercent,
  round2,
} from './contrast.js'
import {
  Button,
  ConnectionIndicator,
  DisclosureRow,
  Input,
  Menu,
  Modal,
  Pill,
  StateDot,
  Switch,
  Tag,
  cx,
} from '../src/vendor/dsh-ui/index.js'

// 用 import.meta.dirname（纯路径字符串）而不是 import.meta.url + fileURLToPath：
// 在 vitest 的 jsdom 环境里，collect 阶段 new URL(...) 拿到的是 jsdom 的 URL 实例，
// fileURLToPath 不认（"must be of scheme file"）；dirname 不受环境影响。
const repoRoot = join(import.meta.dirname, '../../..')
const vendorDir = join(repoRoot, 'apps/web/src/vendor/dsh-ui')
const sourceFiles = readdirSync(vendorDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
const cssFiles = readdirSync(vendorDir).filter((f) => f.endsWith('.module.css'))

describe('Button（L2 原语）', () => {
  it('默认 type=button、文案上屏、点击触发 onClick、外部类名透传', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const view = renderUi(
      <Button className="probe-class" onClick={onClick}>
        保存
      </Button>,
    )
    const button = screen.getByRole('button', { name: '保存' })
    // type=button：放在表单里也不会误触提交（上游为默认值，这里钉住它）。
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveClass('probe-class')
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(view.container.querySelectorAll('button')).toHaveLength(1)
  })

  it('disabled 时不触发 onClick；icon 作为前置节点渲染', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    renderUi(
      <Button disabled onClick={onClick} icon={<svg data-testid="glyph" />}>
        删除
      </Button>,
    )
    const button = screen.getByRole('button', { name: '删除' })
    expect(button).toBeDisabled()
    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.getByTestId('glyph')).toBeInTheDocument()
  })
})

describe('Pill（L2 原语）', () => {
  it('无 onClick 时是静态 span（不可点），不冒充按钮', () => {
    renderUi(<Pill>已完成</Pill>)
    expect(screen.getByText('已完成')).toBeVisible()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('给了 onClick 才成为按钮，active 只影响外观不改可访问名', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    renderUi(
      <Pill active onClick={onClick}>
        全部
      </Pill>,
    )
    const button = screen.getByRole('button', { name: '全部' })
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('Tag（L2 原语）', () => {
  it('文案原样上屏，tone 经 data-tone 暴露（默认 outline），并带稳定锚 data-vendored="tag"', () => {
    const view = renderUi(
      <>
        <Tag>默认</Tag>
        <Tag tone="danger">已撤销</Tag>
      </>,
    )
    expect(screen.getByText('默认')).toHaveAttribute('data-tone', 'outline')
    expect(screen.getByText('已撤销')).toHaveAttribute('data-tone', 'danger')
    // 稳定锚：类名被 CSS Modules hash 掉，Q5 判「样式真的生效」时按它定位。
    expect(screen.getByText('默认')).toHaveAttribute('data-vendored', 'tag')
    // 只读徽标：不是按钮、没有 onClick 入口。
    expect(view.container.querySelectorAll('button')).toHaveLength(0)
  })

  it('调用方可覆写 data-testid（既有 web 单测 / Q5 定位用）', () => {
    renderUi(<Tag data-testid="status-tag">在线</Tag>)
    expect(screen.getByTestId('status-tag')).toHaveTextContent('在线')
    expect(screen.getByTestId('status-tag')).toHaveAttribute('data-vendored', 'tag')
  })
})

describe('StateDot（L2 原语）', () => {
  it('实心状态（done/warning/error/idle）走 span + data-state，对读屏隐藏', () => {
    renderUi(
      <>
        <StateDot state="done" />
        <StateDot state="warning" />
        <StateDot state="error" />
        <StateDot state="idle" />
      </>,
    )
    for (const state of ['done', 'warning', 'error', 'idle']) {
      const dot = document.querySelector(`span[data-state="${state}"]`)
      expect(dot).not.toBeNull()
      // aria-hidden：状态语义必须由旁边的文字承担，点本身不参与可访问树。
      expect(dot).toHaveAttribute('aria-hidden', 'true')
      expect(dot).toHaveAttribute('data-vendored', 'state-dot')
      expect(dot).toHaveStyle({ width: '10px', height: '10px' })
    }
  })

  it('两个分支都支持调用方覆写 data-testid（Q5 定位用）', () => {
    const { unmount } = renderUi(<StateDot state="done" data-testid="dot" />)
    expect(screen.getByTestId('dot')).toHaveAttribute('data-vendored', 'state-dot')
    unmount()

    renderUi(<StateDot state="ongoing" data-testid="dot-ongoing" />)
    const svg = screen.getByTestId('dot-ongoing')
    expect(svg.tagName).toBe('svg')
    expect(svg).toHaveAttribute('data-vendored', 'state-dot')
  })

  it('ongoing 是不同实现分支：svg 像素矩阵 + 8 格错相动画延迟', () => {
    renderUi(<StateDot state="ongoing" size={12} />)
    const matrix = document.querySelector('svg[data-state="ongoing"]')
    expect(matrix).not.toBeNull()
    expect(matrix).toHaveAttribute('viewBox', '0 0 10 10')
    expect(matrix).toHaveAttribute('width', '12')
    const cells = matrix?.querySelectorAll('rect') ?? []
    expect(cells).toHaveLength(8)
    // 相位差是「追击」效果的全部实现：每格 -125ms 递减，首格 -1000ms。
    expect(cells[0]?.getAttribute('style')).toContain('animation-delay: -1000ms')
    expect(cells[7]?.getAttribute('style')).toContain('animation-delay: -125ms')
  })
})

describe('Switch（L2 原语）', () => {
  it('是受控开关：role=switch + label 即可访问名，点击把「下一个状态」交给调用方', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderUi(<Switch checked={false} onChange={onChange} label="启用插件" />)
    const control = screen.getByRole('switch', { name: '启用插件' })
    expect(control).toHaveAttribute('aria-checked', 'false')
    await user.click(control)
    expect(onChange).toHaveBeenCalledWith(true)
    // 受控：onChange 不改自己的 checked，重渲染前 aria-checked 不动。
    expect(control).toHaveAttribute('aria-checked', 'false')
  })

  it('checked=true 时点击请求 false；disabled 时点击被拒', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const { unmount } = renderUi(
      <Switch checked onChange={onToggle} label="启用插件" title="写入中" />,
    )
    await user.click(screen.getByRole('switch', { name: '启用插件' }))
    expect(onToggle).toHaveBeenCalledWith(false)
    expect(screen.getByRole('switch')).toHaveAttribute('title', '写入中')
    unmount()

    const onDisabled = vi.fn()
    renderUi(<Switch checked={false} onChange={onDisabled} label="启用插件" disabled />)
    await user.click(screen.getByRole('switch', { name: '启用插件' }))
    expect(onDisabled).not.toHaveBeenCalled()
  })
})

describe('DisclosureRow（L2 原语）', () => {
  const icon = <svg data-testid="row-icon" />

  it('折叠态：只有 leading 是展开按钮（aria-expanded=false），children 不渲染', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const view = renderUi(
      <DisclosureRow icon={icon} title="工具调用" open={false} expandable onToggle={onToggle}>
        <p>参数正文</p>
      </DisclosureRow>,
    )
    expect(screen.getByText('工具调用')).toBeVisible()
    expect(screen.queryByText('参数正文')).toBeNull()
    const toggle = screen.getByRole('button', { expanded: false })
    await user.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
    // 行本身在 expandOnRowClick 未开时不是按钮（避免一次点击两个展开目标）。
    expect(view.container.querySelector('[data-disclosure-row]')).not.toHaveAttribute('role')
  })

  it('展开态：children 上屏、data-open 标记、折叠提示内容消失', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    renderUi(
      <DisclosureRow
        icon={icon}
        title="工具调用"
        open
        expandable
        onToggle={onToggle}
        collapsedContent={<span>3 个文件</span>}
      >
        <p>参数正文</p>
      </DisclosureRow>,
    )
    expect(screen.getByText('参数正文')).toBeVisible()
    expect(screen.queryByText('3 个文件')).toBeNull()
    expect(document.querySelector('[data-open="true"]')).not.toBeNull()
    // 展开态 leading 仍是按钮（chevron 可点回收起），aria-expanded 跟着翻到 true。
    const toggle = screen.getByRole('button', { expanded: true })
    await user.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('keepContentWhenOpen：展开时折叠提示内容留在行内', () => {
    renderUi(
      <DisclosureRow
        icon={icon}
        title="工具调用"
        open
        expandable
        keepContentWhenOpen
        onToggle={() => {}}
        collapsedContent={<span>3 个文件</span>}
      >
        <p>参数正文</p>
      </DisclosureRow>,
    )
    expect(screen.getByText('3 个文件')).toBeVisible()
  })

  it('expandOnRowClick：整行成为展开目标，Enter/Space 也能开合', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    renderUi(
      <DisclosureRow
        icon={icon}
        title="工具调用"
        open={false}
        expandable
        expandOnRowClick
        onToggle={onToggle}
      >
        <p>参数正文</p>
      </DisclosureRow>,
    )
    const row = screen.getByRole('button', { name: '工具调用', expanded: false })
    expect(row).toHaveAttribute('data-expandable', 'true')
    await user.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })
    fireEvent.keyDown(row, { key: 'a' }) // 无关按键不得开合
    expect(onToggle).toHaveBeenCalledTimes(3)
  })

  it('expandable=false：没有任何展开入口，标题照常显示', () => {
    renderUi(
      <DisclosureRow icon={icon} title="只读行" open={false} expandable={false} onToggle={() => {}}>
        <p>参数正文</p>
      </DisclosureRow>,
    )
    expect(screen.getByText('只读行')).toBeVisible()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('Input（L2 原语，#138 第二批）', () => {
  it('包装成 wrapper span + 原生 input：属性透传、可访问名走 label、根带稳定锚', () => {
    renderUi(<Input aria-label="搜索设备" placeholder="搜索" data-testid="search" />)
    // 锚在 wrapper 上（本仓新增），原生 input 的属性一个未改，所以按 role 取输入框。
    const wrap = screen.getByTestId('search')
    expect(wrap.tagName.toLowerCase()).toBe('span')
    expect(wrap).toHaveAttribute('data-vendored', 'input')
    const field = within(wrap).getByRole('textbox', { name: '搜索设备' })
    expect(field).toHaveAttribute('placeholder', '搜索')
    expect(field.tagName.toLowerCase()).toBe('input')
  })

  it('受控输入：onChange 收到键入值；disabled / type 等原生属性照样透传', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderUi(<Input aria-label="搜索设备" value="" onChange={onChange} />)
    const field = screen.getByRole('textbox', { name: '搜索设备' })
    await user.type(field, 'm4')
    // 受控（value 恒为 ''）：onChange 逐字符上报，输入框内容不自己变。
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(field).toHaveValue('')
  })

  it('icon 只在给了的时候渲染前置节点；不给时 wrapper 里只有 input', () => {
    const { unmount } = renderUi(<Input aria-label="搜索" icon={<svg data-testid="leading" />} />)
    expect(screen.getByTestId('leading')).toBeInTheDocument()
    unmount()

    renderUi(<Input aria-label="搜索" data-testid="bare" />)
    const wrap = screen.getByTestId('bare')
    expect(wrap.querySelectorAll('svg')).toHaveLength(0)
    expect(wrap.querySelectorAll('input')).toHaveLength(1)
  })
})

describe('Menu（L2 原语，#138 第二批）', () => {
  const ITEMS = [
    { id: 'rename', label: '重命名' },
    { type: 'separator' as const, id: 'sep' },
    { type: 'label' as const, id: 'grp', text: '危险操作' },
    { id: 'remove', label: '移除设备', danger: true },
    { id: 'locked', label: '转移所有权', disabled: true },
  ]

  it('open=false 时只有锚点、没有 menu 角色（受控：Menu 自己不写 open）', () => {
    renderUi(
      <Menu
        open={false}
        anchor={<button type="button">设备操作</button>}
        items={ITEMS}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: '设备操作' })).toBeVisible()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.querySelector('[data-vendored="menu"]')).not.toBeNull()
  })

  it('展开后逐项渲染：普通项/分隔线/标题行各按角色上屏，点击普通项回调 id', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    renderUi(
      <Menu
        open
        anchor={<button type="button">设备操作</button>}
        items={ITEMS}
        onSelect={onSelect}
        onClose={() => {}}
      />,
    )
    const menu = screen.getByRole('menu')
    // 5 个 entry → 3 个 menuitem：分隔线是 role=separator、标题行是 role=presentation，
    // 都不占 menuitem（disabled 的「转移所有权」**仍算** menuitem——它是 disabled 而不是
    // 不渲染，这里钉住"那一行确实在 DOM 里且带 disabled"，免得把渲染丢了当成语义正确）。
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(3)
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(3)
    expect(within(menu).getByRole('separator')).toBeInTheDocument()
    expect(within(menu).getByText('危险操作')).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: '转移所有权' })).toBeDisabled()
    await user.click(within(menu).getByRole('menuitem', { name: '重命名' }))
    expect(onSelect).toHaveBeenCalledWith('rename')
  })

  it('disabled 项点不动（不上报 onSelect）', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    renderUi(
      <Menu
        open
        anchor={<button type="button">设备操作</button>}
        items={ITEMS}
        onSelect={onSelect}
        onClose={() => {}}
      />,
    )
    const locked = screen.getByRole('menuitem', { name: '转移所有权' })
    expect(locked).toBeDisabled()
    await user.click(locked)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('selectedId / selectedIds 决定哪一行被标记为选中（trailing check）', () => {
    const { unmount } = renderUi(
      <Menu
        open
        anchor={<button type="button">设备操作</button>}
        items={ITEMS}
        selectedId="rename"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    // check 是 SVG 图标：选中行有、未选中行没有（这是「选中态真的画出来了」的机器证据）。
    const selectedRow = screen.getByRole('menuitem', { name: '重命名' })
    expect(selectedRow.querySelectorAll('svg')).toHaveLength(1)
    expect(screen.getByRole('menuitem', { name: '移除设备' }).querySelectorAll('svg')).toHaveLength(
      0,
    )
    unmount()

    renderUi(
      <Menu
        open
        anchor={<button type="button">设备操作</button>}
        items={ITEMS}
        selectedIds={['remove']}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('menuitem', { name: '移除设备' }).querySelectorAll('svg')).toHaveLength(
      1,
    )
  })

  it('Escape 走 onClose；document 上的外部 pointerdown 也走 onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderUi(
      <Menu
        open
        anchor={<button type="button">设备操作</button>}
        items={ITEMS}
        onSelect={() => {}}
        onClose={onClose}
      />,
    )
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)

    // 菜单内部点击不得触发关闭（列表根上有 stopPropagation 就是为了这类冒泡）。
    await user.click(screen.getByRole('menuitem', { name: '重命名' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    // 外部点击关闭。
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('closeOnPointerLeave=false（默认）时指针离开不关；开了才按 grace 关', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { unmount } = renderUi(
      <Menu
        open
        anchor={<button type="button">设备操作</button>}
        items={ITEMS}
        onSelect={() => {}}
        onClose={onClose}
      />,
    )
    fireEvent.pointerLeave(document.querySelector('[data-vendored="menu"]') as Element)
    // 默认不关：菜单不会因为指针经过就消失。
    expect(onClose).not.toHaveBeenCalled()
    unmount()

    vi.useFakeTimers()
    try {
      const onCloseTimed = vi.fn()
      renderUi(
        <Menu
          open
          closeOnPointerLeave
          anchor={<button type="button">设备操作</button>}
          items={ITEMS}
          onSelect={() => {}}
          onClose={onCloseTimed}
        />,
      )
      fireEvent.pointerLeave(document.querySelector('[data-vendored="menu"]') as Element)
      expect(onCloseTimed).not.toHaveBeenCalled() // grace 未到，先不关
      vi.advanceTimersByTime(200) // POINTER_GRACE_MS
      expect(onCloseTimed).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
    void user
  })

  it('portal=false 时列表留在锚点 wrapper 内；portal=true 时挂到 document.body（React 树仍在 Menu 下）', () => {
    const { container, unmount } = renderUi(
      <Menu
        open
        anchor={<button type="button">设备操作</button>}
        items={ITEMS}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    // 非 portal：列表就在组件自己的 DOM 子树里，within(container) 找得到。
    expect(within(container as HTMLElement).getByRole('menu')).toBeInTheDocument()
    unmount()

    const second = renderUi(
      <Menu
        open
        portal
        getAnchorRect={() => new DOMRect(10, 10, 100, 32)}
        anchor={<button type="button">设备操作</button>}
        items={ITEMS}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    const menu = screen.getByRole('menu')
    // portal：DOM 上挂到 body 直下，调用方的容器里找不到——这正是页面迁移要注意的点。
    expect(second.container.contains(menu)).toBe(false)
    expect(menu.closest('body')).toBe(document.body)
  })
})

describe('ConnectionIndicator（L2 原语，#138 第二批）', () => {
  const LABELS = {
    disconnectedLabel: '连接已断开',
    reconnectLabel: '重新连接',
    connectingLabel: '正在重连',
    recoveredLabel: '连接已恢复',
    reconnectActionLabel: '重新连接设备',
    restartActionLabel: '重新开始重连',
    onReconnect: () => {},
  }

  it('state=undefined 时不渲染任何东西（没有连接反馈就不占位）', () => {
    const view = renderUi(<ConnectionIndicator state={undefined} {...LABELS} />)
    expect(view.container).toBeEmptyDOMElement()
  })

  it('disconnected 是按钮：可访问名走 reconnectActionLabel，点击上抛 onReconnect，data-phase 暴露状态', async () => {
    const user = userEvent.setup()
    const onReconnect = vi.fn()
    renderUi(<ConnectionIndicator state="disconnected" {...LABELS} onReconnect={onReconnect} />)
    const control = screen.getByRole('button', { name: '重新连接设备' })
    expect(control).toHaveAttribute('data-phase', 'disconnected')
    expect(control).toHaveAttribute('data-vendored', 'connection-indicator')
    // 可见文案是断线话术（hover 时才换成「重新连接」）。
    expect(control).toHaveTextContent('连接已断开')
    await user.click(control)
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('connecting 换话术与可访问名（restartActionLabel），并渲染三点动画', () => {
    renderUi(<ConnectionIndicator state="connecting" {...LABELS} />)
    const control = screen.getByRole('button', { name: '重新开始重连' })
    expect(control).toHaveAttribute('data-phase', 'connecting')
    expect(control).toHaveTextContent('正在重连')
    // 三点：一个静态 + 两个错相动画点（第二/三个点各带自己的类）。
    const dots = control.querySelectorAll('span > span')
    expect(dots.length).toBeGreaterThanOrEqual(4) // sizeLabel 里的 '...' 与动画点都在
  })

  it('recovered 不是按钮而是 role=status 的只读提示（aria-label 即恢复话术）', () => {
    const view = renderUi(<ConnectionIndicator state="recovered" {...LABELS} data-testid="conn" />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-label', '连接已恢复')
    expect(status).toHaveAttribute('data-vendored', 'connection-indicator')
    expect(status).toHaveAttribute('data-testid', 'conn')
    expect(status).toHaveTextContent('连接已恢复')
    // 恢复态不该留下重连入口。
    expect(view.container.querySelectorAll('button')).toHaveLength(0)
  })
})

describe('Modal（L2 原语，#138 第二批）', () => {
  it('open=false 时渲染 null', () => {
    const view = renderUi(
      <Modal open={false} onClose={() => {}} title="移除设备" closeLabel="关闭">
        <p>正文</p>
      </Modal>,
    )
    expect(view.container).toBeEmptyDOMElement()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('open=true：portal 到 body、role=dialog + aria-modal + aria-label、标题/描述/正文/页脚都上屏', () => {
    const view = renderUi(
      <Modal
        open
        onClose={() => {}}
        title="移除设备"
        description="该设备将无法再连接。"
        closeLabel="关闭"
        data-testid="confirm"
        footer={<button type="button">确认移除</button>}
      >
        <p>正文段落</p>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: '移除设备' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('data-testid', 'confirm')
    // portal：不在调用方容器里（页面迁移时 within(container) 找不到它）。
    expect(view.container.contains(dialog)).toBe(false)
    expect(screen.getByText('该设备将无法再连接。')).toBeVisible()
    expect(screen.getByText('正文段落')).toBeVisible()
    expect(screen.getByRole('button', { name: '确认移除' })).toBeVisible()
    expect(screen.getByRole('button', { name: '关闭' })).toBeVisible()
  })

  it('ESC 触发 onClose；关闭按钮点击也触发 onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderUi(
      <Modal open onClose={onClose} title="移除设备" closeLabel="关闭">
        <p>正文</p>
      </Modal>,
    )
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('点 mask 关闭；点卡片内部不关闭（mask 是独立兄弟节点，不是 dialog 本体）', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderUi(
      <Modal open onClose={onClose} title="移除设备" closeLabel="关闭" data-testid="card">
        <p>正文段落</p>
      </Modal>,
    )
    await user.click(screen.getByText('正文段落'))
    expect(onClose).not.toHaveBeenCalled()
    // mask 是 dialog 的前一个兄弟节点，且 aria-hidden（读屏不参与，只能按结构取）。
    const dialog = screen.getByTestId('card')
    const mask = dialog.previousElementSibling
    expect(mask).not.toBeNull()
    expect(mask).toHaveAttribute('aria-hidden', 'true')
    await user.click(mask as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('open=false 时不留 ESC 监听：关闭后按 ESC 不再回调', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { rerender } = renderUi(
      <Modal open onClose={onClose} title="移除设备" closeLabel="关闭">
        <p>正文</p>
      </Modal>,
    )
    rerender(
      <Modal open={false} onClose={onClose} title="移除设备" closeLabel="关闭">
        <p>正文</p>
      </Modal>,
    )
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('headless：只渲染 children，不带默认头/关闭按钮，但 mask 与 aria-label 仍在', () => {
    renderUi(
      <Modal open headless onClose={() => {}} title="移除设备">
        <p>自绘内容</p>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: '移除设备' })
    expect(within(dialog).getByText('自绘内容')).toBeVisible()
    // headless 模式不提供 closeLabel（上游类型上互斥），故没有关闭按钮。
    expect(within(dialog).queryByRole('button')).toBeNull()
    expect(within(dialog).queryByRole('heading')).toBeNull()
  })
})

describe('cx（本仓新增，非上游代码）', () => {
  it('跳过 falsy、保留顺序；对象入参按真值拼键名（第二批为 ConnectionIndicator 扩展）', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b')
    expect(cx({ a: true, b: false, c: null, d: undefined })).toBe('a')
    expect(cx('base', { mod: true }, { off: false })).toBe('base mod')
  })
})

describe('设备页状态改用 vendored StateDot + Tag（#138 交付物 3）', () => {
  it('三种状态：文案不变（在线/离线/已撤销），色块 state 与色调 tone 成对', async () => {
    renderApp(
      '/devices',
      loggedInHandlers(ALICE, [
        devicesHandler([
          makeDevice({ name: 'm4-mini', status: 'online' }),
          makeDevice({ name: 'thinkpad-x1', status: 'offline' }),
          makeDevice({ name: 'old-air', status: 'revoked' }),
        ]),
      ]),
    )

    const expected: readonly (readonly [string, string, string, string, string])[] = [
      ['m4-mini', '在线', 'done', 'success', 'device-status-online'],
      ['thinkpad-x1', '离线', 'warning', 'warning', 'device-status-offline'],
      ['old-air', '已撤销', 'error', 'danger', 'device-status-revoked'],
    ]
    for (const [name, label, dotState, tone, statusClass] of expected) {
      const heading = await screen.findByRole('heading', { name })
      const row = heading.closest('li')
      expect(row).not.toBeNull()
      if (row === null) continue
      // 稳定锚点：外层 data-testid，内层两个 data-vendored（Q5 判计算样式时按它们定位）。
      const status = within(row).getByTestId('device-status')
      expect(status.querySelector('[data-vendored="state-dot"]')).not.toBeNull()
      // 每个状态带自己的修饰类：AA 重映射就挂在这个类上（见 global.css），
      // 挂错元素会让重映射失效而看起来「一切正常」。
      expect(status).toHaveClass(statusClass)
      // 文案：#142 的 Q5 用例按文本断言，这里钉住「换渲染层没换文案」。
      const text = within(status).getByText(label)
      expect(text).toHaveAttribute('data-tone', tone) // Tag
      expect(text).toHaveAttribute('data-vendored', 'tag')
      const dot = status.querySelector(`[data-state="${dotState}"]`) // StateDot
      expect(dot).not.toBeNull()
      expect(dot).toHaveAttribute('aria-hidden', 'true')
    }
  })
})

/**
 * vendored 子树的静态纪律。这些不变量一旦破掉，坏法都很安静（token 未定义就渲染成
 * 透明、偷偷 import 上游包就绕过边界门），所以用测试守，而不是靠 review 记得。
 */
describe('vendored 子树纪律（#138）', () => {
  it('至少 vendored 了约定的 10 个组件（首批 6 + 第二批 4）与 L1 token 白名单', () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(11)
    expect(cssFiles.sort()).toEqual([
      'Button.module.css',
      'ConnectionIndicator.module.css',
      'DisclosureRow.module.css',
      'Input.module.css',
      'Menu.module.css',
      'Modal.module.css',
      'Pill.module.css',
      'StateDot.module.css',
      'Switch.module.css',
      'Tag.module.css',
    ])
    // 第二批的四个原语每个都必须同时有 .tsx 与 .module.css（只有一半不算取全）。
    for (const name of ['Input', 'Menu', 'ConnectionIndicator', 'Modal']) {
      expect(sourceFiles, `${name}.tsx 缺失`).toContain(`${name}.tsx`)
      expect(cssFiles, `${name}.module.css 缺失`).toContain(`${name}.module.css`)
    }
  })

  it('零 @deepseek-ai/*、零 @whalepod/*、零第三方 import（只准 react / react-dom 与相对路径）', () => {
    for (const file of sourceFiles) {
      const text = readFileSync(join(vendorDir, file), 'utf8')
      // 出处注释里写的是裸路径 deepseek-ai/deepseek-harness（无 @ 前缀），不会误伤；
      // clsx 只禁依赖语法（注释里说明「本仓不用 clsx」是允许的）。
      expect(text, `${file} 不得出现 DSH 包说明符`).not.toContain('@deepseek-ai/')
      expect(text, `${file} 不得出现本仓包说明符`).not.toContain('@whalepod/')
      expect(text, `${file} 不得依赖 clsx`).not.toMatch(/from\s+'clsx'/)
      expect(text, `${file} 不得使用 require`).not.toMatch(/require\s*\(/)
      const specifiers = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((m) => m[1] ?? '')
      for (const specifier of specifiers) {
        if (specifier.startsWith('.')) {
          // 不许越出子树（越出即与 app 内部结构耦合，vendored 副本就不能整体替换了）。
          expect(specifier.startsWith('../'), `${file} 不得引用子树外的 ${specifier}`).toBe(false)
          continue
        }
        // react-dom 是第二批放行的：Modal 与 Menu 用 createPortal 把浮层挂到 document.body,
        // 这是上游行为，本仓未改（见 vendor/dsh-ui/README.md 的依赖纪律）。
        expect(
          ['react', 'react-dom'].includes(specifier),
          `${file} 只允许 import react / react-dom，实见 ${specifier}`,
        ).toBe(true)
      }
    }
  })

  it('每个 vendored 文件顶部都带出处注释（上游路径 + commit SHA）；本仓新增文件另行标注', () => {
    // .ts/.tsx 与 .module.css 都要：CSS 是照抄来的，出处一样要能一眼看出来。
    for (const file of [...sourceFiles, ...cssFiles]) {
      const text = readFileSync(join(vendorDir, file), 'utf8')
      const head = text.split('\n').slice(0, 6).join('\n')
      if (file === 'cx.ts') {
        // 本仓新增代码，不能冒充上游 vendored 文件（Apache-2.0 vs 上游 MIT）。
        expect(head, 'cx.ts 必须写明是本仓新增').toContain('本仓新增代码')
        expect(head, 'cx.ts 必须写明许可').toContain('Apache-2.0')
        expect(text, 'cx.ts 不得自称 vendored').not.toContain('vendored from')
        continue
      }
      expect(head, `${file} 缺少 vendored 出处注释`).toContain(
        'vendored from deepseek-ai/deepseek-harness',
      )
      expect(head, `${file} 缺少取用 commit`).toContain('c291e7961a515f6d7af9304e7fd1d257929aef26')
    }
  })

  it('manifest.json 覆盖口径：components[] = 全部源码与样式文件，meta[] = 元文件（并集 = 目录全部文件）', () => {
    const manifest = JSON.parse(readFileSync(join(vendorDir, 'manifest.json'), 'utf8')) as {
      upstream: { commit: string }
      components: { local: string; upstream: string | null }[]
      meta: { local: string; upstream: string | null }[]
    }
    expect(manifest.upstream.commit).toBe('c291e7961a515f6d7af9304e7fd1d257929aef26')

    const basenames = (entries: { local: string }[]): string[] =>
      entries.map((entry) => entry.local.split('/').pop() ?? '').sort()
    const onDisk = readdirSync(vendorDir).sort()
    const sourceAndStyle = onDisk.filter((f) => /\.(ts|tsx|css)$/.test(f))
    const metaFiles = onDisk.filter((f) => !/\.(ts|tsx|css)$/.test(f))

    expect(basenames(manifest.components), 'components[] 应逐个登记源码与样式文件').toEqual(
      sourceAndStyle,
    )
    expect(basenames(manifest.meta), 'meta[] 应登记元文件').toEqual(metaFiles)
    // 两份清单合起来正好是目录里的全部文件（不多不少，可逐个人工核对）。
    expect([...basenames(manifest.components), ...basenames(manifest.meta)].sort()).toEqual(onDisk)

    // 每个 local 都写在 manifest 同目录下（相对仓库根），且上游路径必填——
    // 唯一例外是本仓新增的 cx.ts（显式 null）。
    for (const entry of [...manifest.components, ...manifest.meta]) {
      expect(entry.local.startsWith('apps/web/src/vendor/dsh-ui/')).toBe(true)
    }
    expect(
      manifest.components.filter((e) => e.upstream === null).map((e) => e.local),
      'components[] 里只有 cx.ts 是本仓新增',
    ).toEqual(['apps/web/src/vendor/dsh-ui/cx.ts'])
  })

  it('vendored CSS 只吃 L1 白名单（--dsw-*）+ 两个列明的 --dsh-* 例外；白名单在源码里于 tokens.css 之后引入', () => {
    // 先去掉注释再扫：上游注释里就出现过变量名（如 DisclosureRow 的排版说明），
    // 不剥注释会把「注释里提到的变量」误当成「文件里定义的变量」。
    const vendorCss = readdirSync(vendorDir)
      .filter((f) => f.endsWith('.module.css'))
      .map((f) => readFileSync(join(vendorDir, f), 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    // 不得反向引用本仓业务 token（--color-*/--space-* 是原型视觉语言，不是 L1）。
    expect(vendorCss.match(/--color-[a-z-]+/g) ?? []).toEqual([])

    const referenced = new Set(
      [...vendorCss.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1] ?? ''),
    )
    expect(referenced.size).toBeGreaterThanOrEqual(20)
    const tokensCss = readFileSync(join(repoRoot, 'apps/web/src/styles/dsw-tokens.css'), 'utf8')
    for (const name of referenced) {
      expect(tokensCss, `L1 白名单缺定义：${name}`).toContain(`${name}:`)
    }

    // 已知例外（不是漏洞，是上游 body 发布的 content / scrollbar 轴，且每处都带 fallback）：
    // 精确清单 = DisclosureRow 的两个 content 轴变量（#138 首批）+ Menu 的两个 scrollbar
    // 轴变量（#138 L2 第二批）。清单一旦变化就得改注释与 README/manifest 的措辞，
    // 所以在这里钉死。
    //
    // 注意这两类例外的**性质不同**，别混为一谈（实测区分）：
    //   - content 轴两个是**被 var() 读取**的（DisclosureRow），所以"必须带 fallback"
    //     这条纪律对它们成立，下面的循环就是在验这件事；
    //   - scrollbar 轴两个是 Menu 在浮层面板上**赋值/重绑**的（`--dsh-scrollbar-thumb: …`），
    //     Menu 自己没有读取它们——上游的读取方是 scrollbar.css 的 body 与 ::-webkit-scrollbar
    //     规则，本仓没取那份样式。所以本仓现状是：这两条声明**被声明但无人消费**，
    //     既不生效也不报错；将来接全站滚动条皮肤时它们才会开始起作用。
    const consumedDshVars = new Set(
      [...vendorCss.matchAll(/var\((--dsh-[a-z0-9-]+)/g)].map((m) => m[1] ?? ''),
    )
    // 定义判定按**声明起始位置**锚定（前置必须是 { ; 或行首，后置必须是冒号）：
    // 裸查 `(--dsh-x)\s*:` 会把 `--dsh-scrollbar-thumb-hover:` 也当成
    // `--dsh-scrollbar-thumb` 的定义——正则回溯能用 "thum" + "-hover:" 满足模式，
    // 这是子串匹配的经典坑，本切片实测踩过，故按锚定写法。
    const locallyDefined = new Set(
      [...vendorCss.matchAll(/(?:^|[;{\s])(--dsh-[a-z0-9-]+)\s*:/gm)].map((m) => m[1] ?? ''),
    )
    // 外部依赖 = 被 var() 读取、但本子树没有定义的 --dsh-*（= 真的会走 fallback 的那些）。
    const external = [...consumedDshVars].filter((name) => !locallyDefined.has(name)).sort()
    expect(external, '--dsh-* 外部依赖清单变了，必须同步注释/README/manifest').toEqual([
      '--dsh-content-font-delta',
      '--dsh-content-font-size-secondary',
    ])
    for (const name of external) {
      // 例外必须真带 fallback：L1 不提供也要能正确降级。
      const uses = [...vendorCss.matchAll(new RegExp(`var\\(${name}\\s*,[^)]*\\)`, 'g'))]
      const total = [...vendorCss.matchAll(new RegExp(`var\\(${name}[,)]`, 'g'))]
      expect(uses.length, `${name} 每一处引用都必须带 fallback`).toBe(total.length)
    }
    // 子树内部自给的局部变量（定义+使用都在同一文件）不构成外部依赖，但也要在册，
    // 免得以后多出一个没人知道来源的变量。
    expect([...locallyDefined].sort()).toEqual([
      '--dsh-scrollbar-thumb',
      '--dsh-scrollbar-thumb-hover',
      '--dsh-state-ongoing',
    ])
    // 其中只有 --dsh-state-ongoing 是"自给自用"（同一文件里既定义又 var() 读取）；
    // 两个 scrollbar 变量是"声明了但本子树无人读取"（消费者是没被取用的 scrollbar.css），
    // 这一条把两者的区别钉住，免得将来有人把 scrollbar 那两条当成"已接通"。
    const selfContained = [...consumedDshVars].filter((name) => locallyDefined.has(name)).sort()
    expect(selfContained).toEqual(['--dsh-state-ongoing'])

    const globalCss = readFileSync(join(repoRoot, 'apps/web/src/styles/global.css'), 'utf8')
    const prototypeAt = globalCss.indexOf("@import './tokens.css'")
    const dswAt = globalCss.indexOf("@import './dsw-tokens.css'")
    expect(prototypeAt).toBeGreaterThanOrEqual(0)
    expect(dswAt).toBeGreaterThan(prototypeAt)
    // 源码 import 顺序不是产物序保证——注释里必须写明这点（实测产物序见 global.css）。
    expect(globalCss).toContain('这不是产物序')
  })
})

/**
 * #138 L2 第二批对 L1（apps/web/src/styles/dsw-tokens.css）的增量。
 *
 * 这里守的不是「有没有那个变量」，而是**取值仍与上游逐字一致**与**别名间接没被压平**——
 * 这两件事坏掉都不会报错：值改了一个数字只是颜色微变（没人看得出来），
 * 别名被压平成字面量则会让「改一个静态档、所有引用它的语义一起动」这条链断掉。
 */
describe('L1 token 第二批增量（#138）', () => {
  const tokensCss = readFileSync(join(repoRoot, 'apps/web/src/styles/dsw-tokens.css'), 'utf8')

  /** 从 dsw-tokens.css 里取某变量的声明值（同 readTokenValue，但明确只吃 L1 文件）。 */
  const decl = (name: string): string => readTokenValue(tokensCss, name)

  it('上游取值逐字照抄：四个高风险的 alias/静态档不能被"顺手改好看"', () => {
    // warn-label 与 warn-primary 是两个不同档位——上游如此，合并成一个就是 bug。
    // 注意两者在本文件里的**写法不同**：warn-label 是第二批新增、保留 alias 间接；
    // warn-primary 是首批就有的、按首批口径就地展开了字面量（两批写法不一致，见文件头）。
    expect(decl('--dsw-alias-state-warn-label')).toBe('var(--dsw-static-amber-600)')
    expect(decl('--dsw-alias-state-warn-primary')).toBe('rgb(245, 158, 11)')
    expect(decl('--dsw-static-amber-600')).toBe('rgb(221, 134, 41)')
    expect(decl('--dsw-static-amber-500')).toBe('rgb(245, 158, 11)')
    // 两个档位确实是不同颜色——这条是上面"别合并"的机器证据。
    expect(decl('--dsw-static-amber-600')).not.toBe(decl('--dsw-static-amber-500'))
    // label-dimmed 走偏蓝的 neutral-bluish 档，不是中性灰 neutral-*。
    expect(decl('--dsw-alias-label-dimmed')).toBe('var(--dsw-static-neutral-bluish-200)')
    expect(decl('--dsw-alias-bg-layer-1')).toBe('var(--dsw-static-neutral-bluish-00)')
    // 弹层遮罩透明度与模糊。
    expect(decl('--dsw-alias-bg-mask-1')).toBe('rgba(0, 0, 0, 0.24)')
    expect(decl('--dsw-mask-blur')).toBe('blur(2px)')
    // specific-menu 走 alias 间接（→ bg-layer-3），不是静态字面量。
    expect(decl('--dsw-specific-menu')).toBe('var(--dsw-alias-bg-layer-3)')
  })

  it('深色段按上游语义重写（且与浅色取值不同——同值就不该重写）', () => {
    // 定位**规则**而不是注释里的提及：`body[data-ds-dark-theme]` 在文件里出现 4 次
    // （文件头注释、两个段注释、规则本身），裸 indexOf 会命中注释，取到的块就成了 :root
    // ——本切片实测踩过。带大括号一起匹配，只会命中规则。
    const marker = /body\[data-ds-dark-theme\]\s*\{/g
    const hits = [...tokensCss.matchAll(marker)]
    expect(hits, '深色规则应恰好一条').toHaveLength(1)
    const open = (hits[0]?.index ?? 0) + (hits[0]?.[0].length ?? 0) - 1
    // 按括号配对取块本体（不能用 lastIndexOf('}')——文件后面还有别的规则块）。
    let depth = 0
    let close = open
    for (let i = open; i < tokensCss.length; i += 1) {
      if (tokensCss[i] === '{') depth += 1
      else if (tokensCss[i] === '}') {
        depth -= 1
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    // 先剥注释再断言：注释里提到变量名不代表声明了它（文件头与两个段注释都写了变量名）。
    const darkBody = tokensCss.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '')
    for (const [name, value] of [
      ['--dsw-alias-bg-layer-1', 'var(--dsw-static-neutral-bluish-875)'],
      ['--dsw-alias-bg-mask-1', 'rgba(0, 0, 0, 0.5)'],
      ['--dsw-alias-border-l1', 'rgba(255, 255, 255, 0.06)'],
      ['--dsw-alias-state-success-tertiary', 'var(--dsw-static-green-900)'],
      ['--dsw-alias-state-warn-tertiary', 'var(--dsw-static-amber-900)'],
      ['--dsw-specific-menu', 'var(--dsw-alias-bg-layer-3)'],
    ] as const) {
      expect(darkBody, `深色段缺 ${name} 的重写`).toContain(`${name}: ${value};`)
    }
    // 浅深同值的变量不应在深色段再写一遍（单一来源，避免两处漂移）。
    for (const same of [
      '--dsw-alias-state-warn-label',
      '--dsw-mask-blur',
      '--dsw-static-amber-600',
    ]) {
      expect(darkBody, `${same} 浅深同值，不该在深色段重写`).not.toContain(`${same}:`)
    }
  })

  it('elevation 段挂在 `body, body *` 而不是 :root——Menu 重绑描边色才能进到投影里', () => {
    // 这是从上游 gradient-shadow-text.css 抄来的语义：派生值必须逐元素声明，
    // 否则继承下来的是在祖先处就已代入完的值，后代重绑 --dsw-elevation-stroke-color 无效。
    const at = tokensCss.indexOf('body,\nbody * {')
    expect(at, 'elevation 段的选择器不是 `body, body *`').toBeGreaterThanOrEqual(0)
    const block = tokensCss.slice(at, tokensCss.indexOf('}', at))
    expect(block).toContain('--dsw-elevation-stroke-color: var(--dsw-alias-border-l4);')
    expect(block).toContain(
      '--dsw-elevation-stroke: 0 0 0 0.5px var(--dsw-elevation-stroke-color);',
    )
    // prominent = stroke + 两层柔光，取值逐字照抄。
    expect(block).toContain('--dsw-elevation-prominent:')
    expect(block).toContain('0 3px 8px 0 rgba(0, 0, 0, 0.04), 0 0 20px 0 rgba(0, 0, 0, 0.05)')
    // 反面：不能也挂在 :root（挂两处会让 `body *` 那层变成唯一生效的一层，语义就糊了）。
    const rootBlock = tokensCss.slice(
      tokensCss.indexOf(':root {'),
      tokensCss.indexOf('}', tokensCss.indexOf(':root {')),
    )
    expect(rootBlock).not.toContain('--dsw-elevation-prominent')
  })

  it('Menu.module.css 确实重绑了描边色；Modal 确实吃 mask 与 elevation', () => {
    const menuCss = readFileSync(join(vendorDir, 'Menu.module.css'), 'utf8')
    expect(menuCss).toContain('--dsw-elevation-stroke-color: var(--dsw-alias-border-l1);')
    expect(menuCss).toContain('box-shadow: var(--dsw-elevation-prominent);')
    const modalCss = readFileSync(join(vendorDir, 'Modal.module.css'), 'utf8')
    expect(modalCss).toContain('background: var(--dsw-alias-bg-mask-1);')
    expect(modalCss).toContain('backdrop-filter: var(--dsw-mask-blur);')
    expect(modalCss).toContain('box-shadow: var(--dsw-elevation-prominent);')
  })

  it('两批并集 = 37 个被引用变量，且全部在 L1 有声明（零未解析引用）', () => {
    const referenced = new Set(
      readdirSync(vendorDir)
        .filter((f) => f.endsWith('.module.css'))
        .map((f) => readFileSync(join(vendorDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
        .join('\n')
        .match(/var\((--dsw-[a-z0-9-]+)/g)
        ?.map((m) => m.replace('var(', '')) ?? [],
    )
    // 逐个数出来的：首批 23 + 第二批 14（Input 5 / Menu 9 / ConnectionIndicator 6 /
    // Modal 11 各自去重后合并，与首批重叠的是 --dsw-alias-brand-primary 等）。
    expect(referenced.size).toBe(37)
    for (const name of referenced) {
      expect(tokensCss, `L1 白名单缺定义：${name}`).toContain(`${name}:`)
    }
  })
})

/**
 * 设备状态配色的 WCAG AA 门（#138 审查回归）。
 *
 * 事实：vendored Tag 的 success/warning 是 11px 小字 + 10%~12% 同色浅底，上游取的是
 * 500 档亮色，白底上只有 2.2 左右——上游 design-platform.css 里只有 state-warn-label
 * 一个文字专用变体，success/error 没有，即「DSH 的浅底小字」本身不满足 AA（他们的
 * 取舍，不是我们抄错）。prototype/IMPLEMENTATION-PLAN.md:17 明写 AA 为基线，所以本仓
 * 在设备页包裹元素上做局部重映射（global.css 的 .device-status-*），不动 vendored 文件。
 *
 * 这门同时覆盖「当前渲染不出来的状态」：色值全部从 CSS 文本取，三个状态各自算一遍。
 */
describe('设备状态配色 AA 门（#138 审查回归）', () => {
  const tokensCss = readFileSync(join(repoRoot, 'apps/web/src/styles/dsw-tokens.css'), 'utf8')
  const globalCss = readFileSync(join(repoRoot, 'apps/web/src/styles/global.css'), 'utf8')
  const tagCss = readFileSync(join(vendorDir, 'Tag.module.css'), 'utf8')

  const CASES = [
    {
      status: 'online',
      label: '在线',
      alias: '--dsw-alias-state-success-primary',
      dark: '--dsw-static-green-900',
      tone: 'success',
    },
    {
      status: 'offline',
      label: '离线',
      alias: '--dsw-alias-state-warn-primary',
      dark: '--dsw-static-amber-900',
      tone: 'warning',
    },
    {
      status: 'revoked',
      label: '已撤销',
      alias: '--dsw-alias-state-error-primary',
      dark: '--dsw-static-red-900',
      tone: 'danger',
    },
  ] as const

  it('重映射接线在：global.css 把三个状态各自的 alias 指到上游 900 静态色', () => {
    for (const item of CASES) {
      const rule = new RegExp(`\\.device-status-${item.status}\\s*\\{([^}]*)\\}`).exec(
        globalCss,
      )?.[1]
      expect(rule, `${item.status} 缺少 .device-status-${item.status} 重映射规则`).toBeDefined()
      expect(rule).toContain(`${item.alias}: var(${item.dark})`)
      // 深色档取值必须来自 dsw-tokens.css 的白名单（不是就地写死的 rgb）。
      expect(tokensCss, `${item.dark} 不在 L1 白名单里`).toContain(`${item.dark}:`)
    }
  })

  it('实测复算：文字 vs 自身浅底 ≥4.5:1、色块 vs 白底 ≥3:1（三个状态都算）', () => {
    const rows: string[] = []
    for (const item of CASES) {
      const text = parseCssColor(readTokenValue(tokensCss, item.dark))
      expect(text.a, `${item.dark} 应是不透明色`).toBe(1)
      const tint = readToneTintPercent(tagCss, item.tone)
      const onTint = contrastOnTint(text, tint)
      const dotOnWhite = contrastRatio(text, WHITE)
      rows.push(
        `${item.label} 文字/浅底 ${round2(onTint)}:1（底 ${Math.round(tint * 100)}%）` +
          `、色块/白底 ${round2(dotOnWhite)}:1`,
      )
      expect(
        onTint,
        `${item.label} 文字对比度不足 4.5:1（实测 ${round2(onTint)}）`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        dotOnWhite,
        `${item.label} 色块对比度不足 3:1（实测 ${round2(dotOnWhite)}）`,
      ).toBeGreaterThanOrEqual(3)
    }
    // 实测数字留痕（评审要的是「算出来的」而不是「声称的」）。
    console.log(`[#138 AA] ${rows.join('；')}`)
  })

  it('反向钉：上游 500 档亮色确实不达标——重映射不是装饰', () => {
    for (const item of CASES) {
      const bright = parseCssColor(readTokenValue(tokensCss, item.alias))
      const onTint = contrastOnTint(bright, readToneTintPercent(tagCss, item.tone))
      expect(
        onTint,
        `${item.label} 上游亮色竟已达标（${round2(onTint)}），可复核是否可以撤掉重映射`,
      ).toBeLessThan(4.5)
    }
  })
})
