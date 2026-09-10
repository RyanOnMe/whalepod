/**
 * #73 取证面卫生 —— Linux 路径红线判据（P1-18 评审遗留）。
 *
 * 钉死三件事：
 * 1. recorder event()/fact() 的通用路径归约：注入含 Linux home（/home/…）、
 *    os.tmpdir()、repo root、macOS 形态 /Users/ 与 /var/folders/ 的错误消息，
 *    出包前已归约为 <home>/<tmp>/<repo>，且归约只动路径形态不动语义
 * 2. verify 的「证据目录无绝对路径」判定：合成证据里钉一行未归约路径 → FAIL；
 *    绿合成证据 → 该判定 PASS（不误伤）。
 * 3. scripts/secret-scan.sh --self-test：语料含 /home/、tmpdir 形态且逐条断命中。
 *
 * 语料注：本文件刻意不出现 secret-scan 可判命中的字面路径（Linux home 用拼接），
 * 免得自证脚本本身进敏感扫描的命中面；真实形态的语料在 secret-scan --self-test
 * 的运行时临时语料里逐条断言。
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Phase1Recorder, redactText } from '../lib/phase1/events.js'
import { REPO_ROOT } from '../lib/phase1/chain.js'
import { verifyEvidence } from '../lib/phase1/verify.js'
import { writeSyntheticGreenEvidence } from './phase1-synthetic.js'

const TMP_ROOT = tmpdir().replace(/\/+$/, '')
/** chain 导出的 REPO_ROOT 是目录 URL 形态（带尾斜杠）；归约锚点按无尾斜杠比较。 */
const REPO = REPO_ROOT.replace(/\/+$/, '')
/** macOS home 根（分片构造，理由见文件头「语料注」）。 */
const MAC_HOME = `/${'U'}${'sers'}`
/** Linux 成员 home 形态的合成路径。 */
const FAKE_LINUX_HOME = `/${'home'}/carol/proj/src/index.ts`
const FAKE_MAC_HOME_FILE = `${MAC_HOME}/dave/secret/notes.md`

const dirs: string[] = []
function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wp-${prefix}-`))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('#73 recorder 通用路径归约（取证原语·脱敏）', () => {
  it('event()/fact() 注入含 Linux home/tmpdir/repo root 的错误消息 → 落盘文件已归约', () => {
    const dir = newDir('73-recorder')
    const recorder = new Phase1Recorder(dir, `t-${randomUUID()}`)
    const message =
      `ENOENT, no such file or directory ${FAKE_LINUX_HOME} | ` +
      `tmp ${TMP_ROOT}/wp-chain-ws-abc/report.md | ` +
      `repo ${join(REPO, 'packages/domain/src/x.ts')} | ` +
      `macos ${FAKE_MAC_HOME_FILE}`
    recorder.event('node.run', 'artifact candidate collection failed', { reason: message })
    recorder.fact('harness.probe', 'hub.down', { error: message })

    const eventsRaw = readFileSync(join(dir, 'events.jsonl'), 'utf8')
    const factsRaw = readFileSync(join(dir, 'layer-facts.jsonl'), 'utf8')
    for (const raw of [eventsRaw, factsRaw]) {
      expect(raw).not.toContain(FAKE_LINUX_HOME)
      expect(raw).not.toContain(TMP_ROOT)
      expect(raw).not.toContain(REPO)
      expect(raw).not.toContain(FAKE_MAC_HOME_FILE)
      // 归约是替换不是删除：语义骨架与非路径文本必须原样保留。
      expect(raw).toContain('ENOENT, no such file or directory')
      expect(raw).toContain('report.md')
      expect(raw).toContain('<repo>/packages/domain/src/x.ts')
      expect(raw).toContain('<home>/proj/src/index.ts')
    }
    expect(eventsRaw).toContain('<tmp>')
    expect(eventsRaw).toContain('<home>')
    // 内存快照（buildIndex/writeEventsSnapshot 的输入）与落盘一致——索引不再从
    // 未脱敏的内存对象取数。
    const snapDir = newDir('73-recorder-snap')
    const snap = new Phase1Recorder(snapDir, 't-snap')
    snap.event('node.artifact', 'inputs failed', { reason: `at ${FAKE_LINUX_HOME}` })
    snap.writeEventsSnapshot()
    expect(readFileSync(join(snapDir, 'events.jsonl'), 'utf8')).toContain('<home>/proj')
  })

  it('redactText 只动路径形态：非路径文本与既有标记幂等', () => {
    expect(redactText('plain text, nothing path-like')).toBe('plain text, nothing path-like')
    // 既有 Node 投影标记 <home>/private/project 不得被二次归约改形。
    expect(redactText('<home>/private/project')).toBe('<home>/private/project')
    expect(redactText('<redacted>')).toBe('<redacted>')
    // macOS 形态保留（secret-scan /Users/ 模式一致）：任意用户名前缀归 <home>。
    expect(redactText(`${MAC_HOME}/anyone/x`)).toBe('<home>/x')
    // Linux 形态同判。
    expect(redactText(`/${'home'}/anyone/x`)).toBe('<home>/x')
    // 真链路防回归（stderr tail「先归约再截断」）：截断碎片里不得残留
    // 完整机器路径或用户名（截半的字面量无法再匹配，但前缀身份必须已没）。
    const username = homedir().split('/').pop() ?? ''
    const longMsg = `spawn failed: ${join(REPO, 'packages', 'domain', 'src', 'bin.ts')} ENOENT`
    const reduced = redactText(longMsg)
    const truncated = `${reduced.slice(0, Math.max(8, reduced.length - 10))}…`
    expect(truncated).not.toContain(REPO)
    if (username !== '') expect(truncated).not.toContain(username)
    expect(truncated).toContain('spawn failed:')
  })
})

describe('#73 verify「证据目录无绝对路径」判定', () => {
  it('合成绿证据钉入一行未归约路径 → 判定 FAIL（事件流经 recorder 也拦不住直写面）', () => {
    const dir = newDir('73-residue-dirty')
    const runId = randomUUID()
    // 未归约的 Linux home 路径原样进 events.jsonl（绕过 recorder 的直写形态）。
    writeSyntheticGreenEvidence(dir, {
      runId,
      probes: [true, true, true],
      rawEventLine: JSON.stringify({
        ts: '2026-01-01T00:00:00.000Z',
        component: 'node.run',
        kind: 'direct.write.bypass',
        traceId: `phase1-synthetic-${runId.slice(0, 8)}`,
        runId,
        data: { reason: `spawn failed at ${FAKE_LINUX_HOME}` },
      }),
    })
    const verdict = verifyEvidence(dir)
    const check = verdict.checks.find((c) => c.id === 'Q7.evidence-no-abs-path')
    expect(check, 'verify 必须包含「证据目录无绝对路径」判定').toBeDefined()
    expect(check?.pass, `未归约绝对路径必须判负（detail=${check?.detail ?? '-'}）`).toBe(false)
    expect(verdict.pass).toBe(false)
    // 判定 detail 自身不得复述泄漏文本（取证面自洁）。
    expect(check?.detail ?? '').not.toContain(FAKE_LINUX_HOME)
  })

  it('干净合成证据 → 该判定 PASS（不误伤绿链）', () => {
    const dir = newDir('73-residue-clean')
    writeSyntheticGreenEvidence(dir, { runId: randomUUID(), probes: [true, true, true] })
    const verdict = verifyEvidence(dir)
    const check = verdict.checks.find((c) => c.id === 'Q7.evidence-no-abs-path')
    expect(check?.pass, `干净证据必须过判定（detail=${check?.detail ?? '-'}）`).toBe(true)
    expect(verdict.pass).toBe(true)
  })

  it('真家目录/临时目录形态的残留同样判负（本机真实路径钉进 layer-facts）', () => {
    const dir = newDir('73-residue-home')
    const runId = randomUUID()
    writeSyntheticGreenEvidence(dir, { runId, probes: [true, true, true] })
    // 直写（绕过 fact() 归约的形态）：本机 homedir 与 tmpdir 原样落盘。
    appendFileSync(
      join(dir, 'layer-facts.jsonl'),
      JSON.stringify({
        ts: '2026-01-01T00:00:00.000Z',
        component: 'hub.http',
        kind: 'hub.probe',
        traceId: 't',
        ok: false,
        error: `connect ${join(homedir(), '.config', 'pgpass')} refused at ${TMP_ROOT}/x.sock`,
      }) + '\n',
    )
    const verdict = verifyEvidence(dir)
    const check = verdict.checks.find((c) => c.id === 'Q7.evidence-no-abs-path')
    expect(check?.pass).toBe(false)
  })
})

describe('#73 secret-scan --self-test（判定力语料：/home/ 与 tmpdir 模式）', () => {
  it('自检 PASS：固定语料逐条命中（含 Linux home 与本机 tmpdir 形态），干净文件放行', () => {
    const out = execFileSync('bash', ['scripts/secret-scan.sh', '--self-test'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    })
    expect(out).toContain('PASS')
  })
})
