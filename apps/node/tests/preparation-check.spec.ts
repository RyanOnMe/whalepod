import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceRegistry } from '../src/workspace/registry.js'
import { SecretStore } from '../src/secret/store.js'
import { checkPreparation } from '../src/workspace/preparation.js'
let root: string
let registry: WorkspaceRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp-prepare-'))
  registry = new WorkspaceRegistry(join(root, 'registry.sqlite'))
  await mkdir(join(root, 'work'))
})
afterEach(async () => {
  registry.close()
  await rm(root, { recursive: true, force: true })
})
describe('准备检查用生产本机事实（#320）', () => {
  it('确认真实工作目录与文件凭据，不返回秘密和路径', async () => {
    const ws = await registry.register(join(root, 'work'), { name: 'work' })
    const secrets = new SecretStore(join(root, 'secrets.json'), {})
    await secrets.set('provider', 'default', 'fixture-key-for-preparation')
    const result = await checkPreparation(
      { workspaceId: ws.id, provider: 'provider', credentialSlot: 'default' },
      { registry, secrets },
    )
    expect(result).toEqual({ workspace: 'available', credential: 'configured' })
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain('fixture-key-for-preparation')
  })
  it('环境变量凭据与缺失状态使用真实resolve，不依赖inventory清单', async () => {
    const ws = await registry.register(join(root, 'work'), { name: 'work' })
    const secrets = new SecretStore(join(root, 'secrets.json'), {
      WHALEPOD_DSH_SECRET_PROVIDER_DEFAULT: 'fixture-env-key',
    })
    expect(
      await checkPreparation(
        { workspaceId: ws.id, provider: 'provider', credentialSlot: 'default' },
        { registry, secrets },
      ),
    ).toEqual({ workspace: 'available', credential: 'configured' })
    expect(
      await checkPreparation(
        { workspaceId: ws.id, provider: 'missing', credentialSlot: 'default' },
        { registry, secrets },
      ),
    ).toEqual({ workspace: 'available', credential: 'unconfigured' })
  })
  it('已移除目录和凭据权限失败不得显示就绪', async () => {
    const ws = await registry.register(join(root, 'work'), { name: 'work' })
    const secrets = new SecretStore(join(root, 'secrets.json'), {})
    await secrets.set('provider', 'default', 'fixture-key-for-preparation')
    await chmod(join(root, 'secrets.json'), 0o644)
    await rm(join(root, 'work'), { recursive: true })
    expect(
      await checkPreparation(
        { workspaceId: ws.id, provider: 'provider', credentialSlot: 'default' },
        { registry, secrets },
      ),
    ).toEqual({ workspace: 'unavailable', credential: 'unconfirmed' })
  })
})
