/**
 * Runtime 入口的包解析契约（#97）。
 *
 * 成因：`apps/node/src/cli.ts` 用 `createRequire(...).resolve('@project311/runtime/dist/bin.js')`
 * 找 Runtime 子进程入口，而 `apps/runtime/package.json` 的 `exports` 只声明了 `"."`
 * ——深路径解析被 Node 以 ERR_PACKAGE_PATH_NOT_EXPORTED 拒绝，`project311-node start`
 * 启动即死。harness 一直用源文件绝对路径（chain.ts:68 RUNTIME_BIN），从未执行生产
 * 的解析方式，所以缺陷隐身到 #89 的组合根测试才被抓出。
 *
 * 判定基线（真正的不变量，不是"看起来能跑"）：
 * - runtime 包声明的 `bin` 目标，必须能被兄弟包**按 exports 公开子路径**解析到，
 *   且两条路径指向同一个真实存在的文件（exports 与 bin 不得各说各话）；
 * - 辅助锁：cli 源码里用的就是这个子路径说明符——防止以后改了 cli 而测试仍绿。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const RUNTIME_DIR = join(REPO_ROOT, 'apps/runtime')
const NODE_SRC_CLI = join(REPO_ROOT, 'apps/node/src/cli.ts')
/** 约定的公开子路径说明符（不是 dist 深路径：exports 只暴露声明过的入口）。 */
const RUNTIME_BIN_SPECIFIER = '@project311/runtime/bin'

describe('#97 Runtime 入口必须按 exports 公开子路径可解析', () => {
  it('exports 子路径与 package.bin 指向同一真实文件', () => {
    const pkg = JSON.parse(readFileSync(join(RUNTIME_DIR, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>
      exports?: Record<string, unknown>
    }
    const binRel = pkg.bin?.['project311-runtime']
    expect(binRel, 'runtime 包必须声明 bin.project311-runtime').toBeDefined()

    // 从 @project311/node 的模块上下文解析（与 cli.ts 同一依赖视角）。
    const req = createRequire(join(REPO_ROOT, 'apps/node/src/cli.ts'))
    const resolved = req.resolve(RUNTIME_BIN_SPECIFIER)
    expect(resolved).toBe(join(RUNTIME_DIR, binRel!))
    expect(existsSync(resolved)).toBe(true)
  })

  it('生产 cli 用的就是这个说明符（一致性锁，防漂移）', () => {
    const source = readFileSync(NODE_SRC_CLI, 'utf8')
    expect(source).toContain(RUNTIME_BIN_SPECIFIER)
    expect(source).not.toContain('@project311/runtime/dist/bin.js')
  })
})
