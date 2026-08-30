/**
 * P1-18 六原语 harness —— 判定（assert）与归因（localize）原语。
 *
 * phase1-verify 的本体：读 drive 产出的证据目录，跑「成功长什么样」的可证伪
 * 断言；任何一层缺失/中断都 FAIL，并按 component 分层把断点归到
 * Hub / Node / Runtime / Browser 四层之一（05 §4 P1-18 验收标准）。
 *
 * 判定纪律：没数据、缺一环必须 FAIL；归因只看证据事实（分层探活、outbox
 * ack、Node 上行、Runtime 帧摘要、DB 快照、Browser 帧），不看 drive 的故障
 * 注入参数——fault 字段只进报告标题，不进判定逻辑（不自证）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { layerOf, type Phase1Layer } from './events.js'
import type { DriveMeta } from './drive.js'

export type { Phase1Scenario } from './drive.js'

export interface VerifyCheck {
  id: string
  pass: boolean
  detail: string
  /** 断言失败时的层提示（green 断言自带层标；链路断点归因走 attribution）。 */
  layer?: Phase1Layer
}

export interface VerifyAttribution {
  layer: Phase1Layer
  reason: string
  /** 支撑归因的证据事实（引用证据文件与关键行）。 */
  evidence: string[]
}

export interface VerifyVerdict {
  pass: boolean
  traceId: string
  scenario: string
  fault: string
  checks: VerifyCheck[]
  attribution?: VerifyAttribution
}

/** 04 §6.4 六件秘密语料：任一原样出现在证据即 FAIL（Q7 红线）。 */
const CORPUS = [
  'Authorization: Bearer test-secret-123',
  'DEEPSEEK_API_KEY=sk-test-abcdef',
  'npm_xxx_fake_token',
  '-----BEGIN PRIVATE KEY-----',
  '/Users/bob/private/project',
  'https://example.com/path?token=secret#fragment',
] as const

const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled', 'lost'])

/** Hub 下线判定所需的连续探活失败次数（探活间隔 250ms → 连续 3 次 ≈ 750ms 不可达）。 */
const HUB_DOWN_CONSECUTIVE_PROBES = 3

interface FactLine {
  ts: string
  component: string
  kind: string
  [key: string]: unknown
}

interface Snapshot {
  runs: Array<{ id: string; status: string; failureCode: string | null }>
  runEvents: Array<{ runId: string; seq: number; type: string; audience: string; payload: unknown }>
  approvals: Array<{
    id: string
    runId: string
    status: string
    decidedBy: string | null
    decidedAt: string | null
    toolName: string
  }>
  artifacts: Array<{
    id: string
    runId: string
    status: string
    sha256: string
    storageKey: string
    byteSize: number
  }>
  artifactBlobs: Array<{ artifactId: string; blobPresent: boolean }>
  outbox: Array<{
    id: string
    type: string
    payload: Record<string, unknown>
    ackedAt: string | null
    failedAt: string | null
    attempts: number
  }>
}

interface IndexShape {
  traceId: string
  runs: Record<string, { layers: Record<string, { events: number }> }>
  commands: Record<string, { type: string; dispatched: number; ackedAt?: string }>
}

interface Evidence {
  meta: DriveMeta
  events: Array<{
    ts: string
    component: string
    kind: string
    runId?: string
    [k: string]: unknown
  }>
  facts: FactLine[]
  nodeUplink: Array<Record<string, unknown>>
  browser: { alice: unknown[]; bob: unknown[] }
  runtimeFrames: Array<{ type: string; byteLength: number }>
  snapshot: Snapshot | undefined
  index: IndexShape | undefined
}

function readJsonl<T>(path: string): T[] {
  try {
    const text = readFileSync(path, 'utf8')
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as T)
  } catch {
    return []
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

export function loadEvidence(attemptDir: string): Evidence {
  return {
    // meta 缺失/损坏 → 兜底对象（captured=false 判 FAIL，字段仅用于报告展示）。
    meta:
      readJson<DriveMeta>(join(attemptDir, 'meta.json')) ??
      ({
        traceId: 'unknown',
        attemptId: 'unknown',
        scenario: 'unknown',
        fault: 'unknown',
        startedAt: '',
        endedAt: '',
        captured: false,
        runIds: [],
        gitCommit: 'unknown',
        dshVersion: 'unknown',
        protocolVersion: 1,
        platform: 'unknown',
        nodeVersion: 'unknown',
      } as unknown as DriveMeta),
    events: readJsonl(join(attemptDir, 'events.jsonl')),
    facts: readJsonl<FactLine>(join(attemptDir, 'layer-facts.jsonl')),
    nodeUplink: readJsonl(join(attemptDir, 'node-events.jsonl')),
    browser: {
      alice: readJsonl(join(attemptDir, 'browser-alice.jsonl')),
      bob: readJsonl(join(attemptDir, 'browser-bob.jsonl')),
    },
    runtimeFrames: readJsonl(join(attemptDir, 'runtime-summary.jsonl')),
    snapshot: readJson<Snapshot>(join(attemptDir, 'db-snapshot.json')),
    index: readJson<IndexShape>(join(attemptDir, 'index.json')),
  }
}

// ---------- 证据事实归约（归因树的输入） ----------

interface ChainFacts {
  run1: string
  run2?: string
  commandAcked: boolean
  nodeGotRunStart: boolean
  runtimeFrameCount: number
  hubDownAtEnd: boolean
  hubRunEventCount: number
  hubTerminal: string | undefined
  hubCompleted: boolean
  nodeUplinkCount: number
  nodeUplinkHasCompleted: boolean
  browserAliceGotCompleted: boolean
  browserBobGotCompleted: boolean
  aliceSocketClosed: boolean
  bobSocketClosed: boolean
}

function frameRunId(frame: Record<string, unknown>): string | undefined {
  const payload = frame['payload'] as Record<string, unknown> | undefined
  const runId = payload?.['runId']
  return typeof runId === 'string' ? runId : undefined
}

function browserHasCompleted(frames: unknown[], runId: string): boolean {
  return frames.some((raw) => {
    const f = raw as {
      kind?: string
      event?: { type?: string; payload?: { runId?: unknown } }
    }
    return (
      f.kind === 'persistent' &&
      f.event?.type === 'run.event' &&
      f.event.payload?.runId === runId &&
      JSON.stringify(f.event.payload).includes('"run.completed"')
    )
  })
}

function reduceFacts(evidence: Evidence, run1: string, run2?: string): ChainFacts {
  const { snapshot } = evidence
  const probes = evidence.facts.filter((f) => f.kind === 'hub.probe')
  // Hub 下线判定 = 探活序列「末尾连续失败」；单次瞬时超时（重负载 spawn 抖动）
  // 不算——否则它是 harness 偶发红的第一来源。健康 loopback 不会连续 750ms
  // 不可达（探活间隔 250ms）。
  const hubDownAtEnd = (() => {
    if (probes.length === 0) return false
    const tail = probes.slice(-HUB_DOWN_CONSECUTIVE_PROBES)
    return tail.every((f) => f['ok'] === false)
  })()
  const runEvents = snapshot?.runEvents.filter((r) => r.runId === run1) ?? []
  const run1Row = snapshot?.runs.find((r) => r.id === run1)
  const nodeUplinkRun1 = evidence.nodeUplink.filter((f) => frameRunId(f) === run1)
  const runStartAcked =
    snapshot?.outbox.some(
      (o) =>
        o.type === 'run.start' &&
        (o.payload as { runId?: unknown })['runId'] === run1 &&
        o.ackedAt !== null,
    ) ?? false
  return {
    run1,
    ...(run2 === undefined ? {} : { run2 }),
    commandAcked: runStartAcked,
    nodeGotRunStart: evidence.events.some(
      (e) =>
        e.component === 'node.gateway' &&
        e.kind === 'node.frame.received' &&
        (e.data as Record<string, unknown> | undefined)?.['type'] === 'run.start',
    ),
    runtimeFrameCount: evidence.runtimeFrames.length,
    hubDownAtEnd,
    hubRunEventCount: runEvents.length,
    hubTerminal:
      run1Row !== undefined && TERMINAL_RUN_STATES.has(run1Row.status) ? run1Row.status : undefined,
    hubCompleted: run1Row?.status === 'completed',
    nodeUplinkCount: nodeUplinkRun1.length,
    nodeUplinkHasCompleted: nodeUplinkRun1.some((f) =>
      JSON.stringify(f).includes('"run.completed"'),
    ),
    browserAliceGotCompleted: browserHasCompleted(evidence.browser.alice, run1),
    browserBobGotCompleted: browserHasCompleted(evidence.browser.bob, run1),
    aliceSocketClosed: evidence.facts.some(
      (f) => f.kind === 'browser.socket.closed' && f.who === 'alice',
    ),
    bobSocketClosed: evidence.facts.some(
      (f) => f.kind === 'browser.socket.closed' && f.who === 'bob',
    ),
  }
}

/**
 * 归因树：从「终端证据（Browser 看到 run.completed）」逆因果链上溯，第一层
 * 「输入到了、产出没到」的就是断点；上游断掉时下游的缺失不背锅。
 * 返回 undefined = 链路 milestones 全绿（失败在场景断言层，各自带层标）。
 */
export function attribute(facts: ChainFacts): VerifyAttribution | undefined {
  // 1) 命令链未闭合：Hub 派发 → Node 确认。
  if (!facts.commandAcked) {
    if (facts.hubDownAtEnd) {
      return {
        layer: 'Hub',
        reason: 'run.start 命令未被 Node 确认，且 Hub 探活末尾连续失败——Hub 先于命令链闭合下线',
        evidence: [
          'layer-facts.jsonl: hub.probe 末尾连续 ok=false',
          'db-snapshot.json: outbox run.start acked_at 为空',
        ],
      }
    }
    return {
      layer: 'Node',
      reason: facts.nodeGotRunStart
        ? 'Node 收到 run.start 但从未 ack——Node 会话/确认链路中断'
        : 'Hub 在线且已派发（outbox 有派发事实），Node 会话没有收到 run.start——Node 层不在',
      evidence: [
        'db-snapshot.json: outbox run.start acked_at 为空、attempts>0',
        'events.jsonl: node.frame.received(run.start) 缺失',
      ],
    }
  }
  // 2) 命令链闭合但 Hub 中途下线：尾部事件滞留 Node。
  if (facts.hubDownAtEnd) {
    return {
      layer: 'Hub',
      reason: facts.nodeUplinkHasCompleted
        ? 'Node 侧已产出 run.completed 上行帧而 Hub 未落库，且 Hub 探活末尾连续失败——Hub 中途下线'
        : 'Hub 探活末尾连续失败（链路窗口内）——Hub 层中断',
      evidence: [
        'layer-facts.jsonl: hub.probe 末尾连续 ok=false',
        'db-snapshot.json: run_event 缺 run.completed',
      ],
    }
  }
  // 3) Runtime 从未开口：Node 已确认命令但没有一帧 Runtime 协议输出。
  if (facts.runtimeFrameCount === 0) {
    return {
      layer: 'Runtime',
      reason:
        'Node 已确认 run.start，但 Runtime 未产生任何协议帧（runtime-summary 为空）——Runtime 未跑起来或即崩',
      evidence: ['runtime-summary.jsonl: 0 帧', 'db-snapshot.json: run.start 已 ack'],
    }
  }
  // 4) Runtime 有输出但 Node 未上行任何帧。
  if (facts.nodeUplinkCount === 0) {
    return {
      layer: 'Node',
      reason: 'Runtime 已产生协议帧，但 Node 未向 Hub 上行任何帧——Node 上行链路中断',
      evidence: ['node-events.jsonl: 0 帧', 'runtime-summary.jsonl: >0 帧'],
    }
  }
  // 5) Node 有上行但 Hub 零落库。
  if (facts.hubRunEventCount === 0) {
    return {
      layer: 'Hub',
      reason: 'Node 已上行 run 事件，但 Hub run_event 零落库——Hub ingest 中断',
      evidence: ['node-events.jsonl: >0 帧', 'db-snapshot.json: run_event 0 行'],
    }
  }
  // 6) Hub 落了部分事件但没有 completed：谁吞了尾巴。
  if (!facts.hubCompleted) {
    if (facts.nodeUplinkHasCompleted) {
      return {
        layer: 'Hub',
        reason: 'Node 已上行 run.completed 而 Hub 未落库/未终态——Hub ingest 丢尾',
        evidence: ['node-events.jsonl: run.completed 上行在案', 'db-snapshot.json: run 终态缺失'],
      }
    }
    return {
      layer: 'Node',
      reason: 'Hub 未到 completed 且 Node 未上行 run.completed——Node 投影/上行在完成前中断',
      evidence: ['node-events.jsonl: 无 run.completed', 'db-snapshot.json: run 终态缺失'],
    }
  }
  // 7) Hub 已 completed：Browser 侧缺失即 Browser/扇出。
  if (!facts.browserAliceGotCompleted) {
    return {
      layer: facts.aliceSocketClosed ? 'Browser' : 'Hub',
      reason: facts.aliceSocketClosed
        ? 'Hub 已落库 completed，但 owner Browser 连接在扇出窗口内断开——Browser 层缺失'
        : 'Hub 已落库 completed，owner Browser 在线却未收到——Hub 扇出中断',
      evidence: ['db-snapshot.json: run completed', 'browser-alice.jsonl: 缺 run.completed'],
    }
  }
  if (!facts.browserBobGotCompleted) {
    return {
      layer: facts.bobSocketClosed ? 'Browser' : 'Hub',
      reason: facts.bobSocketClosed
        ? 'Hub 已落库 completed，但 member Browser 连接在扇出窗口内断开——Browser 层缺失'
        : 'Hub 已落库 completed，member Browser 在线却未收到 project 帧——Hub 扇出中断',
      evidence: ['db-snapshot.json: run completed', 'browser-bob.jsonl: 缺 run.completed'],
    }
  }
  return undefined
}

// ---------- 断言集 ----------

function check(id: string, pass: boolean, detail: string, layer?: Phase1Layer): VerifyCheck {
  return { id, ...(layer === undefined ? {} : { layer }), pass, detail }
}

/** 全场景公共：观测纪律（component/traceId 分层字段）与证据齐套。 */
function disciplineChecks(evidence: Evidence): VerifyCheck[] {
  const events = evidence.events
  const missingComponent = events.filter(
    (e) => typeof e['component'] !== 'string' || e['component'] === '',
  )
  const missingTrace = events.filter((e) => typeof e['traceId'] !== 'string' || e['traceId'] === '')
  const layers = new Set(events.map((e) => layerOf(String(e['component'] ?? ''))))
  return [
    check(
      'observe-component-field',
      events.length > 0 && missingComponent.length === 0,
      `结构化事件必须逐条带 component 分层字段（缺失 ${missingComponent.length}/${events.length}）`,
    ),
    check(
      'observe-trace-id',
      events.length > 0 && missingTrace.length === 0,
      `结构化事件必须逐条带 traceId 跨层索引键（缺失 ${missingTrace.length}/${events.length}）`,
    ),
    check(
      'observe-layer-coverage',
      ['Hub', 'Node', 'Runtime', 'Browser'].every((l) => layers.has(l as Phase1Layer)),
      `四层观测都在案（实际：${[...layers].join(', ') || '无'}）`,
    ),
  ]
}

/** 单个 Run 的链路 milestones（归因树的判定面）。 */
function chainChecks(facts: ChainFacts, runId: string): VerifyCheck[] {
  return [
    check(
      'chain.command-acked',
      facts.commandAcked,
      `outbox run.start 已被 Node ack（run=${runId.slice(0, 8)}）`,
    ),
    check(
      'chain.runtime-frames',
      facts.runtimeFrameCount > 0,
      `Runtime 产生 ${facts.runtimeFrameCount} 帧协议输出`,
    ),
    check('chain.node-uplink', facts.nodeUplinkCount > 0, `Node 上行 ${facts.nodeUplinkCount} 帧`),
    check(
      'chain.hub-events',
      facts.hubRunEventCount > 0,
      `Hub 落库 ${facts.hubRunEventCount} 行 run_event`,
    ),
    check(
      'chain.hub-completed',
      facts.hubCompleted,
      `Hub 侧 run 终态=completed（实际=${facts.hubTerminal ?? '未终态'}）`,
    ),
    check(
      'chain.browser-owner',
      facts.browserAliceGotCompleted,
      'owner Browser 收到 run.completed',
    ),
    check(
      'chain.browser-member',
      facts.browserBobGotCompleted,
      'member Browser 收到 run.completed（project 帧）',
    ),
  ]
}

/** G4-04/05：双受众 frame diff 与 flush 顺序（对任一 fixture 的完成文本成立）。 */
function projectionChecks(evidence: Evidence, runId: string, finalText: string): VerifyCheck[] {
  const alice = evidence.browser.alice as Array<Record<string, unknown>>
  const bob = evidence.browser.bob as Array<Record<string, unknown>>
  const aliceText = JSON.stringify(alice)
  const bobText = JSON.stringify(bob)
  const aliceLive = alice.filter((f) => f['kind'] === 'live')
  const bobLive = bob.filter((f) => f['kind'] === 'live')
  const ownerRows = (evidence.snapshot?.runEvents ?? []).filter(
    (r) => r.runId === runId && r.audience === 'owner',
  )
  const completedSeq = ownerRows.find((r) => r.type === 'run.completed')?.seq ?? Number.NaN
  const assistantSeqs = ownerRows.filter((r) => r.type === 'assistant.message').map((r) => r.seq)
  return [
    check(
      'G4-04.owner-fulltext',
      aliceText.includes(finalText),
      `owner 流含完整最终文本「${finalText}」`,
    ),
    check(
      'G4-04.member-shrunk',
      bobText.length > 2 && !bobText.includes('"audience":"owner"'),
      'member 流只见 project 帧（零 owner 行）',
    ),
    check(
      'G4-04.live-owner-only',
      aliceLive.length > 0 && bobLive.length === 0,
      `live delta 只到 owner（alice ${aliceLive.length} 条 / bob ${bobLive.length} 条）`,
    ),
    check(
      'G4-05.flush-order',
      assistantSeqs.every((seq) => seq < completedSeq),
      `owner 流 assistant.message seq 全部先于 run.completed（seq=${completedSeq}）`,
    ),
  ]
}

/** 04 §6.4 语料：证据文件（DB 快照 + 双 Browser + Node 上行）零原样出现。 */
function corpusChecks(evidence: Evidence): VerifyCheck[] {
  const surfaces: Array<[string, string]> = [
    ['db-snapshot.json', JSON.stringify(evidence.snapshot ?? {})],
    ['browser-alice.jsonl', JSON.stringify(evidence.browser.alice)],
    ['browser-bob.jsonl', JSON.stringify(evidence.browser.bob)],
    ['node-events.jsonl', JSON.stringify(evidence.nodeUplink)],
  ]
  const hits: string[] = []
  for (const item of CORPUS) {
    for (const [name, text] of surfaces) {
      if (text.includes(item)) hits.push(`${name}: ${item}`)
    }
  }
  const ownerCompleted = (evidence.snapshot?.runEvents ?? []).find(
    (r) => r.type === 'run.completed' && r.audience === 'owner',
  )
  const markers = JSON.stringify(ownerCompleted?.payload ?? {})
  return [
    check(
      'Q7.corpus-absent',
      hits.length === 0,
      hits.length === 0 ? '六件语料在全部证据面零出现' : `语料泄漏：${hits.join('; ')}`,
      'Hub',
    ),
    check(
      'Q7.redaction-markers',
      markers.includes('<redacted>') && markers.includes('<home>/private/project'),
      'owner 完成行带脱敏标记（证明是脱了敏，不是没内容）',
    ),
  ]
}

/** standard 场景：Approval + Artifact + Reviewer 腿。 */
function mainChainChecks(evidence: Evidence, run1: string, run2: string): VerifyCheck[] {
  const snapshot = evidence.snapshot
  const approvals = snapshot?.approvals.filter((a) => a.runId === run1) ?? []
  const approval = approvals[0]
  const runEvents = snapshot?.runEvents ?? []
  const artifacts = snapshot?.artifacts.filter((a) => a.runId === run1) ?? []
  const artifact = artifacts[0]
  const blobOk =
    artifact !== undefined &&
    (snapshot?.artifactBlobs ?? []).some((b) => b.artifactId === artifact.id && b.blobPresent)
  const nodeArtifactEvents = evidence.events.filter(
    (e) => e.component === 'node.artifact' || e.component === 'node.run',
  )
  const inputsPrepared = nodeArtifactEvents.some(
    (e) =>
      String(e['kind'] ?? '').includes('artifact inputs prepared') &&
      (e.data as Record<string, unknown> | undefined)?.['runId'] === run2,
  )
  const toolFinished = runEvents.some(
    (r) =>
      r.runId === run1 &&
      r.type === 'tool.finished' &&
      r.audience === 'owner' &&
      JSON.stringify(r.payload).includes('"succeeded"'),
  )
  const run2Row = snapshot?.runs.find((r) => r.id === run2)
  const run2Events = runEvents.filter((r) => r.runId === run2)
  return [
    check(
      'G5.approval-requested',
      runEvents.some(
        (r) => r.runId === run1 && r.type === 'approval.requested' && r.audience === 'owner',
      ),
      'owner 流有 approval.requested 完整卡',
    ),
    check(
      'G5.approval-allowed',
      approval !== undefined &&
        approval.status === 'allowed_once' &&
        approval.decidedBy !== null &&
        approval.decidedAt !== null,
      `Approval 行终态 allowed_once（实际=${approval?.status ?? '缺失'}）`,
    ),
    check(
      'G5.tool-continued',
      toolFinished,
      'allow 决定后 DSH 工具继续执行（tool.finished succeeded）',
    ),
    check(
      'G6.artifact-candidate-published',
      artifact !== undefined && artifact.status === 'published',
      `Artifact 状态 published（实际=${artifact?.status ?? '缺失'}）`,
    ),
    check(
      'G6.artifact-blob',
      blobOk,
      `内容寻址 blob 在库（sha256=${artifact?.sha256?.slice(0, 12) ?? '-'}…）`,
    ),
    check(
      'G6.reviewer-inputs',
      inputsPrepared,
      'Reviewer Run 从 Hub 拉到已发布 Artifact 输入清单并下载校验（node.artifact 日志在案）',
    ),
    check(
      'G6.reviewer-run-completed',
      run2Row?.status === 'completed' && run2Events.some((r) => r.type === 'run.completed'),
      `Reviewer Run 终态 completed（实际=${run2Row?.status ?? '缺失'}）`,
    ),
  ]
}

/**
 * 判定入口：读证据目录 → 断言 → 归因。exit code 语义由 CLI 层落地。
 */
export function verifyEvidence(attemptDir: string): VerifyVerdict {
  const evidence = loadEvidence(attemptDir)
  const checks: VerifyCheck[] = []
  const scenario = evidence.meta.scenario
  const fault = evidence.meta.fault

  if (evidence.meta.captured !== true) {
    checks.push(
      check('drive.captured', false, `drive 未完成采集：${evidence.meta.error ?? 'meta 缺失'}`),
    )
    return {
      pass: false,
      traceId: evidence.meta.traceId,
      scenario,
      fault,
      checks,
      attribution: {
        layer: 'Hub',
        reason: 'drive 未完成采集（harness 自身失败，无从判定链路）',
        evidence: ['meta.json: captured=false'],
      },
    }
  }
  checks.push(
    check('drive.captured', true, `drive 采集完成（scenario=${scenario}, fault=${fault}）`),
  )
  checks.push(...disciplineChecks(evidence))

  const run1 = evidence.meta.runIds[0]
  const run2 = evidence.meta.runIds[1]
  if (run1 === undefined) {
    checks.push(check('chain.run-created', false, '证据中没有任何 runId（Run 未创建）', 'Hub'))
    const facts = reduceFacts(evidence, '00000000-0000-0000-0000-000000000000')
    const attribution = attribute(facts)
    return {
      pass: false,
      traceId: evidence.meta.traceId,
      scenario,
      fault,
      checks,
      ...(attribution === undefined ? {} : { attribution }),
    }
  }
  checks.push(check('chain.run-created', true, `Run 已创建（${run1.slice(0, 8)}）`))

  const facts = reduceFacts(evidence, run1, run2)
  checks.push(...chainChecks(facts, run1))

  // 归因树：milestone 断链时立即定性（场景绿断言不再叠加噪音）。
  const attribution = attribute(facts)
  if (attribution !== undefined) {
    return {
      pass: false,
      traceId: evidence.meta.traceId,
      scenario,
      fault,
      checks,
      attribution,
    }
  }

  // milestones 全绿 → 场景绿断言。最终文本标记按 fixture 而定（secrets 场景
  // 的最终正文整体脱敏，稳定的存活尾部是 'done.'，与 P1-13 chain spec 同判据）。
  const finalText =
    scenario === 'standard'
      ? 'Artifact published.'
      : scenario === 'secrets'
        ? 'done.'
        : 'Hello from replay.'
  checks.push(...projectionChecks(evidence, run1, finalText))
  if (scenario === 'standard') {
    if (run2 === undefined) {
      checks.push(check('G6.reviewer-run-created', false, 'Reviewer Run 未创建', 'Hub'))
    } else {
      checks.push(...mainChainChecks(evidence, run1, run2))
    }
  }
  if (scenario === 'secrets') {
    checks.push(...corpusChecks(evidence))
  }

  // 跨层索引一致性：绿链的 run 在四层都有证据在案。
  if (evidence.index !== undefined) {
    const indexEntry = evidence.index.runs[run1]
    const layersOk =
      indexEntry !== undefined &&
      ['runtime', 'node', 'hub', 'browser'].every((l) => (indexEntry.layers[l]?.events ?? 0) > 0)
    checks.push(
      check(
        'index.cross-layer',
        layersOk,
        `跨层 traceId/runId 索引：run 在 runtime/node/hub/browser 四层均有证据（${
          indexEntry === undefined
            ? '索引缺该 run'
            : Object.entries(indexEntry.layers)
                .map(([l, v]) => `${l}=${v.events}`)
                .join(', ')
        }）`,
      ),
    )
  } else {
    checks.push(check('index.cross-layer', false, 'index.json 缺失（跨层索引未生成）'))
  }

  return {
    pass: checks.every((c) => c.pass),
    traceId: evidence.meta.traceId,
    scenario,
    fault,
    checks,
  }
}

/** CLI 报告文本。 */
export function formatVerdict(verdict: VerifyVerdict): string {
  const failed = verdict.checks.filter((c) => !c.pass)
  const head = `${verdict.pass ? 'PASS' : 'FAIL'} phase1 (scenario=${verdict.scenario}, fault=${verdict.fault}, traceId=${verdict.traceId}) — ${verdict.checks.length - failed.length}/${verdict.checks.length} checks`
  const lines = [head]
  for (const c of failed) {
    lines.push(`  [x] ${c.id}: ${c.detail}${c.layer === undefined ? '' : `（提示层=${c.layer}）`}`)
  }
  if (verdict.attribution !== undefined) {
    lines.push(
      `  归因: [${verdict.attribution.layer}] ${verdict.attribution.reason}`,
      `  证据: ${verdict.attribution.evidence.join(' | ')}`,
    )
  }
  return lines.join('\n')
}
