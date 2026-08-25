/** SetupTokenStore 单元测试（02 Task 5 Step 3：一次性、0600、恒定时间比较）。 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SetupTokenStore } from '../src/modules/team/setup-token.js'

let dir: string
let store: SetupTokenStore
let tokenPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'p311-setup-token-'))
  tokenPath = join(dir, 'setup-token')
  store = new SetupTokenStore(tokenPath)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SetupTokenStore', () => {
  it('ensure 生成 0600 文件，重复 ensure 不覆盖', async () => {
    await store.ensure()
    const first = await readFile(tokenPath, 'utf8')
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
    await store.ensure()
    expect(await readFile(tokenPath, 'utf8')).toBe(first)
  })

  it('verify 接受正确 Token、拒绝错误 Token；文件缺失时拒绝', async () => {
    await store.ensure()
    const token = await store.read()
    expect(await store.verify(token)).toBe(true)
    expect(await store.verify('wrong')).toBe(false)
    expect(await store.verify(`${token}x`)).toBe(false)
    await store.consume()
    expect(await store.verify(token)).toBe(false)
  })

  it('read 返回 trim 后的明文；verify 容忍文件尾随换行', async () => {
    await store.ensure()
    const token = await store.read()
    await writeFile(tokenPath, `${token}\n`)
    expect(await store.verify(token)).toBe(true)
  })

  it('consume 删除文件；重复 consume 抛错由调用方处理', async () => {
    await store.ensure()
    await store.consume()
    await expect(store.consume()).rejects.toThrow()
  })
})
