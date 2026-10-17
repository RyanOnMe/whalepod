/**
 * #352：设备事实（`node.hello`）的**装配面**——hello 事实按连接重算，且本地 pack
 * 装/重建后**会话内**补发一次 hello。抽成模块的理由：cli.ts 与 E2E node harness
 * 都是「生产装配」的一部分（#99），刷新语义只能有一份实现，判据才打得住。
 *
 * 两件事：
 * 1. `createHelloFacts(...)`：返回**函数**而不是冻结对象——进程/平台/架构是常量；
 *    `pluginPackDigests` 每次读盘（preflight 装/重建后立刻可见）；`dshDistributionVersion`
 *    每次重探（#288 的同一支探针，与 boot 锚同源），探针失败回落启动值（升级场景下
 *    宁可报旧值也不谎报）。重探成本 = 一次短命 node spawn，只在（重）连接时发生。
 * 2. `refreshHelloAfterPreflight(...)`：包一层 preflight——非 core-empty 的装配成功后
 *    调 `resendHello()`（设备视图不等重连/重启收敛；core-empty 不落盘，无需补发）。
 *
 * 语义边界：`resendHello` 是 no-op 当无活连接时——下条连接的 hello 本就会重算。
 */
import { join } from 'node:path'
import { CORE_EMPTY_PACK_DIGEST } from '../plugin/plugin-preflight.js'
import { installedPackDigests } from '../plugin/runtime-config.js'
import { probeDshDistributionVersion } from '../plugin/dsh-version-probe.js'
import type { HelloFacts } from './hub-socket.js'

export interface HelloFactsInputs {
  readonly stateDir: string
  /** Runtime 入口（`@whalepod/runtime/bin` 的解析结果）：探针要真 bin。 */
  readonly runtimeEntry: string
  /** 启动时的探针结果（`resolveDshVersionFacts(...).reported`）：重探失败时的回落值。 */
  readonly startupDshVersion: string
  /** 探针注入点（测试与 harness 可替换；缺省走真 spaw）。 */
  readonly probeDshVersion?: (runtimeEntry: string) => Promise<string | null>
}

export function createHelloFacts(inputs: HelloFactsInputs): () => Promise<HelloFacts> {
  const probe = inputs.probeDshVersion ?? probeDshDistributionVersion
  return async () => ({
    nodeVersion: process.version,
    platform: (process.platform === 'linux' ? 'linux' : 'darwin') as HelloFacts['platform'],
    architecture: process.arch,
    // pack 目录当场读（marker 校验通过才计入；半途/损坏目录不上报）。
    pluginPackDigests: installedPackDigests(join(inputs.stateDir, 'plugin-packs')),
    dshDistributionVersion:
      (await probe(inputs.runtimeEntry).catch(() => null)) ?? inputs.startupDshVersion,
  })
}

export interface HelloRefreshDeps<T> {
  /** 真 preflight（`PluginPackPreflight.ensure` 的绑定形态）。 */
  readonly ensure: (packDigest: string) => Promise<T>
  /** 会话句柄上的补发（`startDeviceSession(...).resendHello`）。 */
  readonly resendHello: () => void
  /** core-empty 判定（生产传 `CORE_EMPTY_PACK_DIGEST`；测试可覆盖）。 */
  readonly isCoreEmpty?: (packDigest: string) => boolean
}

/**
 * preflight 成功（非 core-empty）后补发一次 hello。返回的仍是同一个 ensure 语义
 * （透传结果与异常）——刷新失败不改变 preflight 的成败。
 */
export function refreshHelloAfterPreflight<T>(
  deps: HelloRefreshDeps<T>,
): (packDigest: string) => Promise<T> {
  const isCoreEmpty =
    deps.isCoreEmpty ?? ((packDigest: string) => packDigest === CORE_EMPTY_PACK_DIGEST)
  return async (packDigest: string) => {
    const outcome = await deps.ensure(packDigest)
    if (!isCoreEmpty(packDigest)) deps.resendHello()
    return outcome
  }
}
