/** Content bindings for production acceptance evidence. No local paths are emitted. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { resolveHubServerEntry } from './phase1/hub-assembly.js'

export const sha256 = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex')
export const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export function productionPackageEntries(root: string) {
  const nodeAnchor = createRequire(join(root, 'apps/node/package.json'))
  return {
    hub: resolveHubServerEntry(join(root, 'apps/hub/package.json')),
    node: nodeAnchor.resolve('@whalepod/node/bin'),
    runtime: nodeAnchor.resolve('@whalepod/runtime/bin'),
  }
}

function localPath(root: string, path: string): string {
  const name = relative(root, path)
  assert(
    name && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name),
    'assembly package is outside workspace',
  )
  return name.split(sep).join('/')
}

const ignoredBuildFile = /(?:\.map|\.tsbuildinfo|\.d\.[cm]?ts|\.DS_Store)$/
async function listContent(root: string, dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.cache') continue
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) files.push(...(await listContent(root, path)))
    else if (!ignoredBuildFile.test(entry.name)) {
      assert(entry.isFile(), 'non-regular file in acceptance assembly')
      files.push(path)
    }
  }
  return files
}

export async function fingerprintAssemblyFiles(
  root: string,
  files: readonly string[],
  directories: readonly string[],
) {
  root = await realpath(root)
  const discovered = await Promise.all(
    directories.map(async (dir) => {
      const stat = await lstat(join(root, dir))
      assert(stat.isDirectory(), 'non-directory in acceptance assembly')
      const content = await listContent(root, dir)
      assert(content.length > 0, 'empty acceptance assembly directory')
      return content
    }),
  )
  const paths = [...new Set([...files, ...discovered.flat()])].sort()
  assert(paths.length > 0, 'empty acceptance assembly')
  const records = await Promise.all(
    paths.map(async (path) => {
      const file = join(root, path)
      assert.equal(
        localPath(root, await realpath(file)),
        path,
        'non-canonical acceptance assembly file',
      )
      return [path, sha256(await readFile(file))]
    }),
  )
  return sha256(JSON.stringify(records))
}

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

async function resolveManifest(entry: string, expected: string, root: string) {
  let dir = dirname(await realpath(entry))
  localPath(root, dir)
  while (dir !== root) {
    const path = join(dir, 'package.json')
    let data: PackageManifest | undefined
    try {
      data = JSON.parse(await readFile(path, 'utf8')) as PackageManifest
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (data?.name === expected) return { path, dir, data }
    dir = dirname(dir)
  }
  throw new Error(`acceptance package manifest missing: ${expected}`)
}

/** Follow the built entry points and internal runtime dependencies resolved from each package. */
export async function fingerprintProductionAssembly(root: string) {
  root = await realpath(root)
  const entry = productionPackageEntries(root)
  const pending = [
    ['@whalepod/hub', entry.hub],
    ['@whalepod/node', entry.node],
    ['@whalepod/runtime', entry.runtime],
  ] as [string, string][]
  const seen = new Map<string, string>()
  const files = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'dsh.lock.json',
    'tsconfig.base.json',
  ]
  const dirs: string[] = []
  while (pending.length) {
    const [name, resolved] = pending.pop()!
    const { path, dir, data } = await resolveManifest(resolved, name, root)
    const dirKey = localPath(root, dir)
    const prior = seen.get(name)
    if (prior !== undefined) {
      assert.equal(dirKey, prior, 'multiple builds resolved for one acceptance package')
      continue
    }
    seen.set(name, dirKey)
    files.push(localPath(root, path))
    dirs.push(`${dirKey}/dist`)
    if (name === '@whalepod/db') dirs.push(`${dirKey}/migrations`)
    if (name === '@whalepod/runtime-dsh') dirs.push(`${dirKey}/config`)
    const anchoredRequire = createRequire(path)
    for (const dependency of Object.keys({ ...data.dependencies, ...data.optionalDependencies })) {
      if (dependency.startsWith('@whalepod/'))
        pending.push([dependency, anchoredRequire.resolve(dependency)])
    }
  }
  for (const resolved of Object.values(entry)) files.push(localPath(root, await realpath(resolved)))
  return sha256(
    JSON.stringify({
      version: 1,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      contents: await fingerprintAssemblyFiles(root, files, dirs),
    }),
  )
}

export interface M1RAProvenance {
  assemblyDigest: string
  eventsDigest: string
}

export function bindM1RAProvenance(assemblyDigest: string, events: string | Buffer) {
  assert(isSha256(assemblyDigest), 'invalid M1R-A assembly digest')
  return { provenance: { assemblyDigest, eventsDigest: sha256(events) } }
}

export function verifyM1RAProvenance(
  result: { schemaVersion: number; provenance?: M1RAProvenance },
  events: string | Buffer,
  expectedAssemblyDigest?: string,
) {
  assert(result.schemaVersion === 1 || result.schemaVersion === 2, 'unsupported M1R-A evidence')
  if (expectedAssemblyDigest !== undefined)
    assert(result.schemaVersion === 2, 'legacy M1R-A evidence cannot authorize a real provider run')
  if (result.schemaVersion === 1 && result.provenance === undefined) return
  const provenance = result.provenance
  assert(provenance && isSha256(provenance.assemblyDigest), 'missing M1R-A assembly digest')
  assert(isSha256(provenance.eventsDigest), 'missing M1R-A event digest')
  assert.equal(provenance.eventsDigest, sha256(events), 'M1R-A event digest mismatch')
  if (expectedAssemblyDigest !== undefined)
    assert.equal(provenance.assemblyDigest, expectedAssemblyDigest, 'M1R-A assembly changed')
}

export const HOLDOUT_EVIDENCE = [
  'attempt.json',
  'result.json',
  'partial.json',
  'failure.json',
  'events.jsonl',
  'score.json',
] as const

export async function pathExists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function assertNoHoldoutEvidence(directory: string) {
  const existing = await Promise.all(
    HOLDOUT_EVIDENCE.map((name) => pathExists(join(directory, name))),
  )
  assert(
    !existing.some(Boolean),
    'canonical holdout already has evidence; preserve the completed or interrupted attempt',
  )
}

export interface HoldoutAttempt {
  schemaVersion: 1
  id: string
  startedAt: string
  freezeDigest: string
}

export async function reserveHoldoutAttempt(
  directory: string,
  freezeDigest: string,
  frozenAt: string,
  start = new Date(),
) {
  assert(isSha256(freezeDigest), 'invalid holdout freeze digest')
  assert(Date.parse(frozenAt) < start.getTime(), 'freeze must precede holdout start')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  assert((await lstat(directory)).isDirectory(), 'holdout output must be a real directory')
  await assertNoHoldoutEvidence(directory)
  const attempt: HoldoutAttempt = {
    schemaVersion: 1,
    id: randomUUID(),
    startedAt: start.toISOString(),
    freezeDigest,
  }
  const raw = `${JSON.stringify(attempt, null, 2)}\n`
  try {
    await writeFile(join(directory, 'attempt.json'), raw, { flag: 'wx', mode: 0o600, flush: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        'canonical holdout already has evidence; preserve the completed or interrupted attempt',
      )
    throw error
  }
  return { attempt, raw, digest: sha256(raw) }
}
