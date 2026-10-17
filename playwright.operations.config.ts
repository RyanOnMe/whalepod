import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

// 独立端口/临时目录，避免占用真人正在使用的开发服务；关闭含会话秘密的网络 trace。
process.env['WHALEPOD_E2E_OPERATIONS'] = '1'
export default defineConfig({
  ...base,
  projects: [...(base.projects ?? []), { name: 'p1-306', testMatch: /run-micro\.spec\.ts/ }],
  use: { ...base.use, baseURL: 'http://localhost:5313', trace: 'off' },
  webServer: {
    ...(base.webServer as object),
    url: 'http://localhost:5313/',
    // command 继承 base（#281：包解析 dist 产物 + 装配前增量 build，无 --built-hub 开关）。
    env: { WHALEPOD_E2E_OPERATIONS: '1' },
  },
})
