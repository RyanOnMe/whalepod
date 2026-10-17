/**
 * #281 判据：E2E 的 Hub 装配只走**包解析后的 dist 生产产物**，且 spawn 前强制增量 build。
 *
 * 断链背景：`scripts/e2e-serve.mts` 之前用 `node --import tsx apps/hub/src/server.ts`
 * 拉起 Hub，而生产 Docker 入口是包内 `dist/server.js`——同一入口两套装配，tsc 构建
 * break（类型错误只断 dist 不断 src）时 Q5 照样绿。修复分两片：dist 分支升为唯一
 * 装配、装配前增量 build。本文件钉住「解析出的是 dist 且不是源码路径」与「构建失败
 * 必须响亮传播」两件事——源码入口回潮（有人把 `apps/hub/src/...` 塞回来）必红。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildWorkspaceDistArtifacts,
  resolveHubServerEntry,
  type WorkspaceBuildRunner,
} from './hub-assembly.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const hubPackageAnchor = fileURLToPath(new URL('../../../apps/hub/package.json', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'wp-hub-assembly-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('#281 Hub 生产装配（dist-only）', () => {
  it('解析出的是包内 dist 入口，且不是源码路径（包解析，不是 goalpost 硬编码）', () => {
    buildWorkspaceDistArtifacts(repoRoot)
    const entry = resolveHubServerEntry(hubPackageAnchor)
    expect(entry).toBe(join(repoRoot, 'apps', 'hub', 'dist', 'server.js'))
    // 核心判据：任何形式的 /src/ 入口都是本 Issue 的原始缺陷形态。
    expect(entry).not.toMatch(/[/\\]src[/\\]/)
    expect(existsSync(entry)).toBe(true)
  })

  it('负控：包解析得到但 dist 产物缺失（未构建的包树）→ 报错，并给出可执行动作', () => {
    const fake = join(scratch, 'unbuilt')
    const fakeHub = join(fake, 'node_modules', '@whalepod', 'hub')
    mkdirSync(join(fakeHub, 'dist'), { recursive: true })
    writeFileSync(
      join(fake, 'package.json'),
      JSON.stringify({ name: 'fake-anchor', version: '1.0.0' }),
    )
    writeFileSync(
      join(fakeHub, 'package.json'),
      JSON.stringify({
        name: '@whalepod/hub',
        version: '1.0.0',
        exports: { '.': { default: './dist/index.js' } },
      }),
    )
    writeFileSync(join(fakeHub, 'dist', 'index.js'), '')
    let message = ''
    try {
      resolveHubServerEntry(join(fake, 'package.json'))
      expect.unreachable('缺产物必须抛出')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/pnpm|build/)
    // 红线：对外文本里的绝对路径已归约（临时目录 → <tmp>），原路径不出现。
    expect(message).toContain('<tmp>')
    expect(message).not.toContain(scratch)
  })

  it('负控：锚点不是本仓库的包（解析不到 @whalepod/hub）→ 归因到锚点，不猜下一跳', () => {
    const empty = join(scratch, 'no-packages')
    mkdirSync(empty, { recursive: true })
    writeFileSync(join(empty, 'package.json'), JSON.stringify({ name: 'empty', version: '1.0.0' }))
    expect(() => resolveHubServerEntry(join(empty, 'package.json'))).toThrow(/@whalepod\/hub/)
  })

  it('装配前强制 build：runner 的失败必须带输出响亮传播（不许静默跑旧产物）', () => {
    const calls: string[] = []
    const failing: WorkspaceBuildRunner = ({ repoRoot: root }) => {
      calls.push(root)
      throw new Error('tsc 报错：src/foo.ts(1,1): error TS2304: Cannot find name "x"')
    }
    expect(() => buildWorkspaceDistArtifacts(repoRoot, { runBuild: failing })).toThrow(
      /TS2304|Cannot find name/,
    )
    expect(calls).toEqual([repoRoot])
  })

  it('正控：runner 成功即通过，且构建发生在仓库根（真实装配点）', () => {
    let seen = ''
    const ok: WorkspaceBuildRunner = ({ repoRoot: root }) => {
      seen = root
      return 'Done'
    }
    expect(() => buildWorkspaceDistArtifacts(repoRoot, { runBuild: ok })).not.toThrow()
    expect(seen).toBe(repoRoot)
  })

  it('对外文本红线：构建失败尾巴过 redactText（无绝对路径），返回值仍是未归约真路径', () => {
    const noisy: WorkspaceBuildRunner = ({ repoRoot: root }) => {
      throw new Error(`pnpm 输出：${join(root, 'apps', 'hub')}: error TS2322: boom`)
    }
    let message = ''
    try {
      buildWorkspaceDistArtifacts(repoRoot, { runBuild: noisy })
      expect.unreachable('构建失败必须抛出')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('<repo>')
    expect(message).not.toContain(repoRoot)
    // spawn 用的是真路径：归约只作用于对外文本，不许污染返回值。
    expect(resolveHubServerEntry(hubPackageAnchor)).toContain(repoRoot)
  })

  it('URL 与路径两种锚点形态等价（调用点可传 file URL）', () => {
    const byPath = resolveHubServerEntry(hubPackageAnchor)
    const byUrl = resolveHubServerEntry(pathToFileURL(hubPackageAnchor))
    expect(byUrl).toBe(byPath)
  })
})
