/**
 * ADR-0029 source execution component. An explicit DSH core has one model
 * adapter and no credential, network, retry, compaction or extension plugins.
 * The adapter only prepares a call for an external broker; the broker must
 * authorize the actual endpoint/account and each attempt before network I/O.
 *
 * This component alone is not an isolation boundary. The source Run must
 * remain unavailable until a managed worker and the broker are wired and
 * verified through the real production entry point.
 */
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import {
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  type GenerateOptions,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { dshAnchorUrl } from './dsh-distribution.js'

interface ManagedDraftModelRoute {
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
  readonly sessionId: NonNullable<GenerateOptions['sessionId']>
}

/** Deliberately excludes endpoint, provider credentials and SDK retry configuration. */
export interface ManagedDraftModelRequest {
  readonly attemptId: string
  readonly sessionId: ManagedDraftModelRoute['sessionId']
  readonly model: string
  readonly maxTokens: number
  readonly system?: string
  readonly messages: Readonly<GenerateOptions['messages']>
  readonly tools: readonly ToolSchema[]
}

type ManagedDraftModelPort = (
  request: ManagedDraftModelRequest,
  signal: AbortSignal | undefined,
) => AsyncIterable<StreamChunk>

const noRetry = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'managedDraft.retryPolicy')
const unavailable = () => new LlmError('managed draft model request denied', 'MANAGED_MODEL_DENIED')
const transportFailure = () =>
  new LlmError('managed draft model transport failed', 'MANAGED_MODEL_UNAVAILABLE')

class ManagedDraftModelAdapter extends LlmAdapter {
  constructor(
    private readonly route: ManagedDraftModelRoute,
    private readonly port: ManagedDraftModelPort,
  ) {
    super()
  }

  override providerRetryPolicy() {
    return noRetry
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (
      options.provider !== this.route.provider ||
      options.model !== this.route.model ||
      options.sessionId !== this.route.sessionId ||
      options.purpose !== undefined ||
      options.signal?.aborted ||
      (options.maxTokens !== undefined &&
        (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0))
    ) {
      throw unavailable()
    }
    try {
      const maxTokens = Math.min(options.maxTokens ?? this.route.maxTokens, this.route.maxTokens)
      const request: ManagedDraftModelRequest = {
        attemptId: randomUUID(),
        sessionId: this.route.sessionId,
        model: this.route.model,
        maxTokens,
        messages: options.messages,
        tools: options.tools ?? [],
        ...(options.system === undefined ? {} : { system: options.system }),
      }
      for await (const chunk of this.port(request, options.signal)) {
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') throw transportFailure()
        yield chunk
      }
    } catch {
      // SDK/provider detail can contain source bytes; do not give it to DSH/logging.
      throw transportFailure()
    }
  }
}

const emptyProfile = fileURLToPath(new URL('../config/managed-draft.cordis.yml', import.meta.url))

/** Uses an allowlist, never the ordinary DSH base bundle and its providers or settings. */
export async function bootManagedDraftDshCore(
  route: ManagedDraftModelRoute,
  port: ManagedDraftModelPort,
): Promise<Context> {
  if (
    !route.provider ||
    !route.model ||
    !route.sessionId ||
    !Number.isSafeInteger(route.maxTokens) ||
    route.maxTokens <= 0
  ) {
    throw unavailable()
  }
  const ctx = await boot(
    'whalepod-runtime',
    emptyProfile,
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
        ],
      },
    ],
    undefined,
    dshAnchorUrl(),
  )
  try {
    if (ctx.llm.listProviders().length !== 0 || ctx.llm.listConfigurableProviders().length !== 0)
      throw unavailable()
    ctx.llm.registerAdapter([route.provider], new ManagedDraftModelAdapter({ ...route }, port))
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
