import { randomBytes, randomUUID } from 'node:crypto'
import type { Actor } from '@project311/domain'
import { asUserId } from '@project311/domain'
import { Outbox } from '@project311/db'
import type { Database, DbHandle } from '@project311/db'
import { schema } from '@project311/db'
import type { FakeDeviceGatewayOptions } from '@project311/testkit'
import { FakeClock, FakeDeviceGateway } from '@project311/testkit'
import type { CreateRunInput, RunOrchestrator } from '../src/modules/run/index.js'
import { RunOrchestrator as Orchestrator } from '../src/modules/run/index.js'
import { OutboxWorker } from '../src/modules/run/index.js'
// 复用 packages/db 的集成测试基建（迁移应用、清库、FK 链 seed），不重新发明。
export {
  createTestDatabase,
  resetDatabase,
  seedRunPrereqs,
} from '../../packages/db/tests/helpers.js'
import type { SeedIds } from '../../packages/db/tests/helpers.js'

/** 与仓库 DSH 基线一致（dsh.lock.json；07-资料与版本基线.md）。 */
export const TEST_DSH_VERSION = '0.1.0-rc.8'

export function makeActor(userId: string, role: Actor['role'] = 'owner'): Actor {
  return { userId: asUserId(userId), role }
}

/** 第二个用户 + 其 Device/Workspace，用于越权守卫用例（bobWorkspaceInput → FORBIDDEN）。 */
export async function seedSecondUserDevice(handle: DbHandle, ids: SeedIds) {
  const userId = randomUUID()
  const deviceId = randomUUID()
  const workspaceId = randomUUID()
  const suffix = randomUUID().slice(0, 8)
  await handle.insert(schema.userAccounts).values({
    id: userId,
    username: `user2-${suffix}`,
    displayName: 'Second User',
    passwordHash: '$argon2id$placeholder$placeholder',
  })
  await handle.insert(schema.teamMembers).values({ teamId: ids.teamId, userId, role: 'member' })
  await handle.insert(schema.devices).values({
    id: deviceId,
    ownerUserId: userId,
    name: `dev2-${suffix}`,
    platform: 'linux',
    architecture: 'x64',
    nodeVersion: '24.12.0',
    nodeAppVersion: '0.1.0',
    tokenHash: randomBytes(32),
    capabilities: {},
  })
  await handle.insert(schema.workspaces).values({
    id: workspaceId,
    deviceId,
    ownerUserId: userId,
    name: `ws2-${suffix}`,
    kind: 'directory',
    capabilities: { read: true, write: true },
    available: true,
  })
  return { userId, deviceId, workspaceId }
}

export function makeCreateInput(ids: SeedIds, overrides: Partial<CreateRunInput> = {}) {
  return {
    idempotencyKey: randomUUID(),
    agentId: ids.agentId,
    deviceId: ids.deviceId,
    workspaceId: ids.workspaceId,
    prompt: 'implement the task',
    dshDistributionVersion: TEST_DSH_VERSION,
    ...overrides,
  } satisfies CreateRunInput
}

export interface Harness {
  clock: FakeClock
  outbox: Outbox
  gateway: FakeDeviceGateway
  orchestrator: RunOrchestrator
  worker: OutboxWorker
  /** run.start 的合法设备身份（ingest 的 device 参数）。 */
  deviceFor(ids: SeedIds): { deviceId: string; ownerUserId: string }
  /** worker 派发一轮，并把 Fake Node 的上行帧喂回 orchestrator（模拟一次完整往返）。 */
  pump(ids: SeedIds): Promise<void>
}

export function makeHarness(
  database: Database,
  gatewayOptions: FakeDeviceGatewayOptions = {},
): Harness {
  const clock = new FakeClock(new Date('2026-08-25T00:00:00.000Z'))
  const now = () => clock.now()
  const outbox = new Outbox(database, { now, random: () => 0 })
  const gateway = new FakeDeviceGateway({ now, ...gatewayOptions })
  const orchestrator = new Orchestrator({ database, outbox, now })
  const worker = new OutboxWorker({ outbox, gateway, now })
  return {
    clock,
    outbox,
    gateway,
    orchestrator,
    worker,
    deviceFor: (ids) => ({ deviceId: ids.deviceId, ownerUserId: ids.userId }),
    pump: async (ids) => {
      await worker.dispatchOnce()
      for (const frame of gateway.drainUpstream()) {
        await orchestrator.ingestNodeEvent(
          { deviceId: ids.deviceId, ownerUserId: ids.userId },
          frame,
        )
      }
    },
  }
}

let messageSeq = 0

/** 构造 Node 上行 run.event 帧（unknown：ingest 侧走 fail-closed 解析，与真实 WS 一致）。 */
export function runEventFrame(
  runId: string,
  seq: number,
  event: Record<string, unknown>,
  audience: 'owner' | 'project' | 'admin' = 'project',
): unknown {
  messageSeq += 1
  return {
    protocolVersion: 1,
    messageId: `10000000-0000-4000-8000-${String(messageSeq).padStart(12, '0')}`,
    sentAt: new Date().toISOString(),
    type: 'run.event',
    payload: { runId, seq, occurredAt: new Date().toISOString(), audience, event },
  }
}

export function heartbeatFrame(deviceId: string, activeRunIds: string[] = []): unknown {
  messageSeq += 1
  return {
    protocolVersion: 1,
    messageId: `10000000-0000-4000-8000-${String(messageSeq).padStart(12, '0')}`,
    sentAt: new Date().toISOString(),
    type: 'node.heartbeat',
    payload: { deviceId, activeRunIds, lastEventSeqByRun: {} },
  }
}
