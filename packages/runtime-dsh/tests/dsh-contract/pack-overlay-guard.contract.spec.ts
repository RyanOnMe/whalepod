/**
 * P1-17 契约 —— pack overlay 行契约的机器强制（PR #54 review M11）。
 *
 * bootDshTree 在 pack overlay 入栈前 fail-closed 校验（bridge.ts
 * loadPackOverlay）。vendor applyEntryPatches 的语义（0.1.0-rc.8，
 * lib/index.js 已核实）：id 定位 patch 行 per-key 覆盖既有条目（后层胜——
 * pack 层在栈尾，可改写 dsh-base 核心条目的 config/disabled），同 id insert
 * 不去重（两条都会挂载）。「overlay 只含 insert 行」「pack id 与核心/探针
 * id 空间不相交」由此从约定变成 Runtime 启动门：
 *
 * 1. 携带 id 定位 patch 行（disable 核心条目 llm）的 overlay → boot 失败且
 *    可归因（错误含 overlay 路径 + 行号 + id；校验只拦非契约行，同文件内的
 *    合法 insert 行不改变结论），不发任何帧、slot 不可复用。
 * 2. insert id 与核心 id（llm）冲突的 overlay → boot 失败（vendor 不去重，
 *    双挂必须挡在入栈前）。
 * 3. 反证：拒绝之后同一进程再 boot 合法 insert-only overlay（fixture pack）
 *    照常 ready——校验不误伤合法 pack；探针 extraPatchFiles 通道（replay
 *    层，insert 行）全程由 harness 挂载，ready 即其未被误伤的证据。
 *
 * 驱动走真 DSH boot 回放路径（与 unmodified-plugin.contract 同构）：探针
 * send(initialize) 经 dispatchRuntimeCommand → RuntimeBridge.start →
 * bootDshTree，校验违例即 start 抛错（生产由 bin 转
 * runtime.fatal(RUNTIME_START_FAILED)，错误消息即 summary）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
  type ProbeRuntime,
} from './helpers/replay-runtime.js'
import {
  installCoreOverridePack,
  installFixturePack,
  installIdCollisionPack,
} from './helpers/pack-overlay.js'

const tempRoots: string[] = []
function makePacksRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'whalepod-p1-17-guard-'))
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** start 失败的公共断言：错误可归因、无帧、slot 不可复用、dispose 收敛。 */
async function expectStartRejected(
  runtime: ProbeRuntime,
  spec: ReturnType<typeof runtimeSpec>,
  messageFragments: readonly string[],
): Promise<void> {
  const error: unknown = await runtime.send(initializeCommand(spec)).then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(Error)
  const message = error instanceof Error ? error.message : String(error)
  for (const fragment of messageFragments) {
    expect(message, fragment).toContain(fragment)
  }
  // 无敏感泄露 tripwire（同 unmodified-plugin 崩溃场景）：错误面只是本地
  // overlay 路径与 id，无凭据类材料。
  expect(message).not.toMatch(/api[-_]?key|bearer |authorization/i)

  // start 失败不发任何帧（生产由 bin 转 runtime.fatal；bin 处置表归 stdio 探针）。
  expect(runtime.outputs).toEqual([])

  // bridge 实例不可复用：start 失败后 slot 仍空，后续命令 fail-closed。
  await expect(
    runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'after rejection' })),
  ).rejects.toThrow(/before runtime\.initialize/)

  // 进程协议层不挂死：dispose 收敛干净（boot 未挂树，幂等）。
  await expect(runtime.dispose()).resolves.toBeUndefined()
}

describe('P1-17: pack overlay row contract is machine-enforced at boot', () => {
  it('rejects an overlay carrying an id-targeted patch row and attributes the failure to the row', async () => {
    const tampered = installCoreOverridePack(makePacksRoot())
    const spec = runtimeSpec({ pluginPackOverlayPath: tampered.overlayPath })
    const runtime = await startReplayRuntime('basic', spec)
    try {
      // 归因三要素：overlay 路径（哪个 pack）、行号（哪一行）、id（指向谁）。
      // 第二行才是违例行——第一行合法 insert 不影响结论也不顶罪。
      await expectStartRejected(runtime, spec, [
        tampered.overlayPath,
        'row 2',
        `id: "${tampered.offendingId}"`,
        'id-targeted row',
      ])
    } finally {
      await runtime.dispose()
    }
  })

  it('rejects an overlay whose insert id collides with a core boot-stack id', async () => {
    const tampered = installIdCollisionPack(makePacksRoot())
    const spec = runtimeSpec({ pluginPackOverlayPath: tampered.overlayPath })
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await expectStartRejected(runtime, spec, [
        tampered.overlayPath,
        'row 1',
        `insert id "${tampered.offendingId}" collides with an existing boot-stack layer id`,
      ])
    } finally {
      await runtime.dispose()
    }
  })

  it('still boots a legal insert-only pack overlay (and the probe channel) after the rejections', async () => {
    // 反证：同一进程、同一探针通道（replay.yml 仍在 extraPatchFiles）下，
    // 合法 insert-only overlay 照常 ready——校验只拦非契约行。
    const pack = installFixturePack(makePacksRoot())
    const spec = runtimeSpec({
      pluginPackDigest: pack.packDigest,
      pluginPackOverlayPath: pack.overlayPath,
    })
    const runtime = await startReplayRuntime('basic', spec)
    try {
      await runtime.send(initializeCommand(spec))
      const ready = await runtime.until('runtime.ready')
      expect(ready.payload).toMatchObject({ runId: spec.runId })
    } finally {
      await runtime.dispose()
    }
  })
})
