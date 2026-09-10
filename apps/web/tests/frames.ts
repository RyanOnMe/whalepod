/**
 * P1-08 Web 实时单测共享帧构造器（纯 node，非 spec 文件，不会被 unit glob 收集）。
 */
import { PROTOCOL_VERSION } from '@whalepod/protocol'
import type { ClientFrame } from '@whalepod/protocol'

export const OCCURRED_AT = '2026-08-25T00:00:00.000Z'

export type PersistentClientFrame = Extract<ClientFrame, { kind: 'persistent' }>

export function persistentFrame(
  type: string,
  payload: unknown,
  cursor = '7',
): PersistentClientFrame {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'persistent',
    cursor,
    occurredAt: OCCURRED_AT,
    event: { type, payload },
  } as unknown as PersistentClientFrame
}

export function liveFrame(
  runId = '10000000-0000-4000-8000-000000000001',
  text = 'hello',
): ClientFrame {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'live',
    runId,
    audience: 'owner',
    deltaSeq: 1,
    delta: { text },
  }
}

export function controlFrame(latestCursor = '99'): ClientFrame {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'control',
    type: 'resync.required',
    latestCursor,
  }
}
