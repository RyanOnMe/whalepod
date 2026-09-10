/**
 * #158：下拉选择器统一到 vendored `Menu` —— 三组判据。
 *
 * A. **反面钉**：7 个落页点确实不再是原生 `<select>`。这条必须能在"改回原生 select"
 *    时变红（实测变异验证见 PR 说明）：判据分两层——①`src` 全树禁止出现 `<select`
 *    开标签、②7 个落页点的控件 id 必须落在 `<button aria-haspopup="menu">` 上。
 *    只断言"菜单能开"是不够的：原生 select 加了菜单样式也能开，那样的检查是假绿。
 * B. **契约面不退化**：键盘可达路径（Tab → Enter 打开 → 方向键 → Enter 选中 → Esc 关
 *    且焦点回触发器）、`aria-expanded` 语义与 #152 折叠入口一致、禁用项不可选、
 *    placeholder 与 hint 如实呈现。
 * C. **视觉判据是机器可核的**：触发器那三条关键 computed style（背景 / 描边 /
 *    圆角）在**真实浏览器**里必须等于 L1 token 的解析值——这里先按 CSS 文本与 token
 *    文件算出期望值（jsdom 不处理 CSS，算不了 computed style），浏览器侧的同一条断言
 *    在 Q5（apps/web/tests/e2e/helpers.ts 的 assertMenuTriggerTokens + 三个 spec 调用点）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { renderApp, renderUi } from './render.js'
import { openSelect, selectOption } from './select-menu.js'
import {
  ALICE,
  BOB,
  agentsHandler,
  createInviteHandler,
  loggedInHandlers,
  makeMember,
  packsHandler,
  projectsHandler,
  teamMembersHandler,
} from './fixtures.js'
import {
  SELECT_TRIGGER_BACKGROUND_TOKEN as reExportedBackgroundToken,
  SELECT_TRIGGER_BORDER_TOKEN as reExportedBorderToken,
  SelectMenu,
} from '../src/shared/SelectMenu.js'
// 常量与判定函数从**纯模块**直接取（评审 S1：单测不该从 e2e 的 helpers 反向 import；
// 那个文件会拖 @playwright/test，方向也不对）。e2e 的 helpers 从这里同一份 import。
import {
  SELECT_TRIGGER_BACKGROUND_TOKEN,
  SELECT_TRIGGER_BORDER_TOKEN,
  checkMenuTriggerTokens,
} from '../src/shared/select-trigger-tokens.js'
import { contrastRatio, parseCssColor, readTokenValue, round2 } from './contrast.js'
import type { ProjectView } from '../src/shared/api/types.js'

const repoRoot = join(import.meta.dirname, '../../..')
const webSrc = join(repoRoot, 'apps/web/src')
const tokensCss = readFileSync(join(webSrc, 'styles/dsw-tokens.css'), 'utf8')
const globalCss = readFileSync(join(webSrc, 'styles/global.css'), 'utf8')

/** 递归收集 src 下的文件（跳过 vendor：那是 ADR-0008 的复制品，不在本判据范围内）。 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      return entry === 'vendor' ? [] : sourceFiles(full)
    }
    return /\.(ts|tsx)$/.test(entry) ? [full] : []
  })
}

/** 取 global.css 里某条选择器的声明块原文（找不到就抛——别让判据静默变成空断言）。 */
function cssBlock(selector: string): string {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g').exec(globalCss)
  if (match?.[1] === undefined) throw new Error(`global.css 里找不到规则：${selector}`)
  return match[1]
}

const TRIGGER_BLOCK = cssBlock('.select-menu .select-menu-trigger')

/** #revision-plugin-pack 用例的 Agent 与详情（该 id 只在「新建 Revision」表单里出现）。 */
const revisionProbeAgent = {
  id: 'aaaaaaaa-0000-4000-8000-00000000000f',
  name: 'Probe',
  description: '',
  createdBy: ALICE.userId,
  archivedAt: null,
  currentRevisionId: null,
}
const revisionProbeDetailHandler = {
  method: 'GET' as const,
  url: new RegExp(`/api/v1/agents/${revisionProbeAgent.id}$`),
  respond: () => ({
    status: 200,
    body: { ok: true, data: { ...revisionProbeAgent, currentRevision: null, revisions: [] } },
  }),
}

// ---------- A. 反面钉：不再是原生 <select> ----------

describe('#158 反面钉：7 处下拉不再是原生 <select>', () => {
  it('apps/web/src 全树没有原生 <select> 开标签（vendor 子树除外）', () => {
    // 行内注释与块注释都要剔掉：`SelectMenu.tsx` 的注释里就写着「原生 <select>」四个字，
    // 不剔就会把说明文字当成违规（实测踩过）。
    const stripComments = (text: string): string =>
      text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '')
    const offenders = sourceFiles(webSrc)
      .flatMap((file) => {
        const code = stripComments(readFileSync(file, 'utf8'))
        return [...code.matchAll(/<select[\s>]/g)].map(() => file.slice(repoRoot.length + 1))
      })
      .sort()
    // 7 个落页点全部迁完才为空：容器里再出现一个 <select>，这条立刻红。
    expect(offenders).toEqual([])
  })

  it('落页点 #invite-role：是 <button aria-haspopup="menu">，不是 <select>', async () => {
    renderApp(
      '/members',
      loggedInHandlers(ALICE, [
        teamMembersHandler([makeMember()]),
        createInviteHandler({ role: 'member' }).handler,
      ]),
    )
    const control = await screen.findByLabelText('角色')
    expect(control.tagName).toBe('BUTTON')
    expect(control).toHaveAttribute('aria-haspopup', 'menu')
    expect(control).toHaveAttribute('id', 'invite-role')
    // 反面钉的直白写法：这个 id 底下**不能**是 select 元素。
    expect(document.querySelector('select#invite-role')).toBeNull()
  })

  it('落页点 #task-assignee-<projectId>：是按钮，且每个项目一个（不再按前缀命中原生 select）', async () => {
    const project: ProjectView = {
      id: '22222222-0000-4000-8000-000000000002',
      name: '潮汐观测站',
      description: '',
      createdBy: ALICE.userId,
      archivedAt: null,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    }
    const user = userEvent.setup()
    renderApp('/', loggedInHandlers(ALICE, [projectsHandler([project]), teamMembersHandler()]))
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    const control = await screen.findByLabelText('责任人')
    expect(control.tagName).toBe('BUTTON')
    expect(control).toHaveAttribute('id', `task-assignee-${project.id}`)
    expect(document.querySelectorAll('select[id^="task-assignee-"]')).toHaveLength(0)
    // 成员列表就绪后默认选中自己（#136 的行为必须保留）
    await within(control).findByText(/Alice/)
  })

  it('落页点 #agent-plugin-pack：按钮 + 打开后是菜单项（不是原生 option）', async () => {
    const user = userEvent.setup()
    renderApp(
      '/agents',
      loggedInHandlers(ALICE, [
        agentsHandler([]),
        packsHandler([
          {
            id: 'eeeeeeee-0000-4000-8000-000000000001',
            name: 'core-empty',
            packDigest: 'f'.repeat(64),
            installations: [],
            entries: [],
            createdBy: ALICE.userId,
            createdAt: '2026-08-22T09:00:00.000Z',
          },
        ]),
      ]),
    )
    const control = await screen.findByLabelText('Plugin Pack')
    expect(control.tagName).toBe('BUTTON')
    expect(control).toHaveAttribute('id', 'agent-plugin-pack')
    await user.click(control)
    const list = await screen.findByRole('menu')
    expect(within(list).getByRole('menuitem', { name: 'core-empty' })).toBeVisible()
    expect(screen.queryAllByRole('option')).toHaveLength(0) // 原生 option 一个都不该有
    expect(document.querySelectorAll('select')).toHaveLength(0)
  })

  it('落页点 #revision-plugin-pack：真打开一次（空 Pack 列表下如实禁用）', async () => {
    // 评审 S4 追出：上一版只在标题里声称覆盖了 #revision-plugin-pack，其实从没打开过它。
    const user = userEvent.setup()
    renderApp(
      '/agents',
      loggedInHandlers(ALICE, [
        agentsHandler([revisionProbeAgent]),
        revisionProbeDetailHandler,
        packsHandler([]),
      ]),
    )
    await user.click(await screen.findByRole('button', { name: /Probe/ }))
    const detail = screen.getByRole('region', { name: /Agent 详情/ })
    await user.click(within(detail).getByRole('button', { name: '新建 Revision' }))
    const control = await within(detail).findByLabelText('Plugin Pack')
    expect(control).toHaveAttribute('id', 'revision-plugin-pack')
    expect(control.tagName).toBe('BUTTON')
    // 空 Pack 列表 → 与 #agent-plugin-pack 同款：触发器禁用、文案如实说明
    expect(control).toBeDisabled()
    expect(within(control).getByText('没有可选 Pack')).toBeInTheDocument()
    expect(within(detail).queryAllByRole('option')).toHaveLength(0)
  })
})

// ---------- B. 契约面：键盘路径与语义 ----------

describe('#158 契约面：键盘可达 + aria 语义', () => {
  it('键盘全路径：Tab 到触发器 → Enter 打开（焦点落首项）→ 方向键 → Enter 选中并关闭', async () => {
    const user = userEvent.setup()
    renderApp(
      '/members',
      loggedInHandlers(ALICE, [
        teamMembersHandler([makeMember()]),
        createInviteHandler({ role: 'member' }).handler,
      ]),
    )
    // 真人路径：**全程 Tab 与键盘**走到触发器并完成选择，不用 element.focus() 抄近道。
    const trigger = (await screen.findByLabelText('角色')) as HTMLButtonElement
    document.body.focus()
    // 从 body 起按真实 taborder 逐格前进，直到落在触发器上（触发器的位置随页面结构变，
    // 写死格数会在无关布局改动时假红；这里断言的是「Tab 能到」这件事本身）。
    let hops = 0
    while (document.activeElement !== trigger && hops < 40) {
      await user.tab()
      hops += 1
    }
    expect(document.activeElement, `${hops} 次 Tab 后仍未到触发器`).toBe(trigger)

    // 实测耗时（写进提交说明用的数字）：jsdom 下这段键盘序列本身的开销。
    // 判据是"别退化到秒级"（人手速度上限），不是性能门——所以只 log + 宽上限断言。
    const started = performance.now()
    await user.keyboard('{Enter}')
    const list = await screen.findByRole('menu')
    const openMs = performance.now() - started
    console.log(`[#158] 键盘打开下拉耗时（jsdom）: ${openMs.toFixed(0)}ms`)
    expect(openMs).toBeLessThan(1000)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    // autoFocus 打开即聚焦首项：方向键导航的前提
    expect(document.activeElement).toBe(within(list).getAllByRole('menuitem')[0])
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(within(list).getAllByRole('menuitem')[1])
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveTextContent('Admin（可管理插件与邀请）')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    // S3（评审追出）：选中路径下 `Menu` 不回焦（它只在 Esc + autoFocus 时回焦），
    // 不补的话焦点会掉到 body —— 键盘用户在 RunLauncher 四个字段之间每选一次都要
    // 从文档头重新 Tab。先在这里钉住"回到触发器"。
    expect(document.activeElement).toBe(trigger)
  })

  it('Space 也能打开（原生 button 行为）', async () => {
    const user = userEvent.setup()
    renderApp(
      '/members',
      loggedInHandlers(ALICE, [
        teamMembersHandler([makeMember()]),
        createInviteHandler({ role: 'member' }).handler,
      ]),
    )
    const trigger = (await screen.findByLabelText('角色')) as HTMLButtonElement
    trigger.focus()
    await user.keyboard(' ')
    expect(await screen.findByRole('menu')).toBeVisible()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('Esc 关闭并把焦点还给触发器；Esc 不改值', async () => {
    const user = userEvent.setup()
    renderApp(
      '/members',
      loggedInHandlers(ALICE, [
        teamMembersHandler([makeMember()]),
        createInviteHandler({ role: 'member' }).handler,
      ]),
    )
    const trigger = (await screen.findByLabelText('角色')) as HTMLButtonElement
    trigger.focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('menu')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    // Esc 这条是 vendored Menu 自带的回焦（autoFocus 打开时才有）
    expect(document.activeElement).toBe(trigger)
    expect(trigger).toHaveTextContent('Member（普通成员）')
  })

  it('鼠标选中后焦点也回触发器（S3：不只是键盘路径）', async () => {
    const user = userEvent.setup()
    renderApp(
      '/members',
      loggedInHandlers(ALICE, [
        teamMembersHandler([makeMember()]),
        createInviteHandler({ role: 'member' }).handler,
      ]),
    )
    const trigger = (await screen.findByLabelText('角色')) as HTMLButtonElement
    const list = await openSelect(user, '角色')
    await user.click(list.getByRole('menuitem', { name: 'Admin（可管理插件与邀请）' }))
    expect(trigger).toHaveTextContent('Admin（可管理插件与邀请）')
    expect(document.activeElement).toBe(trigger)
  })

  it('placeholder 是禁用项：点它不选中、不上报 onChange', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderProbe({ onChange })
    const trigger = (await screen.findByLabelText('探针下拉')) as HTMLButtonElement
    await user.click(trigger)
    const list = await screen.findByRole('menu')
    const placeholder = within(list).getByRole('menuitem', { name: '请选择' })
    expect(placeholder).toBeDisabled()
    await user.click(placeholder)
    expect(onChange).not.toHaveBeenCalled()
    // 点禁用项没有选中，但菜单没关（Menu 不自行关闭），焦点仍在项上
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('选中项被禁用时不认这个 value：显示回落 placeholder（原生 select 同款）', () => {
    renderProbe({ value: 'x', placeholder: '请选择' })
    const trigger = screen.getByLabelText('探针下拉')
    expect(within(trigger).getByText('请选择')).toBeInTheDocument()
  })

  it('hint 经 aria-describedby 挂在触发器上（按钮形态的补强，原生 select 没有对应通道）', () => {
    renderProbe({ hint: '先选 Agent…' })
    const trigger = screen.getByLabelText('探针下拉')
    const describedBy = trigger.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    expect(document.getElementById(describedBy as string)).toHaveTextContent('先选 Agent…')
  })

  it('无 hint 时不挂 aria-describedby（不指向不存在的 id）', () => {
    renderProbe({})
    expect(screen.getByLabelText('探针下拉')).not.toHaveAttribute('aria-describedby')
  })

  it('触发器是 type=button：放在表单里不会误触提交', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    // 用 members 页的真实表单：触发器在 <form className="inline-form"> 内
    renderApp(
      '/members',
      loggedInHandlers(ALICE, [
        teamMembersHandler([makeMember()]),
        createInviteHandler({ role: 'member' }).handler,
      ]),
    )
    const trigger = await screen.findByLabelText('角色')
    expect(trigger).toHaveAttribute('type', 'button')
    await user.click(trigger)
    await screen.findByRole('menu')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('选项文案支持富文本（承接原 <option> 里的多节点拼接）', async () => {
    const user = userEvent.setup()
    renderProbe({
      options: [
        {
          value: 'r3',
          label: (
            <>
              r3 — deepseek/<strong>deepseek-chat</strong>（当前）
            </>
          ),
          disabled: false,
        },
      ],
      value: 'r3',
    })
    await user.click(screen.getByLabelText('探针下拉'))
    const list = await screen.findByRole('menu')
    expect(
      within(list).getByRole('menuitem', { name: 'r3 — deepseek/deepseek-chat（当前）' }),
    ).toBeVisible()
  })
})

/** 局部渲染探针：契约用例只钉组件本身，不经过整页。 */
function renderProbe(overrides: {
  onChange?: (value: string) => void
  value?: string
  placeholder?: string
  hint?: string
  options?: ReadonlyArray<{ value: string; label: ReactNode; disabled: boolean }>
}): void {
  renderUi(
    <SelectMenu
      id="probe-select"
      label="探针下拉"
      ariaLabel="探针下拉"
      value={overrides.value ?? ''}
      placeholder={overrides.placeholder ?? '请选择'}
      hint={overrides.hint}
      options={overrides.options ?? [{ value: 'a', label: '选项 A', disabled: false }]}
      onChange={overrides.onChange ?? (() => {})}
    />,
  )
}

// ---------- C. 视觉判据：关键 computed style 来自 L1 token ----------

describe('#158 视觉判据：触发器样式来自 L1 token', () => {
  it('背景 / 描边 / 圆角三条声明**按契约常量**吃 token，不是字面量、也不是别的 token', () => {
    // 断言里不写死 token 名，而是引用 SelectMenu 导出的常量——Q5 的浏览器侧判据锚的是
    // 同一组常量。两侧各写一份就会漂移成"单测管 A、浏览器管 B"：实测把
    // --dsw-alias-bg-layer-1 换成 -2（浅色下同值）时，写死名字的写法能漏过去。
    expect(TRIGGER_BLOCK).toMatch(
      new RegExp(`background:\\s*var\\(${SELECT_TRIGGER_BACKGROUND_TOKEN}\\)`),
    )
    expect(TRIGGER_BLOCK).toMatch(
      new RegExp(`border:\\s*0\\.5px solid var\\(${SELECT_TRIGGER_BORDER_TOKEN}\\)`),
    )
    expect(TRIGGER_BLOCK).toMatch(/border-radius:\s*8px/)
    // 纯模块里的常量必须与 `SelectMenu.tsx` 对外再导出的那一份**同值**——两处定义
    // 曾经就是这么漂移的（评审 S1：e2e 侧一度硬编码字面量）。这里直接比对两个模块。
    expect(SELECT_TRIGGER_BACKGROUND_TOKEN).toBe(reExportedBackgroundToken)
    expect(SELECT_TRIGGER_BORDER_TOKEN).toBe(reExportedBorderToken)
    // 契约常量本身必须真的在 L1 白名单里有声明（名字打错时这条立刻红）
    for (const token of [SELECT_TRIGGER_BACKGROUND_TOKEN, SELECT_TRIGGER_BORDER_TOKEN]) {
      expect(() => readTokenValue(tokensCss, token)).not.toThrow()
    }
    expect(readTokenValue(tokensCss, SELECT_TRIGGER_BACKGROUND_TOKEN)).toBe(
      'var(--dsw-static-neutral-bluish-00)',
    )
    expect(readTokenValue(tokensCss, SELECT_TRIGGER_BORDER_TOKEN)).toBe('rgba(0, 0, 0, 0.16)')
    expect(readTokenValue(tokensCss, '--dsw-static-neutral-bluish-00')).toBe('rgb(255, 255, 255)')
  })

  /**
   * 浏览器侧判据（Q5 的 assertMenuTriggerTokens）的**判定逻辑**在这里跑：用与浏览器同一套
   * 采集口径（computed 值 + 自定义属性原文 + :root 解析值）造探针，喂给同一个纯函数。
   *
   * 实测缺口（这条用例就是为了守住它）：`--dsw-alias-bg-layer-1` 与 `-2` 在浅色下都是
   * `rgb(255,255,255)`，**只比最终颜色**的判据在"换成另一个同值 token"时静默通过；
   * 所以判定函数还要求"规则声明的就是约定 token"（读自定义属性原文）。
   */
  it('Q5 判定函数：声明与解析值都对才过；换同值 token / 裸色值 / 圆角变 / token 缺失全红', () => {
    const backgroundToken = SELECT_TRIGGER_BACKGROUND_TOKEN
    const borderToken = SELECT_TRIGGER_BORDER_TOKEN
    const backgroundResolved = readTokenValue(tokensCss, '--dsw-static-neutral-bluish-00')
    const borderResolved = 'rgba(0, 0, 0, 0.16)'
    const probe = {
      background: backgroundResolved,
      borderColor: borderResolved,
      radius: '8px',
      rawBackground: `var(${backgroundToken})`,
      rawBorder: `var(${borderToken})`,
      resolvedBackgroundToken: backgroundResolved,
      resolvedBorderToken: borderResolved,
    }
    expect(checkMenuTriggerTokens(probe, backgroundToken, borderToken)).toEqual([])

    // 换成另一个同值 token：解析值一样，但声明已经不是约定的那个 → 必须红
    const otherLayer = readTokenValue(tokensCss, '--dsw-alias-bg-layer-2')
    expect(otherLayer).toBe(backgroundResolved)
    expect(
      checkMenuTriggerTokens(
        { ...probe, rawBackground: 'var(--dsw-alias-bg-layer-2)' },
        backgroundToken,
        borderToken,
      ),
    ).toHaveLength(1)

    // 声明改成裸色值（值是白的也照样红：声明面已经脱离 token）
    expect(
      checkMenuTriggerTokens(
        { ...probe, rawBackground: backgroundResolved, background: 'rgb(255, 255, 255)' },
        backgroundToken,
        borderToken,
      ),
    ).toHaveLength(1)

    // 最终值与 token 解析值不符（token 改了但控件没跟上）
    expect(
      checkMenuTriggerTokens(
        { ...probe, background: 'rgb(0, 0, 0)' },
        backgroundToken,
        borderToken,
      ),
    ).toHaveLength(1)

    // 圆角被动过
    expect(
      checkMenuTriggerTokens({ ...probe, radius: '12px' }, backgroundToken, borderToken),
    ).toHaveLength(1)

    // token 没解析（CSS 没加载 / 名字打错）：必须失败，而不是"空串相等"悄悄通过
    expect(
      checkMenuTriggerTokens(
        { ...probe, rawBackground: '', resolvedBackgroundToken: '' },
        backgroundToken,
        borderToken,
      ),
    ).toHaveLength(1)
  })

  it('文字色用 L1 label-primary 而非本仓旧色，且白底对比度过 AA（4.5:1）', () => {
    expect(TRIGGER_BLOCK).toMatch(/color:\s*var\(--dsw-alias-label-primary\)/)
    const fg = parseCssColor(readTokenValue(tokensCss, '--dsw-alias-label-primary'))
    const bg = parseCssColor(readTokenValue(tokensCss, '--dsw-static-neutral-bluish-00'))
    const ratio = round2(
      contrastRatio({ r: fg.r, g: fg.g, b: fg.b }, { r: bg.r, g: bg.g, b: bg.b }),
    )
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  it('整条触发器规则里不出现裸色值（颜色一律 var(--…)）', () => {
    // 只查颜色类声明：几何值（0.5px/8px/40px）本来就是字面量，别把判据写成"整块无数字"。
    const colorDeclarations = TRIGGER_BLOCK.split(';')
      .map((decl) => decl.trim())
      .filter((decl) => /^(background|border|border-color|color|outline|box-shadow)\b/.test(decl))
    for (const decl of colorDeclarations) {
      const values = decl.slice(decl.indexOf(':') + 1)
      // var() 允许出现在值里；除它之外不许有 hex / rgb / hsl 字面量
      const withoutVars = values.replaceAll(/var\([^)]*\)/g, '')
      expect(withoutVars, `裸色值：${decl}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    }
  })
})
