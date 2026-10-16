/**
 * 探针：DSH 发行版身份自报（#288）。
 *
 * 熔断规则「敏感不兼容禁启动」的左侧操作数不该是操作者声明的字符串，而应是
 * Runtime 真要加载的那棵安装树。判据：`dshDistributionInfo()` 报出的 name/version
 * 与 boot 锚（bridge 的 bare plugin 解析锚，同一个 `@deepseek-ai/dsh/package.json`
 * realpath）指向的 package.json 一致——报错源、或换一个包当版本源，本探针即红。
 */
import { readFileSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ExactVersionSchema } from '@whalepod/protocol'
import { dshAnchorUrl, dshDistributionInfo } from '../../src/index.js'

describe('probe: DSH distribution identity（#288）', () => {
  it('自报版本 = boot 锚那棵树里的 @deepseek-ai/dsh 版本（精确版本）', () => {
    const info = dshDistributionInfo()
    const anchorPath = fileURLToPath(dshAnchorUrl())
    const packageJson = JSON.parse(readFileSync(anchorPath, 'utf8')) as {
      name: string
      version: string
    }
    expect(info.name).toBe(packageJson.name)
    expect(info.version).toBe(packageJson.version)
    expect(info.packageDir).toBe(dirname(realpathSync(anchorPath)))
    // 红线（03 §2.5）：DSH 锁精确版本，不接受 range/latest——自报值必须过同一个 schema。
    expect(ExactVersionSchema.safeParse(info.version).success).toBe(true)
  })
})
