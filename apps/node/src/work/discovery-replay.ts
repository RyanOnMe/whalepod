/**
 * RD-04c2 local replay broker. A new task's frozen sources may never reach an
 * ordinary provider before the c3 egress budget guard exists. The caller uses
 * one per-Run, loopback-only connection with no real provider credentials.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdtemp, realpath } from 'node:fs/promises'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { basename, dirname, join } from 'node:path'
import type { DiscoveryExecutionExecutor } from '@whalepod/protocol'
import {
  createDiscoveryLiveModelPort,
  sameDiscoveryLiveExecutor,
  type DiscoveryLiveOptions,
  type DiscoveryModelHubPort,
} from './discovery-live-model.js'

const MAX_REQUEST_BYTES = 512 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_CALLS = 24
const TIMEOUT_MS = 30_000
const CHAT_PATH = '/chat/completions'
const WORKSPACE_PREFIX = 'discovery-workspace-'

export interface DiscoveryReplayGate {
  readonly origin: string
  readonly token: string
  readonly authorizeCandidate: () => Promise<boolean>
  readonly close: () => void
}

/** Persisted cleanup owns this Run home; nothing is written in a registered workspace. */
export async function prepareDiscoveryReplayDirectories(
  homePath: string,
): Promise<{ workspacePath: string; inputPath: string }> {
  const home = await realpath(homePath)
  if (!(await lstat(homePath)).isDirectory()) throw new Error('discovery run home unavailable')
  await chmod(home, 0o700)
  return {
    workspacePath: await mkdtemp(join(home, WORKSPACE_PREFIX)),
    inputPath: await mkdtemp(join(home, 'discovery-inputs-')),
  }
}

export async function verifyDiscoveryReplayWorkspace(
  homePath: string,
  workspacePath: string,
): Promise<string> {
  const [home, workspace, metadata] = await Promise.all([
    realpath(homePath),
    realpath(workspacePath),
    lstat(workspacePath),
  ])
  if (
    workspace !== workspacePath ||
    dirname(workspace) !== home ||
    !basename(workspace).startsWith(WORKSPACE_PREFIX) ||
    !metadata.isDirectory() ||
    (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)
  )
    throw new Error('discovery workspace is not a private Run directory')
  return workspace
}

export function discoveryReplayEndpoint(value: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== CHAT_PATH
  ) {
    throw new Error('discovery replay requires a fixed HTTP loopback endpoint')
  }
  return url
}

interface DiscoveryGateChecks {
  readonly authorize: (signal: AbortSignal) => Promise<boolean>
  readonly observe?: (stage: 'read' | 'tool' | 'model' | 'candidate', allowed: boolean) => void
}

export async function startDiscoveryReplayGate(
  input: DiscoveryGateChecks & {
    readonly endpoint: string
    readonly model: string
  },
): Promise<DiscoveryReplayGate> {
  const endpoint = discoveryReplayEndpoint(input.endpoint)
  return startDiscoveryLoopbackGate({
    ...input,
    async forward(payload, signal, res) {
      // Never send the local capability or a device token to the replay fixture.
      const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = httpRequest(
          endpoint,
          {
            method: 'POST',
            agent: false,
            headers: {
              'content-type': 'application/json',
              'content-length': payload.byteLength,
            },
            signal,
          },
          resolve,
        )
        request.once('error', reject)
        request.end(payload)
      })
      const type = upstream.headers['content-type']
      if (upstream.statusCode !== 200 || typeof type !== 'string') {
        upstream.destroy()
        res.writeHead(503).end()
        return
      }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      let resultBytes = 0
      try {
        for await (const raw of upstream) {
          const chunk = Buffer.from(raw)
          resultBytes += chunk.byteLength
          if (resultBytes > MAX_RESPONSE_BYTES) throw new Error('replay response too large')
          res.write(chunk)
        }
        res.end()
      } finally {
        upstream.destroy()
      }
    },
  })
}

type LiveObserver = Parameters<typeof createDiscoveryLiveModelPort>[2]

export async function startDiscoveryLiveGate(
  input: DiscoveryGateChecks & {
    readonly options: DiscoveryLiveOptions
    readonly executor: DiscoveryExecutionExecutor
    readonly hub: DiscoveryModelHubPort
    readonly observeLive?: LiveObserver
  },
): Promise<DiscoveryReplayGate> {
  if (!sameDiscoveryLiveExecutor(input.options.executor, input.executor))
    throw new Error('discovery live executor does not match local policy')
  const port = createDiscoveryLiveModelPort(input.options, input.hub, input.observeLive)
  return startDiscoveryLoopbackGate({
    ...input,
    model: input.executor.model,
    authorize: async (signal) => !port.isBlocked() && input.authorize(signal),
    mayUpload: port.mayUpload,
    async forward(payload, signal, res) {
      const body = await port.request(payload, signal)
      res
        .writeHead(200, {
          'content-type': 'text/event-stream',
          'content-length': body.byteLength,
          'cache-control': 'no-store',
        })
        .end(body)
    },
  })
}

async function startDiscoveryLoopbackGate(
  input: DiscoveryGateChecks & {
    readonly model: string
    readonly mayUpload?: () => boolean
    readonly forward: (
      bytes: Buffer,
      signal: AbortSignal,
      response: ServerResponse,
    ) => Promise<void>
  },
): Promise<DiscoveryReplayGate> {
  const token = randomBytes(32).toString('base64url')
  const expectedAuth = Buffer.from(`Bearer ${token}`)
  const lifetime = new AbortController()
  let attempted = 0
  const authorize = async (
    stage: 'read' | 'tool' | 'model' | 'candidate',
    signal: AbortSignal,
  ): Promise<boolean> => {
    const allowed =
      !signal.aborted && (await input.authorize(signal).catch(() => false)) && !signal.aborted
    input.observe?.(stage, allowed)
    return allowed
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (res.headersSent) res.destroy()
      else res.writeHead(503).end()
    })
  })
  server.requestTimeout = TIMEOUT_MS
  server.headersTimeout = TIMEOUT_MS

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = Buffer.from(req.headers.authorization ?? '')
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
      res.writeHead(404).end()
      return
    }
    const requestClosed = new AbortController()
    res.once('close', () => requestClosed.abort())
    const signal = AbortSignal.any([
      lifetime.signal,
      requestClosed.signal,
      AbortSignal.timeout(TIMEOUT_MS),
    ])
    const checkStage =
      req.url === '/authorize/read' ? 'read' : req.url === '/authorize/tool' ? 'tool' : undefined
    if (req.method === 'GET' && checkStage !== undefined) {
      res.writeHead((await authorize(checkStage, signal)) ? 204 : 403).end()
      return
    }
    if (req.method !== 'POST' || req.url !== CHAT_PATH || attempted >= MAX_CALLS) {
      res.writeHead(404).end()
      return
    }
    attempted++
    const onAbort = () => req.destroy()
    signal.addEventListener('abort', onAbort, { once: true })
    let byteSize = 0
    const chunks: Buffer[] = []
    try {
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk)
        byteSize += bytes.byteLength
        if (byteSize > MAX_REQUEST_BYTES) {
          res.writeHead(413).end()
          return
        }
        chunks.push(bytes)
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    const payload = Buffer.concat(chunks, byteSize)
    const decoded = JSON.parse(payload.toString('utf8')) as { model?: unknown } | null
    if (decoded?.model !== input.model || !(await authorize('model', signal))) {
      res.writeHead(403).end()
      return
    }
    await input.forward(payload, signal, res)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('discovery replay broker unavailable')
  }
  server.unref()
  return {
    origin: `http://127.0.0.1:${address.port}`,
    token,
    authorizeCandidate: async () =>
      (input.mayUpload?.() ?? true) &&
      authorize('candidate', AbortSignal.any([lifetime.signal, AbortSignal.timeout(TIMEOUT_MS)])),
    close: () => {
      lifetime.abort()
      server.close()
      server.closeAllConnections()
    },
  }
}
