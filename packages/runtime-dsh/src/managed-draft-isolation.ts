/** Source worker launcher. Only a trusted managed host may choose these paths. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshAnchorPath } from './dsh-distribution.js'

const require = createRequire(import.meta.url)

export interface ManagedDraftProcessRoots {
  readonly workerEntry: string
  readonly sourceFile: string
  readonly outputDir: string
}

const unavailable = () => new Error('managed_draft_isolation_unavailable')

function within(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

function runtimeRoots(workerEntry: string): string[] {
  const files = [
    workerEntry,
    fileURLToPath(import.meta.url),
    require.resolve('@whalepod/protocol'),
    dshAnchorPath(),
  ]
  const roots = new Set<string>()
  for (const file of files) {
    const path = realpathSync(file)
    const marker = '/node_modules/'
    const index = path.indexOf(marker)
    roots.add(index < 0 ? dirname(dirname(path)) : path.slice(0, index + marker.length - 1))
  }
  return [...roots]
}

/**
 * macOS only until another platform passes the same kernel checks. Seatbelt
 * constrains this worker, not another ordinary process with the same UID. A
 * managed deployment also needs a private service account/release and must
 * never co-locate private roots with an ordinary Run's writable workspace.
 */
export function spawnManagedDraftProcess(
  roots: ManagedDraftProcessRoots,
  args: readonly string[],
): ChildProcessWithoutNullStreams {
  if (process.platform !== 'darwin') throw unavailable()
  if (
    ![roots.workerEntry, roots.sourceFile, roots.outputDir].every(isAbsolute) ||
    !lstatSync(roots.sourceFile).isFile() ||
    !lstatSync(roots.outputDir).isDirectory() ||
    readdirSync(roots.outputDir).length !== 0
  )
    throw unavailable()

  const node = realpathSync(process.execPath)
  const output = realpathSync(roots.outputDir)
  const source = realpathSync(roots.sourceFile)
  const code = runtimeRoots(roots.workerEntry)
  if (within(output, source) || code.some((root) => within(root, output) || within(root, source)))
    throw unavailable()

  const parameters = [
    `NODE=${node}`,
    `OUTPUT=${output}`,
    `SOURCE=${source}`,
    ...code.map((root, index) => `CODE${index}=${root}`),
  ]
  const profile = `(version 1)
(allow default)
(deny network*)
(deny process-fork)
(deny process-exec (require-not (literal (param "NODE"))))
(deny file-read-data (require-not (require-any
  (literal (param "NODE")) (literal (param "SOURCE")) (subpath (param "OUTPUT"))
  (subpath "/System/Library") (subpath "/usr/lib")
  (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/")
  ${code.map((_, index) => `(subpath (param "CODE${index}"))`).join(' ')}
)))
(deny file-write* (require-not (subpath (param "OUTPUT"))))
`
  return spawn(
    '/usr/bin/sandbox-exec',
    [
      ...parameters.flatMap((parameter) => ['-D', parameter]),
      '-p',
      profile,
      node,
      '--no-addons',
      ...args,
    ],
    { env: {}, cwd: output, stdio: ['pipe', 'pipe', 'pipe'] },
  )
}

function denied(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')
  )
}

async function hostFileDenied(): Promise<boolean> {
  try {
    const handle = await open('/etc/hosts', 'r')
    await handle.close()
    return false
  } catch (error) {
    return denied(error)
  }
}

function loopbackDenied(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port: 9 })
    const done = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    socket.once('error', (error) => done(denied(error)))
    socket.once('connect', () => done(false))
    socket.setTimeout(750, () => done(false))
  })
}

/** Defense in depth against invoking the private binary outside the managed launcher. */
export async function assertManagedDraftProcessIsolation(): Promise<void> {
  if (
    process.platform !== 'darwin' ||
    !(
      await Promise.all([hostFileDenied(), loopbackDenied('127.0.0.1'), loopbackDenied('::1')])
    ).every(Boolean)
  )
    throw unavailable()
}
