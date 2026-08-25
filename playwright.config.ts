import { defineConfig } from '@playwright/test'

// E2E 专用（P1-19 起落地）。testDir 必须显式圈定，否则 playwright 的默认
// testMatch 会抓走 vitest 的 *.spec.ts（scripts/、packages/*/tests/）。
export default defineConfig({
  testDir: 'apps/web/tests/e2e',
})
