/**
 * P1-18 六原语 harness —— 观测（observe）原语。
 *
 * 统一结构化事件流：每个观测点一条 JSONL，固定带 component 分层字段与
 * traceId（跨层索引键），runId 存在时必带。本模块只允许记录「元数据 +
 * 已脱敏投影」——密码、Token、Cookie、原始 Runtime 帧、绝对路径一律不进
 * 事件（红线：证据与密钥不相容；完整 DSH JSONL 不进包，04 §9）。
 *
 * component 取值沿用 06 §8 固定词表（browser | hub.* | node.* |
 * runtime.bridge | dsh.agent | artifact.store），harness 自身的驱动步骤用
 * `harness.*`；layerOf() 把 component 归约到验收四层（Hub/Node/Runtime/
 * Browser），verify 的归因（localize）按它输出断在哪层。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 验收四层（05 §4 P1-18：verify 必须指明 Hub、Node、Runtime 或 Browser）。 */
export type Phase1Layer = 'Hub' | 'Node' | 'Runtime' | 'Browser'

/** component → 验收四层的归约（evidence-map.md 分层表的一致映射）。 */
export function layerOf(component: string): Phase1Layer {
  if (component === 'browser') return 'Browser'
  if (component === 'runtime.bridge' || component === 'dsh.agent') return 'Runtime'
  if (component.startsWith('node.')) return 'Node'
  // hub.* 与 artifact.store 都在 Hub 进程内（04 evidence-map 分层表）。
  return 'Hub'
}

/**
 * 一条结构化观测。data 只放元数据（type/commandId/seq/audience/status/
 * count 等）；文本负载只在「已过 Node 投影脱敏」的文件（browser-*.jsonl、
 * node-events.jsonl、db-snapshot.json）里出现。
 */
export interface Phase1Event {
  /** ISO 时间戳。 */
  ts: string
  /** 06 §8 固定词表 + harness.*（harness 自身动作）。 */
  component: string
  /** 跨层索引键：一次 drive 采集内恒定。 */
  traceId: string
  runId?: string
  /** 观测种类，如 http.request / outbox.dispatch / runtime.stdout / fault.injected。 */
  kind: string
  data?: Record<string, unknown>
}

/** 故障注入种类（fault 注入面，phase1-drive --fault）。 */
export type FaultKind = 'none' | 'hub' | 'node' | 'runtime' | 'browser'

export const FAULT_KINDS: readonly FaultKind[] = ['none', 'hub', 'node', 'runtime', 'browser']

export interface FaultSpec {
  kind: FaultKind
  /** 故障注入时机的描述（进 manifest，归因证据的旁证；判定只看事件流）。 */
  trigger: string
}

/**
 * drive 采集器：把各观测点的结构化事件落成证据目录里的 JSONL 文件。
 *
 * 文件分工（verify 与 evidence 的输入契约）：
 * - events.jsonl          全量结构化事件（元数据级）
 * - layer-facts.jsonl     分层存活事实（hub HTTP 探活 / node 会话 / browser socket）
 * - node-events.jsonl     Node 上行帧全文（已过投影脱敏）
 * - browser-alice.jsonl / browser-bob.jsonl  双 Browser 收到的 ClientFrame 全文（已脱敏）
 * - runtime-summary.jsonl Runtime stdout 帧摘要（只有 type/长度，无文本）
 */
export class Phase1Recorder {
  readonly dir: string
  readonly traceId: string
  private readonly events: Phase1Event[] = []

  constructor(dir: string, traceId: string) {
    this.dir = dir
    this.traceId = traceId
    mkdirSync(dir, { recursive: true })
  }

  /** 追加一条事件（同步落盘：drive 崩溃也不丢已观测的尾巴）。 */
  event(component: string, kind: string, data?: Record<string, unknown>, runId?: string): void {
    const e: Phase1Event = { ts: new Date().toISOString(), component, kind, traceId: this.traceId }
    if (runId !== undefined) e.runId = runId
    if (data !== undefined) e.data = data
    this.events.push(e)
    appendFileSync(join(this.dir, 'events.jsonl'), `${JSON.stringify(e)}\n`)
  }

  /** 分层存活事实（hub 探活、node 会话开闭、browser socket 开闭）。 */
  fact(component: string, kind: string, data: Record<string, unknown>): void {
    const f = { ts: new Date().toISOString(), component, kind, traceId: this.traceId, ...data }
    appendFileSync(join(this.dir, 'layer-facts.jsonl'), `${JSON.stringify(f)}\n`)
  }

  /** Node 上行帧全文（run.event 等已脱敏帧）。 */
  nodeUplink(frame: Record<string, unknown>): void {
    appendFileSync(join(this.dir, 'node-events.jsonl'), `${JSON.stringify(frame)}\n`)
  }

  /** 某 Browser 连接收到的帧全文（ClientFrame，已脱敏）。 */
  browserFrame(who: 'alice' | 'bob', frame: unknown): void {
    appendFileSync(join(this.dir, `browser-${who}.jsonl`), `${JSON.stringify(frame)}\n`)
  }

  /** Browser socket 存活事实。 */
  browserFact(who: 'alice' | 'bob', kind: string): void {
    this.fact('browser', kind, { who })
  }

  /** Runtime stdout 一帧的摘要（协议 type + 字节长度；文本不出 Runtime 层）。 */
  runtimeFrame(type: string, byteLength: number): void {
    appendFileSync(
      join(this.dir, 'runtime-summary.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), type, byteLength })}\n`,
    )
  }

  all(): readonly Phase1Event[] {
    return this.events
  }

  /** 全量事件一次性写 index.json 的伴生输入（由 buildIndex 消费）。 */
  writeEventsSnapshot(): void {
    writeFileSync(
      join(this.dir, 'events.jsonl'),
      this.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    )
  }
}

// ---------- 跨层 traceId/runId 索引 ----------

export interface RunLayerEvidence {
  /** 该层与本 run 相关的观测条数。 */
  events: number
  /** 证据文件名（相对证据目录）。 */
  files: string[]
}

export interface RunIndexEntry {
  firstSeenAt: string
  lastSeenAt: string
  layers: Partial<Record<'runtime' | 'node' | 'hub' | 'browser', RunLayerEvidence>>
}

export interface Phase1Index {
  traceId: string
  generatedAt: string
  scenario: string
  fault: FaultKind
  /** runId → 各层证据计数与文件（跨层对证据的入口）。 */
  runs: Record<string, RunIndexEntry>
  /** commandId → outbox 派发事实（Hub→Node 命令链 trace）。 */
  commands: Record<string, { type: string; runId?: string; dispatched: number; ackedAt?: string }>
}

const RUN_LAYER_COMPONENTS: Record<'runtime' | 'node' | 'hub' | 'browser', (c: string) => boolean> =
  {
    runtime: (c) => c === 'runtime.bridge' || c === 'dsh.agent',
    node: (c) => c.startsWith('node.'),
    hub: (c) => c.startsWith('hub.') || c === 'artifact.store',
    browser: (c) => c === 'browser',
  }

const LAYER_FILES: Record<'runtime' | 'node' | 'hub' | 'browser', string[]> = {
  runtime: ['runtime-summary.jsonl'],
  node: ['node-events.jsonl'],
  hub: ['db-snapshot.json'],
  browser: ['browser-alice.jsonl', 'browser-bob.jsonl'],
}

/**
 * 从结构化事件流构建跨层索引：同一 runId 在 runtime/node/hub/browser 四层
 * 各留下多少观测、落在哪些文件；命令链（outbox 派发/ack）单独成表。
 * verify 用它做「每层证据齐不齐」的一致性检查，人工用它一把捞齐一个 run。
 */
export function buildIndex(input: {
  recorder: Phase1Recorder
  scenario: string
  fault: FaultKind
  dbRunEvents: Array<{ runId: string; ts?: string }>
}): Phase1Index {
  const { recorder, scenario, fault, dbRunEvents } = input
  const runs: Record<string, RunIndexEntry> = {}
  const ensure = (runId: string): RunIndexEntry => {
    const existing = runs[runId]
    if (existing !== undefined) return existing
    const created: RunIndexEntry = { firstSeenAt: '', lastSeenAt: '', layers: {} }
    runs[runId] = created
    return created
  }

  const touch = (runId: string, ts: string): RunIndexEntry => {
    const entry = ensure(runId)
    if (entry.firstSeenAt === '' || ts < entry.firstSeenAt) entry.firstSeenAt = ts
    if (ts > entry.lastSeenAt) entry.lastSeenAt = ts
    return entry
  }

  for (const e of recorder.all()) {
    if (e.runId === undefined) continue
    const entry = touch(e.runId, e.ts)
    for (const [layer, matches] of Object.entries(RUN_LAYER_COMPONENTS) as Array<
      ['runtime' | 'node' | 'hub' | 'browser', (c: string) => boolean]
    >) {
      if (!matches(e.component)) continue
      const layerEvidence = entry.layers[layer] ?? { events: 0, files: LAYER_FILES[layer] }
      layerEvidence.events += 1
      entry.layers[layer] = layerEvidence
    }
  }
  // hub 层证据以 db 快照的 run 行为准（run_events 查询结果）。
  for (const row of dbRunEvents) {
    const entry = touch(row.runId, row.ts ?? new Date().toISOString())
    const hub = entry.layers.hub ?? { events: 0, files: LAYER_FILES.hub }
    hub.events += 1
    entry.layers.hub = hub
  }

  const commands: Phase1Index['commands'] = {}
  for (const e of recorder.all()) {
    if (e.component !== 'hub.outbox') continue
    const commandId = e.data?.['commandId']
    if (typeof commandId !== 'string') continue
    const c = commands[commandId] ?? {
      type: typeof e.data?.['type'] === 'string' ? e.data['type'] : 'unknown',
      dispatched: 0,
    }
    if (e.kind === 'outbox.dispatch') c.dispatched += 1
    if (e.kind === 'outbox.acked' && typeof e.data?.['ackedAt'] === 'string') {
      c.ackedAt = e.data['ackedAt']
    }
    commands[commandId] = c
  }

  return {
    traceId: recorder.traceId,
    generatedAt: new Date().toISOString(),
    scenario,
    fault,
    runs,
    commands,
  }
}
