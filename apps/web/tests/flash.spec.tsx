/**
 * 一次性提示的读取契约（#267）。
 *
 * 为什么值得一条 spec：旧写法把「读即清除」放在 `useState` 初始化器里——那是**渲染期**，
 * React 丢弃一次渲染（并发渲染被导航打断）就把消息吃了、却没人看见。CI 偶发红
 * （session-expiry「登录已过期」找不到）与本地插桩（FlashBanner 在一次流程里挂载
 * 三次）都指向它。判据：peek 可反复读、clear 才真清、显示过就再不出现。
 */
import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderUi } from './render.js'
import { FlashBanner } from '../src/app/FlashBanner.js'
import { clearFlash, peekFlash, setFlash } from '../src/shared/flash.js'

describe('一次性提示的读取契约（#267）', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('peek 反复读都在（渲染被丢弃/双调用也不吞消息）；clear 之后才没有', () => {
    setFlash('已加入 潮汐团队')
    expect(peekFlash()).toBe('已加入 潮汐团队')
    // 渲染期可能被 React 调用多次（丢弃渲染、严格模式双调用）：第二次读必须还在。
    expect(peekFlash()).toBe('已加入 潮汐团队')
    clearFlash()
    expect(peekFlash()).toBeNull()
  })

  it('显示一次即清除：渲染提交后存储清空，重新挂载不再出现', () => {
    setFlash('已加入 潮汐团队')
    const first = renderUi(<FlashBanner />)
    expect(screen.getByText('已加入 潮汐团队')).toBeVisible()
    expect(peekFlash()).toBeNull()
    first.unmount()
    renderUi(<FlashBanner />)
    expect(screen.queryByText('已加入 潮汐团队')).toBeNull()
  })

  it('没有消息时不渲染任何东西（常驻壳里保持安静）', () => {
    const view = renderUi(<FlashBanner />)
    expect(view.container).toBeEmptyDOMElement()
  })
})
