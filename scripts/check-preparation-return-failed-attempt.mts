import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyPreparationReturnEvidence } from './lib/preparation-return-evidence.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const resultPath = join(root, 'artifacts/evidence/preparation-return/result.json')
const output = join(root, 'artifacts/evidence/preparation-return-failed-attempt')
const temporary = await mkdtemp(join(tmpdir(), 'whalepod-preparation-failure-'))
interface ReportSuite {
  errors?: { message?: string }[]
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
  // Optional archived successful evidence is only a stale fixture, never a new positive result.
  const previous = await readFile(process.argv[2] ?? resultPath, 'utf8')
  if (verifyPreparationReturnEvidence(JSON.parse(previous) as unknown).verdict !== 'PASS')
    throw new Error('require genuine previous successful production evidence')
  const observations = []
  for (const stage of ['browser-navigation', 'server-startup'] as const) {
    // Re-seed the old success deliberately for each independent failure stage.
    await mkdir(join(root, 'artifacts/evidence/preparation-return'), { recursive: true })
    await writeFile(resultPath, previous)
    const reportPath = join(temporary, `${stage}.json`)
    const configPath = join(temporary, `${stage}.config.mts`)
    const server =
      stage === 'browser-navigation'
        ? 'undefined'
        : JSON.stringify({
            command: 'node -e "process.exit(42)"',
            url: 'http://127.0.0.1:0',
            reuseExistingServer: false,
            timeout: 5000,
          })
    await writeFile(
      configPath,
      `import base from ${JSON.stringify(pathToFileURL(join(root, 'playwright.operations.config.ts')).href)}
export default { ...base,
  testDir: ${JSON.stringify(join(root, 'apps/web/tests/e2e'))},
  webServer: ${server}, retries: 0,
  use: { ...base.use, baseURL: 'http://127.0.0.1:0', trace: 'off', screenshot: 'off', video: 'off' },
  outputDir: ${JSON.stringify(join(temporary, 'output'))},
  reporter: [['json', { outputFile: ${JSON.stringify(reportPath)} }]],
}
`,
    )
    // Same official entry for production and faults; cleanup must precede Playwright/webServer.
    const drive = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/run-preparation-return.mts', configPath],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
      },
    )
    if (drive.error) throw new Error('negative browser drive did not complete')
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as ReportSuite
    const attempts = results(report)
    const reachedExpectedFailure =
      stage === 'browser-navigation'
        ? attempts.length === 1 &&
          attempts[0]?.status === 'failed' &&
          attempts[0].errors?.some((error) => error.message?.includes('page.goto:')) === true
        : attempts.length === 0 &&
          report.errors?.some(
            (error) => error.message?.includes('config.webServer') && error.message.includes('42'),
          ) === true
    if (drive.status === 0 || !reachedExpectedFailure)
      throw new Error('fault did not reach its specified production-driver stage')
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
    observations.push({
      stage,
      seededOldSuccess: true,
      driverFailedAtExpectedStage: reachedExpectedFailure,
      driverExit: drive.status,
      previousResultRemoved: fileAbsent,
      verifierExit: verify.status,
      verifierVerdict: verdict.verdict,
      verdict: fileAbsent && verify.status === 2 && verdict.verdict === 'FAIL' ? 'PASS' : 'FAIL',
    })
  }
  const passed = observations.every((entry) => entry.verdict === 'PASS')
  const observation = {
    component: 'web.preparation.return.failed-attempt',
    previousProductionEvidenceValid: true,
    cases: observations,
    verdict: passed ? 'PASS' : 'FAIL',
  }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'result.json'), `${JSON.stringify(observation, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(observation)}\n`)
  process.exitCode = passed ? 0 : 2
} catch {
  const observation = {
    component: 'web.preparation.return.failed-attempt',
    verdict: 'FAIL',
    reason:
      'control not completed; require prior valid evidence and the expected driver failure stages',
  }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'result.json'), `${JSON.stringify(observation, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(observation)}\n`)
  process.exitCode = 2
} finally {
  // No deliberately seeded old success may survive the negative control, even if it fails.
  await rm(resultPath, { force: true })
  await rm(temporary, { recursive: true, force: true })
}
