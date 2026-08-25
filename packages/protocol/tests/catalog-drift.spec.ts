/**
 * catalog 是 frame/fixture 登记处（02-第一阶段实施计划.md Task 3: catalog-drift.spec.ts）。
 *
 * schema union 的成员（catalog 列表即由 union 导出）与 fixtures/ 目录内容必须一一对应：
 * 加了 frame 没加 fixture、删了 frame 没删 fixture，都在这里变红。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CLIENT_FRAME_KINDS,
  CLIENT_PERSISTENT_EVENT_TYPES,
  HTTP_FIXTURE_SCHEMAS,
  NODE_DOWNSTREAM_TYPES,
  NODE_UPSTREAM_TYPES,
  PROJECTED_RUN_EVENT_TYPES,
  RUNTIME_COMMAND_TYPES,
  RUNTIME_OUTPUT_TYPES,
} from '../src/catalog.js'
import { PROTOCOL_VERSION } from '../src/index.js'

const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url))

function fixtureNames(dir: string): string[] {
  return readdirSync(join(FIXTURES_ROOT, dir))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort()
}

describe('protocol catalog drift', () => {
  it.each([
    ['node-upstream', NODE_UPSTREAM_TYPES],
    ['node-downstream', NODE_DOWNSTREAM_TYPES],
    ['runtime-command', RUNTIME_COMMAND_TYPES],
    ['runtime-output', RUNTIME_OUTPUT_TYPES],
    ['run-event', PROJECTED_RUN_EVENT_TYPES],
    ['client-event', CLIENT_PERSISTENT_EVENT_TYPES],
  ] as const)('%s fixtures match the catalog exactly', (dir, types) => {
    expect(fixtureNames(dir)).toEqual([...types].sort())
  })

  it('client-frame fixtures cover every frame kind', () => {
    expect(fixtureNames('client-frame')).toEqual([...CLIENT_FRAME_KINDS].sort())
  })

  it('http fixtures cover every registered DTO', () => {
    expect(fixtureNames('http')).toEqual(Object.keys(HTTP_FIXTURE_SCHEMAS).sort())
  })

  it('pins protocolVersion to 1', () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })
})
