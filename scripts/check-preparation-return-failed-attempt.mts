import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyPreparationReturnEvidence } from './lib/preparation-return-evidence.js'

// Start with genuine successful production evidence. Never restore it after a failed attempt.
const root = fileURLToPath(new URL('../', import.meta.url))
const resultPath = join(root, 'artifacts/evidence/preparation-return/result.json')
const output = join(root, 'artifacts/evidence/preparation-return-failed-attempt')
const temporary = await mkdtemp(join(tmpdir(), 'whalepod-preparation-failure-'))
interface ReportSuite {
  suites?: ReportSuite[]
  specs?: { tests: { results: { status: string; errors?: { message?: string }[] }[] }[] }[]
}
function results(suite: ReportSuite): { status: string; errors?: { message?: string }[] }[] {
  return [
    ...(suite.specs ?? []).flatMap((spec) => spec.tests.flatMap((test) => test.results)),
    ...(suite.suites ?? []).flatMap(results),
  ]
}
try {
  await rm(join(output, 'result.json'), { force: true })
  const previous = JSON.parse(await readFile(resultPath, 'utf8')) as unknown
  if (verifyPreparationReturnEvidence(previous).verdict !== 'PASS')
    throw new Error('run the successful production preparation scenario first')
  const reportPath = join(temporary, 'report.json')
  const configPath = join(temporary, 'failure.config.mts')
  // A refused browser entry is a real failed run of the same driver, before setup/commands.
  // No Hub, Node or user development service is started for this negative control.
  await writeFile(
    configPath,
    `import base from ${JSON.stringify(pathToFileURL(join(root, 'playwright.operations.config.ts')).href)}
export default { ...base,
  testDir: ${JSON.stringify(join(root, 'apps/web/tests/e2e'))},
  webServer: undefined, retries: 0,
  use: { ...base.use, baseURL: 'http://127.0.0.1:0', trace: 'off', screenshot: 'off', video: 'off' },
  outputDir: ${JSON.stringify(join(temporary, 'output'))},
  reporter: [['json', { outputFile: ${JSON.stringify(reportPath)} }]],
}
`,
  )
  const drive = spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', '--config', configPath, '--project', 'p1-315'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    },
  )
  if (drive.error) throw new Error('negative browser drive did not complete')
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as ReportSuite
  const attempts = results(report)
  const failedAtNavigation =
    attempts.length === 1 &&
    attempts[0]?.status === 'failed' &&
    attempts[0].errors?.some((error) => error.message?.includes('page.goto:')) === true
  if (drive.status === 0 || !failedAtNavigation)
    throw new Error('negative control must reach the actual driver and fail at browser navigation')
  let fileAbsent = false
  try {
    await readFile(resultPath)
  } catch (error) {
    fileAbsent = (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  const verify = spawnSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/verify-preparation-return-evidence.mts', resultPath],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    },
  )
  const verdict = JSON.parse(verify.stdout) as { verdict?: string }
  const passed = fileAbsent && verify.status === 2 && verdict.verdict === 'FAIL'
  const observation = {
    component: 'web.preparation.return.failed-attempt',
    previousProductionEvidenceValid: true,
    driverReachedEntryAndFailed: failedAtNavigation,
    driverExit: drive.status,
    previousResultRemoved: fileAbsent,
    verifierExit: verify.status,
    verifierVerdict: verdict.verdict,
    verdict: passed ? 'PASS' : 'FAIL',
  }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'result.json'), `${JSON.stringify(observation, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(observation)}\n`)
  process.exitCode = passed ? 0 : 2
} catch {
  // Keep paths, raw driver payloads and credentials out of diagnostics.
  const observation = {
    component: 'web.preparation.return.failed-attempt',
    verdict: 'FAIL',
    reason: 'control not completed; require prior valid evidence and an available browser',
  }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'result.json'), `${JSON.stringify(observation, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(observation)}\n`)
  process.exitCode = 2
} finally {
  await rm(temporary, { recursive: true, force: true })
}
