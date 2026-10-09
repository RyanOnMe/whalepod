/**
 * #99-A：harness 的 Runtime 入口必须与生产同一装配（包解析 dist 产物，
 * 不用源码路径）。TDD 红测试：RUNTIME_BIN 不得指向 src/，必须等于
 * node 上下文下 `@whalepod/runtime/bin` 的解析结果。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

describe('#99-A RUNTIME_BIN walks the production assembly', () => {
  it('chain.ts 的 RUNTIME_BIN 等于包解析产物（非 src 路径）', async () => {
    const chain = (await import('./lib/phase1/chain.js')) as {
      RUNTIME_BIN: string
    }
    expect(chain.RUNTIME_BIN).not.toContain('/src/')
    const req = createRequire(join(REPO_ROOT, 'apps/node/src/cli.ts'))
    expect(chain.RUNTIME_BIN).toBe(req.resolve('@whalepod/runtime/bin'))
    expect(existsSync(chain.RUNTIME_BIN)).toBe(true)
  })
})
