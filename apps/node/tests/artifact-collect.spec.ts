/**
 * Node Artifact 采集器单测（P1-15；04 §6.3 路径攻击矩阵的 Node 半场、G6-02/03）。
 *
 * 判定基线：
 * - 攻击向量（../、绝对路径、NUL、symlink 逃逸）→ 拒绝且不调用上传；错误码
 *   ARTIFACT_PATH_OUTSIDE_WORKSPACE。语料与 packages/runtime-dsh/tests/
 *   artifact-tool.spec.ts 镜像（同一 realpath 边界语义，双侧改语义都会红）。
 * - 正常文件 → 读入临时副本 + sha256 → 上传收到的字节与副本一致；临时副本清理。
 * - 超限（真实 50 MiB 上限，稀疏文件）→ ARTIFACT_TOO_LARGE，不调用上传。
 * - 上传失败 → 上抛（RunManager 负责结构化日志），临时副本也清理。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactCollector, ArtifactCollectError } from '../src/artifact/collect.js'

let root: string
let workspace: string
let staging: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'p311-artifact-collect-'))
  workspace = join(root, 'ws')
  staging = join(root, 'staging')
  await mkdir(join(workspace, 'reports'), { recursive: true })
  await mkdir(staging, { recursive: true })
  await writeFile(join(workspace, 'reports', 'out.md'), '# report\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const CONTENT = '# report\n'
const DIGEST = createHash('sha256').update(CONTENT).digest('hex')

interface Harness {
  collector: ArtifactCollector
  uploads: Array<{ runId: string; candidate: Record<string, unknown>; body: Buffer }>
  nextUploadError?: Error
}

function makeHarness(
  overrides: Partial<ConstructorParameters<typeof ArtifactCollector>[0]> = {},
): Harness {
  const h: Harness = { uploads: [], collector: undefined as unknown as ArtifactCollector }
  h.collector = new ArtifactCollector({
    stagingDir: staging,
    upload: async (runId, candidate, body) => {
      if (h.nextUploadError !== undefined) throw h.nextUploadError
      h.uploads.push({ runId, candidate, body })
      return { artifactId: '01905f7c-0000-7000-8000-000000000801' }
    },
    ...overrides,
  })
  return h
}

describe('ArtifactCollector.collect', () => {
  it('正常路径：读临时副本 + hash + 上传一致字节，临时副本清理', async () => {
    const h = makeHarness()
    const collected = await h.collector.collect(
      'r1',
      {
        relativePath: 'reports/out.md',
        title: 'Report',
        mediaType: 'text/markdown',
      },
      workspace,
    )
    expect(collected.artifactId).toBe('01905f7c-0000-7000-8000-000000000801')
    expect(collected.sha256).toBe(DIGEST)
    expect(collected.byteSize).toBe(CONTENT.length)
    expect(collected.sourceRelativePath).toBe('reports/out.md')
    expect(h.uploads).toHaveLength(1)
    expect(h.uploads[0]?.body.toString()).toBe(CONTENT)
    expect(h.uploads[0]?.candidate).toMatchObject({
      sha256: DIGEST,
      byteSize: CONTENT.length,
      title: 'Report',
      mediaType: 'text/markdown',
    })
    // 临时副本已清理。
    expect(await readdir(staging)).toHaveLength(0)
  })

  it('G6-02: ../ 逃逸 → ARTIFACT_PATH_OUTSIDE_WORKSPACE，不上传', async () => {
    const h = makeHarness()
    await expect(
      h.collector.collect(
        'r1',
        {
          relativePath: '../secret.txt',
          title: 'S',
          mediaType: 'text/plain',
        },
        workspace,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUTSIDE_WORKSPACE' })
    expect(h.uploads).toHaveLength(0)
  })

  it('绝对路径与 NUL 拒绝；%2e%2e 不解码、按缺失文件拒绝', async () => {
    const h = makeHarness()
    await expect(
      h.collector.collect(
        'r1',
        { relativePath: '/etc/passwd', title: 'x', mediaType: 'text/plain' },
        workspace,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUTSIDE_WORKSPACE' })
    await expect(
      h.collector.collect(
        'r1',
        { relativePath: 'a\0b', title: 'x', mediaType: 'text/plain' },
        workspace,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUTSIDE_WORKSPACE' })
    await expect(
      h.collector.collect(
        'r1',
        { relativePath: '%2e%2e/secret', title: 'x', mediaType: 'text/plain' },
        workspace,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_SOURCE_UNAVAILABLE' })
    expect(h.uploads).toHaveLength(0)
  })

  it('大小写变体的 .. 逃逸同样拒绝（不得借大小写绕过边界）', async () => {
    const h = makeHarness()
    await expect(
      h.collector.collect(
        'r1',
        {
          relativePath: '../REPORTS/../../out.md',
          title: 'x',
          mediaType: 'text/plain',
        },
        workspace,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUTSIDE_WORKSPACE' })
    expect(h.uploads).toHaveLength(0)
  })

  it('symlink 逃逸拒绝（canonical 边界复验），内指 symlink 放行', async () => {
    const outside = join(root, 'outside.md')
    await writeFile(outside, 'secret')
    await symlink(outside, join(workspace, 'escape.md'))
    await symlink(join(workspace, 'reports', 'out.md'), join(workspace, 'link.md'))
    const h = makeHarness()
    await expect(
      h.collector.collect(
        'r1',
        { relativePath: 'escape.md', title: 'x', mediaType: 'text/plain' },
        workspace,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUTSIDE_WORKSPACE' })
    const collected = await h.collector.collect(
      'r1',
      {
        relativePath: 'link.md',
        title: 'ok',
        mediaType: 'text/markdown',
      },
      workspace,
    )
    expect(collected.sha256).toBe(DIGEST)
  })

  it('缺失文件与目录 → ARTIFACT_SOURCE_UNAVAILABLE；错误消息不含绝对路径（红线）', async () => {
    const h = makeHarness()
    const probes = ['reports/missing.md', 'reports']
    for (const relativePath of probes) {
      try {
        await h.collector.collect(
          'r1',
          { relativePath, title: 'x', mediaType: 'text/plain' },
          workspace,
        )
        expect.unreachable('must reject')
      } catch (error) {
        expect(error).toBeInstanceOf(ArtifactCollectError)
        expect((error as Error).message).not.toContain(workspace)
        expect((error as Error).message).not.toContain(root)
      }
    }
  })

  it('超限（稀疏文件打满真实上限）→ ARTIFACT_TOO_LARGE，不上传、副本清理', async () => {
    const big = join(workspace, 'big.bin')
    await writeFile(big, '')
    await truncate(big, 52_428_801)
    const h = makeHarness()
    await expect(
      h.collector.collect(
        'r1',
        { relativePath: 'big.bin', title: 'x', mediaType: 'application/octet-stream' },
        workspace,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_TOO_LARGE' })
    expect(h.uploads).toHaveLength(0)
    expect(await readdir(staging)).toHaveLength(0)
  })

  it('上传失败：上抛错误且临时副本清理（G6-03 链路）', async () => {
    const h = makeHarness()
    h.nextUploadError = new ArtifactCollectError('ARTIFACT_UPLOAD_FAILED', 'hub rejected upload')
    await expect(
      h.collector.collect(
        'r1',
        {
          relativePath: 'reports/out.md',
          title: 'Report',
          mediaType: 'text/markdown',
        },
        workspace,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_UPLOAD_FAILED' })
    expect(existsSync(staging)).toBe(true)
    expect(await readdir(staging)).toHaveLength(0)
  })
})
