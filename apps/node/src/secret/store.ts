/**
 * SecretStore（P1-12；02 Task 12 Step 3、03 §2.4）。
 *
 * 解析顺序：环境变量 PROJECT311_DSH_SECRET_<PROVIDER>_<SLOT> → 本地 secrets.json。
 * Hub 只知道 credential slot 名与「已配置/未配置」（inventory 上报形态），永不获取明文。
 * 本地文件 mode 0600；发现权限过宽（组/其他位非零）一律拒绝读取——fail-closed，
 * 静态保护依赖操作系统账号（文档明示），权限护栏是最后的机器可查防线。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, readFile, rename, writeFile } from 'node:fs/promises'

export class SecretError extends Error {
  constructor(
    readonly code: 'SECRET_FILE_PERMISSIONS',
    message: string,
  ) {
    super(message)
    this.name = 'SecretError'
  }
}

export type SecretStatus = 'configured' | 'unconfigured'

interface SecretFileShape {
  [provider: string]: { [slot: string]: string }
}

function envVarName(provider: string, slot: string): string {
  const normalize = (part: string): string => part.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  return `PROJECT311_DSH_SECRET_${normalize(provider)}_${normalize(slot)}`
}

export class SecretStore {
  constructor(
    private readonly storePath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** 解析最小凭据；两处都没有返回 undefined（未配置不是错误，spawn 前再判定）。 */
  resolve(provider: string, slot: string): string | undefined {
    const fromEnv = this.env[envVarName(provider, slot)]
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    return this.readFromFile(provider, slot)
  }

  /** 本地文件已配置的 (provider, slot) 清单；inventory 只上报 slot 名。 */
  async configuredSlots(): Promise<Array<{ provider: string; slot: string }>> {
    const data = this.readWholeFile(false)
    const slots: Array<{ provider: string; slot: string }> = []
    for (const provider of Object.keys(data).sort()) {
      for (const slot of Object.keys(data[provider] ?? {}).sort()) {
        slots.push({ provider, slot })
      }
    }
    return slots
  }

  /** inventory 上报形态：只报状态。 */
  status(provider: string, slot: string): SecretStatus {
    return this.resolve(provider, slot) === undefined ? 'unconfigured' : 'configured'
  }

  /** 交互写入（CLI 从 TTY 无回显读取后调用）；文件恒定 0600。 */
  async set(provider: string, slot: string, value: string): Promise<void> {
    const data = this.readWholeFile(false)
    data[provider] = { ...data[provider], [slot]: value }
    await this.writeWholeFile(data)
  }

  /** 接口对称（与其他 store 一致）；文件型 store 无需释放资源。 */
  close(): void {}

  async remove(provider: string, slot: string): Promise<void> {
    const data = this.readWholeFile(false)
    if (data[provider] === undefined) return
    delete data[provider][slot]
    if (Object.keys(data[provider]).length === 0) delete data[provider]
    await this.writeWholeFile(data)
  }

  private assertPermissions(): void {
    if (!existsSync(this.storePath)) return
    // stat 同步版足够（本地小文件）；权限位含组/其他任何位即拒绝。
    const mode = statSync(this.storePath).mode & 0o777
    if ((mode & 0o077) !== 0) {
      throw new SecretError(
        'SECRET_FILE_PERMISSIONS',
        `secrets file must be 0600, got ${mode.toString(8)}`,
      )
    }
  }

  private readWholeFile(gate: boolean): SecretFileShape {
    if (!existsSync(this.storePath)) return {}
    // 读路径（resolve/status）对宽权限 fail-closed；写路径（set/remove）由
    // 本 store 独占该文件，读原始内容合并后以 0600 原子替换，顺带修复权限。
    if (gate) this.assertPermissions()
    const raw = readFileSync(this.storePath, 'utf8')
    if (raw.trim() === '') return {}
    return JSON.parse(raw) as SecretFileShape
  }

  private readFromFile(provider: string, slot: string): string | undefined {
    if (!existsSync(this.storePath)) return undefined
    const data = this.readWholeFile(true)
    return data[provider]?.[slot]
  }

  private async writeWholeFile(data: SecretFileShape): Promise<void> {
    // 先 0600 写临时文件再改名：避免半写状态与宽权限窗口。
    const tmpPath = `${this.storePath}.${randomUUID()}.tmp`
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    await rename(tmpPath, this.storePath)
    // chmod 兜底：跨平台 writeFile mode 受 umask 影响（与 apps/node/src/config.ts 同策略）。
    await chmod(this.storePath, 0o600)
  }
}
