import { createHash } from 'node:crypto'
import { DiscoveryExecutorAttemptSettleSchema } from '@whalepod/protocol'
import { z } from 'zod'
import { openStateDatabase } from '../state/db.js'
import { DiscoverySettlementUnacknowledged } from './discovery-model-hub.js'
import type { DiscoveryModelHubPort, DiscoveryModelSettle } from './discovery-live-model.js'

const BATCH_SIZE = 8
export const DISCOVERY_SETTLEMENT_TIMEOUT_MS = 10_000
const RunId = z.uuid()

export function discoverySettlementFile(identity: { deviceId: string; hubUrl: string }): string {
  // A repaired device or a different Hub must never receive another pairing's receipts.
  const scope = createHash('sha256')
    .update(JSON.stringify([identity.deviceId, new URL(identity.hubUrl).origin]))
    .digest('hex')
  return `discovery-settlement-${scope}.sqlite`
}

type Send = (
  runId: string,
  input: DiscoveryModelSettle,
  signal: AbortSignal,
) => ReturnType<DiscoveryModelHubPort['settle']>

interface Row {
  seq: number
  run_id: string
  attempt_id: string
  request_digest: string
  kind: DiscoveryModelSettle['outcome']['kind']
  input_tokens: number | null
  output_tokens: number | null
  response_id_digest: string | null
}

/** This outbox can send only a settlement; it has no provider or begin port. */
export class SqliteDiscoverySettlementOutbox {
  private readonly db: ReturnType<typeof openStateDatabase>
  private readonly inFlight = new Map<string, Promise<boolean>>()
  private readonly permanentDenials = new Set<string>()
  private cursor = 0
  private draining: Promise<void> | undefined

  constructor(
    path: string,
    private readonly send: Send,
  ) {
    this.db = openStateDatabase(path)
    this.db.exec(`
      create table if not exists discovery_settlement_outbox (
        run_id text not null,
        attempt_id text not null,
        request_digest text not null,
        kind text not null,
        input_tokens integer,
        output_tokens integer,
        response_id_digest text,
        primary key (run_id, attempt_id)
      )
    `)
  }

  async settle(runId: string, input: DiscoveryModelSettle, signal: AbortSignal): Promise<boolean> {
    RunId.parse(runId)
    DiscoveryExecutorAttemptSettleSchema.parse(input)
    const outcome = input.outcome
    // Autocommit, with the state DB's synchronous=FULL, precedes the first HTTP write.
    this.db
      .prepare(`insert into discovery_settlement_outbox (
        run_id, attempt_id, request_digest, kind, input_tokens, output_tokens, response_id_digest
      ) values (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        runId,
        input.attemptId,
        input.requestDigest,
        outcome.kind,
        outcome.kind === 'actual' ? outcome.inputTokens : null,
        outcome.kind === 'actual' ? outcome.outputTokens : null,
        outcome.kind === 'actual' ? (outcome.responseIdDigest ?? null) : null,
      )
    return this.deliver(runId, input, signal)
  }

  flush(): Promise<void> {
    this.draining ??= this.retryBatch().finally(() => {
      this.draining = undefined
    })
    return this.draining
  }

  close(): void {
    this.db.close()
  }

  private async retryBatch(): Promise<void> {
    // Round-robin batches so permanently retained rows cannot starve later receipts.
    const rows = this.db
      .prepare(
        `select rowid as seq, * from discovery_settlement_outbox
         where rowid > ? order by rowid limit ?`,
      )
      .all(this.cursor, BATCH_SIZE) as unknown as Row[]
    this.cursor = rows.length < BATCH_SIZE ? 0 : rows.at(-1)!.seq
    await Promise.all(
      rows.map(async (row) => {
        if (this.permanentDenials.has(`${row.run_id}:${row.attempt_id}`)) return
        const outcome: DiscoveryModelSettle['outcome'] =
          row.kind === 'actual'
            ? {
                kind: 'actual',
                inputTokens: row.input_tokens!,
                outputTokens: row.output_tokens!,
                ...(row.response_id_digest === null
                  ? {}
                  : { responseIdDigest: row.response_id_digest }),
              }
            : { kind: row.kind }
        await this.deliver(
          row.run_id,
          { attemptId: row.attempt_id, requestDigest: row.request_digest, outcome },
          AbortSignal.timeout(DISCOVERY_SETTLEMENT_TIMEOUT_MS),
        ).catch(() => undefined)
      }),
    )
  }

  private deliver(
    runId: string,
    input: DiscoveryModelSettle,
    signal: AbortSignal,
  ): Promise<boolean> {
    const key = `${runId}:${input.attemptId}`
    const active = this.inFlight.get(key)
    if (active) return active
    const work = Promise.resolve()
      .then(() => this.send(runId, input, signal))
      .then((allowContinue) => {
        // Both true and false acknowledge a receipt; only an unacknowledged send stays queued.
        this.db
          .prepare('delete from discovery_settlement_outbox where run_id = ? and attempt_id = ?')
          .run(runId, input.attemptId)
        return allowContinue
      })
      .catch((error: unknown) => {
        if (error instanceof DiscoverySettlementUnacknowledged && !error.retryable)
          this.permanentDenials.add(key)
        throw error
      })
      .finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, work)
    return work
  }
}
