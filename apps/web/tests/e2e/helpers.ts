/**
 * P1-19 E2E 共享助手（Q5 浏览器门）。
 *
 * 三条通道，职责分明（六原语·驱动）：
 * 1. 浏览器通道：产品 UI（Playwright locators）——一切用户可见行为必须走这里；
 * 2. Hub HTTP 通道：真人同一 API（登录 Cookie + Origin + Idempotency-Key），
 *    仅用于 UI 尚未覆盖的动作（邀请开通、配对码生成——成员管理/设备配对 UI
 *    属后续版本，P1-07 既有惯例）；
 * 3. e2e-serve 控制面通道（127.0.0.1 + 一次性 Token）：**只做故障注入与取证**
 *    （Node/Hub 进程生命周期、脱敏后的 DB 事实快照、日志尾），不承载产品行为。
 *
 * 控制面 Token 只存在于 0600 临时清单与本进程内存，不进 git、不进证据包。
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  CONTROL_BACKGROUND_TOKEN,
  CONTROL_BORDER_TOKEN,
  CONTROL_LABEL_TOKEN,
  CONTROL_TOUCH_TOKEN,
  checkControlTokens,
} from '../../src/shared/control-style-tokens.js'
import { expect } from '@playwright/test'
import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test'

export interface E2eEnv {
  hubOrigin: string
  webOrigin: string
  setupTokenPath: string
  setupToken: string
  controlPort: number
  controlToken: string
}

let envCache: E2eEnv | undefined

export function env(): E2eEnv {
  if (envCache === undefined) {
    envCache = JSON.parse(readFileSync(join(tmpdir(), 'whalepod-e2e-env.json'), 'utf8')) as E2eEnv
  }
  if (envCache.controlPort === undefined || envCache.controlToken === undefined) {
    throw new Error('环境清单缺控制面字段（e2e-serve 版本过旧？）')
  }
  return envCache
}

/** 以某个已登录会话的 Cookie 直调 Hub HTTP API（账号开通/配对码等非 UI 覆盖动作）。 */
export async function hubApi(
  cookie: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${env().hubOrigin}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      // Origin 与 Idempotency-Key 与浏览器同形（03 §4：非安全方法双闸门）。
      origin: env().webOrigin,
      'idempotency-key': randomUUID(),
      cookie,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json()) as { ok: boolean; data?: unknown }
  return { status: res.status, data: json.data }
}

export async function sessionCookie(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(env().webOrigin)
  const session = cookies.find((c) => c.name === 'whalepod_session')
  if (session === undefined) throw new Error('会话 Cookie 不存在')
  return `${session.name}=${session.value}`
}

/** 控制面调用（故障注入/取证专用；Token 绝不进任何落盘证据）。 */
export async function controlApi<T = unknown>(
  path: string,
  body?: unknown,
  method: 'GET' | 'POST' = 'POST',
): Promise<T> {
  const e = env()
  const res = await fetch(`http://127.0.0.1:${e.controlPort}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-e2e-control': e.controlToken,
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`控制面 ${path} 失败：${res.status} ${text.slice(0, 500)}`)
  }
  return (await res.json()) as T
}

/** Node 子进程控制面（e2e-serve 代理转发；同样只注入故障/读观测）。 */
export async function nodeControl<T = unknown>(path: string, body?: unknown): Promise<T> {
  return controlApi<T>(`/control/node/proxy`, { path, body })
}

// ---------- 脱敏后的 DB 事实（判定/归因用；列白名单在 e2e-serve 侧） ----------

export interface RunFact {
  run: {
    id: string
    status: string
    failureCode: string | null
    failureSummary: string | null
    ownerUserId: string
    rerunOfRunId: string | null
    startedAt: string | null
    finishedAt: string | null
  }
  runEvents: Array<{ seq: number; type: string; audience: string }>
  approvals: Array<{ id: string; status: string; toolName: string; decidedBy: string | null }>
  artifacts: Array<{
    id: string
    status: string
    sha256: string
    title: string
    ownerUserId: string
  }>
  outbox: Array<{ type: string; attempts: number; acked: boolean; failed: boolean }>
}

export function getRunFact(runId: string): Promise<RunFact> {
  return controlApi<RunFact>(`/control/db/run/${runId}`, undefined, 'GET')
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'lost'])

/** 轮询到 Run 目标状态（终态之外的跃迁判定，如 waiting_approval）。 */
export async function waitForRunStatus(
  runId: string,
  status: string,
  timeoutMs = 90_000,
): Promise<RunFact> {
  const deadline = Date.now() + timeoutMs
  let last = 'missing'
  for (;;) {
    const fact = await getRunFact(runId)
    last = `${fact?.run.status ?? '-'}/${fact?.run.failureCode ?? '-'}`
    if (fact !== null && fact.run.status === status) return fact
    if (fact !== null && TERMINAL.has(fact.run.status)) {
      throw new Error(
        `Run ${runId.slice(0, 8)} 提前进终态 ${fact.run.status}（期望 ${status}，failure=${fact.run.failureCode ?? '-'} ${fact.run.failureSummary ?? ''}）`,
      )
    }
    if (Date.now() > deadline) {
      throw new Error(`Run ${runId.slice(0, 8)} 未在 ${timeoutMs}ms 内到 ${status}（当前 ${last}）`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------- UI 通用步骤（键盘可达纪律与 P1-07 一致） ----------

/** 键盘路径：填输入框后 Enter（表单隐式提交）。 */
export async function fillAndEnter(page: Page, selector: string, value: string): Promise<void> {
  await page.fill(selector, value)
  await page.press(selector, 'Enter')
}

// ---------- #168：自研表单控件（.field input / .field textarea / .button）的浏览器侧判据 ----------

/**
 * 从 vendored `Input.module.css` 的 `.wrap` 读 DSH 族的描边宽度与圆角（**不抄数字**）。
 *
 * 与单测 `tests/control-family.spec.tsx` 的 `readVendorMetrics` 同口径，但这份是给
 * Playwright 进程用的（那个是 vitest/jsdom 侧的），所以只能各读一次源文件——两边的
 * **判定逻辑与 token 常量**仍然共用 `src/shared/control-style-tokens.ts`。
 */
function readVendorInputMetrics(): { borderWidth: string; radius: string } {
  // cwd = 仓库根是本套 e2e 的既有约定（pairing-ui.spec.ts 也这么用）；路径不对就当场炸，
  // 不静默跳过——静默跳过的判据等于没有判据。
  const text = readFileSync(
    join(process.cwd(), 'apps/web/src/vendor/dsh-ui/Input.module.css'),
    'utf8',
  ).replaceAll(/\/\*[\s\S]*?\*\//g, '')
  const wrap = /(?:^|[},])\s*\.wrap\s*\{([^}]*)\}/.exec(text)?.[1]
  if (wrap === undefined) throw new Error('vendored Input.module.css 里找不到 .wrap 规则')
  const border = /border\s*:\s*([\d.]+(?:px|rem|em))/.exec(wrap)?.[1]
  const radius = /border-radius\s*:\s*([^;]+)/.exec(wrap)?.[1]?.trim()
  if (border === undefined || radius === undefined) {
    throw new Error('vendored Input.module.css 的 .wrap 缺 border 宽度或 border-radius')
  }
  return { borderWidth: border, radius }
}

/**
 * #168 视觉判据（真实浏览器实测）：`.field input` / `.field textarea` / `.button` 的
 * **描边宽度、描边色、背景、文字色、圆角、min-height** 必须与约定一致。
 *
 * 采集到的 computed style 里，"用了哪个 token"读 `getPropertyValue('--dsw-…')`（拿到的是
 * **声明原文**，实测如此），"最终值"读 `backgroundColor` / `borderTopColor` / `color`；
 * 判定交给与单测共用的 `checkControlTokens`——两边各写一份判定必然漂移。
 *
 * 为什么要浏览器这一遍：单测读的是 CSS **文本**，证明不了层叠（`@media`、后置规则、
 * 深色覆盖）之后浏览器算出来的还是这套值。
 */
export async function assertControlTokens(control: Locator, label: string): Promise<void> {
  const probe = await control.evaluate(
    (el, tokens) => {
      const style = getComputedStyle(el)
      const root = getComputedStyle(document.documentElement)
      const readRaw = (name: string): string => style.getPropertyValue(name).trim()
      const resolve = (name: string): string => {
        // `:root` 上的定义可能是 var() 链（实测 `--dsw-alias-button-primary-fill` →
        // `--dsw-alias-brand-primary`），手工跟两跳足够；跟不动就返回原文，判定会当成空串报错。
        let value = root.getPropertyValue(name).trim()
        for (let hop = 0; hop < 3; hop += 1) {
          const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)
          if (ref?.[1] === undefined) break
          value = root.getPropertyValue(ref[1]).trim()
        }
        return value
      }
      return {
        background: style.backgroundColor,
        borderColor: style.borderTopColor,
        borderWidth: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
        color: style.color,
        minHeight: style.minHeight,
        rawBackground: readRaw(tokens.backgroundToken),
        rawBorder: readRaw(tokens.borderToken),
        rawColor: readRaw(tokens.labelToken),
        resolvedBackgroundToken: resolve(tokens.backgroundToken),
        resolvedBorderToken: resolve(tokens.borderToken),
        resolvedLabelToken: resolve(tokens.labelToken),
        resolvedTouchToken: resolve(tokens.touchToken),
      }
    },
    {
      backgroundToken: CONTROL_BACKGROUND_TOKEN,
      borderToken: CONTROL_BORDER_TOKEN,
      labelToken: CONTROL_LABEL_TOKEN,
      touchToken: CONTROL_TOUCH_TOKEN,
    },
  )
  const vendor = readVendorInputMetrics()
  const failures = checkControlTokens(
    probe,
    {
      backgroundToken: CONTROL_BACKGROUND_TOKEN,
      borderToken: CONTROL_BORDER_TOKEN,
      labelToken: CONTROL_LABEL_TOKEN,
      vendorBorderWidth: vendor.borderWidth,
      vendorRadius: vendor.radius,
      minTouchPx: 40,
    },
    label,
  )
  if (failures.length > 0) throw new Error(`${label} 样式判据未过：\n- ${failures.join('\n- ')}`)
}

/** run_event 全表 seq 连续性判定（R1/R6 补发无缺无重）。 */
export function assertSeqContiguous(fact: RunFact): void {
  const seqs = [...new Set(fact.runEvents.map((e) => e.seq))].sort((a, b) => a - b)
  const contiguous = seqs.every((seq, index) => seq === index + 1)
  if (!contiguous) {
    throw new Error(`run_event seq 不连续（缺序或重复）：${JSON.stringify(seqs)}`)
  }
  if (fact.runEvents.length !== seqs.length) {
    throw new Error(`run_event 出现重复 (runId,seq) 行：${JSON.stringify(fact.runEvents)}`)
  }
}

// ---------- Node/Hub 生命周期（故障注入面；只在 e2e-serve 有真进程可操作） ----------

export interface NodeStartResult {
  deviceId: string
  workspaceDir: string
  workspaceId: string
}

export function startNode(input: {
  pairingCode: string
  workspaceFiles?: Record<string, string>
}): Promise<NodeStartResult> {
  return controlApi<NodeStartResult>('/control/node/start', input)
}

export function stopNode(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<{ stopped: boolean }> {
  return controlApi('/control/node/stop', { signal })
}

export function restartNode(): Promise<NodeStartResult> {
  return controlApi<NodeStartResult>('/control/node/restart', {})
}

export interface HubRestartResult {
  downMs: number
  hubOrigin: string
}

export function restartHub(input: {
  signal: 'SIGTERM' | 'SIGKILL'
  stayDownMs?: number
}): Promise<HubRestartResult> {
  return controlApi<HubRestartResult>('/control/hub/restart', input)
}

export function setRuntimeFixture(
  name: 'approval' | 'basic' | 'secrets' | 'rejection',
): Promise<unknown> {
  return nodeControl('/fixture', { name })
}

/** Builder workspace 真实目录（G6-07 负断言数据源；只在测试进程内存活）。 */
export async function workspaceCanonicalPath(): Promise<string> {
  const res = await nodeControl<{ canonicalPath: string }>('/workspace-path', {})
  return res.canonicalPath
}

export function dropNodeConnection(offlineMs: number): Promise<unknown> {
  return nodeControl('/drop', { offlineMs })
}

export function dropAckCount(count: number): Promise<unknown> {
  return nodeControl('/ack-drop', { count })
}

/**
 * #88：终态 Run 的 Runtime 必须由产品路径自动回收（Node 终态即发
 * runtime.shutdown；Hub 见心跳把终态 Run 报 active 会补 admin run.cancel）。
 * 本断言只做观测：轮询 /runtimes 直到该 Run 不在管（进程已退、容量已释放）。
 * 超时即产品回归——不允许测试代为回收（旧 /release 缝已随 #88 删除）。
 */
export async function waitForRuntimeReleased(runId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { runtimes } = await activeRuntimes()
    if (!runtimes.some((r) => r.runId === runId)) return
    if (Date.now() > deadline) {
      throw new Error(`Runtime 未在 ${timeoutMs}ms 内被产品路径回收（runId=${runId}）`)
    }
    await sleep(500)
  }
}

export interface RuntimeInfo {
  runId: string
  pid: number
}

export function activeRuntimes(): Promise<{
  runtimes: RuntimeInfo[]
  spawnCounts: Record<string, number>
}> {
  return nodeControl('/runtimes')
}

/** 直接 OS 级探活（取证红线：不猜，kill 0 说了算）。 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export interface InputManifestFact {
  runId: string
  manifest: unknown
  copiedFiles: string[]
  manifestText: string
}

export function inputManifestForRun(runId: string): Promise<InputManifestFact> {
  return nodeControl('/input-manifest', { runId })
}

export function seedPluginPack(ownerUserId: string): Promise<{ pluginPackId: string }> {
  return controlApi('/control/plugin-pack/seed', { ownerUserId })
}

// ---------- 失败证据（Q5/六原语·取证；复用 P1-18 redact + artifacts/evidence 目录） ----------

interface ControlTails {
  hubTail: string
  nodeTail: string
  viteTail: string
}

/** 证据文本兜底归约（与 P1-18 redactText 同占位符；控制面日志尾已先行归约）。 */
function scrubLocalPaths(text: string): string {
  const home = process.env['HOME'] ?? tmpdir()
  return text
    .replace(/\u001b\[[0-9;]*m/g, '') // 证据纯文本：去 ANSI 装饰。
    .replaceAll(home, '<home>')
    .replaceAll(tmpdir(), '<tmp>')
    .replaceAll(process.cwd(), '<repo>')
}

/**
 * 测试失败时打包证据到 artifacts/evidence/e2e/<attempt>/：
 * manifest（git/版本/时间）、脱敏后的 Hub/Node/vite 日志尾、trace/截图路径索引。
 * 文本一律先 redactText（repo/tmpdir/home 归约，#73 模式），密码与 Token 不进包。
 */
export async function collectEvidenceOnFailure(
  testInfo: TestInfo,
  facts: { traceId: string; runIds: string[] },
): Promise<void> {
  if (testInfo.status === undefined || testInfo.status === testInfo.expectedStatus) return
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const attemptId = `${new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\..+$/, 'Z')}-${testInfo.testId}`
  const dir = join(process.cwd(), 'artifacts', 'evidence', 'e2e', attemptId)
  mkdirSync(dir, { recursive: true })
  // 绝对路径归约（#73 红线）：控制面返回的日志尾已在 e2e-serve 侧过 P1-18
  // 同一 redactText（repo/tmp/home → 占位符）；这里只兜底处理测试错误文本。
  let tails: ControlTails = { hubTail: '', nodeTail: '', viteTail: '' }
  try {
    tails = await controlApi<ControlTails>('/control/tails', undefined, 'GET')
  } catch {
    // 控制面已不可用：留空，不影响其余证据。
  }
  writeFileSync(join(dir, 'hub.log.txt'), tails.hubTail)
  writeFileSync(join(dir, 'node.log.txt'), tails.nodeTail)
  writeFileSync(join(dir, 'vite.log.txt'), tails.viteTail)
  for (const runId of facts.runIds) {
    try {
      const fact = await getRunFact(runId)
      writeFileSync(join(dir, `run-${runId.slice(0, 8)}.json`), JSON.stringify(fact, null, 2))
    } catch {
      // Run 都不存在时没取证价值。
    }
  }
  const files = ['hub.log.txt', 'node.log.txt', 'vite.log.txt']
  for (const attachment of testInfo.attachments) {
    if (attachment.path !== undefined) {
      files.push(scrubLocalPaths(attachment.path)) // N1：绝对路径不进包（Q7 红线）
    }
  }
  const manifest = {
    traceId: facts.traceId,
    attemptId,
    test: testInfo.titlePath.join(' / '),
    status: testInfo.status,
    error: scrubLocalPaths(String(testInfo.error?.message ?? testInfo.error ?? '')).slice(0, 4000),
    startedAt: new Date(Date.now() - (testInfo.duration ?? 0)).toISOString(),
    endedAt: new Date().toISOString(),
    runIds: facts.runIds,
    files,
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.error(`[e2e-evidence] 失败证据：${scrubLocalPaths(dir)}`)
}
