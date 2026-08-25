import { defineConfig } from 'vitest/config'

// Vitest 4 已移除 vitest.workspace.ts，projects 改为在根配置 test.projects 声明。
// 三个 project：unit（默认全量 spec）、integration（P1-04 起落地，真实 PostgreSQL）、
// dsh-contract（P1-11 起落地）。integration/dsh-contract 目前空跑，命令带 --passWithNoTests。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'scripts/**/*.spec.ts',
            'apps/*/tests/**/*.spec.ts',
            'packages/*/tests/**/*.spec.ts',
          ],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/tests/integration/**',
            '**/tests/dsh-contract/**',
          ],
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'apps/*/tests/integration/**/*.spec.ts',
            'packages/*/tests/integration/**/*.spec.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
      {
        test: {
          name: 'dsh-contract',
          include: ['packages/runtime-dsh/tests/dsh-contract/**/*.spec.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
    ],
  },
})
