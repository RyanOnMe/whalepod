/**
 * #138 L1+L2：vendored DSH 原语（apps/web/src/vendor/dsh-ui）的行为契约与真实接线。
 *
 * 三块：
 * A. 六个原语各自的语义契约——role / aria / data-* 钩子 + 受控回调，逐个最小用例。
 *    断言的是读屏与键盘能看到的表面，**不锚 hash 类名**（vitest 默认不处理 CSS，
 *    类名在测试里没有意义，锚它只会得到一条假绿）。
 * B. 真实界面接线：/devices 的设备状态改用 vendored StateDot + Tag 渲染，文案仍是
 *    「在线/离线/已撤销」（#142 的用例按文本断言，这里同时钉住 data-state/data-tone）。
 * C. vendored 子树的静态纪律：零 @deepseek-ai/*、零第三方 import（react 除外）、
 *    每个文件带出处注释、引用的 --dsw-* 变量在 L1 白名单里有定义、manifest.json
 *    登记了全部文件。
 *
 * 没验的（如实说明）：①颜色/间距/深色一套（vitest 不处理 CSS，要真实浏览器才谈得上）；
 * ②与上游的逐像素一致性；③L3 运行视图（不在本切片）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { renderApp, renderUi } from './render.js'
import { ALICE, devicesHandler, loggedInHandlers, makeDevice } from './fixtures.js'
import { Button, DisclosureRow, Pill, StateDot, Switch, Tag } from '../src/vendor/dsh-ui/index.js'

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

    const expected: readonly (readonly [string, string, string, string])[] = [
      ['m4-mini', '在线', 'done', 'success'],
      ['thinkpad-x1', '离线', 'warning', 'warning'],
      ['old-air', '已撤销', 'error', 'danger'],
    ]
    for (const [name, label, dotState, tone] of expected) {
      const heading = await screen.findByRole('heading', { name })
      const row = heading.closest('li')
      expect(row).not.toBeNull()
      if (row === null) continue
      // 稳定锚点：外层 data-testid，内层两个 data-vendored（Q5 判计算样式时按它们定位）。
      const status = within(row).getByTestId('device-status')
      expect(status.querySelector('[data-vendored="state-dot"]')).not.toBeNull()
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
  // 用 import.meta.dirname（纯路径字符串）而不是 import.meta.url + fileURLToPath：
  // 在 vitest 的 jsdom 环境里，collect 阶段 new URL(...) 拿到的是 jsdom 的 URL
  // 实例，fileURLToPath 不认（"must be of scheme file"）；dirname 不受环境影响。
  const repoRoot = join(import.meta.dirname, '../../..')
  const vendorDir = join(repoRoot, 'apps/web/src/vendor/dsh-ui')
  const sourceFiles = readdirSync(vendorDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  const cssFiles = readdirSync(vendorDir).filter((f) => f.endsWith('.module.css'))

  it('至少 vendored 了约定的 6 个组件与 L1 token 白名单', () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(7)
    expect(cssFiles.sort()).toEqual([
      'Button.module.css',
      'DisclosureRow.module.css',
      'Pill.module.css',
      'StateDot.module.css',
      'Switch.module.css',
      'Tag.module.css',
    ])
  })

  it('零 @deepseek-ai/*、零 @whalepod/*、零第三方 import（只准 react 与相对路径）', () => {
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
        expect(specifier, `${file} 只允许 import react`).toBe('react')
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

  it('vendored CSS 只吃 --dsw-*，且每个变量都在 L1 白名单里有定义；白名单在 tokens.css 之后引入', () => {
    const vendorCss = readdirSync(vendorDir)
      .filter((f) => f.endsWith('.module.css'))
      .map((f) => readFileSync(join(vendorDir, f), 'utf8'))
      .join('\n')
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

    const globalCss = readFileSync(join(repoRoot, 'apps/web/src/styles/global.css'), 'utf8')
    const prototypeAt = globalCss.indexOf("@import './tokens.css'")
    const dswAt = globalCss.indexOf("@import './dsw-tokens.css'")
    expect(prototypeAt).toBeGreaterThanOrEqual(0)
    expect(dswAt).toBeGreaterThan(prototypeAt)
  })
})
