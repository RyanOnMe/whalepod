/**
 * Runtime 子进程环境白名单（P1-12；02 Task 12 Step 5）。
 *
 * 白名单：PATH、locale、临时目录，加 SecretStore 为该 provider/slot 解析的
 * 最小模型凭据（键形 `<PROVIDER>_API_KEY`）。其余一律剔除——Hub/Device Token、
 * SSH agent、其他 provider key、云平台 metadata 凭据都进不了 Runtime。
 * 凭据缺失在 spawn 前即抛 MODEL_CREDENTIAL_UNAVAILABLE（Runtime 一个不启动）。
 */
import { isAbsolute, join } from 'node:path'
import type { RuntimeStartSpec } from '../runtime-driver.js'
import type { SecretStore } from '../secret/store.js'

export class RuntimeEnvError extends Error {
  constructor(
    readonly code: 'MODEL_CREDENTIAL_UNAVAILABLE' | 'INVALID_WORKSPACE',
    message: string,
  ) {
    super(message)
    this.name = 'RuntimeEnvError'
  }
}

/**
 * provider → credential-ref 环境名真值表（#117）。
 *
 * 默认约定是派生 `<PROVIDER>_API_KEY`；但真值源是各 DSH adapter 包内的
 * credential-ref 默认（如 dsh-llm-deepseek 的 DEFAULT_API_KEY_ENV），二者
 * 不一致时必须以 adapter 为准——alpha.2 狗食实录：`deepseek-official` 纯
 * 派生得 DEEPSEEK_OFFICIAL_API_KEY，DSH credentials「继承进程环境」层认
 * 不到此名，Run 以 MISSING_CREDENTIAL 败。
 * 新 provider 入表前必须核对其 adapter 的 credential-ref 默认值并留出处。
 */
const CREDENTIAL_ENV_OVERRIDES: Readonly<Record<string, string>> = {
  // dsh-llm-deepseek@0.1.0-rc.8 lib/index.js：PROVIDER='deepseek-official'，
  // DEFAULT_API_KEY_ENV='DEEPSEEK_API_KEY'（settings 段 llm-deepseek 的
  // apiKeyEnv 默认）。
  'deepseek-official': 'DEEPSEEK_API_KEY',
}

export function buildRuntimeEnvironment(
  spec: RuntimeStartSpec,
  ctx: {
    workspacePath: string
    secrets: SecretStore
    processEnv: NodeJS.ProcessEnv
    /**
     * 额外透传的变量名白名单（默认空）。生产 cli 不传；验收链路（G4-04/Q3
     * replay overlay）显式列入 DSH_SNAPSHOT_FILE 等 replay 变量——这是 04 文档
     * 契约探针的一等概念，不是后门（名字显式列出，值仍来自进程环境）。
     */
    extraPassthrough?: readonly string[]
  },
): NodeJS.ProcessEnv {
  if (!isAbsolute(ctx.workspacePath)) {
    throw new RuntimeEnvError('INVALID_WORKSPACE', 'workspace path must be canonical absolute')
  }
  const env: NodeJS.ProcessEnv = {}
  if (ctx.processEnv.PATH !== undefined) env.PATH = ctx.processEnv.PATH
  if (ctx.processEnv.LANG !== undefined) env.LANG = ctx.processEnv.LANG
  if (ctx.processEnv.LC_ALL !== undefined) env.LC_ALL = ctx.processEnv.LC_ALL
  env.TMPDIR = ctx.processEnv.TMPDIR ?? join(ctx.workspacePath, '.p311-tmp')

  for (const name of ctx.extraPassthrough ?? []) {
    const value = ctx.processEnv[name]
    if (value !== undefined) env[name] = value
  }

  const secret = ctx.secrets.resolve(spec.agent.provider, spec.agent.credentialSlot)
  if (secret === undefined) {
    throw new RuntimeEnvError(
      'MODEL_CREDENTIAL_UNAVAILABLE',
      `credential not configured: ${spec.agent.provider}/${spec.agent.credentialSlot}`,
    )
  }
  const providerKey = spec.agent.provider.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  const credentialEnv = CREDENTIAL_ENV_OVERRIDES[spec.agent.provider] ?? `${providerKey}_API_KEY`
  env[credentialEnv] = secret
  return env
}
