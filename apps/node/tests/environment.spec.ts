/**
 * Runtime 环境注入单测（#117）：provider → 凭证环境名是**真值表驱动**，
 * 不是纯派生。
 *
 * 背景（alpha.2 狗食实录，issues #117）：dsh-llm-deepseek 注册的 provider 是
 * `deepseek-official`，其 credential-ref 恒为 `DEEPSEEK_API_KEY`（adapter 包内
 * DEFAULT_API_KEY_ENV）——纯派生 `<PROVIDER>_API_KEY` 会产出
 * `DEEPSEEK_OFFICIAL_API_KEY`，DSH credentials 层序里「继承进程环境」层
 * 认不到这个名字，Run 以 MISSING_CREDENTIAL 败。
 *
 * 判定基线：
 * - deepseek-official + 已配 slot → 注入名恰为 DEEPSEEK_API_KEY，且不出现
 *   派生名 DEEPSEEK_OFFICIAL_API_KEY；
 * - 表外 provider 保持派生约定（'<NORM>_API_KEY'），向后兼容既有行为；
 * - slot 未配置 → spawn 前 MODEL_CREDENTIAL_UNAVAILABLE（原有纪律不破）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRuntimeEnvironment, RuntimeEnvError } from '../src/supervisor/environment.js'
import { SecretStore } from '../src/secret/store.js'

let cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

async function fixture(
  provider: string,
  env: Record<string, string>,
): Promise<{ secrets: SecretStore; workspacePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'p311-env-'))
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const workspacePath = join(root, 'ws')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(workspacePath)
  return {
    secrets: new SecretStore(join(root, 'secrets.json'), env),
    workspacePath,
  }
}

const spec = (provider: string) => ({
  agent: { provider, credentialSlot: 'default', model: 'deepseek-chat' },
})

describe('runtime 环境注入：provider→credential-ref 真值表（#117）', () => {
  it('deepseek-official → 注入 DEEPSEEK_API_KEY（adapter 真值），不产派生名', async () => {
    const { secrets, workspacePath } = await fixture('deepseek-official', {
      PROJECT311_DSH_SECRET_DEEPSEEK_OFFICIAL_DEFAULT: 'sk-real-route',
    })
    const env = buildRuntimeEnvironment(spec('deepseek-official'), {
      workspacePath,
      secrets,
      processEnv: { PATH: '/usr/bin' },
    })
    expect(env['DEEPSEEK_API_KEY']).toBe('sk-real-route')
    expect(env['DEEPSEEK_OFFICIAL_API_KEY']).toBeUndefined()
  })

  it('表外 provider 保持派生约定（向后兼容，dsh → DSH_API_KEY）', async () => {
    const { secrets, workspacePath } = await fixture('dsh', {
      PROJECT311_DSH_SECRET_DSH_DEFAULT: 'sk-legacy',
    })
    const env = buildRuntimeEnvironment(spec('dsh'), {
      workspacePath,
      secrets,
      processEnv: { PATH: '/usr/bin' },
    })
    expect(env['DSH_API_KEY']).toBe('sk-legacy')
  })

  it('slot 未配置 → spawn 前 MODEL_CREDENTIAL_UNAVAILABLE（纪律不破）', async () => {
    const { secrets, workspacePath } = await fixture('deepseek-official', {})
    expect(() =>
      buildRuntimeEnvironment(spec('deepseek-official'), {
        workspacePath,
        secrets,
        processEnv: { PATH: '/usr/bin' },
      }),
    ).toThrowError(/credential not configured: deepseek-official\/default/)
    // 评审补钉：错误种类（RuntimeEnvError.code）一并断言，不只匹配 message。
    try {
      buildRuntimeEnvironment(spec('deepseek-official'), {
        workspacePath,
        secrets,
        processEnv: { PATH: '/usr/bin' },
      })
      expect.unreachable('missing slot must throw')
    } catch (error) {
      expect((error as RuntimeEnvError).code).toBe('MODEL_CREDENTIAL_UNAVAILABLE')
    }
  })
})
