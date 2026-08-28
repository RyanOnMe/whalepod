/**
 * web 测试项目 setup（vitest.config.ts 的 web project 指定）：
 * - jest-dom matcher（用户视角断言 toBeVisible/toBeInTheDocument 等）
 * - 每个用例后清理 DOM（RTL 在非 globals 模式下不自动清理）与全局 mock
 */
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { setRealtimeSocketFactoryForTest } from '../src/app/realtime.js'
import { resetRunLiveBuffers } from '../src/shared/realtime/run-buffer.js'

// AppShell 挂载的 RealtimeBridge 在测试中不联网：no-op socket 替换真实 WS
// （协议行为由 socket.spec.ts / event-router.spec.ts 单测覆盖，链路验收在
// hub 集成测试与 P1-19 e2e）。
setRealtimeSocketFactoryForTest(() => ({ connect: () => {}, close: () => {} }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetRunLiveBuffers()
})
