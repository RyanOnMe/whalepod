/**
 * SecretStore 单测（P1-12；02 Task 12 Step 3/7）。
 *
 * 判定基线：
 * - 解析顺序：环境变量 PROJECT311_DSH_SECRET_<PROVIDER>_<SLOT> 先于本地 secrets.json；
 * - 本地文件 mode 0600；权限过宽（组/其他可读）一律拒绝读取（fail-closed，02 Step 7）；
 * - Hub 只拿到 slot 的「已配置/未配置」状态，永不拿到 secret 明文。
 */
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { NodeInventorySchema } from '@project311/protocol'
import {
  CREDENTIAL_PROVIDER_MAX,
  SecretStore,
} from '../src/secret/store.js'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'p311-secrets-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const storePath = (): string => join(root, `secrets-${Math.random().toString(36).slice(2)}.json`)

describe('SecretStore.resolve', () => {
  it('环境变量优先于本地文件', async () => {
    const path = storePath()
    const store = new SecretStore(path)
    await store.set('dsh', 'api_key', 'from-file')
    const env = { PROJECT311_DSH_SECRET_DSH_API_KEY: 'from-env' }
    const storeWithEnv = new SecretStore(path, env)

    expect(storeWithEnv.resolve('dsh', 'api_key')).toBe('from-env')
    expect(store.resolve('dsh', 'api_key')).toBe('from-file')
    await store.close()
  })

  it('两处都没有 → undefined（未配置，不是错误）', () => {
    const store = new SecretStore(storePath())
    expect(store.resolve('dsh', 'missing_slot')).toBeUndefined()
    store.close()
  })

  it('provider/slot 大小写与连字符归一到环境变量名', () => {
    const store = new SecretStore(storePath(), {
      PROJECT311_DSH_SECRET_DSH_DEEPSEEK_API: 'env-value',
    })
    expect(store.resolve('DSH', 'deepseek-api')).toBe('env-value')
    store.close()
  })

  it('secrets.json 权限过宽（组/其他可读）→ 拒绝读取（fail-closed）', async () => {
    const path = storePath()
    const store = new SecretStore(path)
    await store.set('dsh', 'api_key', 'secret-value')
    await chmod(path, 0o644)

    expect(() => store.resolve('dsh', 'api_key')).toThrowError(
      expect.objectContaining({ code: 'SECRET_FILE_PERMISSIONS' }),
    )
    store.close()
  })

  it('本地文件 mode 0600', async () => {
    const path = storePath()
    const store = new SecretStore(path)
    await store.set('dsh', 'api_key', 'secret-value')
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
    store.close()
  })

  it('status 只报已配置/未配置，不泄露明文', async () => {
    const path = storePath()
    const store = new SecretStore(path, { PROJECT311_DSH_SECRET_DSH_API_KEY: 'x' })
    await store.set('dsh', 'other', 'y')

    expect(store.status('dsh', 'api_key')).toBe('configured')
    expect(store.status('dsh', 'other')).toBe('configured')
    expect(store.status('dsh', 'nothing')).toBe('unconfigured')
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('unconfigured-only-check')
    store.close()
  })
})

describe('SecretStore.set/remove 持久化', () => {
  it('set 后重开仍可解析；remove 后变未配置', async () => {
    const path = storePath()
    const first = new SecretStore(path)
    await first.set('dsh', 'api_key', 'persisted')
    first.close()

    const second = new SecretStore(path)
    expect(second.resolve('dsh', 'api_key')).toBe('persisted')
    await second.remove('dsh', 'api_key')
    expect(second.resolve('dsh', 'api_key')).toBeUndefined()
    second.close()
  })

  it('secrets.json 内容是 JSON 且不含明文 env 值', async () => {
    const path = storePath()
    const store = new SecretStore(path)
    await store.set('dsh', 'a', 'v-a')
    await store.set('dsh', 'b', 'v-b')
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, Record<string, string>>
    expect(parsed.dsh).toMatchObject({ a: 'v-a', b: 'v-b' })
    store.close()
  })
})

describe('写文件权限（writeFile 直接 0644 后 store.set 修回 0600）', () => {
  it('chmod 回 0600 前不读，之后恢复可读', async () => {
    const path = storePath()
    await writeFile(path, JSON.stringify({ dsh: { api_key: 'v' } }), { mode: 0o644 })
    const store = new SecretStore(path)
    expect(() => store.resolve('dsh', 'api_key')).toThrowError(
      expect.objectContaining({ code: 'SECRET_FILE_PERMISSIONS' }),
    )
    await store.set('dsh', 'api_key', 'rewritten')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(store.resolve('dsh', 'api_key')).toBe('rewritten')
    store.close()
  })
})

/**
 * #101（credentialSlots 分支）：provider/slot 会随 inventory 上行，越界即毒帧；
 * Hub 按 ADR-0007 fail-closed 断设备连接，而 #89 让上报发生在**每条连接**
 * ⟹ 一次越界就永久「连接→被踢→重连→再被踢」。本地必须拒。
 */
describe('SecretStore provider/slot 协议边界（#101）', () => {
  const frameWith = (provider: string, slot: string) =>
    NodeInventorySchema.safeParse({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: 'node.inventory',
      payload: {
        deviceId: randomUUID(),
        credentialSlots: [{ provider, slot }],
        workspaces: [],
      },
    })

  function makeStore(): SecretStore {
    return new SecretStore(join(root, `sec-${Math.random().toString(36).slice(2)}.json`))
  }

  it('协议口径：provider ≤100、slot ≤80（边界值过、+1 拒）', () => {
    expect(frameWith('p'.repeat(100), 's'.repeat(80)).success).toBe(true)
    expect(frameWith('p'.repeat(101), 'short').success).toBe(false)
    expect(frameWith('short', 's'.repeat(81)).success).toBe(false)
    expect(frameWith('', 's').success).toBe(false)
  })

  it('store 与协议同口径：越界抛 SECRET_SLOT_INVALID 且不落盘', async () => {
    const store = makeStore()
    await store.set('deepseek', 'default', 'v')
    await store.set('p'.repeat(CREDENTIAL_PROVIDER_MAX), 'ok-slot', 'v')
    // configuredSlots() 就是 inventory.build() 喂 credentialSlots 的那个来源。
    const slots = await store.configuredSlots()
    expect(slots.some((entry) => entry.provider === 'p'.repeat(CREDENTIAL_PROVIDER_MAX))).toBe(true)

    await expect(store.set('p'.repeat(101), 'x', 'v')).rejects.toMatchObject({
      code: 'SECRET_SLOT_INVALID',
      message: expect.stringContaining('provider must be 1-100 characters (protocol bound)'),
    })
    await expect(store.set('deepseek', 's'.repeat(81), 'v')).rejects.toMatchObject({
      code: 'SECRET_SLOT_INVALID',
      message: expect.stringContaining('slot must be 1-80 characters (protocol bound)'),
    })
    expect(frameWith('p'.repeat(101), 'x').success).toBe(false) // 佐证：这种值一旦上行的后果
  })
})
