import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
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
