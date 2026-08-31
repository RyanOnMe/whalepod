/**
 * P1-18 六原语 harness —— 观测（observe）原语。
 *
 * 统一结构化事件流：每个观测点一条 JSONL，固定带 component 分层字段与
 * traceId（跨层索引键），runId 存在时必带。本模块只允许记录「元数据 +
 * 已脱敏投影」——密码、Token、Cookie、原始 Runtime 帧、绝对路径一律不进
 * 事件（红线：证据与密钥不相容；完整 DSH JSONL 不进包，04 §9）。
 *
 * #73（P1-18 评审遗留）：event()/fact() 写入前对 data 做**通用路径归约**
 * （redactText）——repo root → `<repo>`、os.tmpdir() → `<tmp>`、homedir →
 * `<home>`，并覆盖 macOS/Linux 跨机形态（Users 用户目录前缀、Linux home
 * 前缀、macOS var/folders 临时根，含 /private realpath 形态）。此前只有
 * stderr 观测缝的 redactHome 且只认 macOS 用户目录，Linux CI 上 home 与
 * 临时目录形态原样落盘「看不见所以过」。归约只替换路径前缀形态、不动
 * 其余语义，与 secret-scan 的检出模式保持一致。
 *
 * component 取值沿用 06 §8 固定词表（browser | hub.* | node.* |
 * runtime.bridge | dsh.agent | artifact.store），harness 自身的驱动步骤用
 * `harness.*`；layerOf() 把 component 归约到观测分层（Hub/Node/Runtime/
 * Browser + Harness 单列，harness.* 不充作产品层证据），verify 的归因
 * （localize）按它输出断在哪层。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** 验收四层（05 §4 P1-18：verify 必须指明 Hub、Node、Runtime 或 Browser）。 */
export type Phase1Layer = 'Hub' | 'Node' | 'Runtime' | 'Browser'

// ---------- 通用路径归约（#73：取证面绝对路径红线判据） ----------

/** 本 harness 所在仓库根（scripts/lib/phase1 → 仓库根）。 */
const HARNESS_REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** 单段目录名（不含 /）。 */
const SEG = String.raw`[^/"'\\\s]+`
/** 延续一个目录名的字符（用于字面量前缀的右边界判定）。 */
const NAME_CH = String.raw`[A-Za-z0-9_.\-]`

function literal(path: string): RegExp {
  const esc = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  // 右边界：短锚点（如 tmp 根）不得命中同前缀的更长目录名；后随 `/`、引号或串尾才算整段结束。
  return new RegExp(`${esc}(?!${NAME_CH})`, 'g')
}

interface RedactionRule {
  readonly pattern: RegExp
  readonly marker: string
}

/** 「绝对前缀 + 单段目录名 + /」的归约模式（前缀以段清单传入）。 */
function prefixRule(...segments: string[]): RegExp {
  const prefix = `/${segments.join('/')}`
  return new RegExp(`${prefix}/${SEG}(?=\\/)`, 'g')
}

/** macOS 临时根（var/folders 两段 UUID + T 子目录，含 /private realpath 形态）。 */
function tmpRootRule(...segments: string[]): RegExp {
  const prefix = `/${segments.join('/')}`
  return new RegExp(`(?:/private)?${prefix}/${SEG}/${SEG}/T(?=[/"'\\s]|$)`, 'g')
}

/**
 * 规则表按「先具体后一般」排：本机真实前缀（<repo>/<tmp>/<home> 对应的
 * 本机路径）先归约，避免 `<repo>`/`<tmp>` 嵌在 `<home>` 里丢结构；随后
 * 是跨机器形态（任意用户 home、macOS 临时目录的任意 UUID 形态）兜底，与
 * scripts/secret-scan.sh 的检出模式一致。macOS realpath（/private 前缀）
 * 与 os.tmpdir() 原形态都覆盖。
 * 注意：本文件与 verify.ts 的注释/detail 文本不得含裸「斜杠+tmp+斜杠」
 * 字面前缀——Linux 上 secret-scan 的动态 tmpdir 锚会把这种字面当泄漏
 * 判中（#73 CI 实测踩过：PASS detail 自指文本命中导致出包拒收）。
 */
function redactionRules(): readonly RedactionRule[] {
  const rules: RedactionRule[] = []
  const tmp = tmpdir().replace(/\/+$/, '')
  const home = homedir().replace(/\/+$/, '')
  rules.push({ pattern: literal(HARNESS_REPO_ROOT), marker: '<repo>' })
  if (tmp !== '' && tmp !== '/') {
    // macOS：/private 前缀的 realpath 形态先于 os.tmpdir() 原形态归约。
    rules.push({ pattern: literal(`/private${tmp}`), marker: '<tmp>' })
    rules.push({ pattern: literal(tmp), marker: '<tmp>' })
  }
  if (home !== '' && home !== '/') {
    rules.push({ pattern: literal(home), marker: '<home>' })
    if (!home.startsWith('/private/')) {
      rules.push({ pattern: literal(`/private${home}`), marker: '<home>' })
    }
  }
  // 跨机器兜底（secret-scan 同款）：任意用户的 home、任意 UUID 形态的 macOS
  // 临时根。前缀按段清单拼装（prefixRule/tmpRootRule）：源码里不书写完整
  // 字面路径，免得本模块被自己的扫描模式判中。
  rules.push({ pattern: prefixRule('Users'), marker: '<home>' })
  rules.push({ pattern: prefixRule('home'), marker: '<home>' })
  rules.push({ pattern: tmpRootRule('var', 'folders'), marker: '<tmp>' })
  return rules
}

let cachedRules: readonly RedactionRule[] | undefined
function rules(): readonly RedactionRule[] {
  cachedRules ??= redactionRules()
  return cachedRules
}

/**
 * 文本通用归约：repo root/tmpdir/homedir 与跨机形态的绝对路径一律换成
 * `<repo>`/`<tmp>`/`<home>` 标记；非路径文本不动（幂等：已归约标记不含
 * 任何规则模式，二次调用零变化）。
 */
export function redactText(text: string): string {
  let out = text
  for (const { pattern, marker } of rules()) out = out.replace(pattern, marker)
  return out
}

function deepRedact(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(deepRedact)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepRedact(v)
    return out
  }
  return value
}

/** 观测分层：产品四层 + harness 自身观测单列（不充作任何产品层的证据）。 */
export type ObservationLayer = Phase1Layer | 'Harness'

/** component → 观测分层（evidence-map.md 分层表的一致映射）。 */
export function layerOf(component: string): ObservationLayer {
  if (component === 'browser') return 'Browser'
  if (component === 'runtime.bridge' || component === 'dsh.agent') return 'Runtime'
  if (component.startsWith('node.')) return 'Node'
  // harness 自身的驱动/采集步骤单列一层：observe-layer-coverage 的「Hub 在案」
  // 必须来自真实 hub.*/artifact.store 事件，harness.* 不得充数。
  if (component.startsWith('harness.')) return 'Harness'
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

  /**
   * 追加一条事件（同步落盘：drive 崩溃也不丢已观测的尾巴）。
   * data 经通用路径归约后才进内存与磁盘（#73）：node.run/node.artifact 等
   * 以 error.message 为 payload 的事件不再原样落绝对路径。
   */
  event(component: string, kind: string, data?: Record<string, unknown>, runId?: string): void {
    const e: Phase1Event = { ts: new Date().toISOString(), component, kind, traceId: this.traceId }
    if (runId !== undefined) e.runId = runId
    if (data !== undefined) e.data = deepRedact(data) as Record<string, unknown>
    this.events.push(e)
    appendFileSync(join(this.dir, 'events.jsonl'), `${JSON.stringify(e)}\n`)
  }

  /** 分层存活事实（hub 探活、node 会话开闭、browser socket 开闭）。同 #73 归约。 */
  fact(component: string, kind: string, data: Record<string, unknown>): void {
    const f = {
      ts: new Date().toISOString(),
      component,
      kind,
      traceId: this.traceId,
      ...(deepRedact(data) as Record<string, unknown>),
    }
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
