import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openStateDatabase } from '../src/state/db.js'
import type { DiscoveryModelSettle } from '../src/work/discovery-live-model.js'
import { createDiscoveryModelHubPort } from '../src/work/discovery-model-hub.js'
import {
  discoverySettlementFile,
  SqliteDiscoverySettlementOutbox,
} from '../src/work/discovery-settlement-outbox.js'

const runId = randomUUID()
const receipt: DiscoveryModelSettle = {
  attemptId: randomUUID(),
  requestDigest: 'a'.repeat(64),
  outcome: {
    kind: 'actual',
    inputTokens: 365,
    outputTokens: 402,
    responseIdDigest: 'b'.repeat(64),
  },
}
const signal = () => AbortSignal.timeout(3000)
const folders: string[] = []

function dbPath() {
  const folder = mkdtempSync(join(tmpdir(), 'whalepod-node-settlement-'))
  folders.push(folder)
  return join(folder, 'settlement.sqlite')
}

function inspect(path: string) {
  const db = openStateDatabase(path)
  try {
    return db.prepare('select * from discovery_settlement_outbox').all()
  } finally {
    db.close()
  }
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('discovery executor SQLite settlement outbox', () => {
  it('persists only receipt facts before HTTP and replays exactly that settlement after lost ack and restart', async ({
    onTestFinished,
  }) => {
    const path = dbPath()
    const received: {
      path: string | undefined
      key: string | string[] | undefined
      body: unknown
    }[] = []
    const durable: ReturnType<typeof inspect>[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      received.push({
        path: req.url,
        key: req.headers['idempotency-key'],
        body: JSON.parse(Buffer.concat(chunks).toString()),
      })
      durable.push(inspect(path))
      if (received.length === 1) {
        // Hub received the complete attempt but its acknowledgement was lost.
        res.destroy()
      } else {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, data: { allowContinue: false } }))
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback unavailable')
    const config = { hubUrl: `http://127.0.0.1:${address.port}`, deviceToken: 'local-only-test' }
    const send = (id: string, input: DiscoveryModelSettle, abort: AbortSignal) =>
      createDiscoveryModelHubPort(config, id).settle(input, abort)
    const first = new SqliteDiscoverySettlementOutbox(path, send)
    try {
      await expect(first.settle(runId, receipt, signal())).rejects.toThrow()
    } finally {
      first.close()
    }
    const second = new SqliteDiscoverySettlementOutbox(path, send)
    try {
      await second.flush()
      await second.flush()
      expect(received).toEqual(
        Array(2).fill({
          path: `/api/v1/node/runs/${runId}/discovery-model/settle`,
          key: receipt.attemptId,
          body: receipt,
        }),
      )
      expect(durable).toEqual(
        Array(2).fill([
          {
            run_id: runId,
            attempt_id: receipt.attemptId,
            request_digest: receipt.requestDigest,
            kind: 'actual',
            input_tokens: 365,
            output_tokens: 402,
            response_id_digest: 'b'.repeat(64),
          },
        ]),
      )
      expect(inspect(path)).toEqual([])
    } finally {
      second.close()
    }
  })

  it('retries a temporary outage in the same process and shares an in-flight settlement', async () => {
    const path = dbPath()
    let rejectFirst: (reason: Error) => void = () => undefined
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject
          }),
      )
      .mockResolvedValueOnce(true)
    const outbox = new SqliteDiscoverySettlementOutbox(path, send)
    try {
      const first = outbox.settle(runId, receipt, signal())
      const initialRetry = outbox.flush()
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      const failure = expect(first).rejects.toThrow('temporary')
      rejectFirst(new Error('temporary'))
      await failure
      await initialRetry
      expect(inspect(path)).toHaveLength(1)
      await outbox.flush()
      expect(send).toHaveBeenCalledTimes(2)
      expect(inspect(path)).toEqual([])
    } finally {
      outbox.close()
    }
  })

  it('does not send before a successful SQLite write and separates pairing files', async () => {
    const identity = { deviceId: randomUUID(), hubUrl: 'http://127.0.0.1:1234/' }
    expect(discoverySettlementFile(identity)).toBe(
      discoverySettlementFile({ ...identity, hubUrl: 'http://127.0.0.1:1234' }),
    )
    expect(discoverySettlementFile(identity)).not.toBe(
      discoverySettlementFile({ ...identity, deviceId: randomUUID() }),
    )
    expect(discoverySettlementFile(identity)).not.toBe(
      discoverySettlementFile({ ...identity, hubUrl: 'http://127.0.0.1:9876' }),
    )
    const send = vi.fn()
    const outbox = new SqliteDiscoverySettlementOutbox(dbPath(), send)
    outbox.close()
    await expect(outbox.settle(runId, receipt, signal())).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })
})
