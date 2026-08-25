/**
 * Hub 运行配置。环境变量以 PROJECT311_ 为前缀（旧代号 TABTIN_* 属文档暂定标识，
 * 不扩散进新代码）。
 */
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
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  loginMax: 10,
  anonymousMax: 20,
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const publicOrigin = env.PROJECT311_PUBLIC_ORIGIN
  const databaseUrl = env.DATABASE_URL
  if (publicOrigin === undefined || publicOrigin === '') {
    throw new Error('PROJECT311_PUBLIC_ORIGIN 未设置（期望形如 https://hub.example.com）')
  }
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL 未设置')
  }
  return {
    publicOrigin,
    databaseUrl,
    setupTokenPath: env.PROJECT311_SETUP_TOKEN_PATH ?? 'data/setup-token',
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 8080),
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
