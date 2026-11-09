/** Synthetic historical evidence via a separate, loopback-only Executor; never substitutes for Router. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { schema } from '@whalepod/db'
import { eq } from 'drizzle-orm'
import { until, type ProductionAcceptance } from './production-acceptance.js'
import { digest } from './router-quality.js'

const slot = 'quality-historical-fixture'
const provider = 'deepseek-official'
const model = 'deepseek-v4-flash'
const relativePath = 'out/prior-outcome.md'

async function serveFixture(request: IncomingMessage, response: ServerResponse) {
  assert.equal(request.method, 'POST')
  assert.equal(request.url, '/chat/completions')
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString()) as {
    stream: boolean
    messages: { role: string }[]
    tools?: { function: { name: string } }[]
  }
  assert.equal(body.stream, true)
  const toolResults = body.messages.filter((item) => item.role === 'tool')
  assert(toolResults.length <= 1)
  const finish = toolResults.length === 0 ? 'tool_calls' : 'stop'
  if (finish === 'tool_calls')
    assert(body.tools?.some((item) => item.function.name === 'publish_artifact'))
  const delta =
    finish === 'stop'
      ? { role: 'assistant', content: 'Synthetic historical outcome submitted as a candidate.' }
      : {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'quality-fixture-candidate',
              type: 'function',
              function: {
                name: 'publish_artifact',
                arguments: JSON.stringify({
                  relativePath,
                  title: 'Prior outcome',
                  mediaType: 'text/markdown',
                }),
              },
            },
          ],
        }
  const frames = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
  ]
  response
    .writeHead(200, { 'content-type': 'text/event-stream' })
    .end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n')
}

export function fixtureProvider(request: IncomingMessage, response: ServerResponse) {
  void serveFixture(request, response).catch(() =>
    response.writeHead(400).end('historical fixture request rejected'),
  )
}

export async function configureFixtureExecutor(h: ProductionAcceptance) {
  assert(h.providerOrigin, 'loopback-only Executor fixture endpoint missing')
  await h.cli([
    'workspace',
    'add',
    h.workspaceDir,
    '--name',
    'Router quality historical evidence',
    '--state-dir',
    h.stateDir,
  ])
  await h.cli(
    ['secret', 'set', provider, slot, '--state-dir', h.stateDir],
    `${randomBytes(24).toString('base64url')}\n`,
  )
  h.startNode(h.providerOrigin)
  const workspace = await until('fixture workspace registered by production Node', async () => {
    const rows = await h.api<{ workspaceId: string; name: string }[]>('/workspaces')
    return rows.find((row) => row.name === 'Router quality historical evidence')
  })
  const packs = await h.api<{ id: string; name: string }[]>('/plugin-packs')
  const pack = packs.find((item) => item.name === 'core-empty')
  assert(pack, 'production Setup did not create the core-empty pack')
  const agent = await h.api<{ id: string }>('/agents', {
    name: 'Historical evidence fixture',
    persona: 'Attach a synthetic pre-existing outcome for owner review.',
    provider,
    model,
    credentialSlot: slot,
    pluginPackId: pack.id,
  })
  return { workspaceId: workspace.workspaceId, agentId: agent.id }
}

export async function makePublishedFixture(
  h: ProductionAcceptance,
  executor: Awaited<ReturnType<typeof configureFixtureExecutor>>,
  taskId: string,
  body: string,
): Promise<string> {
  await mkdir(join(h.workspaceDir, 'out'), { recursive: true })
  await writeFile(join(h.workspaceDir, relativePath), body, { mode: 0o600 })
  const run = await h.api<{ id: string }>(
    `/tasks/${taskId}/runs`,
    {
      agentId: executor.agentId,
      workspaceId: executor.workspaceId,
      deviceId: h.deviceId,
      prompt: 'Submit the pre-existing outcome to the owner for review.',
    },
    { expected: 201 },
  )
  const approval = await until('fixture publish_artifact approval', async () => {
    const [row] = await h.database.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.runId, run.id))
    return row
  })
  assert.equal(approval.toolName, 'publish_artifact')
  await h.api(`/approvals/${approval.id}/decisions`, { decision: 'allowed_once' })
  const artifact = await until('fixture candidate uploaded by production Node', async () => {
    const [row] = await h.database.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.runId, run.id))
    return row
  })
  assert.equal(artifact.status, 'candidate')
  assert.equal(artifact.sha256, digest(body))
  await h.api(`/artifacts/${artifact.id}/publish`, {})
  await until('fixture run completed', async () => {
    const [row] = await h.database.db.select().from(schema.runs).where(eq(schema.runs.id, run.id))
    assert(
      !row || !['failed', 'cancelled', 'lost'].includes(row.status),
      'historical fixture Run did not complete',
    )
    return row?.status === 'completed' ? row.id : undefined
  })
  return artifact.id
}
