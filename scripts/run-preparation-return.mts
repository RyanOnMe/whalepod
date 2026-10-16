import { spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const resultPath = join(root, 'artifacts/evidence/preparation-return/result.json')
// Before even Playwright configuration, webServer plugins or browser fixtures can fail.
await rm(resultPath, { force: true })
const configuration = process.argv[2] ?? 'playwright.config.ts'
const drive = spawnSync(
  'pnpm',
  ['exec', 'playwright', 'test', '--config', configuration, '--project', 'p1-315'],
  {
    cwd: root,
    stdio: 'inherit',
  },
)
process.exitCode = drive.status ?? 2
