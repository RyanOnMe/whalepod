/**
 * Run 状态迁移的**唯一收口**（P1-192 评审 B1）。
 *
 * 为什么必须有：ADR-0009 决策 5 要求「未 running 的一切窗口只排队，等 Run 进入 `running`
 * 时按序补发」，而 Hub 里能把 Run 写成 `running` 的入口有 **5 个**（不只是事件流那两条）：
 *
 *   1. `orchestrator.ts` 的 `runtime.ready`（事件路径）
 *   2. `orchestrator.ts` 的 `approval.decided` 回显（**生产上基本是死路**：HTTP 决策已在同一
 *      事务里把 Run 置 running，事件到达时 `run.status` 已不是 `waiting_approval`）
 *   3. `orchestrator.ts` 的 `handleRunSnapshot`（reconciler 探活补 `runtime_ready`）
 *   4. `decide.ts` 的 HTTP 审批决策 —— **真人主路径**
 *   5. `approval-expiry.ts` 的过期清扫
 *
 * 首版只在 1、2 两处调了补发，于是「审批中说的话」在通过后永远吊在 `pending`（评审用探针在
 * 3/4/5 上实测：status=running、`run.followup` 命令 0 条）。这正是 #189 的同一个洞换了位置。
 * 因此把「进入 running 顺带放行排队指令」收口到本函数，所有写入点都必须走它；
 * `scripts/check-boundaries.ts` 里有一条源码扫描判据（`checkRunStatusChokePoint`）钉住
 * 「不得用字面量 `'running'` 直调 `setRunStatus`」这件事。
 *
 * 另有一道自检：**终态禁复活**（AGENTS.md 红线）。5 个现有调用方之前都有状态机把关，但既然
 * 这里是唯一写入口，就自己再挡一道——否则一个绕过状态机的调用能把 Run 从终态拉回 running
 * 并顺带补发指令。
 */
import { eq } from 'drizzle-orm'
import { DomainError } from '@whalepod/domain'
import type { Outbox, RunRow, Tx } from '@whalepod/db'
import { schema, setRunStatus, TERMINAL_RUN_STATUSES } from '@whalepod/db'
import type { RunStatusPatch } from '@whalepod/db'
import { dispatchPendingInstructions } from './followup.js'

/**
 * 迁移 Run 状态；若迁移的结果是 `running`，在同一事务里放行该 Run 上排队的追问。
 *
 * 返回值与 `setRunStatus` 一致（Run 不存在时 undefined）。
 */
export async function applyRunStatus(
  tx: Tx,
  outbox: Outbox,
  runId: string,
  status: RunRow['status'],
  patch: RunStatusPatch = {},
): Promise<RunRow | undefined> {
  const current = await tx
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
  const from = current[0]?.status
  if (from !== undefined && from !== status && TERMINAL_RUN_STATUSES.has(from)) {
    throw new DomainError(
      'INVALID_RUN_TRANSITION',
      `run is ${from} (terminal); terminal states never revive`,
    )
  }
  const row = await setRunStatus(tx, runId, status, patch)
  if (row !== undefined && status === 'running') {
    // 幂等（补发器以 outbox.message_id 判重），所以「多调一次」是安全的，
    // 而「漏调一次」会让指令永久停在 pending —— 这就是收口的价值。
    await dispatchPendingInstructions(tx, outbox, row)
  }
  return row
}
