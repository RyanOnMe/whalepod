/**
 * #381 两成员交接闭环的生产验收 runner（与 `run-create-to-recovery.mts` 同型）。
 *
 * 步骤与理由：
 *   1. 先删掉旧 result.json——**上一次的 PASS 不能替这一次背书**；
 *   2. 跑 p1-381 这支真装配 e2e（真 Hub/Node/Runtime + 两个成员浏览器）；
 *   3. Playwright 非正常收场（含配置/服务启动阶段就失败）时再删一次 result.json：
 *      凡在失败前写下的结果都不算一次成功尝试；
 *   4. 最后跑**独立判定器**（`verify-handoff-loop-evidence.mts`），把它的退出码作为本
 *      runner 的退出码——这样 `pnpm test:e2e` 的绿不再可能绕开独立判定。
 *
 * 判定器自己带负控（`scripts/lib/handoff-loop-evidence.spec.ts`，随 `pnpm check` 跑）。
 */
import { spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const resultPath = join(root, 'artifacts/evidence/handoff-loop/result.json')
const configuration = process.argv[2] ?? 'playwright.config.ts'

await rm(resultPath, { force: true })

const drive = spawnSync(
  'pnpm',
  ['exec', 'playwright', 'test', '--config', configuration, '--project', 'p1-381'],
  { cwd: root, stdio: 'inherit' },
)

// 失败（或信号/启动错误）前写下的结果一律失效：不留下一个看起来「验过」的文件。
if (drive.status !== 0 || drive.signal !== null || drive.error !== undefined) {
  await rm(resultPath, { force: true })
  process.exitCode = drive.status ?? 2
} else {
  const verify = spawnSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/verify-handoff-loop-evidence.mts',
      resultPath,
      ...(process.env['WHALEPOD_E2E_OFFICE_PREVIEW'] === '1' ? ['--office'] : []),
    ],
    { cwd: root, stdio: 'inherit' },
  )
  process.exitCode = verify.status ?? 2
}
