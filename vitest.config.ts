import { defineConfig } from 'vitest/config'

// Vitest 4 已移除 vitest.workspace.ts，projects 改为在根配置 test.projects 声明。
// 三个 project：unit（默认全量 spec）、integration（P1-04 落地：packages/db，真实
// PostgreSQL 由根 test:integration 经 scripts/with-test-postgres.mts 提供）、
// dsh-contract（P1-11 落地：runtime-dsh 十项探针 + apps/runtime stdio 探针；boot
// 是重活，超时统一放宽到 120s）。
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
            '**/*.integration.spec.ts',
          ],
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'apps/*/tests/integration/**/*.spec.ts',
            'packages/*/tests/integration/**/*.spec.ts',
            'apps/*/tests/**/*.integration.spec.ts',
            'packages/*/tests/**/*.integration.spec.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
          // 所有 integration spec 共享同一个临时 PostgreSQL（scripts/with-test-postgres.mts）：
          // 串行执行文件，避免并发 TRUNCATE 互踩。
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'dsh-contract',
          include: [
            'packages/runtime-dsh/tests/dsh-contract/**/*.spec.ts',
            'apps/*/tests/dsh-contract/**/*.spec.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
