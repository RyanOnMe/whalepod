/**
 * Plugin Pack preflight 单测（P1-17；02 Task 17 Step 5 全链路机器证据）。
 *
 * 判定基线（fail-closed，每一环都有拒绝路径）：
 * - 本地未命中 → 内存 fetch 注入 descriptor + tarball 字节 → 安装 → overlay
 *   生成 → runtime.initialize 带 pluginPackOverlayPath；
 * - 本地完整命中 → 第二次 preflight **不访问网络**；
 * - descriptor packDigest 漂移 / lock digest 漂移 / 包 SRI 漂移 / 未审核包
 *   各自拒绝：ack accepted=false 且**不 spawn Runtime**；
 * - core-empty pack：不触发 preflight 网络，initialize 不带 overlay 字段。
 */
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NodeDownstream, RuntimeCommand } from '@project311/protocol'
import { pluginCordisEntry } from '@project311/protocol'
import { digestPluginCordisEntry, digestPluginPack } from '@project311/protocol/plugin-pack-digest'
import { stringify as stringifyYaml } from 'yaml'
import {
  PluginPreflightError,
  CORE_EMPTY_PACK_DIGEST,
  PluginPackPreflight,
} from '../src/plugin/plugin-preflight.js'
import { sriFor } from '../src/plugin/integrity.js'
import { PluginInstaller, type PluginFetch } from '../src/plugin/installer.js'
import { digestLockfile, type PluginLockfile } from '../src/plugin/lockfile.js'
import { PackageStore } from '../src/plugin/package-store.js'
import { PACK_OVERLAY_FILENAME } from '../src/plugin/runtime-config.js'
import { fetchPluginPackDescriptor } from '../src/run/pack-descriptor-client.js'
import { RunManager } from '../src/run/run-manager.js'
import type { RuntimeDriver, RuntimeHandle } from '../src/runtime-driver.js'
import { RuntimeSupervisor } from '../src/supervisor/runtime-supervisor.js'
import { SecretStore } from '../src/secret/store.js'
import { WorkspaceRegistry } from '../src/workspace/registry.js'
import { buildTarGz } from '../src/plugin/tar.js'

// ---------- 夹具：确定性 tarball / lock / manifest / descriptor ----------

const tempDirs: string[] = []
function mktemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p311-preflight-'))
  tempDirs.push(dir)
  return dir
}
/** 发布的包树是只读的（0o555）：清理前先恢复写权限再删。 */
function wipeTree(dir: string): void {
  if (!existsSync(dir)) return
  chmodSync(dir, 0o755)
  for (const name of readdirSync(dir)) {
    const child = join(dir, name)
    const st = lstatSync(child)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) wipeTree(child)
    else chmodSync(child, 0o644)
  }
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    wipeTree(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})

const PKG_NAME = '@project311/tabtin-fixed-time'
const PKG_VERSION = '0.1.0'
const HUB_URL = 'http://hub.test'

function depTarball(): Buffer {
  return buildTarGz([{ path: 'package/index.js', content: Buffer.from('// dep\n') }])
}

function rootTarball(): Buffer {
  return buildTarGz([
    {
      path: 'package/package.json',
      content: Buffer.from(JSON.stringify({ name: PKG_NAME, version: PKG_VERSION }), 'utf8'),
    },
    {
      path: 'package/index.js',
      content: Buffer.from('export const now = () => "2030-01-02"\n', 'utf8'),
    },
  ])
}

function makeLock(tarball: Buffer): PluginLockfile {
  return {
    schemaVersion: 1,
    package: { name: PKG_NAME, version: PKG_VERSION },
    dependencies: [
      {
        name: 'left-pad',
        version: '1.3.0',
        resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
        integrity: sriFor(depTarball()),
      },
    ],
  }
}

interface FixtureManifestInput {
  integrity: string
  reviewStatus?: 'reviewed' | 'unreviewed' | 'local-development'
}

function makeManifest({ integrity, reviewStatus = 'reviewed' }: FixtureManifestInput) {
  return {
    schemaVersion: 1,
    name: PKG_NAME,
    version: PKG_VERSION,
    tarballUrl: 'https://registry.npmjs.org/@project311/tabtin-fixed-time/-/x-0.1.0.tgz',
    integrity,
    dependencyLockDigest: '0'.repeat(64), // 由调用方按 lock 覆写
    dshCompatibility: '0.1.0-rc.8',
    entrypoint: 'index.js',
    capabilities: [],
    capabilityClass: 'declared',
    license: 'MIT',
    review: { status: reviewStatus, commit: 'b'.repeat(40), at: '2026-08-28T00:00:00.000Z' },
  }
}

function configDigestOf(manifest: { name: string; version: string; entrypoint: string }): string {
  return digestPluginCordisEntry(pluginCordisEntry(manifest))
}

function packEntryOf(manifest: ReturnType<typeof makeManifest>) {
  return {
    name: manifest.name,
    version: manifest.version,
    integrity: manifest.integrity,
    dependencyLockDigest: manifest.dependencyLockDigest,
    entrypoint: manifest.entrypoint,
    configDigest: configDigestOf(manifest),
  }
}

/** 组 descriptor：manifest/lock 一致性由调用方保证（漂移变体故意破坏某环）。 */
function makeDescriptor(manifest: ReturnType<typeof makeManifest>, lock: PluginLockfile) {
  return {
    schemaVersion: 1 as const,
    packDigest: digestPluginPack({ schemaVersion: 1, packages: [packEntryOf(manifest)] }),
    name: 'curated-core',
    packages: [{ manifest, lockfile: stringifyYaml(lock), entry: packEntryOf(manifest) }],
  }
}

// ---------- 内存 fetch：descriptor（HTTP 形）+ tarball（PluginFetch 形） ----------

function makeMemoryFetcher(descriptor: unknown, tarballs: Map<string, Buffer>) {
  const descriptorUrl = (packDigest: string): string =>
    `${HUB_URL}/api/v1/node/plugin-packs/${packDigest}`
  const fetchImpl = async (url: string | URL): Promise<Response> => {
    const text = String(url)
    if (text.startsWith(`${HUB_URL}/api/v1/node/plugin-packs/`)) {
      const digest = text.split('/').pop()!
      const payload = (descriptor as { packDigest?: string } | null)?.packDigest
      // descriptor 服务按请求的 packDigest 回包（Hub 语义：digest 即地址）。
      if (payload !== undefined && payload === digest) {
        return new Response(JSON.stringify({ ok: true, data: descriptor }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND' } }), {
        status: 404,
      })
    }
    const body = tarballs.get(text)
    return body === undefined
      ? new Response(null, { status: 404 })
      : new Response(new Uint8Array(body), { status: 200 })
  }
  const pluginFetch: PluginFetch = async (url) => {
    const body = tarballs.get(url)
    return body === undefined ? { status: 404, body: Buffer.alloc(0) } : { status: 200, body }
  }
  return { descriptorUrl, fetchImpl, pluginFetch }
}

function makePreflight(
  descriptor: unknown,
  tarballs: Map<string, Buffer>,
): { preflight: PluginPackPreflight; fetches: string[] } {
  const { fetchImpl, pluginFetch } = makeMemoryFetcher(descriptor, tarballs)
  const fetches: string[] = []
  const instrumented = async (url: string | URL): Promise<Response> => {
    fetches.push(String(url))
    return fetchImpl(url)
  }
  const store = new PackageStore(join(mktemp(), 'store'))
  const preflight = new PluginPackPreflight({
    packsRoot: join(mktemp(), 'packs'),
    store,
    installer: new PluginInstaller({
      store,
      fetchImpl: pluginFetch,
      allowedHosts: ['registry.npmjs.org'],
      maxTarballBytes: 8 * 1024 * 1024,
    }),
    fetchDescriptor: (packDigest) =>
      fetchPluginPackDescriptor(HUB_URL, 'device-token', packDigest, {
        fetchImpl: instrumented,
      }),
  })
  return { preflight, fetches }
}

// ---------- 纯 preflight 层 ----------

describe('PluginPackPreflight（descriptor 全链）', () => {
  it('本地未命中 → 拉 descriptor → 安装 → overlay 落盘；本地命中后不再访问网络', async () => {
    const tarball = rootTarball()
    const lock = makeLock(tarball)
    const manifest = {
      ...makeManifest({ integrity: sriFor(tarball) }),
      dependencyLockDigest: digestLockfile(lock),
    }
    const descriptor = makeDescriptor(manifest, lock)
    const { preflight, fetches } = makePreflight(
      descriptor,
      new Map([
        [manifest.tarballUrl, tarball],
        [lock.dependencies[0]!.resolved, depTarball()],
      ]),
    )

    const first = await preflight.ensure(descriptor.packDigest)
    expect(first.overlayPath).toBeDefined()
    expect(existsSync(first.overlayPath!)).toBe(true)
    expect(fetches).toHaveLength(1) // descriptor 一次；tarball 走 installer 自己的 fetch
    const overlayBody = readFileSync(first.overlayPath!, 'utf8')
    expect(overlayBody).toContain(`# pack: ${descriptor.packDigest}`)
    expect(overlayBody).toContain(PKG_NAME)

    // 第二次：本地完整命中（marker + store 树），零网络。
    fetches.length = 0
    const second = await preflight.ensure(descriptor.packDigest)
    expect(second.overlayPath).toBe(first.overlayPath)
    expect(fetches).toHaveLength(0)
    expect(second.overlayPath!.endsWith(PACK_OVERLAY_FILENAME)).toBe(true)
  })

  it('descriptor packDigest 漂移 → PLUGIN_PACK_MISMATCH', async () => {
    const tarball = rootTarball()
    const lock = makeLock(tarball)
    const manifest = {
      ...makeManifest({ integrity: sriFor(tarball) }),
      dependencyLockDigest: digestLockfile(lock),
    }
    const descriptor = makeDescriptor(manifest, lock)
    const drifted = { ...descriptor, packDigest: 'e'.repeat(64) }
    const { preflight } = makePreflight(drifted, new Map())
    await expect(preflight.ensure(drifted.packDigest)).rejects.toMatchObject({
      code: 'PLUGIN_PACK_MISMATCH',
      name: 'PluginPreflightError',
    })
  })

  it('lock digest 漂移 → 拒绝（LOCK_DIGEST_MISMATCH → PLUGIN_PACK_MISMATCH）', async () => {
    const tarball = rootTarball()
    const lock = makeLock(tarball)
    const manifest = {
      ...makeManifest({ integrity: sriFor(tarball) }),
      dependencyLockDigest: digestLockfile(lock),
    }
    const descriptor = makeDescriptor(manifest, lock)
    const driftedLock = {
      ...lock,
      dependencies: [{ ...lock.dependencies[0]!, version: '9.9.9' }],
    }
    const driftedDescriptor = {
      ...descriptor,
      packages: [{ manifest, lockfile: stringifyYaml(driftedLock), entry: packEntryOf(manifest) }],
    }
    const { preflight } = makePreflight(driftedDescriptor, new Map())
    await expect(preflight.ensure(descriptor.packDigest)).rejects.toMatchObject({
      code: 'PLUGIN_PACK_MISMATCH',
    })
  })

  it('包 SRI 漂移（digest 链自洽但字节不符）→ 拒绝且 store 无残留', async () => {
    const tarball = rootTarball()
    const lock = makeLock(tarball)
    // manifest.integrity 声明 evil 字节：descriptor 内部自洽（digest 复算通过），
    // 漂移在安装侧 SRI 校验暴露——校验链必须不放行这种「自洽的谎言」。
    const evilManifest = {
      ...makeManifest({ integrity: sriFor(Buffer.from('evil')) }),
      dependencyLockDigest: digestLockfile(lock),
    }
    const descriptor = makeDescriptor(evilManifest, lock)
    const { preflight } = makePreflight(
      descriptor,
      new Map([
        [evilManifest.tarballUrl, tarball],
        [lock.dependencies[0]!.resolved, depTarball()],
      ]),
    )
    await expect(preflight.ensure(descriptor.packDigest)).rejects.toMatchObject({
      code: 'PLUGIN_PACK_MISMATCH',
    })
  })

  it('unreviewed 包 → PLUGIN_UNREVIEWED（第一阶段 fail-closed）', async () => {
    const tarball = rootTarball()
    const lock = makeLock(tarball)
    const manifest = {
      ...makeManifest({ integrity: sriFor(tarball), reviewStatus: 'unreviewed' }),
      dependencyLockDigest: digestLockfile(lock),
    }
    const descriptor = makeDescriptor(manifest, lock)
    const { preflight } = makePreflight(descriptor, new Map())
    await expect(preflight.ensure(descriptor.packDigest)).rejects.toMatchObject({
      code: 'PLUGIN_UNREVIEWED',
    })
  })

  it('Hub 无此 pack（404）→ NOT_FOUND', async () => {
    const { preflight } = makePreflight(undefined, new Map())
    await expect(preflight.ensure('a'.repeat(64))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('core-empty pack 直接放行（不触发网络）', async () => {
    const { preflight, fetches } = makePreflight(undefined, new Map())
    const outcome = await preflight.ensure(CORE_EMPTY_PACK_DIGEST)
    expect(outcome.overlayPath).toBeUndefined()
    expect(fetches).toHaveLength(0)
  })
})

// ---------- RunManager 集成（run.start → preflight → spawn/拒绝） ----------

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const COMMAND_ID = '22222222-2222-4222-8222-222222222222'

interface FakeRuntime {
  readonly runId: string
  readonly stdin: RuntimeCommand[]
}

function makeFakeDriver(): { driver: RuntimeDriver; runtimes: FakeRuntime[] } {
  const runtimes: FakeRuntime[] = []
  const driver: RuntimeDriver = {
    async spawn(spec, _ctx): Promise<RuntimeHandle> {
      const runtime: FakeRuntime = { runId: spec.runId, stdin: [] }
      runtimes.push(runtime)
      return {
        pid: 2_000_000 + runtimes.length,
        exitPromise: new Promise(() => {}),
        send: (command) => {
          runtime.stdin.push(command)
        },
      }
    },
    async terminate() {},
  }
  return { driver, runtimes }
}

async function makeRunHarness(preflight: PluginPackPreflight): Promise<{
  manager: RunManager
  runtimes: FakeRuntime[]
  sentFrames: () => Array<{ type: string; payload: Record<string, unknown> }>
  workspaceId: string
}> {
  const root = mktemp()
  const workspaceDir = join(root, 'ws')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(workspaceDir, { recursive: true })
  const registry = new WorkspaceRegistry(join(root, 'registry.db'), 'test-hmac-key')
  const workspace = await registry.register(workspaceDir, { name: 'ws-1' })
  const secrets = new SecretStore(join(root, 'secrets.json'), {
    PROJECT311_DSH_SECRET_DSH_API_KEY: 'sk-test-123',
  })
  const { driver, runtimes } = makeFakeDriver()
  const sent: string[] = []
  const manager = new RunManager({
    supervisor: new RuntimeSupervisor({
      driver,
      registry,
      secrets,
      stateDbPath: join(root, 'supervisor.db'),
      capacity: 2,
      runtimeTimeoutMs: 60_000,
    }),
    registry,
    commandStore: new (await import('../src/spool/command-store.js')).CommandStore(
      join(root, 'commands.db'),
    ),
    eventStore: new (await import('../src/spool/event-store.js')).EventStore(
      join(root, 'events.db'),
    ),
    send: (frame) => sent.push(frame),
    runtimeHomeFor: (runId) => {
      mkdirSync(join(root, 'runtime-home', runId), { recursive: true })
      return join(root, 'runtime-home', runId)
    },
    homeDir: '/Users/testhome',
    pluginPackPreflight: (packDigest) => preflight.ensure(packDigest),
  })
  return {
    manager,
    runtimes,
    workspaceId: workspace.id,
    sentFrames: () =>
      sent.map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> }),
  }
}

function runStartFrame(workspaceId: string, packDigest: string): NodeDownstream {
  return {
    protocolVersion: 1,
    messageId: 'm-1',
    sentAt: new Date().toISOString(),
    type: 'run.start',
    payload: {
      commandId: COMMAND_ID,
      runId: RUN_ID,
      taskId: '33333333-3333-4333-8333-333333333333',
      ownerUserId: '44444444-4444-4444-8444-444444444444',
      agent: {
        id: '55555555-5555-4555-8555-555555555555',
        profileRevisionId: '66666666-6666-4666-8666-666666666666',
        persona: 'test persona',
        provider: 'dsh',
        model: 'test-model',
        credentialSlot: 'api_key',
      },
      workspaceId,
      expectedProfileDigest: 'a'.repeat(64),
      expectedPluginPackDigest: packDigest,
      prompt: 'do the thing',
    },
  } as NodeDownstream
}

describe('run.start → preflight → Runtime（RunManager 集成）', () => {
  it('全链路：安装 pack → ack accepted → initialize 带 pluginPackOverlayPath', async () => {
    const tarball = rootTarball()
    const lock = makeLock(tarball)
    const manifest = {
      ...makeManifest({ integrity: sriFor(tarball) }),
      dependencyLockDigest: digestLockfile(lock),
    }
    const descriptor = makeDescriptor(manifest, lock)
    const { preflight } = makePreflight(
      descriptor,
      new Map([
        [manifest.tarballUrl, tarball],
        [lock.dependencies[0]!.resolved, depTarball()],
      ]),
    )
    const h = await makeRunHarness(preflight)

    await h.manager.handleFrame(runStartFrame(h.workspaceId, descriptor.packDigest))
    const ack = h.sentFrames().find((f) => f.type === 'command.ack')
    expect(ack?.payload).toMatchObject({ commandId: COMMAND_ID, accepted: true })
    expect(h.runtimes).toHaveLength(1)
    const initialize = h.runtimes[0]!.stdin[0]!
    expect(initialize.type).toBe('runtime.initialize')
    const payload = initialize.payload as Record<string, unknown>
    expect(payload['pluginPackDigest']).toBe(descriptor.packDigest)
    expect(typeof payload['pluginPackOverlayPath']).toBe('string')
    expect(existsSync(String(payload['pluginPackOverlayPath']))).toBe(true)
  })

  it.each([
    ['descriptor packDigest 漂移', 'pack-digest-drift'],
    ['lock digest 漂移', 'lock-drift'],
    ['包 SRI 漂移', 'sri-drift'],
  ])('%s → ack rejected %s，不 spawn Runtime', async (_label, variant) => {
    const tarball = rootTarball()
    const lock = makeLock(tarball)
    const manifest = {
      ...makeManifest({ integrity: sriFor(tarball) }),
      dependencyLockDigest: digestLockfile(lock),
    }
    let descriptor = makeDescriptor(manifest, lock)
    let requested = descriptor.packDigest
    if (variant === 'pack-digest-drift') {
      descriptor = { ...descriptor, packDigest: 'e'.repeat(64) }
      requested = descriptor.packDigest
    } else if (variant === 'lock-drift') {
      const driftedLock = {
        ...lock,
        dependencies: [{ ...lock.dependencies[0]!, version: '9.9.9' }],
      }
      descriptor = {
        ...descriptor,
        packages: [
          { manifest, lockfile: stringifyYaml(driftedLock), entry: packEntryOf(manifest) },
        ],
      }
    } else {
      const evilManifest = {
        ...makeManifest({ integrity: sriFor(Buffer.from('evil')) }),
        dependencyLockDigest: digestLockfile(lock),
      }
      descriptor = makeDescriptor(evilManifest, lock)
      requested = descriptor.packDigest
    }
    const { preflight } = makePreflight(
      descriptor,
      new Map([
        [manifest.tarballUrl, tarball],
        [lock.dependencies[0]!.resolved, depTarball()],
      ]),
    )
    const h = await makeRunHarness(preflight)

    await h.manager.handleFrame(runStartFrame(h.workspaceId, requested))
    const acks = h.sentFrames().filter((f) => f.type === 'command.ack')
    expect(acks).toHaveLength(1)
    expect(acks[0]!.payload['accepted']).toBe(false)
    expect((acks[0]!.payload['error'] as { code: string }).code).toBe('PLUGIN_PACK_MISMATCH')
    expect(h.runtimes).toHaveLength(0) // 绝不带着未校验 pack 启动 Runtime
  })

  it('core-empty pack：不触发 preflight 网络，initialize 不带 overlay 字段', async () => {
    const { preflight, fetches } = makePreflight(undefined, new Map())
    const h = await makeRunHarness(preflight)

    await h.manager.handleFrame(runStartFrame(h.workspaceId, CORE_EMPTY_PACK_DIGEST))
    const ack = h.sentFrames().find((f) => f.type === 'command.ack')
    expect(ack?.payload).toMatchObject({ commandId: COMMAND_ID, accepted: true })
    expect(fetches).toHaveLength(0)
    expect(h.runtimes).toHaveLength(1)
    const payload = h.runtimes[0]!.stdin[0]!.payload as Record<string, unknown>
    expect('pluginPackOverlayPath' in payload).toBe(false)
  })
})
