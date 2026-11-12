/**
 * RD-04c2 still uses the real DSH session, agent loop and filesystem tool.
 * It cannot load the ordinary provider/settings/plugins: those could send a
 * frozen source outside the loopback gate before c3 exists.
 */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { dshAnchorUrl } from './dsh-distribution.js'

const profile = fileURLToPath(new URL('../config/cordis.yml', import.meta.url))
const TOKEN_ENV = 'WHALEPOD_DISCOVERY_REPLAY_TOKEN'
const denied = () => new Error('discovery execution authorization unavailable')

function replayGate(): { origin: URL; token: string } {
  const origin = new URL(process.env.WHALEPOD_DISCOVERY_REPLAY_ORIGIN ?? '')
  const token = process.env[TOKEN_ENV]
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !origin.port ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    token === undefined ||
    !/^[A-Za-z0-9_-]{43}$/.test(token)
  )
    throw denied()
  return { origin, token }
}

export async function authorizeDiscoveryRuntime(stage: 'tool' | 'read'): Promise<void> {
  try {
    const { origin, token } = replayGate()
    const response = await fetch(new URL(`/authorize/${stage}`, origin), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 204) return
    await response.body?.cancel()
  } catch {
    // Never expose transport details, source content, or the local token.
  }
  throw denied()
}

export function bootDiscoveryReplayDsh(workspacePath: string): Promise<Context> {
  const { origin } = replayGate()
  return boot(
    'whalepod-runtime',
    profile,
    [
      {
        insert: [
          { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' },
          { id: 'llm', name: '@deepseek-ai/dsh-llm' },
          { id: 'session', name: '@deepseek-ai/dsh-session' },
          { id: 'agent', name: '@deepseek-ai/dsh-agent' },
          { id: 'tools', name: '@deepseek-ai/dsh-tools' },
          { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: { persona: '' } },
          { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
          {
            id: 'sandbox-policy',
            name: '@deepseek-ai/dsh-sandbox-policy',
            config: { mode: 'workspace-write', workspaceRoot: workspacePath },
          },
          { id: 'fs-sandbox', name: '@deepseek-ai/dsh-fs-sandbox' },
          { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
          {
            id: 'llm-deepseek',
            name: '@deepseek-ai/dsh-llm-deepseek',
            config: {
              baseURL: origin.origin,
              apiKeyEnv: TOKEN_ENV,
              retryPolicy: { mode: 'normal', maxRetries: 0 },
            },
          },
        ],
      },
    ],
    undefined,
    dshAnchorUrl(),
  )
}
