/**
 * #158 单测助手：走真人路径操作已迁移到 vendored `Menu` 的下拉控件。
 *
 * 为什么单独一个文件：7 个落页点里有 4 个测试文件要用同一套动作（点开 → 点选项），
 * 各写一遍 `click` 序列迟早漂移；而且**「必须是真人路径」这件事本身**（不是
 * `user.selectOptions()` 那种只有原生 `<select>` 才有的近道）值得有个可复用的名字。
 */
import { screen, within } from '@testing-library/react'
import type { Screen } from '@testing-library/dom'
import { userEvent } from '@testing-library/user-event'

type User = ReturnType<typeof userEvent.setup>
/**
 * 查询范围：默认整页（`screen`）。同一页有多个同标签控件时（如 Agent 页的创建表单与
 * Revision 表单各有一个「Plugin Pack」），调用方传 `within(region)` 收窄——
 * 这与原来 `within(detail).getByLabelText(...)` 的写法一致。
 */
export type QueryScope = Pick<Screen, 'findByRole' | 'findAllByRole'>

/**
 * 按可访问名取触发器按钮（迁移后 `id` 落在 `<button>` 上，不再是 `<select>`）。
 *
 * 用 `findByRole` 而不是 `getByRole`：调用点常在页面首次渲染后立刻取控件，而列表数据
 * （成员/Pack/设备）还没落地时页面可能整个还没挂上——实测踩过，`getByRole` 拿到的是
 * 空 body（"There are no accessible roles"）。异步查询把这段等待吃掉。
 */
export function selectTrigger(
  name: string | RegExp,
  scope: QueryScope = screen,
): Promise<HTMLElement> {
  return scope.findByRole('button', { name })
}

/** 同名的全部触发器（一个页面里有多处同标签控件时按顺序取）。 */
export function selectTriggers(
  name: string | RegExp,
  scope: QueryScope = screen,
): Promise<HTMLElement[]> {
  return scope.findAllByRole('button', { name })
}

/**
 * 点开触发器，等列表里的项出现，返回列表内可用的查询函数。
 * @param name 触发器的可访问名（与原 `<select>` 的 `aria-label` / 标签同源）
 */
export async function openSelect(
  user: User,
  name: string | RegExp,
  scope: QueryScope = screen,
): Promise<ReturnType<typeof within>> {
  await user.click(await selectTrigger(name, scope))
  const list = await screen.findByRole('menu')
  return within(list)
}

/**
 * 点开 → 点选项（按项文案精确匹配；用 `exact: false` 承接「r3 — deepseek/…（当前）」
 * 这类带后缀的富文本）。
 * @returns 被点的那个项（调用方需要时可断言它的 role/禁用态）
 */
export async function selectOption(
  user: User,
  name: string | RegExp,
  optionName: string | RegExp,
  scope: QueryScope = screen,
): Promise<HTMLElement> {
  const list = await openSelect(user, name, scope)
  const option = list.getByRole('menuitem', { name: optionName })
  await user.click(option)
  return option
}
