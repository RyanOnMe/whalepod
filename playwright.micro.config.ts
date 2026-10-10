import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

/** #306 专用冷启；Hub 使用包解析后的生产产物，不继承旧 harness 的源码启动。 */
export default defineConfig({
  ...base,
  projects: [{ name: 'p1-306', testMatch: /run-micro\.spec\.ts/ }],
  // 本链自行生成字段白名单证据；原始网络 trace 会收录 Setup/Cookie，禁止归档。
  use: { ...base.use, trace: 'off' },
  webServer: {
    ...(base.webServer as object),
    command: 'node --import tsx scripts/e2e-serve.mts --built-hub',
  },
})
