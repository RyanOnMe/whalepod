/** Packaged managed source worker, a real file sandbox, and a broker-side replay. */
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { describe, expect, it, vi } from 'vitest'
import { MANAGED_DRAFT_OUTPUT_NAME } from '@whalepod/protocol'
import {
  prepareManagedDraftCollector,
  spawnManagedDraftProcess,
} from '@whalepod/runtime-dsh/managed-draft'
import {
  createManagedDraftModelBroker,
  type ManagedDraftEgressAuthorization,
} from '@whalepod/runtime-dsh/managed-draft-broker'

const require = createRequire(import.meta.url)
const workerEntry = require.resolve('@whalepod/runtime/managed-draft-worker')
const source = 'private-source-fixture'
const output = 'fixed-draft-fixture'

function macSandboxAvailable(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    execFileSync(
      '/usr/bin/sandbox-exec',
      ['-p', '(version 1)(allow default)(deny network*)', '/usr/bin/true'],
      { stdio: 'ignore' },
    )
    return true
  } catch {
    return false
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'whalepod-managed-draft-contract-'))
  const sourceFile = join(root, 'input.txt')
  const forbiddenFile = join(root, 'old.txt')
  const outputDir = join(root, 'output')
  await Promise.all([
    writeFile(sourceFile, source),
    writeFile(forbiddenFile, 'old-workspace-fixture'),
    mkdir(outputDir, { mode: 0o700 }),
  ])
  return {
    root,
    sourceFile,
    forbiddenFile,
    outputDir,
    workerEntry,
    runId: randomUUID(),
    manifestDigest: 'a'.repeat(64),
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    sourceByteSize: Buffer.byteLength(source),
  }
}

async function drive(
  f: Awaited<ReturnType<typeof fixture>>,
  child: ReturnType<typeof spawnManagedDraftProcess>,
  options: {
    wrongSource?: boolean
    wrongAttempt?: boolean
    request?: (runId: string, request: unknown) => Promise<string>
  } = {},
) {
  const { runId, manifestDigest, sourceSha256, sourceByteSize } = f
  let modelAttemptId: string | undefined
  const lines = createInterface({ input: child.stdout })
  const messages: unknown[] = []
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  )
  try {
    child.stderr.resume()
    child.stdin.write(
      JSON.stringify({
        kind: 'initialize',
        runId,
        model: 'fixed-model',
        manifestDigest,
        sha256: options.wrongSource ? '0'.repeat(64) : sourceSha256,
        byteSize: sourceByteSize,
      }) + '\n',
    )
    for await (const line of lines) {
      const frame = JSON.parse(line)
      messages.push(frame)
      if (frame.kind === 'model.request') {
        modelAttemptId = frame.request.attemptId
        expect(frame.request.model).toBe('fixed-model')
        expect(frame.request.messages[0].content).toEqual([{ type: 'text', text: source }])
        expect(frame.request).not.toHaveProperty('endpoint')
        expect(frame.request).not.toHaveProperty('apiKey')
        child.stdin.end(
          JSON.stringify({
            kind: 'model.response',
            attemptId: options.wrongAttempt ? randomUUID() : frame.request.attemptId,
            text:
              options.request === undefined ? output : await options.request(runId, frame.request),
          }) + '\n',
        )
      }
    }
    const exit = await exited
    return { status: exit.code, exit, messages, runId, modelAttemptId }
  } finally {
    child.kill()
    lines.close()
  }
}

describe.skipIf(!macSandboxAvailable())('RD-03c3a packaged managed source worker', () => {
  it('reports kernel isolation before the trusted host populates the source file', async () => {
    const f = await fixture()
    try {
      const launchEntry = require.resolve('@whalepod/runtime/managed-draft-host')
      await rm(f.sourceFile)
      await writeFile(f.sourceFile, '', { mode: 0o600 })
      const child = spawn(process.execPath, [launchEntry, f.sourceFile, f.outputDir], {
        env: {},
        cwd: f.root,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
      child.stderr.resume()
      const lines = createInterface({ input: child.stdout })
      const iterator = lines[Symbol.asyncIterator]()
      const receive = async () => {
        const next = await iterator.next()
        if (next.done) throw new Error('managed worker exited before the expected frame')
        return JSON.parse(next.value)
      }
      try {
        expect(await receive()).toEqual({ kind: 'isolation.ready' })
        expect((await readFile(f.sourceFile)).byteLength).toBe(0)
        await writeFile(f.sourceFile, source)
        child.stdin.write(
          JSON.stringify({
            kind: 'initialize',
            runId: f.runId,
            model: 'fixed-model',
            manifestDigest: f.manifestDigest,
            sha256: f.sourceSha256,
            byteSize: f.sourceByteSize,
          }) + '\n',
        )
        const model = await receive()
        expect(model).toMatchObject({ kind: 'model.request', runId: f.runId })
        child.stdin.end(
          JSON.stringify({
            kind: 'model.response',
            attemptId: model.request.attemptId,
            text: output,
          }) + '\n',
        )
        expect(await receive()).toMatchObject({
          kind: 'candidate',
          modelAttemptId: model.request.attemptId,
        })
        expect((await iterator.next()).done).toBe(true)
        expect(await exited).toBe(0)
      } finally {
        child.kill()
        lines.close()
        await exited
      }
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('reads fixed bytes and writes the candidate only after a response bound to its broker request', async () => {
    const f = await fixture()
    const posts: Buffer[] = []
    const targets: { method: string | undefined; url: string | undefined }[] = []
    const admissions: ManagedDraftEgressAuthorization[] = []
    const provider = createServer(async (request, reply) => {
      targets.push({ method: request.method, url: request.url })
      const body: Buffer[] = []
      for await (const bytes of request) body.push(Buffer.from(bytes))
      posts.push(Buffer.concat(body))
      reply.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: output } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      )
    })
    try {
      await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
      const address = provider.address()
      if (address === null || typeof address === 'string')
        throw new Error('missing fixture endpoint')
      const collector = prepareManagedDraftCollector(f)
      const child = spawnManagedDraftProcess(f, [workerEntry, f.sourceFile])
      const { status, exit, messages, runId, modelAttemptId } = await drive(f, child, {
        request: async (boundRunId, request) => {
          const broker = createManagedDraftModelBroker(
            {
              runId: boundRunId,
              provider: 'fixture-provider',
              model: 'fixed-model',
              endpoint: `http://127.0.0.1:${address.port}/draft-model`,
              accountId: 'fixture-account',
              policyVersion: '1',
              manifestDigest: f.manifestDigest,
              sourceSha256: f.sourceSha256,
              sourceByteSize: f.sourceByteSize,
            },
            'fixture-credential',
            async (admission) => {
              expect(posts).toEqual([])
              admissions.push(admission)
              return { ...admission, decisionId: randomUUID() }
            },
          )
          return (await broker.request(request)).text
        },
      })
      expect(status).toBe(0)
      expect(posts).toHaveLength(1)
      expect(targets).toEqual([{ method: 'POST', url: '/draft-model' }])
      expect(admissions).toHaveLength(1)
      expect(admissions[0]?.payloadSha256).toBe(
        createHash('sha256').update(posts[0]!).digest('hex'),
      )
      expect(messages).toHaveLength(2)
      expect(messages[1]).toMatchObject({
        kind: 'candidate',
        runId,
        manifestDigest: f.manifestDigest,
        modelAttemptId,
        sha256: createHash('sha256').update(output).digest('hex'),
        byteSize: Buffer.byteLength(output),
      })
      const collected = await collector.collect(messages[1], exit, modelAttemptId)
      expect(collected).toMatchObject({
        runId,
        manifestDigest: f.manifestDigest,
        modelAttemptId,
        mediaType: 'text/plain',
        body: Buffer.from(output),
      })
      expect(collected.fileWriteReceiptId).toMatch(/^[a-f0-9-]+$/)
      await expect(collector.collect(messages[1], exit, modelAttemptId)).rejects.toThrow(
        'managed_draft_output_rejected',
      )
      expect(await readFile(join(f.outputDir, MANAGED_DRAFT_OUTPUT_NAME), 'utf8')).toBe(output)
    } finally {
      await new Promise<void>((resolve) => provider.close(() => resolve()))
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it.each([
    { label: 'mismatched source digest', wrongSource: true, requests: 0 },
    { label: 'mismatched broker attempt', wrongAttempt: true, requests: 1 },
  ])('rejects $label without registering a draft', async ({ requests, ...options }) => {
    const f = await fixture()
    try {
      const child = spawnManagedDraftProcess(f, [workerEntry, f.sourceFile])
      const { status, messages } = await drive(f, child, options)
      expect(status).toBe(1)
      expect(messages).toHaveLength(requests)
      expect(messages.every((frame) => (frame as { kind: string }).kind === 'model.request')).toBe(
        true,
      )
      await expect(readFile(join(f.outputDir, MANAGED_DRAFT_OUTPUT_NAME))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('rejects the same initialization when the worker was launched without the policy', async () => {
    const f = await fixture()
    try {
      const child = spawn(process.execPath, [workerEntry, f.sourceFile], {
        cwd: f.outputDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const { status, messages } = await drive(f, child)
      expect(status).toBe(1)
      expect(messages).toEqual([])
      await expect(readFile(join(f.outputDir, MANAGED_DRAFT_OUTPUT_NAME))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it.each([
    'failed-exit',
    'wrong-run',
    'wrong-digest',
    'oversize',
    'symlink',
    'hardlink',
    'replaced-file',
  ] as const)('rejects %s at private output collection', async (kind) => {
    const f = await fixture()
    try {
      const collector = prepareManagedDraftCollector(f)
      const child = spawnManagedDraftProcess(f, [workerEntry, f.sourceFile])
      const { exit, messages, modelAttemptId } = await drive(f, child)
      expect(exit.code).toBe(0)
      const receipt = messages[1] as Record<string, unknown>
      const path = join(f.outputDir, MANAGED_DRAFT_OUTPUT_NAME)
      if (kind === 'wrong-run') receipt['runId'] = randomUUID()
      if (kind === 'wrong-digest') receipt['sha256'] = '0'.repeat(64)
      if (kind === 'oversize') receipt['byteSize'] = 65_537
      if (kind === 'hardlink') await link(path, join(f.outputDir, 'hardlink'))
      if (kind === 'symlink' || kind === 'replaced-file') {
        await rm(path)
        if (kind === 'symlink') await symlink(f.forbiddenFile, path)
        else await writeFile(path, output, { mode: 0o600 })
      }
      const code = kind === 'failed-exit' ? 1 : exit.code
      await expect(collector.collect(receipt, { ...exit, code }, modelAttemptId)).rejects.toThrow(
        'managed_draft_output_rejected',
      )
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('does not prepare a collector over an old output directory', async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.outputDir, MANAGED_DRAFT_OUTPUT_NAME), output, { mode: 0o600 })
      expect(() => prepareManagedDraftCollector(f)).toThrow('managed_draft_output_rejected')
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('blocks direct sockets and old file reads and writes using the same launch policy', async () => {
    const f = await fixture()
    vi.stubEnv('WHALEPOD_DEVICE_TOKEN', 'device-secret-fixture')
    vi.stubEnv('HTTPS_PROXY', 'proxy-fixture')
    const child = spawnManagedDraftProcess(f, [
      '-e',
      `const fs = require('node:fs'); const net = require('node:net');
       const file = process.argv[1];
       const attempt = (fn) => { try { fn(); return 'allowed'; } catch (e) { return e.code; } };
       const read = attempt(() => fs.readFileSync(file));
       const write = attempt(() => fs.writeFileSync(file, 'escape'));
       const hardlink = attempt(() => { fs.linkSync(file, 'escape-hardlink'); fs.readFileSync('escape-hardlink'); });
       const symlink = attempt(() => { fs.symlinkSync(file, 'escape-symlink'); fs.readFileSync('escape-symlink'); });
       const socket = net.connect(9, '127.0.0.1');
       socket.on('error', (error) => console.log(JSON.stringify([
         read, write, hardlink, symlink, error.code,
         process.env.WHALEPOD_DEVICE_TOKEN === undefined && process.env.HTTPS_PROXY === undefined
       ])));
       socket.on('connect', () => process.exit(2));`,
      f.forbiddenFile,
    ])
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
    try {
      child.stderr.resume()
      child.stdin.end()
      const lines = createInterface({ input: child.stdout })
      const facts: unknown[] = []
      for await (const line of lines) facts.push(JSON.parse(line))
      expect(await exited).toBe(0)
      expect(facts).toEqual([['EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', true]])
      expect(await readFile(f.forbiddenFile, 'utf8')).toBe('old-workspace-fixture')
    } finally {
      child.kill()
      vi.unstubAllEnvs()
      await rm(f.root, { recursive: true, force: true })
    }
  })
})
