import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

/** #306 专用冷启。Hub 装配自 #281 起全局唯一（包解析 dist 产物），本链无需覆写 webServer。 */
export default defineConfig({
  ...base,
  projects: [{ name: 'p1-306', testMatch: /run-micro\.spec\.ts/ }],
  // 本链自行生成字段白名单证据；原始网络 trace 会收录 Setup/Cookie，禁止归档。
  use: { ...base.use, trace: 'off' },
})
