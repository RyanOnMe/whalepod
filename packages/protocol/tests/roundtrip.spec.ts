/**
 * Wire fixture 往返解析（02-第一阶段实施计划.md Task 3 Step 1）。
 *
 * fixtures/ 下每个 JSON 必须被对应 parse 函数/schema 接受且逐项相等；
 * 顶层或 payload 混入未知字段必须被拒绝（strict envelope，未知字段策略见 03 §11）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { HTTP_FIXTURE_SCHEMAS } from '../src/catalog.js'
import {
  ClientPersistentEventSchema,
  ProjectedRunEventSchema,
  parseClientFrame,
  parseNodeFrame,
  parseRuntimeFrame,
} from '../src/index.js'

const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url))

function listFixtureFiles(dir: string): string[] {
  return readdirSync(join(FIXTURES_ROOT, dir))
    .filter((name) => name.endsWith('.json'))
    .sort()
}

function readFixture(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_ROOT, dir, name), 'utf8'))
}

/** 带 envelope（protocolVersion/messageId/sentAt/type/payload）的四类 wire。 */
const ENVELOPE_WIRES = [
  { dir: 'node-upstream', parse: (input: unknown) => parseNodeFrame(input, 'upstream') },
  { dir: 'node-downstream', parse: (input: unknown) => parseNodeFrame(input, 'downstream') },
  { dir: 'runtime-command', parse: (input: unknown) => parseRuntimeFrame(input, 'command') },
  { dir: 'runtime-output', parse: (input: unknown) => parseRuntimeFrame(input, 'output') },
] as const

for (const wire of ENVELOPE_WIRES) {
  describe(`fixtures/${wire.dir}`, () => {
    for (const name of listFixtureFiles(wire.dir)) {
      it(`round-trips ${name}`, () => {
        const frame = readFixture(wire.dir, name)
        expect(wire.parse(frame)).toEqual(frame)
      })

      it(`rejects unknown top-level fields on ${name}`, () => {
        const frame = readFixture(wire.dir, name)
        expect(() => wire.parse({ ...(frame as Record<string, unknown>), surprise: true })).toThrow()
      })

      it(`rejects unknown payload fields on ${name}`, () => {
        const frame = readFixture(wire.dir, name) as { payload: Record<string, unknown> }
        const mutated = { ...(frame as object), payload: { ...frame.payload, surprise: 1 } }
        expect(() => wire.parse(mutated)).toThrow()
      })
    }
  })
}

describe('fixtures/client-frame', () => {
  for (const name of listFixtureFiles('client-frame')) {
    it(`round-trips ${name}`, () => {
      const frame = readFixture('client-frame', name)
      expect(parseClientFrame(frame)).toEqual(frame)
    })

    it(`rejects unknown top-level fields on ${name}`, () => {
      const frame = readFixture('client-frame', name)
      expect(() => parseClientFrame({ ...(frame as Record<string, unknown>), surprise: true })).toThrow()
    })
  }
})

describe('fixtures/run-event', () => {
  for (const name of listFixtureFiles('run-event')) {
    it(`round-trips projected run event ${name}`, () => {
      const event = readFixture('run-event', name)
      expect(ProjectedRunEventSchema.parse(event)).toEqual(event)
    })

    it(`rejects unknown event fields on ${name}`, () => {
      const projected = readFixture('run-event', name) as { event: Record<string, unknown> }
      const mutated = { ...projected, event: { ...projected.event, surprise: 1 } }
      expect(() => ProjectedRunEventSchema.parse(mutated)).toThrow()
    })
  }
})

describe('fixtures/client-event', () => {
  for (const name of listFixtureFiles('client-event')) {
    it(`round-trips client event ${name}`, () => {
      const event = readFixture('client-event', name)
      expect(ClientPersistentEventSchema.parse(event)).toEqual(event)
    })
  }
})

describe('fixtures/http', () => {
  for (const [name, schema] of Object.entries(HTTP_FIXTURE_SCHEMAS)) {
    it(`round-trips ${name}`, () => {
      const body = readFixture('http', `${name}.json`)
      expect((schema as ZodType).parse(body)).toEqual(body)
    })

    it(`rejects unknown fields on ${name}`, () => {
      const body = readFixture('http', `${name}.json`)
      expect(() =>
        (schema as ZodType).parse({ ...(body as Record<string, unknown>), surprise: 1 }),
      ).toThrow()
    })
  }
})
