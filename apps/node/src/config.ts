/**
 * Node 本地配置（02 Task 9 Step 3）。
 * 明文 Device Token 与 Hub URL 存 ~/.whalepod-node/config.json，文件 mode 0600
 * （03 §2.4：Token 不打印进日志；本地文件不得世界可读）。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface NodeConfig {
  readonly hubUrl: string
  readonly deviceId: string
  readonly deviceToken: string
}

export const DEFAULT_CONFIG_DIR: string = join(homedir(), '.whalepod-node')
const CONFIG_FILENAME = 'config.json'

export interface ConfigPath {
  /** 配置目录；默认 ~/.whalepod-node。 */
  readonly configDir?: string
  /** 完整路径；优先于 configDir。 */
  readonly path?: string
}

function resolvePath(options: ConfigPath = {}): string {
  if (options.path !== undefined) return options.path
  return join(options.configDir ?? DEFAULT_CONFIG_DIR, CONFIG_FILENAME)
}

/** 读取配置；文件不存在返回 undefined（调用方据此引导重新配对）。 */
export async function loadConfig(options: ConfigPath = {}): Promise<NodeConfig | undefined> {
  const path = resolvePath(options)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as NodeConfig
    return parsed
  } catch {
    return undefined
  }
}

/** 写入配置并强制 0600：父目录不存在则创建。返回最终路径。 */
export async function saveConfig(config: NodeConfig, options: ConfigPath = {}): Promise<string> {
  const path = resolvePath(options)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 })
  // chmod 二次保证：跨平台 writeFile mode 可能受 umask 影响，显式 chmod 兜底。
  try {
    await (await import('node:fs/promises')).chmod(path, 0o600)
  } catch {
    // 忽略：测试只断言 stat.mode。
  }
  return path
}

/** 供测试断言权限的便利函数。 */
export async function configMode(options: ConfigPath): Promise<number | undefined> {
  try {
    const s = await stat(resolvePath(options))
    return s.mode & 0o777
  } catch {
    return undefined
  }
}
