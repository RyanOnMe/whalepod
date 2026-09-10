/**
 * Hub 运行配置。环境变量以 WHALEPOD_ 为前缀（定名 #133 前的旧前缀 TABTIN_ 与
 * PROJECT311_ 已全量替换，不再接受）。
 */
import { fileURLToPath } from 'node:url'

export interface RateLimitConfig {
  /** 固定窗口长度，默认 15 分钟。 */
  readonly windowMs: number
  /** 登录：每 IP + username 每窗口 10 次。 */
  readonly loginMax: number
  /** Setup / Invite accept：每 IP 每窗口 20 次。 */
  readonly anonymousMax: number
}

export interface HubConfig {
  /** 浏览器访问 Hub 的精确 Origin（scheme://host[:port]），非安全方法逐字节比对。 */
  readonly publicOrigin: string
  readonly databaseUrl: string
  /** 一次性 Setup Token 文件路径（mode 0600，成功 setup 后删除）。 */
  readonly setupTokenPath: string
  readonly host: string
  readonly port: number
  readonly rateLimit?: RateLimitConfig | undefined
  /**
   * Curated 插件 catalog 目录（catalog/*.json + locks/*.lock.yaml，02 Task 17）。
   * 缺省 = 仓库根 plugins/（见 defaultPluginCatalogDir）。
   */
  readonly pluginCatalogDir?: string | undefined
  /** 显式 dev mode：仅此开关打开时允许安装 local-development 清单（默认 fail-closed 拒绝）。 */
  readonly pluginDevMode?: boolean | undefined
  /**
   * #113：反代形态开关（透传 fastify trustProxy）。true ⟹ request.ip 取 XFF
   * 首跳，按 IP 速率限制按真实客户端分桶（nginx 已注入 X-Forwarded-For）；
   * false（默认，直连形态）⟹ 忽略 XFF，伪造头骗不到限流/审计。
   */
  readonly trustProxy?: boolean | undefined
  /**
   * 内容寻址 Artifact Store 根目录（P1-15；blob 树 sha256/ab/cd/<digest> + tmp/）。
   */
  readonly artifactStoreDir: string
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  loginMax: 10,
  anonymousMax: 20,
}

/**
 * 默认 curated catalog 目录：仓库根 plugins/。本文件的 src 与 dist 形态都位于
 * 仓库根下三级（apps/hub/src|dist），../../../ 恒解析回仓库根——不依赖进程 cwd。
 */
export function defaultPluginCatalogDir(): string {
  return fileURLToPath(new URL('../../../plugins', import.meta.url))
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const publicOrigin = env.WHALEPOD_PUBLIC_ORIGIN
  const databaseUrl = env.DATABASE_URL
  if (publicOrigin === undefined || publicOrigin === '') {
    throw new Error('WHALEPOD_PUBLIC_ORIGIN 未设置（期望形如 https://hub.example.com）')
  }
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL 未设置')
  }
  return {
    publicOrigin,
    databaseUrl,
    setupTokenPath: env.WHALEPOD_SETUP_TOKEN_PATH ?? 'data/setup-token',
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 8080),
    pluginCatalogDir: env.WHALEPOD_PLUGIN_CATALOG_DIR,
    // 显式开关：仅 '1'/'true' 视为开启，其余（含未设置）一律关闭。
    pluginDevMode: env.WHALEPOD_PLUGIN_DEV_MODE === '1' || env.WHALEPOD_PLUGIN_DEV_MODE === 'true',
    // #113：同形态显式开关——compose（nginx 反代）置 true；直连默认 false，
    // 否则直连部署反而被伪造 XFF 骗过限流。
    trustProxy: env.WHALEPOD_TRUST_PROXY === '1' || env.WHALEPOD_TRUST_PROXY === 'true',
    artifactStoreDir: env.WHALEPOD_ARTIFACT_STORE_DIR ?? 'data/artifact-store',
  }
}

/**
 * Cookie Secure 策略（02 Task 5 Step 5）：localhost 开发允许 Secure=false，
 * 其他 public origin 强制 Secure=true。
 */
export function isSecureCookieRequired(publicOrigin: string): boolean {
  const { hostname } = new URL(publicOrigin)
  return hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1'
}
