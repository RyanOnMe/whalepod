/**
 * P1-18 六原语 harness —— 取证（evidence）原语。
 *
 * phase1-evidence 的本体：把一次 drive 采集（attempt 目录）整理成 04 §9
 * Evidence 包——manifest.json（commit/版本/时间/逐文件摘要）+ README + 可选
 * 按 runId 过滤的收缩包；出包前必过 scripts/secret-scan.sh，命中即拒收
 * （删包、非零退出）。密钥、/tmp 与证据包三相斥：包只落在仓库
 * artifacts/evidence/（gitignore）下。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import type { DriveMeta } from './drive.js'
import type { VerifyVerdict } from './verify.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

export interface EvidenceManifest {
  traceId: string
  attemptId: string
  scenario: string
  fault: string
  runIds: string[]
  gitCommit: string
  dshVersion: string
  protocolVersion: number
  platform: string
  nodeVersion: string
  browserLayer: string
  replayFixtureSeed: string
  startedAt: string
  endedAt: string
  verdict: string
  files: Array<{ file: string; sha256: string; bytes: number }>
}

function sha256File(path: string): { sha256: string; bytes: number } {
  const buf = readFileSync(path)
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.byteLength }
}

/** 仓库内 evidence 根目录（gitignore：artifacts/evidence/）。 */
export function evidenceRoot(): string {
  return join(REPO_ROOT, 'artifacts', 'evidence')
}

/** 默认取 artifacts/evidence 下最近一次有 meta.json 的 attempt 目录。 */
export function latestAttemptDir(): string | undefined {
  const root = evidenceRoot()
  if (!existsSync(root)) return undefined
  const candidates: Array<{ dir: string; mtimeMs: number }> = []
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) scan(full)
      else if (entry.name === 'meta.json') candidates.push({ dir, mtimeMs: 0 })
    }
  }
  scan(root)
  // readdirSync 无 mtime；用目录名排序兜底（attemptId 含 UTC 时间戳，字典序即时间序）。
  const dirs = [...new Set(candidates.map((c) => c.dir))].sort()
  return dirs[dirs.length - 1]
}

export interface PackageOptions {
  /** drive 的 attempt 目录（含 meta.json）。 */
  attemptDir: string
  /** 收缩包：只保留与该 run 相关的证据（新目录，不动原包）。 */
  runId?: string
}

export interface PackageResult {
  packageDir: string
  manifest: EvidenceManifest
  secretScanPassed: boolean
}

/**
 * 出包：复制证据文件（--run 时收缩过滤）→ manifest + README → secret-scan。
 * 扫描命中：删除整个包目录并抛错（命中即拒，绝不带毒出包）。
 */
export async function packageEvidence(options: PackageOptions): Promise<PackageResult> {
  const { attemptDir, runId } = options
  const meta = JSON.parse(readFileSync(join(attemptDir, 'meta.json'), 'utf8')) as DriveMeta
  const packageDir =
    runId === undefined
      ? join(dirname(attemptDir), `${basename(attemptDir)}-package`)
      : join(dirname(attemptDir), `${basename(attemptDir)}-run-${runId.slice(0, 8)}`)
  mkdirSync(packageDir, { recursive: true })

  const FILES = [
    'meta.json',
    'events.jsonl',
    'layer-facts.jsonl',
    'node-events.jsonl',
    'runtime-summary.jsonl',
    'browser-alice.jsonl',
    'browser-bob.jsonl',
    'db-snapshot.json',
    'index.json',
    'assertions.json',
  ] as const

  // --run 收缩只作用于 run 作用域的 JSONL 流；其余 JSON/JSONL 原样入包
  // （layer-facts/runtime-summary 是层级事实不按 run 切，index/assertions 原样）。
  const RUN_SCOPED_JSONL = new Set([
    'events.jsonl',
    'node-events.jsonl',
    'browser-alice.jsonl',
    'browser-bob.jsonl',
  ])
  const filterByRun = (file: string, content: string): string => {
    if (runId === undefined || !RUN_SCOPED_JSONL.has(file)) return content
    // 逐行保含 runId 的行（events/node 帧与 browser 帧的 runId 形态不同，
    // 统一用「文本含 runId」过滤——runId 是 UUID，误配概率为零）。
    if (content === '') return content
    const lines = content.split('\n').filter((line) => line.trim() === '' || line.includes(runId))
    return `${lines.join('\n')}\n`
  }

  const copied: string[] = []
  for (const file of FILES) {
    const src = join(attemptDir, file)
    if (!existsSync(src)) continue
    const raw = readFileSync(src, 'utf8')
    writeFileSync(join(packageDir, file), filterByRun(file, raw))
    copied.push(file)
  }
  for (const file of copied) {
    if (file === 'db-snapshot.json' && runId !== undefined) {
      // 结构化快照按 run 收缩（JSON 非 JSONL）。
      const snapshot = JSON.parse(readFileSync(join(packageDir, file), 'utf8')) as Record<
        string,
        unknown
      >
      const filtered: Record<string, unknown> = { ...snapshot }
      for (const key of ['runs', 'runEvents', 'approvals', 'artifacts', 'artifactBlobs']) {
        const rows = snapshot[key]
        if (Array.isArray(rows)) {
          filtered[key] = rows.filter((row) => JSON.stringify(row).includes(runId))
        }
      }
      for (const key of ['outbox']) {
        const rows = snapshot[key]
        if (Array.isArray(rows)) {
          filtered[key] = rows.filter(
            (row) =>
              JSON.stringify(row).includes(runId) ||
              JSON.stringify(row).includes('approval.decide'),
          )
        }
      }
      filtered['runIds'] = [runId]
      filtered['filteredByRun'] = runId
      writeFileSync(join(packageDir, file), `${JSON.stringify(filtered, null, 2)}\n`)
    }
  }

  const verdict = existsSync(join(attemptDir, 'assertions.json'))
    ? (JSON.parse(readFileSync(join(attemptDir, 'assertions.json'), 'utf8')) as VerifyVerdict)
    : undefined

  const files = copied.map((file) => ({ file, ...sha256File(join(packageDir, file)) }))
  const manifest: EvidenceManifest = {
    traceId: meta.traceId,
    attemptId: meta.attemptId,
    scenario: meta.scenario,
    fault: meta.fault,
    runIds: runId === undefined ? meta.runIds : [runId],
    gitCommit: meta.gitCommit,
    dshVersion: meta.dshVersion,
    protocolVersion: meta.protocolVersion,
    platform: meta.platform,
    nodeVersion: meta.nodeVersion,
    browserLayer: 'ws 双客户端（P1-19 之前的 Browser 层真身）',
    replayFixtureSeed: meta.scenario,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    verdict: verdict === undefined ? 'verify-not-run' : verdict.pass ? 'PASS' : 'FAIL',
    files,
  }
  writeFileSync(join(packageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const readme = [
    `# phase1 evidence — ${meta.scenario}/${meta.attemptId}`,
    '',
    `- traceId: \`${meta.traceId}\`（跨层索引键，见 index.json）`,
    `- scenario/fault: ${meta.scenario} / ${meta.fault}`,
    `- commit: ${meta.gitCommit} · DSH ${meta.dshVersion} · protocol v${meta.protocolVersion}`,
    `- verdict: ${manifest.verdict}${verdict?.attribution === undefined ? '' : `（归因 ${verdict.attribution.layer}）`}`,
    '',
    '## 文件',
    '',
    ...files.map((f) => `- \`${f.file}\`（${f.bytes}B, sha256 ${f.sha256.slice(0, 12)}…）`),
    '',
    '## 纪律',
    '',
    '- 本包出包前已过 `scripts/secret-scan.sh`；命中即拒收。',
    '- runtime 层只有帧型与字节长度（runtime-summary.jsonl）；文本面全部经过 Node 投影脱敏。',
    '- 复跑：`pnpm phase1:drive -- --scenario ' +
      meta.scenario +
      '` → `pnpm phase1:verify -- --evidence <dir>`。',
  ].join('\n')
  writeFileSync(join(packageDir, 'README.md'), `${readme}\n`)

  // secret-scan 是包的一部分（Q7）：命中（非零退出）即删包拒收。
  let scanPassed = true
  try {
    execFileSync(join(REPO_ROOT, 'scripts', 'secret-scan.sh'), [packageDir], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    })
  } catch {
    scanPassed = false
  }
  if (!scanPassed) {
    rmDirForce(packageDir)
    throw new Error(`secret-scan 命中，证据包已拒收删除：${packageDir}`)
  }
  return { packageDir, manifest, secretScanPassed: true }
}

function rmDirForce(dir: string): void {
  execFileSync('rm', ['-rf', dir])
}
