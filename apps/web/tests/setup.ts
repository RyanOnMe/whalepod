/**
 * web 测试项目 setup（vitest.config.ts 的 web project 指定）：
 * - jest-dom matcher（用户视角断言 toBeVisible/toBeInTheDocument 等）
 * - 每个用例后清理 DOM（RTL 在非 globals 模式下不自动清理）与全局 mock
 */
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
