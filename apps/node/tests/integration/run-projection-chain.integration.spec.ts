/**
 * P1-13 G4-04/G4-05/R1 全链路验收（04 §6.3/§6.4 的机器证据）。
 *
 * 真链路全要素，无一环 mock：
 *   Browser(ws) ⇄ 真 Hub（buildApp + listen + 真 PG + 真 OutboxWorker）
 *   ⇄ 真 Node 会话（session.ts + RunManager + RuntimeSupervisor + DshRuntimeDriver）
 *   ⇄ 真 Runtime 子进程（apps/runtime bin + DSH + replay overlay，无外部模型）。
 *
 * 装配（setupChain）自 P1-18 起上升为 scripts/lib/phase1/chain.ts：与
 * phase1-drive/verify 共用同一份「真 Hub+真 Node+真 Runtime+双 Browser」
 * 装配与观测缝，本文件只保留场景断言。
 *
 * 覆盖：
 *   G4-04  owner/member 两个 Browser 连接的 frame diff（owner 全文 vs member
 *          缩水流），live delta 只到 owner；
 *   G4-05  owner 流上最后一条 assistant 内容先于 run.completed（flush 顺序）；
 *   R1     Hub 进程重启（Node 不动）→ Node 重连自动补发，Hub 侧 seq 连续无缺口；
 *   #52    Runtime 在悬置 Approval 下完成（stub 直发帧）→ Run 收敛 completed、
 *          审批折叠、spool 清空（全链路毒帧清零，ADR-0007）；
 *   语料   04 §6.4 六件秘密语料在 Hub DB 与两个 Browser 帧流中都零出现，
 *          且 owner 文本呈现脱敏标记（证明是「脱了敏」，不是「没内容」）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema } from '@project311/db'
import type { ClientFrame } from '@project311/protocol'
import { createTestDatabase, idemKey } from '../../../hub/tests/helpers.js'
import type { Database } from '@project311/db'
import {
  assembleChain,
  FIXTURE_APPROVAL,
  FIXTURE_BASIC,
  FIXTURE_SECRETS,
  TAKE_TIMEOUT_MS,
  type ChainAssembly,
} from '../../../../scripts/lib/phase1/chain.js'

const silence = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 04 §6.4 六件秘密语料：任何一件的原样出现 = Q7 失败。 */
const CORPUS = [
  'Authorization: Bearer test-secret-123',
  'DEEPSEEK_API_KEY=sk-test-abcdef',
  'npm_xxx_fake_token',
  '-----BEGIN PRIVATE KEY-----',
  '/Users/bob/private/project',
  'https://example.com/path?token=secret#fragment',
] as const

describe('P1-13 全链路（真 Hub + 真 Node + 真 Runtime/replay）', () => {
  let database: Database
  let chain: ChainAssembly | undefined

  beforeAll(async () => {
    database = await createTestDatabase()
  }, 180_000)

  afterEach(async () => {
    await chain?.cleanup()
    chain = undefined
  })

  afterAll(async () => {
    await database.close()
  })

  /** 完整链路装配（共享实现见 scripts/lib/phase1/chain.ts）。 */
  async function setupChain(fixture: string): Promise<ChainAssembly> {
    chain = await assembleChain({ database, fixture, agents: 1 })
    return chain
  }

  function startRun(input: {
    ctx: ChainAssembly['ctx']
    alice: ChainAssembly['alice']
    taskId: string
    builderAgentId: string
    deviceId: string
    workspaceId: string
  }): Promise<string> {
    return input.ctx.app
      .inject({
        method: 'POST',
        url: `/api/v1/tasks/${input.taskId}/runs`,
        headers: {
          origin: input.ctx.origin,
          cookie: input.alice.cookie,
          'idempotency-key': idemKey(),
        },
        payload: {
          agentId: input.builderAgentId,
          deviceId: input.deviceId,
          workspaceId: input.workspaceId,
          prompt: 'hello replay',
        },
      })
      .then((res) => {
        expect(res.statusCode).toBe(201)
        return res.json().data.id as string
      })
  }

  /** 等 Hub 侧某 run 的 run_event 出现 predicate 命中的行（轮询 PG，超时红）。 */
  async function waitForRunEvent(
    runId: string,
    predicate: (
      rows: Array<{ seq: number; type: string; audience: string; payload: unknown }>,
    ) => boolean,
    timeoutMs = TAKE_TIMEOUT_MS,
  ): Promise<Array<{ seq: number; type: string; audience: string; payload: unknown }>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const rows = await database.db
        .select()
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, runId))
        .orderBy(schema.runEvents.seq)
      if (predicate(rows)) return rows
      if (Date.now() > deadline) {
        const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
        const outbox = await database.db.select().from(schema.dispatchOutbox)
        throw new Error(
          `run events not satisfied; have: ${JSON.stringify(rows.map((r) => [r.seq, r.audience, r.type]))}; run=${JSON.stringify({ status: run?.status, failureCode: run?.failureCode, failureSummary: run?.failureSummary })}; outbox=${JSON.stringify(outbox.map((o) => ({ type: o.type, acked: o.ackedAt !== null, attempts: o.attemptCount })))}`,
        )
      }
      await silence(100)
    }
  }

  it('G4-04/G4-05：owner 全文+直播 vs member 缩水流；flush 顺序 completed 收尾', async () => {
    const c = await setupChain(FIXTURE_BASIC)
    const aliceWs = await c.connectBrowser(c.alice)
    const bobWs = await c.connectBrowser(c.bob)
    const runId = await startRun({
      ctx: c.ctx,
      alice: c.alice,
      taskId: c.taskId,
      builderAgentId: c.builderAgentId,
      deviceId: c.deviceId,
      workspaceId: c.workspaceId,
    })

    // Hub 落库到 completed（双受众各一行）。
    const rows = await waitForRunEvent(runId, (rs) =>
      rs.some((r) => r.type === 'run.completed' && r.audience === 'owner'),
    )
    const ownerRows = rows.filter((r) => r.audience === 'owner')
    const projectRows = rows.filter((r) => r.audience === 'project')

    // G4-05：owner 侧 assistant.message 全部先于 run.completed（seq 有序）。
    const completedSeq = ownerRows.find((r) => r.type === 'run.completed')?.seq ?? -1
    for (const row of ownerRows.filter((r) => r.type === 'assistant.message')) {
      expect(row.seq).toBeLessThan(completedSeq)
    }
    // owner 完整最终文本；project 行是确定性摘要（同事实，收缩呈现）。
    const ownerCompleted = ownerRows.find((r) => r.type === 'run.completed')
    expect(JSON.stringify(ownerCompleted?.payload)).toContain('Hello from replay.')
    expect(projectRows.length).toBeGreaterThan(0)
    for (const row of projectRows) expect(row.audience).toBe('project')

    // Browser 侧 frame diff：等 alice 收到 run.completed 持久帧。
    const aliceDeadline = Date.now() + TAKE_TIMEOUT_MS
    while (
      !aliceWs.frames.some(
        (f) =>
          f.kind === 'persistent' &&
          f.event.type === 'run.event' &&
          JSON.stringify(f.event.payload).includes('"run.completed"'),
      )
    ) {
      if (Date.now() > aliceDeadline) throw new Error('alice never saw run.completed')
      await silence(50)
    }
    // member 侧同一等待纪律（#66）：CI 慢环境下 Bob 的扇出/断线补洞可能晚于
    // Alice 到达——轮询等到 Bob 收到 run.completed 项目帧再断言；等不到必须红
    //（判定不软化：project run.completed 对 member 必达）。
    const bobDeadline = Date.now() + TAKE_TIMEOUT_MS
    while (
      !bobWs.frames.some(
        (f) =>
          f.kind === 'persistent' &&
          f.event.type === 'run.event' &&
          JSON.stringify(f.event.payload).includes('"run.completed"'),
      )
    ) {
      if (Date.now() > bobDeadline) {
        throw new Error('bob never saw run.completed (project audience)')
      }
      await silence(50)
    }
    const aliceRunEvents = aliceWs.frames.filter(
      (f) => f.kind === 'persistent' && f.event.type === 'run.event',
    )
    const bobRunEvents = bobWs.frames.filter(
      (f) => f.kind === 'persistent' && f.event.type === 'run.event',
    )
    // owner 见 owner 行（含 assistant.message 全文）；member 只见 project 行。
    expect(aliceRunEvents.some((f) => JSON.stringify(f).includes('Hello from replay.'))).toBe(true)
    expect(bobRunEvents.length).toBeGreaterThan(0)
    for (const frame of bobRunEvents) {
      expect(JSON.stringify(frame)).not.toContain('"audience":"owner"')
    }
    // 受众差异的硬核证据：assistant.message 是 owner-only 事件（03 §8）——
    // member 的帧流里一条都不出现；owner 流里必有。
    const isAssistantMessage = (f: ClientFrame) =>
      f.kind === 'persistent' &&
      f.event.type === 'run.event' &&
      JSON.stringify(f.event.payload).includes('"assistant.message"')
    expect(aliceRunEvents.some(isAssistantMessage)).toBe(true)
    expect(bobRunEvents.some(isAssistantMessage)).toBe(false)
    // live delta 只到 owner。
    const aliceLive = aliceWs.frames.filter((f) => f.kind === 'live')
    const bobLive = bobWs.frames.filter((f) => f.kind === 'live')
    expect(aliceLive.length).toBeGreaterThan(0)
    expect(bobLive).toHaveLength(0)
    expect(aliceLive.map((f) => (f.kind === 'live' ? f.delta.text : '')).join('')).toContain(
      'Hello from replay.',
    )
  }, 120_000)

  it('G5-01/G5-03：Approval 卡双受众 diff + owner HTTP 决策 → decide 命令链 → DSH 工具继续执行', async () => {
    const c = await setupChain(FIXTURE_APPROVAL)
    const aliceWs = await c.connectBrowser(c.alice)
    const bobWs = await c.connectBrowser(c.bob)
    const runId = await startRun({
      ctx: c.ctx,
      alice: c.alice,
      taskId: c.taskId,
      builderAgentId: c.builderAgentId,
      deviceId: c.deviceId,
      workspaceId: c.workspaceId,
    })

    // G5-01 前半：Approval 卡落库（DSH 工具触发 ask）。
    const rows = await waitForRunEvent(runId, (rs) =>
      rs.some((r) => r.type === 'approval.requested' && r.audience === 'owner'),
    )
    const requested = rows.find((r) => r.type === 'approval.requested' && r.audience === 'owner')
    const card = (
      requested?.payload as {
        approval: {
          approvalId: string
          callId: string
          toolName: string
          reason: string
          preview: unknown
        }
      }
    ).approval
    expect(card.toolName).toBe('publish_artifact')
    expect(card.reason).not.toBe('')
    // callId 关联（03 §8）：preview 来自同 callId 的 tool/call 参数。
    expect(JSON.stringify(card.preview)).toContain('out/report.md')

    const [approvalRow] = await database.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, card.approvalId))
    expect(approvalRow).toBeDefined()
    expect(approvalRow?.status).toBe('pending')
    expect(approvalRow?.callId).toBe(card.callId)

    // G5-01 后半：两端 frame diff——owner 见完整卡；member 只见等待态。
    const aliceDeadline = Date.now() + TAKE_TIMEOUT_MS
    while (
      !aliceWs.frames.some(
        (f) =>
          f.kind === 'persistent' &&
          f.event.type === 'run.event' &&
          JSON.stringify(f.event.payload).includes(`"${card.approvalId}"`),
      )
    ) {
      if (Date.now() > aliceDeadline) throw new Error('alice never saw approval card')
      await silence(50)
    }
    // 等待条件必须盯断言目标本身（#91，#67 同族）：approval.changed(pending)
    // 在审批创建时即广播，可能先于 requested 收缩卡到达——盯它做等待会提前
    // 放行，下方 :301 的 requested 断言偶发空集。改为轮询 requested 帧。
    const bobDeadline = Date.now() + TAKE_TIMEOUT_MS
    while (
      !bobWs.frames.some(
        (f) => f.kind === 'persistent' && JSON.stringify(f.event).includes('"approval.requested"'),
      )
    ) {
      if (Date.now() > bobDeadline) throw new Error('bob never saw approval.requested')
      await silence(50)
    }
    // owner 流里有带正文的卡；member 流里只有收缩卡（reason 恒空）与状态事件，
    // owner 卡的 reason 正文一条都不出现。
    const aliceRequested = aliceWs.frames.filter(
      (f) => f.kind === 'persistent' && JSON.stringify(f.event).includes('"approval.requested"'),
    )
    expect(aliceRequested.some((f) => JSON.stringify(f).includes(card.reason))).toBe(true)
    for (const frame of bobWs.frames) {
      expect(JSON.stringify(frame), 'member stream must not carry owner card reason').not.toContain(
        card.reason,
      )
    }
    const bobRequested = bobWs.frames.filter(
      (f) => f.kind === 'persistent' && JSON.stringify(f.event).includes('"approval.requested"'),
    )
    expect(bobRequested.length).toBeGreaterThan(0)
    for (const frame of bobRequested) {
      const payload = frame.kind === 'persistent' ? frame.event.payload : {}
      const approval = (payload as { event?: { approval?: { reason?: string } } }).event?.approval
      expect(approval?.reason).toBe('')
    }

    // G5-03：owner 经真人 HTTP 路径决定 → Hub→Node→Runtime 命令链。
    const decideRes = await c.ctx.app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${card.approvalId}/decisions`,
      headers: {
        origin: c.ctx.origin,
        cookie: c.alice.cookie,
        'idempotency-key': crypto.randomUUID(),
      },
      payload: { decision: 'allowed_once' },
    })
    expect(decideRes.statusCode).toBe(200)
    expect(decideRes.json()).toMatchObject({
      ok: true,
      data: { status: 'allowed_once', decidedBy: c.alice.userId },
    })

    // 命令链 trace：outbox 的 approval.decide 已被 Node ack。
    const decideDeadline = Date.now() + TAKE_TIMEOUT_MS
    for (;;) {
      const [command] = await database.db
        .select()
        .from(schema.dispatchOutbox)
        .where(eq(schema.dispatchOutbox.type, 'approval.decide'))
      if (command?.ackedAt !== null && command !== undefined) {
        expect(command.payload).toMatchObject({
          runId,
          approvalId: card.approvalId,
          callId: card.callId,
          decision: 'allowed_once',
        })
        break
      }
      if (Date.now() > decideDeadline) throw new Error('approval.decide never acked by node')
      await silence(100)
    }

    // DSH 工具继续执行：allow 后 publish_artifact 跑通（tool.finished succeeded），
    // Agent 生成解释后 Run 正常完成。
    // 注：artifact.candidate 的投影与落库是 P1-15 交付，本链路不断言。
    await waitForRunEvent(runId, (rs) =>
      rs.some(
        (r) =>
          r.type === 'tool.finished' &&
          r.audience === 'owner' &&
          (r.payload as { outcome?: string }).outcome === 'succeeded',
      ),
    )
    await waitForRunEvent(runId, (rs) =>
      rs.some((r) => r.type === 'run.completed' && r.audience === 'owner'),
    )
    const [finalRun] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(finalRun?.status).toBe('completed')

    const [decidedApproval] = await database.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, card.approvalId))
    expect(decidedApproval?.status).toBe('allowed_once')
    expect(decidedApproval?.decidedBy).toBe(c.alice.userId)
    expect(decidedApproval?.decidedAt).not.toBeNull()
    // 决定回显是持久事件（owner/project 双受众）。
    const decidedRows = await database.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId))
    expect(
      decidedRows
        .filter((r) => r.type === 'approval.decided')
        .map((r) => r.audience)
        .sort(),
    ).toEqual(['owner', 'project'])
  }, 180_000)

  it('R1：Hub 重启（Node 不动）→ 重连自动补发，Hub 侧 seq 连续完整', async () => {
    // 确定性时序：等 Node 侧 runtime 真的在跑 → 关 Hub → 等 runtime 跑完
    // （Node 侧视角：activeRunIds 清空 = 全部事件已产出并落 spool、上行丢弃）
    // → 同端口重启 Hub → Node 自动重连 → onConnected 全量 drain 补发。
    const c = await setupChain(FIXTURE_BASIC)
    const runId = await startRun({
      ctx: c.ctx,
      alice: c.alice,
      taskId: c.taskId,
      builderAgentId: c.builderAgentId,
      deviceId: c.deviceId,
      workspaceId: c.workspaceId,
    })

    const startDeadline = Date.now() + 30_000
    while (!c.supervisor.activeRunIds().includes(runId)) {
      if (Date.now() > startDeadline) throw new Error('runtime never started on node')
      await silence(50)
    }
    await c.closeHub()
    // 完成信号 = spool 里出现 run.completed（runtime 完成后子进程驻留等待
    // shutdown——activeRunIds 不是完成信号）。直读 spool sqlite（WAL 允许并发读）。
    const spool = new DatabaseSync(join(c.nodeStateDir, 'events.sqlite'), { readOnly: true })
    const doneDeadline = Date.now() + 60_000
    for (;;) {
      const row = spool
        .prepare(
          "select seq from spooled_event where run_id = ? and instr(payload, 'run.completed') > 0",
        )
        .get(runId)
      if (row !== undefined) break
      if (Date.now() > doneDeadline) {
        spool.close()
        throw new Error('run.completed never reached node spool')
      }
      await silence(100)
    }
    spool.close()

    await c.listenAgain()

    const rows = await waitForRunEvent(runId, (rs) => rs.some((r) => r.type === 'run.completed'))
    // 全量补发：seq 空间跨受众共享（每行一个 seq；03 §8）——全行集合
    // 从 1 连续无缺口，且双受众都在（dedup 幂等 = 恰好一次应用）。
    const seqs = [...new Set(rows.map((r) => r.seq))].sort((a, b) => a - b)
    expect(seqs, 'run seq space contiguous').toEqual(
      Array.from({ length: seqs.length }, (_, i) => i + 1),
    )
    expect(rows.some((r) => r.audience === 'owner')).toBe(true)
    expect(rows.some((r) => r.audience === 'project')).toBe(true)
    // 终态落地：Hub 侧 run 行转 completed（终态禁复活的正向面）。
    const [run] = await database.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(run?.status).toBe('completed')
  }, 120_000)

  it('#52 全链路：Runtime 在悬置 Approval 下完成 → Run 收敛 completed、审批折叠、连接与 spool 正常收口', async () => {
    // 「审批不阻塞」的 Runtime 用 stub 直发 §7.2 帧构造（与 fault=runtime 必崩
    // stub 同先例）：ready → approval.requested（无决定）→ run.completed。
    // 真 Node（投影/spool/drain/重连）+ 真 Hub（WS/orchestrator/PG）原样跑毒帧
    // 序列——修复前此处必现 4003 循环：run 永卡 waiting_approval、spool 永不清空。
    const stubDir = mkdtempSync(join(tmpdir(), 'p311-p52-runtime-stub-'))
    const stub = join(stubDir, 'runtime-entry.mjs')
    // driver 的 spawn 参数形态：node <entry> -- --run-id <id> --nonce <n> --prompt-stdin
    writeFileSync(
      stub,
      [
        'const argv = process.argv.slice()',
        "const runId = argv[argv.indexOf('--run-id') + 1]",
        'const send = (type, payload) =>',
        '  process.stdout.write(',
        "    JSON.stringify({ protocolVersion: 1, messageId: crypto.randomUUID(), sentAt: new Date().toISOString(), type, payload }) + '\\n',",
        '  )',
        'process.stdin.resume()',
        "setTimeout(() => send('runtime.ready', { runId, dshSessionId: 'stub-session-1' }), 100)",
        "setTimeout(() => send('approval.requested', { runId, callId: 'call-p52-1', toolName: 'bash', reason: 'needs rm' }), 400)",
        "setTimeout(() => send('run.completed', { runId, dshSessionId: 'stub-session-1' }), 900)",
      ].join('\n'),
    )
    let c: ChainAssembly
    try {
      c = await assembleChain({
        database,
        fixture: FIXTURE_BASIC,
        agents: 1,
        runtimeEntry: stub,
        nodeArgs: [],
      })
      chain = c
      const runId = await startRun({
        ctx: c.ctx,
        alice: c.alice,
        taskId: c.taskId,
        builderAgentId: c.builderAgentId,
        deviceId: c.deviceId,
        workspaceId: c.workspaceId,
      })

      // 悬置审批落 Hub：Run 进入 waiting_approval（真人路径上行）。
      await waitForRunEvent(runId, (rs) =>
        rs.some((r) => r.type === 'approval.requested' && r.audience === 'owner'),
      )
      const [waiting] = await database.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
      expect(waiting?.status).toBe('waiting_approval')

      // 裁决覆盖：run.completed 到达 → 全链路收敛为真终态 completed（修复前永不满足）。
      const rows = await waitForRunEvent(
        runId,
        (rs) => rs.some((r) => r.type === 'run.completed' && r.audience === 'owner'),
        30_000,
      )
      const [finalRun] = await database.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
      expect(finalRun?.status).toBe('completed')
      expect(finalRun?.failureCode).toBeNull()

      // 折叠：pending Approval 随终态 cancelled（owner 行里的 approvalId 对上）。
      const ownerRequested = rows.find(
        (r) => r.type === 'approval.requested' && r.audience === 'owner',
      )
      const approvalId = (ownerRequested?.payload as { approval: { approvalId: string } }).approval
        .approvalId
      const [approval] = await database.db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.id, approvalId))
      expect(approval?.status).toBe('cancelled')

      // 连接与 spool 正常收口：毒帧被 ack → spool 清空（毒帧循环拆除的直接证明；
      // 修复前 Hub 4003 反复断连，run.completed 永远进不了 Hub）。
      const spoolDeadline = Date.now() + 10_000
      for (;;) {
        const spool = new DatabaseSync(join(c.nodeStateDir, 'events.sqlite'), { readOnly: true })
        let left: { n: number }
        try {
          left = spool
            .prepare('select count(*) as n from spooled_event where run_id = ?')
            .get(runId) as { n: number }
        } finally {
          spool.close()
        }
        if (left.n === 0) break
        if (Date.now() > spoolDeadline) throw new Error('spool never drained; poison loop intact')
        await silence(100)
      }
    } finally {
      rmSync(stubDir, { recursive: true, force: true })
    }
  }, 90_000)

  it('秘密语料：六件语料在 Hub DB 与两个 Browser 帧流零出现，脱敏标记在', async () => {
    const c = await setupChain(FIXTURE_SECRETS)
    const aliceWs = await c.connectBrowser(c.alice)
    const bobWs = await c.connectBrowser(c.bob)
    const runId = await startRun({
      ctx: c.ctx,
      alice: c.alice,
      taskId: c.taskId,
      builderAgentId: c.builderAgentId,
      deviceId: c.deviceId,
      workspaceId: c.workspaceId,
    })

    const rows = await waitForRunEvent(runId, (rs) =>
      rs.some((r) => r.type === 'run.completed' && r.audience === 'owner'),
    )
    // 等 alice 的直播帧到齐（completed 之前的 live delta）。
    await silence(500)

    // 1) Hub DB：六件语料零出现。
    const dbText = JSON.stringify(rows)
    for (const item of CORPUS) {
      expect(dbText, `DB must not contain: ${item}`).not.toContain(item)
    }
    // 2) Browser 帧流：零出现。
    for (const item of CORPUS) {
      expect(JSON.stringify(aliceWs.frames), `alice frames: ${item}`).not.toContain(item)
      expect(JSON.stringify(bobWs.frames), `bob frames: ${item}`).not.toContain(item)
    }
    // 3) 脱敏标记在（证明脱了敏而非没内容）：owner 完成行含 <redacted> 与 <home>。
    const ownerCompleted = rows.find((r) => r.type === 'run.completed' && r.audience === 'owner')
    const finalText = JSON.stringify(ownerCompleted?.payload)
    expect(finalText).toContain('<redacted>')
    expect(finalText).toContain('<home>/private/project')
    expect(finalText).toContain('https://example.com/path')
    expect(finalText).toContain('done.')
  }, 120_000)
})
