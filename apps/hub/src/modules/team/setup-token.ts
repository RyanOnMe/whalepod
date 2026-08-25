import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { access, readFile, unlink, writeFile } from 'node:fs/promises'

/**
 * 一次性 Setup Token 文件生命周期（02 Task 5 Step 3）。
 * Token 只存在于该文件（mode 0600）与 CLI  stdout；Hub 日志不打印 Token。
 * 成功 setup 后 consume() 删除文件；已初始化实例不再重新生成（server.ts 只在无 Team 时 ensure）。
 */
export class SetupTokenStore {
  constructor(private readonly path: string) {}

  /** 文件已存在则不动；不存在则以 wx + 0600 生成新 Token。 */
  async ensure(): Promise<void> {
    try {
      await access(this.path)
    } catch {
      await writeFile(this.path, randomBytes(32).toString('base64url'), {
        mode: 0o600,
        flag: 'wx',
      })
    }
  }

  /** 读取 Token 明文；仅供 CLI 在尚无 Team 时打印给部署者。 */
  async read(): Promise<string> {
    return (await readFile(this.path, 'utf8')).trim()
  }

  /** 恒定时间比较（双方先取 SHA-256，避免长度泄露与早期退出）。 */
  async verify(candidate: string): Promise<boolean> {
    let expected: string
    try {
      expected = await readFile(this.path, 'utf8')
    } catch {
      return false
    }
    const a = createHash('sha256').update(expected.trim()).digest()
    const b = createHash('sha256').update(candidate).digest()
    return timingSafeEqual(a, b)
  }

  async consume(): Promise<void> {
    await unlink(this.path)
  }
}
