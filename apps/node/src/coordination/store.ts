import type { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { openStateDatabase } from '../state/db.js'

export interface CoordinationJournalInput {
  evaluationId: string
  attempt: number
  leaseToken: string
  nonce: string
  requestJson: string
  homePath: string
}
export interface CoordinationJournal extends CoordinationJournalInput {
  state: 'active' | 'result' | 'acked'
  pid: number | null
  processStartTime: string | null
  modelStartedAt: string | null
  readEntryIds: string[]
  resultJson: string | null
  cleaned: boolean
}
interface Row {
  evaluation_id: string
  attempt: number
  lease_token: string
  nonce: string
  request_json: string
  home_path: string
  state: CoordinationJournal['state']
  pid: number | null
  process_start_time: string | null
  model_started_at: string | null
  read_entry_ids: string
  result_json: string | null
  cleaned: number
}
function fromRow(row: Row): CoordinationJournal {
  return {
    evaluationId: row.evaluation_id,
    attempt: row.attempt,
    leaseToken: row.lease_token,
    nonce: row.nonce,
    requestJson: row.request_json,
    homePath: row.home_path,
    state: row.state,
    pid: row.pid,
    processStartTime: row.process_start_time,
    modelStartedAt: row.model_started_at,
    readEntryIds: JSON.parse(row.read_entry_ids) as string[],
    resultJson: row.result_json,
    cleaned: row.cleaned !== 0,
  }
}

// Read corrupt oversized attempts without node:sqlite throwing before cleanup can
// reject them. REAL preserves every valid safe integer exactly.
const JOURNAL_COLUMNS =
  'evaluation_id, cast(attempt as real) as attempt, lease_token, nonce, request_json, home_path, state, pid, process_start_time, model_started_at, read_entry_ids, result_json, cleaned'

/** Durable attempt identity, result outbox and cleanup queue. This is not a second team state authority. */
export class CoordinationStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    this.db = openStateDatabase(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`pragma busy_timeout = 5000;
      create table if not exists coordination_attempt (
        evaluation_id text not null, attempt integer not null, lease_token text not null,
        nonce text not null, request_json text not null, home_path text not null,
        state text not null default 'active', pid integer, process_start_time text,
        model_started_at text, read_entry_ids text not null default '[]',
        result_json text, cleaned integer not null default 0,
        primary key(evaluation_id, attempt)
      )`)
  }
  close(): void {
    this.db.close()
  }
  begin(input: CoordinationJournalInput): boolean {
    const old = this.get(input.evaluationId, input.attempt)
    if (old !== undefined) {
      if (old.leaseToken !== input.leaseToken)
        throw new Error('coordination attempt lease mismatch')
      return false
    }
    this.db
      .prepare(`insert into coordination_attempt
      (evaluation_id,attempt,lease_token,nonce,request_json,home_path) values (?,?,?,?,?,?)`)
      .run(
        input.evaluationId,
        input.attempt,
        input.leaseToken,
        input.nonce,
        input.requestJson,
        input.homePath,
      )
    return true
  }
  get(evaluationId: string, attempt: number): CoordinationJournal | undefined {
    const row = this.db
      .prepare(
        'select ' +
          JOURNAL_COLUMNS +
          ' from coordination_attempt where evaluation_id=? and attempt=?',
      )
      .get(evaluationId, attempt) as Row | undefined
    return row === undefined ? undefined : fromRow(row)
  }
  private list(where: string): CoordinationJournal[] {
    return (
      this.db
        .prepare(
          `select ${JOURNAL_COLUMNS} from coordination_attempt where ${where} order by evaluation_id,attempt`,
        )
        .all() as unknown as Row[]
    ).map(fromRow)
  }
  active(): CoordinationJournal[] {
    return this.list("state='active'")
  }
  pendingResults(): CoordinationJournal[] {
    return this.list("state='result'")
  }
  cleanupTasks(): CoordinationJournal[] {
    return this.list("state<>'active' and cleaned=0")
  }
  setProcess(id: string, attempt: number, pid: number, start: string): void {
    this.db
      .prepare(
        "update coordination_attempt set pid=?,process_start_time=? where evaluation_id=? and attempt=? and state='active'",
      )
      .run(pid, start, id, attempt)
  }
  /** Only called after exit, ESRCH, or confirmed PID reuse; never merely after signaling. */
  clearProcess(id: string, attempt: number): void {
    this.db
      .prepare(
        'update coordination_attempt set pid=null,process_start_time=null where evaluation_id=? and attempt=?',
      )
      .run(id, attempt)
  }
  markHeartbeat(id: string, attempt: number, entries: readonly string[], started?: string): void {
    const row = this.get(id, attempt)
    if (row?.state !== 'active') return
    const read = [...new Set([...row.readEntryIds, ...entries])].sort()
    this.db
      .prepare(
        "update coordination_attempt set read_entry_ids=?,model_started_at=coalesce(model_started_at,?) where evaluation_id=? and attempt=? and state='active'",
      )
      .run(JSON.stringify(read), started ?? null, id, attempt)
  }
  saveResult(id: string, attempt: number, resultJson: string): boolean {
    return (
      this.db
        .prepare(
          "update coordination_attempt set state='result',result_json=? where evaluation_id=? and attempt=? and state='active'",
        )
        .run(resultJson, id, attempt).changes > 0
    )
  }
  ackResult(id: string, attempt: number, lease: string): boolean {
    return (
      this.db
        .prepare(
          "update coordination_attempt set state='acked',result_json=null where evaluation_id=? and attempt=? and lease_token=? and state='result'",
        )
        .run(id, attempt, lease).changes > 0
    )
  }
  markCleaned(id: string, attempt: number): void {
    this.db
      .prepare(
        "update coordination_attempt set cleaned=1 where evaluation_id=? and attempt=? and state<>'active'",
      )
      .run(id, attempt)
  }
}
