import { defineConfig } from 'vitest/config'

// Vitest 4 已移除 vitest.workspace.ts，projects 改为在根配置 test.projects 声明。
// 五个 project：unit（默认全量 spec）、integration（P1-04 落地：packages/db，真实
// PostgreSQL 由根 test:integration 经 scripts/with-test-postgres.mts 提供）、
// dsh-contract（P1-11 落地：runtime-dsh 十项探针 + apps/runtime stdio 探针；boot
// 是重活，超时统一放宽到 120s）、web（P1-07 落地：apps/web 组件测试，jsdom 环境；
// root 指向 apps/web，让 vitest 从该目录解析 jsdom/testing-library，避免污染
// unit 项目——unit 的 include 只匹配 *.spec.ts，web 的 *.spec.tsx 不会混入）、
// resilience（P1-16 落地 Q6 故障门：R4/R5/R9 与 G7 需要故障注入的用例——断连计时、
// 强杀、进程退出走真人路径探针；DB 依赖用例经根 test:resilience 的
// scripts/with-test-postgres.mts 提供一次性 PostgreSQL，文件串行防 TRUNCATE 互踩）。
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
            '**/tests/e2e/**',
            '**/tests/resilience/**',
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
            // P1-18：六原语 harness 自证（scripts/lib/phase1 的绿链/断层判定）。
            'scripts/tests/**/*.integration.spec.ts',
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
      {
        // P1-07：apps/web 组件测试。项目 root 收缩到 apps/web：include/setupFiles
        // 相对项目 root 解析，jsdom 也由该目录的 node_modules 解析（vitest 按项目
        // config.root 解析环境模块）。注意 root 相对「运行时的 cwd」解析，因此
        // apps/web 的 test 脚本先 cd 回仓库根（见 apps/web/package.json）。
        test: {
          name: 'web',
          root: 'apps/web',
          include: ['tests/**/*.spec.tsx'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'jsdom',
          setupFiles: ['tests/setup.ts'],
        },
      },
      {
        // P1-16：Q6 故障门（pnpm test:resilience）。故障注入走真人路径探针：
        // 真实子进程 spawn/信号/退出、FakeClock 推进租约时间、真实 reconcileLeases；
        // 不做接口背后的暗手。含 DB 的用例（Hub 租约）经 with-test-postgres 包装，
        // 与 integration 同样串行；真实进程用例放宽超时。
        test: {
          name: 'resilience',
          include: [
            'apps/*/tests/resilience/**/*.spec.ts',
            'packages/*/tests/resilience/**/*.spec.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
