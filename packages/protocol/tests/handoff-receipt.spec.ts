/**
 * 交接交付/接收与下游 Run 交接输入（#380；ADR-0017 §5）协议形状判据。
 *
 * 钉的是「请求能不能表达一件事」：交付必须恰好一种下游（建/联）；确认/采用的
 * 理解必填；交接输入只在会建 Run 的意图上出现；快照条目上限与同 Task 清单同源。
 */
import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_INPUT_MANIFEST_MAX_ENTRIES,
  ConfirmHandoffReceiptRequestSchema,
  CreateRunRequestSchema,
  DeliverHandoffRequestSchema,
  HandoffInputManifestSchema,
  SendInstructionRequestSchema,
} from '../src/index.js'

const id = '00000000-0000-4000-8000-000000000001'
const id2 = '00000000-0000-4000-8000-000000000002'
const base = { agentId: id, deviceId: id, workspaceId: id, prompt: 'handoff' }

function entry(index: number) {
  return {
    artifactId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    runId: id,
    title: `t${index}`,
    mediaType: 'text/plain',
    byteSize: 1,
    sha256: 'a'.repeat(64),
    publishedAt: '2026-10-18T00:00:00.000Z',
  }
}

describe('#380 交付与接收确认请求', () => {
  it('deliver 必须恰好一种下游目标：新建或关联', () => {
    expect(
      DeliverHandoffRequestSchema.safeParse({ receiverUserId: id, newTask: { title: 'x' } })
        .success,
    ).toBe(true)
    expect(
      DeliverHandoffRequestSchema.safeParse({ receiverUserId: id, downstreamTaskId: id2 }).success,
    ).toBe(true)
    // 两者都给 / 都不给：畸形，fail-closed。
    expect(
      DeliverHandoffRequestSchema.safeParse({
        receiverUserId: id,
        downstreamTaskId: id2,
        newTask: { title: 'x' },
      }).success,
    ).toBe(false)
    expect(DeliverHandoffRequestSchema.safeParse({ receiverUserId: id }).success).toBe(false)
  })

  it('确认/采用：理解必填（空白字符串不构成理解），差异可选但限长', () => {
    expect(ConfirmHandoffReceiptRequestSchema.safeParse({ understanding: '做前端' }).success).toBe(
      true,
    )
    expect(
      ConfirmHandoffReceiptRequestSchema.safeParse({
        understanding: '做前端',
        differences: '接口改',
      }).success,
    ).toBe(true)
    expect(ConfirmHandoffReceiptRequestSchema.safeParse({ understanding: '' }).success).toBe(false)
    expect(ConfirmHandoffReceiptRequestSchema.safeParse({}).success).toBe(false)
    expect(
      ConfirmHandoffReceiptRequestSchema.safeParse({ understanding: 'x'.repeat(10001) }).success,
    ).toBe(false)
  })

  it('交接输入只随会建 Run 的意图出现：followup 与隐式指令都拒绝', () => {
    expect(CreateRunRequestSchema.safeParse({ ...base, handoffReceiptId: id }).success).toBe(true)
    for (const intent of [undefined, { kind: 'followup', runId: id }]) {
      expect(
        SendInstructionRequestSchema.safeParse({
          text: 'x',
          handoffReceiptId: id,
          ...(intent ? { intent } : {}),
        }).success,
      ).toBe(false)
    }
    expect(
      SendInstructionRequestSchema.safeParse({
        text: 'x',
        agentId: id,
        intent: { kind: 'new' },
        handoffReceiptId: id,
      }).success,
    ).toBe(true)
    expect(
      SendInstructionRequestSchema.safeParse({
        text: 'x',
        intent: { kind: 'resume', runId: id },
        handoffReceiptId: id,
      }).success,
    ).toBe(true)
  })

  it('交接输入快照：条目上限与同 Task 清单同源，摘要格式与 64 上限都被钉住', () => {
    const manifest = {
      upstreamTaskId: id,
      upstreamTaskTitle: '后端交付',
      receiptId: id,
      revisionId: id2,
      revisionNumber: 1,
      artifacts: [entry(1)],
    }
    expect(HandoffInputManifestSchema.safeParse(manifest).success).toBe(true)
    const tooMany = {
      ...manifest,
      artifacts: Array.from({ length: ARTIFACT_INPUT_MANIFEST_MAX_ENTRIES + 1 }, (_, i) =>
        entry(i + 1),
      ),
    }
    expect(HandoffInputManifestSchema.safeParse(tooMany).success).toBe(false)
    const badDigest = { ...manifest, artifacts: [{ ...entry(1), sha256: 'nothex' }] }
    expect(HandoffInputManifestSchema.safeParse(badDigest).success).toBe(false)
    expect(HandoffInputManifestSchema.safeParse({ ...manifest, revisionNumber: 0 }).success).toBe(
      false,
    )
  })
})
