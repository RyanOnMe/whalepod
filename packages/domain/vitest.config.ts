import { defineConfig } from 'vitest/config'

// 领域包自己的单测入口（02-第一阶段实施计划.md Task 2 Step 2/6）：
// `pnpm --filter @project311/domain test[:coverage]`。根 vitest.config.ts 不动；
// Q1 门要求状态机与权限分支覆盖率不低于 95%，阈值固化在这里。
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        branches: 95,
        lines: 95,
        functions: 95,
        statements: 95,
      },
    },
  },
})
