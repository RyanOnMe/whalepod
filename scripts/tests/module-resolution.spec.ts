import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// 静态 import 走真人路径：修复失效时这里最先炸（解析失败回退 dist、或模块根本
// 加载不出来）。protocol 子路径也一并静态引入，覆盖 exports 的第二个入口。
import * as protocol from '@whalepod/protocol'
import * as protocolDigest from '@whalepod/protocol/plugin-pack-digest'
import * as domain from '@whalepod/domain'
import * as db from '@whalepod/db'
import * as runtimeDsh from '@whalepod/runtime-dsh'
import * as testkit from '@whalepod/testkit'

// #35：workspace 包在 vitest 下的解析契约——测试打 src，不打陈旧 dist。
// 机制：各包 exports 带 development 条件（→ ./src/*.ts）；vitest 的 server
// 解析条件含 development，于是 vitest 面永远选 src。tsx 直跑的 scripts
// （phase1-drive 等）与生产解析不带该条件、仍走 default → dist——所以
// 「改 src 后跑 tsx scripts」仍需先 `pnpm typecheck` 重建 dist。红绿证据
// 与边界见 docs/agent/module-resolution-acceptance.md。本 spec 是机器
// 判据：development 条件被删除、或解析退回 dist 时，这里必须红。
const packagesRoot = fileURLToPath(new URL('../../packages/', import.meta.url))
const workspacePackages = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

const staticallyImported: Record<string, unknown> = {
  domain,
  protocol,
  db,
  'runtime-dsh': runtimeDsh,
  testkit,
}

describe('vitest 把 @whalepod/* 解析到 src（#35）', () => {
  for (const name of workspacePackages) {
    it(`@whalepod/${name} 解析到 src 且可静态 import`, () => {
      const resolved = import.meta.resolve(`@whalepod/${name}`)
      expect(resolved, resolved).toMatch(new RegExp(`/packages/${name}/src/index\\.ts$`))
      // 真实加载过（而非仅路径断言）：namespace 里应当有本包的导出。
      expect(Object.keys(staticallyImported[name] as object).length).toBeGreaterThan(0)
    })
  }

  it('@whalepod/protocol/plugin-pack-digest 子路径同样打到 src', () => {
    const resolved = import.meta.resolve('@whalepod/protocol/plugin-pack-digest')
    expect(resolved, resolved).toMatch(/\/packages\/protocol\/src\/plugin-pack-digest\.ts$/)
    expect(Object.keys(protocolDigest).length).toBeGreaterThan(0)
  })
})
