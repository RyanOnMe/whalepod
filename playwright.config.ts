import { defineConfig } from '@playwright/test'

/**
 * E2E（Q5 种子；P1-07 验收场景先行落地）。
 *
 * testDir 必须显式圈定，否则 playwright 的默认 testMatch 会抓走 vitest 的
 * spec 文件（scripts、各包 tests 目录下同后缀的文件）。
 *
 * 环境生命周期：webServer 直接拉起 scripts/e2e-serve.mts：本进程是 playwright 的直接子进程
 *（SIGTERM 可达，容器清理可保证），内部经 scripts/lib/ephemeral-postgres.mts
 * 启动一次性 PG（随机端口随机密码）、应用迁移、以生产入口 server.ts 拉起真实
 * Hub、再拉起 vite dev（5173，/api/v1 与 /ws/v1 同源反代）。浏览器只见 5173 一个
 * origin，与生产同源部署同形（03 §4）。
 */
export default defineConfig({
  testDir: 'apps/web/tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  // 一个 Hub 实例只容一个团队（Setup 一次性，产品约束）——不同 spec 文件必须
  // 各占一套环境。Q5（pnpm test:e2e）据此拆成按项目两次串行调用，每次 webServer
  // 全新冷启；--project 过滤见根 package.json。
  projects: [
    { name: 'p1-07', testMatch: /task-room\.spec\.ts/ },
    { name: 'p1-19', testMatch: /full-chain\.spec\.ts/ },
    // #140：实时观察用例独立成套——判据是「对端零操作」，与既有两条「显式
    // reload 驱动」的用例口径相反；混在一起旁路会重新长回来。
    { name: 'p1-140', testMatch: /realtime-observation\.spec\.ts/ },
    // #141：邀请链真人路径（Owner 生成链接 → 新浏览器加入）——单 Hub 只容一个团队，
    // 所以它必须独占一套冷启环境（p1-07 的团队已被自身 Setup 占用）。
    { name: 'p1-141', testMatch: /invite-accept\.spec\.ts/ },
  ],
  use: {
    baseURL: 'http://localhost:5173',
    // 用系统 Chrome（channel）而非 Playwright 自带 Chromium：首次浏览器下载
    // 依赖境外 CDN，本机网络下不可靠；真 Chrome 也是真人同一条路径。
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: {
    // 单进程直启（不走 pnpm exec/tsx cli 包装）：playwright 的信号直达 e2e-serve，
    // 不留孤儿孙进程——它们会占住 18080/5173 并污染后续运行的端口与 env 文件。
    command: 'node --import tsx scripts/e2e-serve.mts',
    url: 'http://localhost:5173/',
    reuseExistingServer: false,
    timeout: 180_000,
    // 先 SIGTERM 让 e2e-serve 清理容器与子进程；宽限后 playwright 才升级 SIGKILL。
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
