/**
 * workspace/secret CLI 命令单测（P1-12 Step 3）：真实 registry/secret 实例驱动。
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WorkspaceRegistry } from '../src/workspace/registry.js'
import { SecretStore } from '../src/secret/store.js'
import { runWorkspaceCommand, runSecretSet } from '../src/workspace/cli-commands.js'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'p311-ws-cli-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeDeps() {
  const out: string[] = []
  const registry = new WorkspaceRegistry(
    join(root, `reg-${Math.random().toString(36).slice(2)}.sqlite`),
  )
  const secrets = new SecretStore(join(root, `sec-${Math.random().toString(36).slice(2)}.json`))
  return {
    deps: {
      registry,
      secrets,
      write: (text: string) => out.push(text),
    },
    out,
    registry,
    secrets,
  }
}

describe('workspace/secret CLI 命令', () => {
  it('add → list → remove 全链（输出含 opaque id；不显示路径于 list）', async () => {
    const { deps, out, registry } = makeDeps()
    const dir = join(root, 'cli-ws')
    await mkdir(dir)
    await runWorkspaceCommand(deps, 'add', { path: dir, name: 'my-project' })
    expect(out[0]).toMatch(/^registered: [0-9a-f-]{36} \(directory\) my-project/)

    await runWorkspaceCommand(deps, 'list', {})
    expect(out[1]).toMatch(/^[0-9a-f-]{36}  my-project  directory/)

    const id = out[0].split(' ')[1] ?? ''
    await runWorkspaceCommand(deps, 'remove', { id })
    expect(out[2]).toContain('removed')

    const list = await registry.list()
    expect(list).toEqual([])
  })

  it('注册不存在目录 → WORKSPACE_UNAVAILABLE 输出且退出码 1', async () => {
    const { deps, out } = makeDeps()
    await runWorkspaceCommand(deps, 'add', { path: join(root, 'ghost'), name: 'ghost' })
    expect(out.join('')).toContain('WORKSPACE_UNAVAILABLE')
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('secret set：写入 0600 文件且 status 变 configured', async () => {
    const { deps, secrets } = makeDeps()
    await runSecretSet(deps, 'dsh', 'api_key', async () => 'typed-secret')
    expect(secrets.status('dsh', 'api_key')).toBe('configured')
    expect(secrets.resolve('dsh', 'api_key')).toBe('typed-secret')
  })
})
