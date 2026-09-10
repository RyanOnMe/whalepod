import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, saveConfig, type NodeConfig } from '../src/config.js'

// P1-09：本地配置 mode 0600 往返（02 Task 9 Step 3）。
describe('node local config', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wp-node-cfg-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('保存与读取往返一致，文件 mode 0600', async () => {
    const config: NodeConfig = {
      hubUrl: 'http://127.0.0.1:4242',
      deviceId: 'device-uuid',
      deviceToken: 't'.repeat(43),
    }
    const path = await saveConfig(config, { configDir: dir })
    const loaded = await loadConfig({ path })
    expect(loaded).toEqual(config)
    // 权限断言：明文 Token 所在文件必须 0600。
    const { statSync } = await import('node:fs')
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('配置缺失时 loadConfig 返回 undefined（不抛错）', async () => {
    const loaded = await loadConfig({ path: join(dir, 'missing.json') })
    expect(loaded).toBeUndefined()
  })
})
