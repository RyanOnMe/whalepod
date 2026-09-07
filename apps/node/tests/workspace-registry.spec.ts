/**
 * Workspace Registry 单测（P1-12；03 §2.4 workspace_registry、G3-04/06、02 Task 12 Step 1）。
 *
 * 判定基线：
 * - 注册时 realpath 归一（canonical 被采用）；Hub 只见 opaque id/label，路径不出 Node。
 * - resolve 验证「canonical 路径仍在 + filesystem identity（dev/ino）未变」；
 *   目录被换成指向他处的 symlink → WORKSPACE_UNAVAILABLE（G3-06 symlink 替换）。
 * - 删除 registry 项不删目录。
 */
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NodeInventorySchema } from '@project311/protocol'
import { WORKSPACE_NAME_MAX, WorkspaceRegistry } from '../src/workspace/registry.js'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'p311-ws-registry-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeRegistry(): WorkspaceRegistry {
  return new WorkspaceRegistry(join(root, `state-${Math.random().toString(36).slice(2)}.sqlite`))
}

describe('WorkspaceRegistry.register', () => {
  it('注册真实目录：realpath 归一 + opaque id + filesystem identity 落库', async () => {
    const registry = makeRegistry()
    const dir = join(root, 'project-a')
    await mkdir(dir)

    const ws = await registry.register(dir, { name: 'project-a' })

    expect(ws.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(ws.name).toBe('project-a')
    // symlink 归一：canonical 必须等于根的真实路径前缀（macOS /var/* → /private/var/*）。
    const rootCanonical = await realpath(root)
    expect(ws.canonicalPath.startsWith(rootCanonical + '/')).toBe(true)
    await registry.close()
  })

  it('注册 symlink：canonical realpath 被采用（G3-06 前半）', async () => {
    const registry = makeRegistry()
    const real = join(root, 'real-target')
    await mkdir(real)
    const link = join(root, 'linked-project')
    await symlink(real, link)

    const ws = await registry.register(link, { name: 'linked' })

    expect(ws.canonicalPath).toBe(await realpath(real))
    await registry.close()
  })

  it('注册不存在的目录 → WORKSPACE_UNAVAILABLE', async () => {
    const registry = makeRegistry()
    await expect(
      registry.register(join(root, 'no-such-dir'), { name: 'ghost' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
    await registry.close()
  })

  it('同名（owner 范围内）重复注册 → CONFLICT', async () => {
    const registry = makeRegistry()
    const dir = join(root, 'dup-a')
    await mkdir(dir)
    await registry.register(dir, { name: 'same-name' })
    await expect(registry.register(dir, { name: 'same-name' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await registry.close()
  })
})

describe('WorkspaceRegistry.resolve', () => {
  it('解析已注册的真实目录', async () => {
    const registry = makeRegistry()
    const dir = join(root, 'project-b')
    await mkdir(dir)
    const ws = await registry.register(dir, { name: 'project-b' })

    await expect(registry.resolve(ws.id)).resolves.toBe(await realpath(dir))
    await registry.close()
  })

  it('目录被替换为指向他处的 symlink → WORKSPACE_UNAVAILABLE，无路径泄露', async () => {
    const registry = makeRegistry()
    const dir = join(root, 'project-c')
    await mkdir(dir)
    const ws = await registry.register(dir, { name: 'project-c' })

    // 换成 symlink 指向另一个目录：路径还在但 filesystem identity 变了。
    const decoy = join(root, 'decoy-target')
    await mkdir(decoy)
    await writeFile(join(decoy, 'decoy.txt'), 'not your workspace')
    await rm(dir, { recursive: true })
    await symlink(decoy, dir)

    await expect(registry.resolve(ws.id)).rejects.toMatchObject({
      code: 'WORKSPACE_UNAVAILABLE',
    })
    await registry.close()
  })

  it('目录被删除 → WORKSPACE_UNAVAILABLE（G3-05 前置）', async () => {
    const registry = makeRegistry()
    const dir = join(root, 'project-d')
    await mkdir(dir)
    const ws = await registry.register(dir, { name: 'project-d' })
    await rm(dir, { recursive: true })

    await expect(registry.resolve(ws.id)).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
    await registry.close()
  })

  it('未注册的 id → WORKSPACE_UNAVAILABLE（不可枚举同形态）', async () => {
    const registry = makeRegistry()
    await expect(registry.resolve('018f8f8f-8f8f-7a8f-8f8f-8f8f8f8f8f8f')).rejects.toMatchObject({
      code: 'WORKSPACE_UNAVAILABLE',
    })
    await registry.close()
  })
})

describe('WorkspaceRegistry.list/remove', () => {
  it('list 返回全部注册项；remove 移除映射但保留目录', async () => {
    const registry = makeRegistry()
    const dir = join(root, 'project-e')
    await mkdir(dir)
    const ws = await registry.register(dir, { name: 'project-e' })

    expect((await registry.list()).map((w) => w.id)).toContain(ws.id)

    await registry.remove(ws.id)
    expect((await registry.list()).map((w) => w.id)).not.toContain(ws.id)
    // 删除 registry 项不删目录：目录仍在原处。
    await expect(registry.resolve(ws.id)).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
    const stat = await import('node:fs/promises').then((fs) => fs.stat(dir))
    expect(stat.isDirectory()).toBe(true)
    await registry.close()
  })
})

/**
 * #101：name 协议边界的本地守卫 + 上界漂移锁。
 *
 * 背景：Hub 对结构性坏帧按 ADR-0007 fail-closed **断开设备连接**，而 #89 之后
 * inventory 每条连接建立后都上报 ⟹ 一个超长名就是「连接→被踢→重连→再被踢」的
 * 死循环。故 invalid 帧必须在本地事实源就被挡住，且两侧边界不得各说各话。
 */
describe('WorkspaceRegistry name 边界（#101）', () => {
  const frameWith = (name: string) =>
    NodeInventorySchema.safeParse({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: 'node.inventory',
      payload: {
        deviceId: randomUUID(),
        credentialSlots: [],
        workspaces: [
          {
            workspaceId: randomUUID(),
            name,
            kind: 'directory',
            capabilities: { read: true, write: true, git: false },
            available: true,
            lastCheckedAt: new Date().toISOString(),
          },
        ],
      },
    })

  it('协议上界确为 80（80 通过、81 被拒）——registry 守卫生效的前提', () => {
    expect(frameWith('a'.repeat(80)).success).toBe(true)
    expect(frameWith('a'.repeat(81)).success).toBe(false)
    expect(frameWith('').success).toBe(false)
  })

  it('registry 与协议同一口径：80 收、81 拒且错误可操作', async () => {
    const registry = makeRegistry()
    const dir = join(root, `nm-${Math.random().toString(36).slice(2)}`)
    await mkdir(dir, { recursive: true })

    const ok = await registry.register(dir, { name: 'a'.repeat(WORKSPACE_NAME_MAX) })
    expect(ok.name).toHaveLength(WORKSPACE_NAME_MAX)

    await expect(registry.register(dir, { name: 'a'.repeat(81) })).rejects.toMatchObject({
      code: 'WORKSPACE_NAME_INVALID',
      message: expect.stringContaining('1-80 characters (protocol bound)'),
    })
    await expect(registry.register(dir, { name: '' })).rejects.toMatchObject({
      code: 'WORKSPACE_NAME_INVALID',
    })
    registry.close()
  })

  it('守卫本地常量与协议上界一致（改协议忘改 registry 时这条先红）', () => {
    expect(WORKSPACE_NAME_MAX).toBe(80)
    // 80 必须可用、81 必须不可用——两侧同时成立才算一致。
    expect(frameWith('a'.repeat(WORKSPACE_NAME_MAX)).success).toBe(true)
    expect(frameWith('a'.repeat(WORKSPACE_NAME_MAX + 1)).success).toBe(false)
  })
})
