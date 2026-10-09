/**
 * web 测试项目 setup（vitest.config.ts 的 web project 指定）：
 * - jest-dom matcher（用户视角断言 toBeVisible/toBeInTheDocument 等）
 * - 每个用例后清理 DOM（RTL 在非 globals 模式下不自动清理）与全局 mock
 * - RTL 的异步发现超时放宽（见下方 configure）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { setRealtimeSocketFactoryForTest } from '../src/app/realtime.js'
import { resetRunLiveBuffers } from '../src/shared/realtime/run-buffer.js'

// findBy*/waitFor 的默认发现超时是 1000ms——机器速度混进了判据里：全量并行
// （两个套件同机、CI 共享 runner）实测挂在 1.2–1.8s 上的用例，单跑全是绿的，
// 12 条中招用例互相无关，说明红的是「这台机器当时多快」而不是产品行为。
// 判据要的是「会出现」，不是「1 秒内出现」：放宽到 5s，真不出现照旧红。
configure({ asyncUtilTimeout: 5_000 })

// AppShell 挂载的 RealtimeBridge 在测试中不联网：no-op socket 替换真实 WS
// （协议行为由 socket.spec.ts / event-router.spec.ts 单测覆盖，链路验收在
// hub 集成测试与 P1-19 e2e）。
setRealtimeSocketFactoryForTest(() => ({ connect: () => {}, close: () => {} }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetRunLiveBuffers()
})
