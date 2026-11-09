/**
 * RD-03c3a component proof with pinned DSH. The recording transport represents
 * the broker boundary. This does not certify the production worker, OS
 * isolation, broker-to-provider egress, or the Hub authorization fence.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import {
  bootManagedDraftDshCore,
  type ManagedDraftModelRequest,
} from '../../src/managed-draft-model.js'

const route = { provider: 'managed-draft', model: 'fixed-model', maxTokens: 256 }
const source = 'registered-source-probe'
const toolName = 'read_registered_source'
const message = createUserMessage({
  content: [{ type: 'text', text: 'read the registered source' }],
  source: { kind: 'user' },
})

describe('RD-03c3a pinned DSH model port', () => {
  it('sends the tool continuation through the same sole adapter with a new attempt', async () => {
    const calls: ManagedDraftModelRequest[] = []
    const cwd = await mkdtemp(join(tmpdir(), 'whalepod-managed-draft-probe-'))
    const sessionId = SessionId(randomUUID())
    const ctx = await bootManagedDraftDshCore({ ...route, sessionId }, async function* (request) {
      calls.push(request)
      if (calls.length === 1) {
        const id = CallId('registered-source-read')
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: toolName, argumentsDelta: '{}' }
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id, name: toolName, arguments: '{}' },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    try {
      expect(ctx.llm.listProviders().map((provider) => provider.id)).toEqual([route.provider])
      expect(ctx.llm.listConfigurableProviders()).toEqual([])
      expect(ctx.get('credentials')).toBeUndefined()
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd },
        agentOptions: route,
        setup(agentCtx) {
          agentCtx.tools.register(
            defineTool({
              name: toolName,
              description: 'Read the sole registered source.',
              parameters: {},
              output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: value }],
              },
              async execute() {
                return source
              },
            }),
          )
        },
      })
      try {
        handle.agent.followup(message)
        await handle.agent.whenIdle()
        expect(calls).toHaveLength(2)
        expect(new Set(calls.map((request) => request.attemptId)).size).toBe(2)
        expect(calls.map((request) => request.sessionId)).toEqual([sessionId, sessionId])
        expect(calls.map((request) => request.tools.map((tool) => tool.name))).toEqual([
          [toolName],
          [toolName],
        ])
        expect(JSON.stringify(calls[0]?.messages)).not.toContain(source)
        expect(JSON.stringify(calls[1]?.messages)).toContain(source)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('refuses foreign routes, auxiliary purposes and cancelled requests without invoking transport', async () => {
    const calls: ManagedDraftModelRequest[] = []
    const sessionId = SessionId(randomUUID())
    const ctx = await bootManagedDraftDshCore({ ...route, sessionId }, async function* (request) {
      calls.push(request)
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const base = { provider: route.provider, model: route.model, messages: [message], sessionId }
    const signal = AbortSignal.abort()
    try {
      for (const override of [
        { provider: 'deepseek-official' },
        { model: 'unapproved-model' },
        { sessionId: SessionId(randomUUID()) },
        { purpose: 'compaction' as const },
        { purpose: 'session-title' as const },
        { signal },
        { maxTokens: -1 },
        { maxTokens: NaN },
      ]) {
        const chunks: StreamChunk[] = []
        for await (const chunk of ctx.llm.stream({ ...base, ...override })) chunks.push(chunk)
        expect(chunks).not.toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
      }
      expect(calls).toEqual([])
      for await (const _ of ctx.llm.stream({ ...base, maxTokens: 4_096 })) {
        // Drain the sole approved transport.
      }
      expect(calls).toHaveLength(1)
      expect(calls[0]?.maxTokens).toBe(route.maxTokens)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sanitizes transport failures and gives an explicit reattempt a fresh identity', async () => {
    const calls: ManagedDraftModelRequest[] = []
    const sessionId = SessionId(randomUUID())
    const ctx = await bootManagedDraftDshCore({ ...route, sessionId }, async function* (request) {
      calls.push(request)
      if (calls.length === 1) throw new Error(source)
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const request = { provider: route.provider, model: route.model, messages: [message], sessionId }
    const drain = async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk)
      return chunks
    }
    try {
      expect(ctx.llm.providerRetryPolicy(route.provider)).toMatchObject({ maxRetries: 0 })
      const failed = await drain()
      expect(failed).toContainEqual({
        type: 'finish',
        reason: {
          kind: 'error',
          failure: expect.objectContaining({ code: 'MANAGED_MODEL_UNAVAILABLE' }),
        },
      })
      expect(JSON.stringify(failed)).not.toContain(source)
      expect(calls).toHaveLength(1)
      expect(await drain()).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(calls).toHaveLength(2)
      expect(calls[1]?.attemptId).not.toBe(calls[0]?.attemptId)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
