import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProductionAcceptance } from './production-acceptance.js'

/** Baseline for the RD-04a production driver: two ordinary Task comment surfaces. */
export async function setupRd04aFixture(env: ProductionAcceptance) {
  await env.start()
  assert(env.providerOrigin, 'RD-04a fixture requires a loopback model responder')
  const colleague = await env.inviteMember('discovery-colleague')
  const project = await env.api<{ id: string }>('/projects', {
    name: 'RD-04a event accessibility',
  })
  await env.cli([
    'workspace',
    'add',
    env.workspaceDir,
    '--name',
    'discovery-acceptance',
    '--state-dir',
    env.stateDir,
  ])
  await env.cli([
    'coordination',
    'configure',
    '--state-dir',
    env.stateDir,
    '--owner-user-id',
    env.owner.userId,
    '--billing-user-id',
    env.owner.userId,
    '--provider',
    'replay',
    '--model',
    'discovery-replay',
    '--slot',
    'acceptance',
    '--endpoint',
    `${env.providerOrigin}/chat/completions`,
  ])
  await env.cli(
    ['coordination', 'secret', 'set', 'replay', 'acceptance', '--state-dir', env.stateDir],
    randomBytes(24).toString('base64url') + '\n',
  )
  const { configRevision } = JSON.parse(
    await readFile(join(env.stateDir, 'coordination.json'), 'utf8'),
  ) as { configRevision: string }
  env.startNode()
  await env.waitCoordinationInventory()
  await env.api(`/projects/${project.id}/router/config`, {
    enabled: true,
    deviceId: env.deviceId,
    operatorUserId: env.owner.userId,
    billingUserId: env.owner.userId,
    credentialSlot: 'acceptance',
    credentialConfigRevision: configRevision,
    provider: 'replay',
    model: 'discovery-replay',
    teamDailyCallLimit: 10,
    projectDailyCallLimit: 10,
    teamDailyTokenLimit: 100_000,
    projectDailyTokenLimit: 100_000,
    teamDailyCostMicrosLimit: 10_000,
    projectDailyCostMicrosLimit: 10_000,
    maxInputTokens: 32_000,
    maxOutputTokens: 512,
    maxCostMicros: 100,
    inputPriceMicrosPerMillionTokens: 1,
    outputPriceMicrosPerMillionTokens: 1,
    timeoutSeconds: 20,
    maxRetries: 0,
  })
  const pack = (await env.api<{ id: string; name: string }[]>('/plugin-packs')).find(
    (row) => row.name === 'core-empty',
  )
  assert(pack, 'real team setup must provision the core-empty plugin pack')
  const agent = await env.api<{ id: string }>('/agents', {
    name: 'Existing venue planner',
    persona: 'Plan accessible seating at the venue.',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    credentialSlot: 'acceptance',
    pluginPackId: pack.id,
    maxTokens: 2048,
  })
  const task = await env.api<{ id: string }>(`/projects/${project.id}/tasks`, {
    title: 'Accessible seating at the venue',
    assigneeUserId: env.owner.userId,
  })
  await env.api(`/tasks/${task.id}/accept`, {})
  const agreement = await env.api<{ draftVersion: number }>(`/tasks/${task.id}/agreement/draft`, {
    content: {
      goal: 'Confirm accessible seats and aisle width at the venue.',
      constraints: 'The survey found that the rail station has no step-free route to the venue.',
      acceptance: 'Venue layout checked; transport and shuttle planning are outside this task.',
      openQuestions: 'None for the seating plan.',
    },
  })
  await env.api(`/tasks/${task.id}/agreement/confirm`, { draftVersion: agreement.draftVersion })
  const work = await env.api<{ workKey: string }>(`/tasks/${task.id}/works`, {
    goal: 'Maintain the venue seating plan',
  })
  await env.api(`/works/${work.workKey}/mandates`, {
    autoDispatch: 'off',
    allowedAgentIds: [agent.id],
    allowedToolNames: ['write'],
    allowedActionClasses: ['draft'],
    allowedSourceTypes: ['task_message'],
    maxRunsPerWork: 1,
    maxAttempts: 1,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  })
  const subscription = await env.api<{ id: string }>(`/works/${work.workKey}/subscriptions`, {
    targetType: 'task',
    targetRef: task.id,
  })
  const discussion = await env.api<{ id: string }>(`/projects/${project.id}/tasks`, {
    title: 'Planning discussion',
    assigneeUserId: env.owner.userId,
  })
  return { project, task, work, subscription, discussion, colleague }
}
