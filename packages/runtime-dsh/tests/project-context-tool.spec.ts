/**
 * ADR-0027 §4（PC-05a）：read_project_context 工具。
 *
 * 参数只有 entryId；文件名来自清单白名单；每次读取重新核对 digest/byteSize，
 * 成功才发 read 回执。拒绝消息不含本机目录。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunProjectContextManifestEntry } from '@whalepod/protocol'
import {
  createReadProjectContextTool,
  projectContextHeaderNonceMatches,
  projectContextNonce,
} from '../src/project-context-tool.js'

let root: string
let entriesDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wp-project-context-tool-'))
  entriesDir = join(root, 'runtime-context')
  mkdirSync(entriesDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const ENTRY_ID = '01905f7c-0000-7000-8000-000000000951'
const BODY = '# 冻结上下文\n预算结论：8 万\n'
const ENTRY: RunProjectContextManifestEntry = {
  entryId: ENTRY_ID,
  kind: 'decision',
  title: '预算结论',
  revisionId: null,
  businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
  digest: createHash('sha256').update(BODY).digest('hex'),
  byteSize: Buffer.byteLength(BODY, 'utf8'),
  snapshotAuthorizationGeneration: null,
}

describe('read_project_context tool', () => {
  it('returns the frozen body with structured fields and emits a read receipt', async () => {
    writeFileSync(join(entriesDir, ENTRY_ID), BODY)
    const reads: unknown[] = []
    const tool = createReadProjectContextTool([ENTRY], entriesDir, (fact) => reads.push(fact))
    const result = (await tool.execute({ entryId: ENTRY_ID }, {} as never)) as {
      entryId: string
      kind: string
      title: string
      digest: string
      byteSize: number
      content: string
      truncated: boolean
    }
    expect(result).toMatchObject({
      entryId: ENTRY_ID,
      kind: 'decision',
      title: '预算结论',
      digest: ENTRY.digest,
      byteSize: ENTRY.byteSize,
      content: BODY,
      truncated: false,
    })
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({
      entryId: ENTRY_ID,
      digestVerified: true,
      byteSize: ENTRY.byteSize,
    })
  })

  it('rejects unknown or path-shaped ids before touching the filesystem', async () => {
    const tool = createReadProjectContextTool([ENTRY], entriesDir, () => {})
    for (const entryId of ['../../escape.md', '/etc/passwd', ENTRY_ID]) {
      await expect(tool.execute({ entryId }, {} as never)).rejects.toThrow(
        entryId === ENTRY_ID ? 'unavailable' : 'unknown project context entry',
      )
    }
    const message = await tool
      .execute({ entryId: '../../escape.md' }, {} as never)
      .catch((error: unknown) => String(error))
    expect(String(message)).not.toContain(entriesDir)
  })

  it('refuses a copy whose digest or size drifted and emits no receipt', async () => {
    writeFileSync(join(entriesDir, ENTRY_ID), 'tampered')
    const reads: unknown[] = []
    const tool = createReadProjectContextTool([ENTRY], entriesDir, (fact) => reads.push(fact))
    await expect(tool.execute({ entryId: ENTRY_ID }, {} as never)).rejects.toThrow(
      'failed digest verification',
    )
    expect(reads).toHaveLength(0)
  })

  it('derives the nonce deterministically and checks the header marker', () => {
    const digest = createHash('sha256').update('snapshot').digest('hex')
    const runId = '01905f7c-0000-7000-8000-000000000301'
    const nonce = projectContextNonce(digest, runId)
    expect(nonce).toMatch(/^[a-f0-9]{16}$/)
    expect(projectContextNonce(digest, runId)).toBe(nonce)
    expect(projectContextHeaderNonceMatches(`[project-context:${nonce}]`, digest, runId)).toBe(true)
    expect(projectContextHeaderNonceMatches('[project-context:deadbeef]', digest, runId)).toBe(
      false,
    )
  })
})
