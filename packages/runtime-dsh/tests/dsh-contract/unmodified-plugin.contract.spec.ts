/**
 * P1-17 契约 —— 未修改 DSH 插件经 Plugin Pack overlay 装入 Runtime
 * （02 Task 17 Step 1 正例与 Step 8「插件崩溃不影响 Hub」的 Runtime 侧一半）。
 *
 * 三条链（fixture 驱动的是 LLM 出口回放；工具在 Runtime 真实执行——
 * 这才是「未修改插件工作」的证据，不是把工具结果录进 fixture）：
 *
 * 1. 正例：Node preflight 形状的 pack overlay 经 RuntimeSpec.pluginPackOverlayPath
 *    挂进 boot 栈后，replay 回放一次 fixed_time 工具调用；Run 态审批闸对插件
 *    工具一视同仁（session-owner 对每次工具调用 ask——「插件安装不等于永久
 *    授权」，02 Task 17 Step 6），按 approval 契约 allowed_once 放行后，经
 *    session.event 投影断言工具结果（fixture 源码内联定值
 *    { iso: '2030-01-02T03:04:05.000Z' }——只有 overlay 指向的源码被真实加载
 *    并执行才可能产出）。
 * 2. digest 三阶段锚：catalog integrity（SRI）== committed tarball 字节 ==
 *    runtime 实际加载的 tmp 安装树（全成员字节级）——catalog ↔ tarball ↔
 *    被加载树闭环；apps/node 侧已验 tarball == fixture 源（plugin-installer
 *    探针），本场景补「runtime 加载的就是 catalog 登记的那份」。
 * 3. 崩溃隔离：apply() 即抛错的插件 overlay 使 RuntimeBridge.start
 *    fail-closed——错误可归因（含插件 id/路径与插件自身报错，无凭据类材料）、
 *    bridge 实例不可复用（slot 未初始化，后续命令 fail-closed）、boot 自行
 *    dispose 残树、进程协议层不挂死（同进程再 boot 照常 ready）。
 *
 * overlay 行形状与 apps/node/src/plugin/runtime-config.ts 互为镜像，安装布局
 * 与渲染细节见 helpers/pack-overlay.ts 头注。
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRuntimeFrame, type RuntimeOutput } from '@whalepod/protocol'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
  type ProbeRuntime,
} from './helpers/replay-runtime.js'
import {
  committedTarballPath,
  installCrashPluginPack,
  installFixturePack,
  readTarballEntries,
} from './helpers/pack-overlay.js'

function sessionEventsOf(outputs: readonly RuntimeOutput[]): { type: string; data: unknown }[] {
  return outputs
    .filter((frame) => frame.type === 'session.event')
    .map((frame) => frame.payload.event as { type: string; data: unknown })
}

/** 等到 type 类型的 output 帧累计出现 minimum 次（run.completed 等无差别帧的第 N 次）。 */
async function untilOutputCount(
  runtime: ProbeRuntime,
  type: RuntimeOutput['type'],
  minimum: number,
): Promise<void> {
  for (;;) {
    if (runtime.outputs.filter((frame) => frame.type === type).length >= minimum) return
    // 挂起等「在此之后到达」的下一帧该类型帧：until 的谓词按帧位置排除已见帧
    // （run.completed 帧形状无差别，只能按到达次序区分）。
    const seen = runtime.outputs.length
    await runtime.until(type, (frame) => runtime.outputs.indexOf(frame) >= seen)
  }
}

const tempRoots: string[] = []
function makePacksRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'whalepod-p1-17-packs-'))
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('P1-17: unmodified DSH plugin via Runtime Plugin Pack overlay', () => {
  it('loads the unmodified fixed_time plugin from the pack overlay and executes it end to end', async () => {
    const pack = installFixturePack(makePacksRoot())
    const spec = runtimeSpec({
      pluginPackDigest: pack.packDigest,
      pluginPackOverlayPath: pack.overlayPath,
    })
    // wire 形状：pluginPackOverlayPath 随 runtime.initialize 过 RuntimeCommandSchema
    // （packages/protocol runtime-wire 已 generate 的可选字段）。
    expect(() => parseRuntimeFrame(initializeCommand(spec), 'command')).not.toThrow()

    const runtime = await startReplayRuntime('unmodified-plugin', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')

      await runtime.send(
        commandFrame('run.prompt', { runId: spec.runId, text: 'Call fixed_time exactly once.' }),
      )

      // Run 态审批闸（session-owner 对每次工具调用 ask）先于工具解析：插件工具
      // 一样被拦，一次 allowed_once 放行（一次性授权，无永久面）。
      const requested = await runtime.until('approval.requested', (frame) => {
        return frame.payload.toolName === 'fixed_time'
      })
      expect(requested.payload.callId).toBe('call-fixed-time-1')
      await runtime.send(
        commandFrame('approval.decide', {
          runId: spec.runId,
          callId: requested.payload.callId,
          decision: 'allowed_once',
        }),
      )

      await runtime.until('run.completed')

      // session.event 投影（不爬日志）：tool/call 原样到达，tool/result 成功且
      // 含 fixture 源码内联的定值（02 Task 17 Step 1 的期望值逐字节）。
      const events = sessionEventsOf(runtime.outputs)
      const call = events.find((event) => event.type === 'tool/call')?.data as
        | { name: string; arguments: string }
        | undefined
      expect(call).toBeDefined()
      expect(call).toMatchObject({ name: 'fixed_time', arguments: '{}' })

      const result = events.find((event) => event.type === 'tool/result')
      const serialized = JSON.stringify(result?.data ?? {})
      expect(serialized).not.toContain('"isError":true')
      expect(serialized).toContain('2030-01-02T03:04:05.000Z')

      // followup turn：pack 插件注册随整棵树存活，回放的第二 turn 正常收尾。
      await runtime.send(
        commandFrame('run.followup', { runId: spec.runId, text: 'Anything else?' }),
      )
      const followupMessage = await runtime.until('session.event', (frame) => {
        const event = frame.payload.event as { type?: string; data?: { turn?: number } }
        return event.type === 'assistant/message' && event.data?.turn === 2
      })
      expect(JSON.stringify(followupMessage.payload.event)).toContain(
        'Follow-up turn after the fixed_time call.',
      )
      await untilOutputCount(runtime, 'run.completed', 2)
    } finally {
      await runtime.dispose()
    }
  })

  it('cannot execute the plugin tool without the pack overlay (the overlay is what mounts it)', async () => {
    // 反证：同一回放、同一审批放行，缺 overlay 时 fixed_time 未注册——
    // allowed_once 后 dispatch 落 ToolNotFoundError，结果 isError 且无定值。
    const spec = runtimeSpec()
    const runtime = await startReplayRuntime('unmodified-plugin', spec)
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(
        commandFrame('run.prompt', { runId: spec.runId, text: 'Call fixed_time exactly once.' }),
      )
      const requested = await runtime.until('approval.requested', (frame) => {
        return frame.payload.toolName === 'fixed_time'
      })
      await runtime.send(
        commandFrame('approval.decide', {
          runId: spec.runId,
          callId: requested.payload.callId,
          decision: 'allowed_once',
        }),
      )
      await runtime.until('run.completed')

      const events = sessionEventsOf(runtime.outputs)
      const result = events.find((event) => event.type === 'tool/result')
      const serialized = JSON.stringify(result?.data ?? {})
      expect(serialized).toContain('"isError":true')
      expect(serialized).not.toContain('2030-01-02T03:04:05.000Z')
    } finally {
      await runtime.dispose()
    }
  })

  it('anchors the loaded pack tree to the catalog integrity (catalog ↔ tarball ↔ installed tree)', async () => {
    const pack = installFixturePack(makePacksRoot())
    const tarball = readFileSync(committedTarballPath())

    // 阶段一 catalog ↔ committed tarball：SRI integrity 覆盖 tarball 字节。
    const sri = `sha256-${createHash('sha256').update(tarball).digest('base64')}`
    expect(sri).toBe(pack.manifest.integrity)

    // 阶段二 committed tarball ↔ runtime 实际加载的安装树：tarball 全部文件成员
    // 字节级相等（最强可机判形式——不是只锚 entrypoint，整树都被覆盖）。
    const installedRoot = join(pack.packDir, 'node_modules', pack.manifest.name)
    const entries = readTarballEntries(tarball)
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.path.startsWith('package/'), entry.path).toBe(true)
      const relative = entry.path.slice('package/'.length)
      expect(readFileSync(join(installedRoot, relative)), entry.path).toEqual(entry.content)
    }

    // 阶段三 pack 身份：spec.pluginPackDigest / overlay 头 / overlay specifier
    // 都锚在 catalog manifest 派生的同一 packDigest 与本 pack 目录上——
    // 「runtime 加载的就是 catalog 登记的」由场景一在该 overlayPath 上的
    // 执行成功闭合。
    expect(pack.overlayYaml).toContain(`# pack: ${pack.packDigest}`)
    expect(pack.overlayYaml).toContain(
      `name: '${join(pack.packDir, 'node_modules', pack.manifest.name, pack.manifest.entrypoint)}'`,
    )
  })

  it('fails start with an attributable error when a pack plugin crashes on apply, and does not wedge the process', async () => {
    const crash = installCrashPluginPack(makePacksRoot())
    const spec = runtimeSpec({ pluginPackOverlayPath: crash.overlayPath })
    const runtime = await startReplayRuntime('unmodified-plugin', spec)
    try {
      const error: unknown = await runtime.send(initializeCommand(spec)).then(
        () => undefined,
        (caught: unknown) => caught,
      )
      expect(error).toBeInstanceOf(Error)
      // 可归因：loader 汇聚 fiber FAILED，错误含插件 id/绝对路径与插件自身报错。
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain(crash.pluginId)
      expect(message).toContain(crash.scriptedMessage)
      // 无敏感泄露 tripwire：boot 阶段无凭据参与，错误面只是插件栈与本地路径
      // （本地路径只走本地 wire/测试，红线同 workspacePath，不进 Hub/日志投影）。
      expect(message).not.toMatch(/api[-_]?key|bearer |authorization/i)

      // start 失败不发任何帧（进程内由调用方转 runtime.fatal；bin 处置表归 stdio 探针）。
      expect(runtime.outputs).toEqual([])

      // bridge 实例不可复用：start 失败后 slot 仍空，后续命令 fail-closed。
      await expect(
        runtime.send(commandFrame('run.prompt', { runId: spec.runId, text: 'after crash' })),
      ).rejects.toThrow(/before runtime\.initialize/)

      // 进程协议层不挂死：dispose 收敛干净（boot 内部已 dispose 残树，幂等）。
      await expect(runtime.dispose()).resolves.toBeUndefined()
    } finally {
      await runtime.dispose()
    }

    // 崩溃之后同一进程再 boot 干净 runtime 照常 ready（插件的激活拒绝被 boot
    // 消费，未泄漏成 unhandledRejection/fail-loud 杀进程）。
    const clean = await startReplayRuntime('basic')
    try {
      await clean.send(initializeCommand(clean.spec))
      await expect(clean.until('runtime.ready')).resolves.toMatchObject({ type: 'runtime.ready' })
    } finally {
      await clean.dispose()
    }
  })
})
