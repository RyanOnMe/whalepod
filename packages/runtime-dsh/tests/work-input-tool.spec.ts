/**
 * ADR-0028 §3（RD-02a-2b）：read_work_input 工具。
 *
 * 参数只有 inboxItemId；文件名来自清单白名单；每次读取重新核对 digest/byteSize，
 * 成功才发 read 回执。拒绝消息不含本机目录。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkInputManifestEntry } from '@whalepod/protocol'
import { createReadWorkInputTool } from '../src/work-input-tool.js'

let root: string
let entriesDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wp-work-input-tool-'))
  entriesDir = join(root, 'runtime-work-inputs')
  mkdirSync(entriesDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const ITEM_ID = '01905f7c-0000-7000-8000-000000000981'
const BODY = '# 需求澄清\nRD02A2_ECHO\n'
const ENTRY: WorkInputManifestEntry = {
  inboxItemId: ITEM_ID,
  sourceType: 'task_message',
  sourceId: '01905f7c-0000-7000-8000-000000000991',
  sourceVersion: '3',
  sourceDigest: createHash('sha256').update('source-v3').digest('hex'),
  bodyDigest: createHash('sha256').update(BODY).digest('hex'),
  byteSize: Buffer.byteLength(BODY, 'utf8'),
  authorizationGeneration: 'gen-1',
  title: '需求澄清',
}

describe('read_work_input tool', () => {
  it('returns the pinned body with structured fields and emits a read receipt', async () => {
    writeFileSync(join(entriesDir, ITEM_ID), BODY)
    const reads: unknown[] = []
    const tool = createReadWorkInputTool([ENTRY], entriesDir, (fact) => reads.push(fact))
    const result = (await tool.execute({ inboxItemId: ITEM_ID }, {} as never)) as {
      inboxItemId: string
      sourceType: string
      sourceId: string
      sourceVersion: string
      title: string
      digest: string
      byteSize: number
      content: string
      truncated: boolean
    }
    expect(result).toMatchObject({
      inboxItemId: ITEM_ID,
      sourceType: 'task_message',
      sourceId: ENTRY.sourceId,
      sourceVersion: '3',
      title: '需求澄清',
      digest: ENTRY.bodyDigest,
      byteSize: ENTRY.byteSize,
      content: BODY,
      truncated: false,
    })
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({
      inboxItemId: ITEM_ID,
      digestVerified: true,
      byteSize: ENTRY.byteSize,
    })
  })

  it('rejects unknown or path-shaped ids before touching the filesystem', async () => {
    const tool = createReadWorkInputTool([ENTRY], entriesDir, () => {})
    for (const inboxItemId of ['../../escape.md', '/etc/passwd', ITEM_ID]) {
      await expect(tool.execute({ inboxItemId }, {} as never)).rejects.toThrow(
        inboxItemId === ITEM_ID ? 'unavailable' : 'unknown work input item',
      )
    }
    const message = await tool
      .execute({ inboxItemId: '../../escape.md' }, {} as never)
      .catch((error: unknown) => String(error))
    expect(String(message)).not.toContain(entriesDir)
  })

  it('refuses a copy whose digest or size drifted and emits no receipt', async () => {
    // 与原文等长：确保拒绝来自摘要而不是 byteSize。
    writeFileSync(join(entriesDir, ITEM_ID), 'X'.repeat(Buffer.byteLength(BODY)))
    const reads: unknown[] = []
    const tool = createReadWorkInputTool([ENTRY], entriesDir, (fact) => reads.push(fact))
    await expect(tool.execute({ inboxItemId: ITEM_ID }, {} as never)).rejects.toThrow(
      'failed digest verification',
    )
    expect(reads).toHaveLength(0)
  })

  it('renders structured fields and the body for the model surface', () => {
    const tool = createReadWorkInputTool([ENTRY], entriesDir, () => {})
    const value = {
      inboxItemId: ITEM_ID,
      sourceType: 'task_message',
      sourceId: ENTRY.sourceId,
      sourceVersion: '3',
      title: '需求澄清',
      digest: ENTRY.bodyDigest,
      byteSize: ENTRY.byteSize,
      truncated: false,
      content: BODY,
    }
    const rendered = tool.output.render({ inboxItemId: ITEM_ID }, value as never)
    const text = (rendered as { type: string; text: string }[])
      .map((block) => block.text)
      .join('\n')
    expect(text).toContain(`work input: ${ITEM_ID}`)
    expect(text).toContain('source: task_message/01905f7c-0000-7000-8000-000000000991')
    expect(text).toContain('version: 3')
    expect(text).toContain(`digest: ${ENTRY.bodyDigest}`)
    expect(text).toContain(BODY)
  })
})
