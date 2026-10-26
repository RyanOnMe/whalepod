import { defineConfig } from '@playwright/test'
import base from './playwright.operations.config.js'

// Only this lane selects the documented paced replay overlay. Real Hub/Node/Runtime
// assembly and isolated operations ports remain identical to the other Q5 lanes.
process.env['WHALEPOD_E2E_AGENT_MOTION'] = '1'
export default defineConfig({
  ...base,
  projects: [{ name: 'agent-brand', testMatch: /agent-brand\.spec\.ts/ }],
  use: {
    ...base.use,
    trace: 'off',
    launchOptions: { args: ['--no-proxy-server'] },
  },
  webServer: {
    ...(base.webServer as object),
    env: { WHALEPOD_E2E_OPERATIONS: '1', WHALEPOD_E2E_AGENT_MOTION: '1' },
  },
})
