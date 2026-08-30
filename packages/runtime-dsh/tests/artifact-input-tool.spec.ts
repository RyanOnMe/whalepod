/**
 * read_artifact_input 工具（P1-15；G6-07 Reviewer 只读输入）。
 *
 * Reviewer Run 的唯一 Artifact 读取面：参数只有 artifactId——文件名由 manifest
 * 成员资格决定（UUID 白名单），模型的任何字符串都无法变成文件系统路径；
 * 只读（无写参数）、副本由 Node 预下载并经 sha256 校验。路径红线：任何拒绝
 * 消息不携带 inputsDir 绝对路径。
 */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReadArtifactInputTool, type ArtifactInputEntry } from '../src/artifact-input-tool.js'

let root: string
let inputsDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'p311-artifact-input-'))
  inputsDir = join(root, 'inputs')
  mkdirSync(inputsDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const TEXT_ENTRY: ArtifactInputEntry = {
  artifactId: '01905f7c-0000-7000-8000-000000000901',
  title: 'Builder report',
  mediaType: 'text/markdown',
  byteSize: 9,
  sha256: '3c'.repeat(32),
}

const BINARY_ENTRY: ArtifactInputEntry = {
  artifactId: '01905f7c-0000-7000-8000-000000000902',
  title: 'Chart',
  mediaType: 'image/png',
  byteSize: 4,
  sha256: '4d'.repeat(32),
}

function seed(entry: ArtifactInputEntry, bytes: string | Buffer): void {
  writeFileSync(join(inputsDir, entry.artifactId), bytes)
}

function makeTool(entries: ArtifactInputEntry[] = [TEXT_ENTRY, BINARY_ENTRY]) {
  return createReadArtifactInputTool(entries, inputsDir)
}

describe('read_artifact_input tool', () => {
  it('returns metadata plus content for a text artifact', async () => {
    seed(TEXT_ENTRY, '# report\n')
    const tool = makeTool()
    const result = (await tool.execute({ artifactId: TEXT_ENTRY.artifactId }, {} as never)) as {
      artifactId: string
      content?: string
      truncated: boolean
      sha256: string
    }
    expect(result.artifactId).toBe(TEXT_ENTRY.artifactId)
    expect(result.sha256).toBe(TEXT_ENTRY.sha256)
    expect(result.content).toBe('# report\n')
    expect(result.truncated).toBe(false)
  })

  it('never exposes content of a binary artifact, only metadata', async () => {
    seed(BINARY_ENTRY, Buffer.from([0, 1, 2, 3]))
    const tool = makeTool()
    const result = (await tool.execute({ artifactId: BINARY_ENTRY.artifactId }, {} as never)) as {
      content?: string
      note?: string
    }
    expect(result.content).toBeUndefined()
    expect(result.note).toContain('binary')
  })

  it('truncates large text with an explicit flag', async () => {
    const big: ArtifactInputEntry = { ...TEXT_ENTRY, byteSize: 200_000 }
    seed(big, 'a'.repeat(200_000))
    const tool = makeTool([big])
    const result = (await tool.execute({ artifactId: big.artifactId }, {} as never)) as {
      content?: string
      truncated: boolean
    }
    expect(result.truncated).toBe(true)
    expect((result.content ?? '').length).toBeLessThan(200_000)
  })

  it('rejects unknown artifactId without touching the filesystem', async () => {
    const tool = makeTool()
    await expect(
      tool.execute({ artifactId: '01905f7c-0000-7000-8000-000000000999' }, {} as never),
    ).rejects.toThrow(/unknown artifact input/i)
  })

  it('traversal-shaped ids cannot become filesystem paths (manifest whitelist only)', async () => {
    const tool = makeTool()
    await expect(tool.execute({ artifactId: '../../escape.md' }, {} as never)).rejects.toThrow(
      /unknown artifact input/i,
    )
  })

  it('failure messages never carry the inputs directory (red line)', async () => {
    const tool = makeTool()
    try {
      await tool.execute({ artifactId: '../../escape.md' }, {} as never)
      expect.unreachable('must reject')
    } catch (error) {
      expect((error as Error).message).not.toContain(inputsDir)
      expect((error as Error).message).not.toContain(root)
    }
  })

  it('reports a missing local copy as unavailable, without the path', async () => {
    seed(TEXT_ENTRY, '# report\n')
    unlinkSync(join(inputsDir, TEXT_ENTRY.artifactId))
    const tool = makeTool()
    try {
      await tool.execute({ artifactId: TEXT_ENTRY.artifactId }, {} as never)
      expect.unreachable('missing copy must fail')
    } catch (error) {
      expect((error as Error).message).not.toContain(inputsDir)
    }
  })
})
