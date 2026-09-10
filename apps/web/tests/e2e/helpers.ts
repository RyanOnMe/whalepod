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
  TOUCH_MIN_PX,
  checkControlTokens,
  normalizeColor,
  parseVendorInputMetrics,
  resolveTokenValue,
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
 * #168 视觉判据（真实浏览器实测）：控件的**背景 / 描边色 / 文字色**必须等于同名 token 的
 * **解析值**；**描边宽度与圆角**必须等于**同一浏览器里 vendored `Input` 声明的实测值**；
 * `min-height` 必须等于 `--touch-min`。
 *
 * 两条口径是被实测逼出来的（评审 BLOCK-1，两条都会让 Q5 对每个控件必红）：
 * 1. `getComputedStyle(el).getPropertyValue('--dsw-…')` 拿到的是**解析值**而不是声明原文
 *    ——自定义属性是继承属性，且 computed-value 阶段就完成了 `var()` 代换。所以浏览器侧
 *    **判不了"用的哪个 token"**，那一条由源码文本判据负责；这里只做解析值对解析值。
 * 2. Chrome 对 `border: 0.5px` 的 computed/used 宽度就是 **1px**（本机实测：DPR=1 与 DPR=2
 *    都是 `1px`）。所以期望值不能写 `'0.5px'`，改为在**同一个浏览器**里给 vendored 的
 *    `border` / `border-radius` 声明建一个参照元素实测——元素对元素比较，取整与上游度量
 *    变化都自动吸收（实测：控件与参照都在 DPR=1/2 下报 `1px`，圆角都报 `8px`）。
 *
 * 判定交给与单测共用的 `checkControlTokens`（`src/shared/control-style-tokens.ts`）。
 *
 * 参照元素的**自检**不能省：如果设计 token 没进页面（例如判据跑在没加载 `dsw-tokens.css`
 * 的页面上），`border: 0.5px solid var(--dsw-alias-border-l4)` 会在 computed-value 阶段整条失效、
 * 参照按 `border-width` 初值 `0px` 计算——实测确实如此（`ref: "0px"`）。那种情况下
 * "控件 == 参照" 可能两边都是 0 而**假绿**。所以下面显式断言参照非 0，并断言参照的描边色
 * 等于 vendored CSS 里那个 token 的解析值。
 */
export async function assertControlTokens(control: Locator, label: string): Promise<void> {
  // cwd = 仓库根是本套 e2e 的既有约定（pairing-ui.spec.ts 也这么用）；路径不对就当场炸，
  // 不静默跳过——静默跳过的判据等于没有判据。
  const vendorCss = readFileSync(
    join(process.cwd(), 'apps/web/src/vendor/dsh-ui/Input.module.css'),
    'utf8',
  )
  const metrics = parseVendorInputMetrics(vendorCss)
  const probe = await control.evaluate(
    (el, input) => {
      // 从元素自身往 documentElement 走：继承属性 + 局部重绑都算对（深色主题也在 body 上）。
      const chain = ((): CSSStyleDeclaration[] => {
        const styles: CSSStyleDeclaration[] = []
        for (let node: Element | null = el; node !== null; node = node.parentElement) {
          styles.push(getComputedStyle(node))
        }
        if (styles.length === 0) styles.push(getComputedStyle(document.documentElement))
        return styles
      })()
      // 参照元素：插进 DOM 再量。为什么不是 `display: none`——那种元素根本不进渲染树，
      // Chrome 不会解析出计算值；这里用 fixed + 移出视口，元素正常参与布局与计算。
      const reference = document.createElement('div')
      reference.setAttribute('data-control-family-reference', 'true')
      reference.style.cssText = `position: fixed; top: 0; left: -9999px; width: 10px; height: 10px; border: ${input.borderDeclaration}; border-radius: ${input.radius};`
      document.body.append(reference)
      try {
        const referenceStyle = getComputedStyle(reference)
        const style = getComputedStyle(el)
        return {
          background: style.backgroundColor,
          borderColor: style.borderTopColor,
          borderWidth: style.borderTopWidth,
          radius: style.borderTopLeftRadius,
          color: style.color,
          minHeight: style.minHeight,
          referenceBorderWidth: referenceStyle.borderTopWidth,
          referenceRadius: referenceStyle.borderTopLeftRadius,
          referenceBorderColor: referenceStyle.borderTopColor,
          chain,
        }
      } finally {
        reference.remove()
      }
    },
    { borderDeclaration: metrics.borderDeclaration, radius: metrics.radius },
  )
  // 参照自检（理由见函数头注释）：token 没进页面时整条 `border` 会在 computed-value 阶段失效，
  // 参照按 0px 计算，"两边都是 0"会假绿。
  const referenceBorderPx = Number.parseFloat(probe.referenceBorderWidth)
  if (!Number.isFinite(referenceBorderPx) || referenceBorderPx <= 0) {
    throw new Error(
      `${label} 的参照元素量到 ${probe.referenceBorderWidth}：vendored 的 \`${metrics.borderDeclaration}\` 在这张页面上没生效（设计 token 缺失？）——判据不能就这样通过`,
    )
  }
  if (Number.parseFloat(probe.referenceRadius) <= 0) {
    throw new Error(`${label} 的参照元素圆角量到 ${probe.referenceRadius}（vendored 度量没生效）`)
  }
  const resolvedBorderToken = resolveTokenValue(probe.chain, CONTROL_BORDER_TOKEN)
  if (normalizeColor(probe.referenceBorderColor) !== normalizeColor(resolvedBorderToken)) {
    throw new Error(
      `${label} 的参照元素描边色 ${probe.referenceBorderColor} 与页面 token ${CONTROL_BORDER_TOKEN}=${resolvedBorderToken} 不符：源码里的 vendored 度量与页面加载的 token 已经对不上了`,
    )
  }
  const failures = checkControlTokens(
    {
      ...probe,
      resolved: {
        background: resolveTokenValue(probe.chain, CONTROL_BACKGROUND_TOKEN),
        border: resolveTokenValue(probe.chain, CONTROL_BORDER_TOKEN),
        label: resolveTokenValue(probe.chain, CONTROL_LABEL_TOKEN),
        touch: resolveTokenValue(probe.chain, CONTROL_TOUCH_TOKEN),
      },
    },
    {
      backgroundToken: CONTROL_BACKGROUND_TOKEN,
      borderToken: CONTROL_BORDER_TOKEN,
      labelToken: CONTROL_LABEL_TOKEN,
      minTouchPx: TOUCH_MIN_PX,
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
