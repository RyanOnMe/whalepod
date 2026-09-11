/**
 * publish_artifact 工具侧工作区校验（P1-15；03 §7.2、04 §6.3 路径攻击矩阵的
 * Runtime 半场）。
 *
 * 工具在把候选登记为 artifact.candidate 帧之前，先在桥内做 fail-closed 校验：
 * 相对路径、NUL、越界（含 symlink 逃逸）、目录、超限一律拒绝——工具结果失败
 * 回给模型，绝不发帧。校验器与 apps/node 采集器语义一致（同库 realpath 边界
 * 规则），攻击向量语料在两处 spec 镜像，任一侧改语义都会红。
 *
 * 红线断言：拒绝消息绝不携带 workspace 绝对路径（错误文本会回给模型与团队投影）。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ArtifactCandidateError,
  createWorkspaceArtifactValidator,
} from '../src/artifact-validation.js'
// ArtifactCandidate 的**定义**在 artifact-tool.ts（artifact-validation 只导出错误类型）；
// #178 把 tests/ 纳入 typecheck 面后这条错位的 import 才暴露出来。
import { createPublishArtifactTool, type ArtifactCandidate } from '../src/artifact-tool.js'

let root: string
let workspace: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wp-artifact-tool-'))
  workspace = join(root, 'ws')
  mkdirSync(join(workspace, 'reports'), { recursive: true })
  writeFileSync(join(workspace, 'reports', 'out.md'), '# report\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const MAX_BYTES = 52_428_800

function makeValidator(maxBytes = MAX_BYTES) {
  return createWorkspaceArtifactValidator({ workspacePath: workspace, maxBytes })
}

function candidate(relativePath: string): ArtifactCandidate {
  return { relativePath, title: 'Report', mediaType: 'text/markdown' }
}

describe('workspace artifact validator', () => {
  it('accepts a plain workspace-relative file', () => {
    expect(() => makeValidator().validate(candidate('reports/out.md'))).not.toThrow()
  })

  it('accepts a symlink resolving inside the workspace (canonical adopted)', () => {
    symlinkSync(join(workspace, 'reports', 'out.md'), join(workspace, 'link.md'))
    expect(() => makeValidator().validate(candidate('link.md'))).not.toThrow()
  })

  it('rejects .. traversal', () => {
    let caught: unknown
    try {
      makeValidator().validate(candidate('../secret.txt'))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ArtifactCandidateError)
    expect((caught as ArtifactCandidateError).reason).toBe('path-outside-workspace')
  })

  it('rejects nested .. traversal that re-enters and escapes', () => {
    expect(() => makeValidator().validate(candidate('reports/../../x'))).toThrow(
      ArtifactCandidateError,
    )
  })

  it('rejects case-variant .. traversal (cannot bypass the boundary by case)', () => {
    try {
      makeValidator().validate(candidate('../REPORTS/../../out.md'))
      expect.unreachable('case-variant escape must be rejected')
    } catch (error) {
      expect((error as ArtifactCandidateError).reason).toBe('path-outside-workspace')
    }
  })

  it('rejects absolute paths', () => {
    try {
      makeValidator().validate(candidate('/etc/passwd'))
      expect.unreachable('absolute path must be rejected')
    } catch (error) {
      expect((error as ArtifactCandidateError).reason).toBe('path-outside-workspace')
    }
  })

  it('rejects NUL bytes', () => {
    try {
      makeValidator().validate(candidate('reports/out.md\0'))
      expect.unreachable('NUL must be rejected')
    } catch (error) {
      expect((error as ArtifactCandidateError).reason).toBe('path-outside-workspace')
    }
  })

  it('rejects percent-encoded traversal without decoding (literal file simply missing)', () => {
    try {
      makeValidator().validate(candidate('%2e%2e/secret.txt'))
      expect.unreachable('must not publish')
    } catch (error) {
      // 未解码：字面文件不存在 → unreadable（不是越界成功，也不是发布成功）。
      expect((error as ArtifactCandidateError).reason).toBe('unreadable')
    }
  })

  it('rejects a symlink resolving outside the workspace', () => {
    const outside = join(root, 'outside.md')
    writeFileSync(outside, 'secret')
    symlinkSync(outside, join(workspace, 'escape.md'))
    try {
      makeValidator().validate(candidate('escape.md'))
      expect.unreachable('symlink escape must be rejected')
    } catch (error) {
      expect((error as ArtifactCandidateError).reason).toBe('path-outside-workspace')
    }
  })

  it('rejects a directory', () => {
    try {
      makeValidator().validate(candidate('reports'))
      expect.unreachable('directory must be rejected')
    } catch (error) {
      expect((error as ArtifactCandidateError).reason).toBe('not-a-file')
    }
  })

  it('rejects a missing file', () => {
    try {
      makeValidator().validate(candidate('reports/missing.md'))
      expect.unreachable('missing file must be rejected')
    } catch (error) {
      expect((error as ArtifactCandidateError).reason).toBe('unreadable')
    }
  })

  it('rejects a file over the size cap (sparse, real limit)', () => {
    const big = join(workspace, 'big.bin')
    writeFileSync(big, '')
    truncateSync(big, MAX_BYTES + 1)
    try {
      makeValidator().validate(candidate('big.bin'))
      expect.unreachable('oversize must be rejected')
    } catch (error) {
      expect((error as ArtifactCandidateError).reason).toBe('too-large')
    }
  })

  it('accepts a file at exactly the size cap', () => {
    const edge = join(workspace, 'edge.bin')
    writeFileSync(edge, '')
    truncateSync(edge, MAX_BYTES)
    expect(() => makeValidator().validate(candidate('edge.bin'))).not.toThrow()
  })

  it('rejection messages never carry the workspace absolute path (red line)', () => {
    const probes = ['../secret.txt', '/etc/passwd', 'reports/missing.md', 'reports']
    for (const probe of probes) {
      try {
        makeValidator().validate(candidate(probe))
      } catch (error) {
        expect((error as Error).message).not.toContain(workspace)
        expect((error as Error).message).not.toContain(root)
      }
    }
  })
})

describe('publish_artifact tool wiring', () => {
  function makePort() {
    const published: ArtifactCandidate[] = []
    return {
      published,
      port: {
        publish: (c: ArtifactCandidate) => {
          published.push(c)
        },
      },
    }
  }

  it('publishes through the port when validation passes', async () => {
    const { port, published } = makePort()
    const tool = createPublishArtifactTool(port, makeValidator())
    const result = await tool.execute(
      { relativePath: 'reports/out.md', title: 'Report', mediaType: 'text/markdown' },
      {} as never,
    )
    expect(result).toEqual({ registered: true })
    expect(published).toHaveLength(1)
    expect(published[0]?.relativePath).toBe('reports/out.md')
  })

  it('rejects before publishing when validation fails: no frame, no port call', async () => {
    const { port, published } = makePort()
    const tool = createPublishArtifactTool(port, makeValidator())
    await expect(
      tool.execute(
        { relativePath: '../secret.txt', title: 'S', mediaType: 'text/plain' },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ArtifactCandidateError)
    expect(published).toHaveLength(0)
  })

  it('stays backward compatible: no validator → publish directly (probe harness)', async () => {
    const { port, published } = makePort()
    const tool = createPublishArtifactTool(port)
    const result = await tool.execute(
      { relativePath: 'whatever.md', title: 'T', mediaType: 'text/plain' },
      {} as never,
    )
    expect(result).toEqual({ registered: true })
    expect(published).toHaveLength(1)
  })
})
