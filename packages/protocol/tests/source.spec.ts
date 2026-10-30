import { describe, expect, it } from 'vitest'
import {
  CreateProjectSourceRequestSchema,
  NodeHelloSchema,
  RevokeProjectSourceRequestSchema,
  SourcePermissionCheckSchema,
  SourcePermissionResultSchema,
} from '../src/index.js'

const NODE_ID = '813b0ff8-7499-4b1e-8d65-93e66da96364'
const REQUEST_ID = '9d5c3b1e-2a4f-4c6d-8e7f-1a2b3c4d5e6f'

function envelope(type: string, payload: Record<string, unknown>) {
  return {
    protocolVersion: 1,
    messageId: '7b8c9d0e-1f2a-4b3c-9d4e-5f60718293a4',
    sentAt: '2026-10-31T00:00:00.000Z',
    type,
    payload,
  }
}

describe('source binding protocol (ADR-0024)', () => {
  it('requires explicit team share scope and defaults autoExtraction to false', () => {
    const parsed = CreateProjectSourceRequestSchema.parse({
      platform: 'feishu',
      kind: 'group',
      resourceKey: 'oc_resource',
      displayLabel: '活动筹备群',
      collectorNodeId: NODE_ID,
      credentialSlot: 'feishu-app',
      shareScope: 'team',
    })
    expect(parsed.autoExtraction).toBe(false)
    expect(() =>
      CreateProjectSourceRequestSchema.parse({
        platform: 'feishu',
        kind: 'group',
        resourceKey: 'oc_resource',
        displayLabel: '活动筹备群',
        collectorNodeId: NODE_ID,
        credentialSlot: 'feishu-app',
      }),
    ).toThrow()
  })

  it('rejects unknown resource kinds and platforms', () => {
    expect(() =>
      CreateProjectSourceRequestSchema.parse({
        platform: 'slack',
        kind: 'group',
        resourceKey: 'x',
        displayLabel: 'x',
        collectorNodeId: NODE_ID,
        credentialSlot: 'slot',
        shareScope: 'team',
      }),
    ).toThrow()
    expect(() =>
      CreateProjectSourceRequestSchema.parse({
        platform: 'feishu',
        kind: 'all_files',
        resourceKey: 'x',
        displayLabel: 'x',
        collectorNodeId: NODE_ID,
        credentialSlot: 'slot',
        shareScope: 'team',
      }),
    ).toThrow()
  })

  it('requires a revoke reason', () => {
    expect(RevokeProjectSourceRequestSchema.parse({ reason: '活动结束' }).reason).toBe('活动结束')
    expect(() => RevokeProjectSourceRequestSchema.parse({ reason: '   ' })).toThrow()
  })

  it('parses hello with source capabilities and rejects unknown capabilities', () => {
    const hello = {
      deviceId: NODE_ID,
      nodeVersion: '24.12.0',
      platform: 'darwin',
      architecture: 'arm64',
      supportedProtocolVersions: [1],
      dshDistributionVersion: '0.1.0-rc.8',
      pluginPackDigests: ['a'.repeat(64)],
      sourceCapabilities: ['feishu.read.v1'],
    }
    expect(NodeHelloSchema.parse(envelope('node.hello', hello)).payload.sourceCapabilities).toEqual(
      ['feishu.read.v1'],
    )
    expect(() =>
      NodeHelloSchema.parse(
        envelope('node.hello', { ...hello, sourceCapabilities: ['feishu.write.v1'] }),
      ),
    ).toThrow()
  })

  it('readable permission result must carry appKey; non-readable must not', () => {
    const readable = envelope('source.permission_result', {
      requestId: REQUEST_ID,
      result: 'readable',
      appKey: 'app-key-hash',
    })
    expect(SourcePermissionResultSchema.parse(readable).payload.appKey).toBe('app-key-hash')
    // appKey 上限与 DB varchar(200) 对齐；超过上限必须在 wire 层拒绝。
    const longKey = 'a'.repeat(200)
    expect(
      SourcePermissionResultSchema.parse(
        envelope('source.permission_result', {
          requestId: REQUEST_ID,
          result: 'readable',
          appKey: longKey,
        }),
      ).payload.appKey,
    ).toBe(longKey)
    expect(() =>
      SourcePermissionResultSchema.parse(
        envelope('source.permission_result', {
          requestId: REQUEST_ID,
          result: 'readable',
          appKey: 'a'.repeat(201),
        }),
      ),
    ).toThrow()
    expect(() =>
      SourcePermissionResultSchema.parse(
        envelope('source.permission_result', { requestId: REQUEST_ID, result: 'readable' }),
      ),
    ).toThrow()
    expect(() =>
      SourcePermissionResultSchema.parse(
        envelope('source.permission_result', {
          requestId: REQUEST_ID,
          result: 'denied',
          appKey: 'app-key-hash',
        }),
      ),
    ).toThrow()
  })

  it('permission check frame carries no credential value, only a slot name', () => {
    const frame = envelope('source.permission_check', {
      requestId: REQUEST_ID,
      platform: 'feishu',
      kind: 'group',
      resourceKey: 'oc_resource',
      credentialSlot: 'feishu-app',
    })
    expect(SourcePermissionCheckSchema.parse(frame).payload.credentialSlot).toBe('feishu-app')
    expect(() =>
      SourcePermissionCheckSchema.parse({
        ...frame,
        payload: { ...frame.payload, appSecret: 'must-not-travel' },
      }),
    ).toThrow()
  })
})
