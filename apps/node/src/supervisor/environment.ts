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
  env[`${providerKey}_API_KEY`] = secret
  return env
}
