/**
 * ADR-0028（RD-02a-2b）：工作输入经 read_work_input 进入模型，正文不落在
 * run.start 清单或 executionContext 里，只能来自 Node 受控下载副本。
 *
 * 机器判据（与 PC-00/PC-05a 同配方）：
 * - 工具结果含结构化字段与正文；路径形 id 被拒且消息不含本机路径；
 * - delivered/read 两级回执在本地 wire 上可观测；
 * - 回放脚本用 `{{fromRequest:RD02A2_ECHO}}` 引用只存在于副本文本里的 marker，
 *   解析失败即 fail loud——出现即证明正文进入了下一次模型请求；
 * - 无清单时工具根本不存在（fail-closed 面）。
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeOutput } from '@whalepod/protocol'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
  type ProbeRuntime,
} from './helpers/replay-runtime.js'

const WORK_KEY = '01905f7c-0000-7000-8000-000000000971'
const ITEM_ID = '01905f7c-0000-7000-8000-000000000981'
const CONTENT = '# frozen work input\nRD02A2_ECHO\n'
const BODY_DIGEST = createHash('sha256').update(CONTENT).digest('hex')
const MANIFEST_DIGEST = createHash('sha256').update('rd02a2b-contract').digest('hex')

interface ToolResultData {
  turn: number
  step: number
  message: {
    source: { kind: string; callId?: string }
    content: {
      type: string
      toolCallId?: string
      isError?: boolean
      content?: { type: string; text?: string }[]
    }[]
  }
  error?: { name?: string; code?: string }
}

interface ToolResultBlock {
  toolCallId?: string
  isError?: boolean
  content?: { type: string; text?: string }[]
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeInputsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'whalepod-rd02a2b-inputs-'))
  tempDirs.push(dir)
  return dir
}

function outputText(outputs: readonly RuntimeOutput[]): string {
  const strings = (value: unknown): string[] => {
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.flatMap(strings)
    if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings)
    return []
  }
  return strings(outputs.map((frame) => frame.payload)).join('\n')
}

function toolResultsOf(outputs: readonly RuntimeOutput[]): ToolResultData[] {
  return outputs
    .filter((frame) => frame.type === 'session.event')
    .map((frame) => frame.payload.event as { type: string; data: unknown })
    .filter((event) => event.type === 'tool/result')
    .map((event) => event.data as ToolResultData)
}

function blockOf(data: ToolResultData): ToolResultBlock | undefined {
  return data.message.content.find((block) => block.type === 'tool-result')
}

function callIdOf(data: ToolResultData): string | undefined {
  return blockOf(data)?.toolCallId ?? data.message.source.callId
}

function isErrorOf(data: ToolResultData): boolean {
  return blockOf(data)?.isError === true
}

function resultText(data: ToolResultData): string {
  return (blockOf(data)?.content ?? []).map((block) => block.text ?? '').join('\n')
}

async function driveToCompletion(runtime: ProbeRuntime, prompt: string): Promise<void> {
  await runtime.send(initializeCommand(runtime.spec))
  await runtime.until('runtime.ready')
  await runtime.send(commandFrame('run.prompt', { runId: runtime.spec.runId, text: prompt }))
  const outcome = await Promise.race([
    runtime.until('run.completed').then(() => 'completed'),
    runtime
      .until('runtime.fatal')
      .then((fatal) => `runtime.fatal ${fatal.payload.code}: ${fatal.payload.summary}`),
  ])
  expect(outcome).toBe('completed')
}

function withWorkInputs(
  spec: ReturnType<typeof runtimeSpec>,
  entriesDir: string,
): ReturnType<typeof runtimeSpec> {
  return {
    ...spec,
    approvalPolicy: 'full_access' as const,
    workInputs: {
      workKey: WORK_KEY,
      manifestDigest: MANIFEST_DIGEST,
      entries: [
        {
          inboxItemId: ITEM_ID,
          sourceType: 'task_message',
          sourceId: '01905f7c-0000-7000-8000-000000000991',
          sourceVersion: '3',
          sourceDigest: createHash('sha256').update('source-v3').digest('hex'),
          bodyDigest: BODY_DIGEST,
          byteSize: Buffer.byteLength(CONTENT),
          authorizationGeneration: 'gen-1',
          title: '需求澄清',
        },
      ],
      entriesDir,
    },
  }
}

describe('ADR-0028: work inputs reach the model through read_work_input', () => {
  it('projects the pinned body and structured fields, and emits delivered/read receipts', async () => {
    const entriesDir = makeInputsDir()
    writeFileSync(join(entriesDir, ITEM_ID), CONTENT)
    const base = runtimeSpec()
    const spec = withWorkInputs(base, entriesDir)
    const runtime = await startReplayRuntime('read-work-input', spec)
    try {
      await driveToCompletion(runtime, 'read the work input')

      const results = toolResultsOf(runtime.outputs)
      expect(results).toHaveLength(2)
      const [read, escaped] = results as [ToolResultData, ToolResultData]
      const text = resultText(read)
      expect(isErrorOf(read)).toBe(false)
      expect(text).toContain(`work input: ${ITEM_ID}`)
      expect(text).toContain('source: task_message/01905f7c-0000-7000-8000-000000000991')
      expect(text).toContain('version: 3')
      expect(text).toContain('title: 需求澄清')
      expect(text).toContain(`digest: ${BODY_DIGEST}`)
      expect(text).toContain(CONTENT)

      expect(callIdOf(escaped)).toBe('call-work-input-2')
      expect(isErrorOf(escaped)).toBe(true)
      expect(resultText(escaped)).toContain('unknown work input item')
      for (const secretPath of [entriesDir, spec.workspacePath, spec.dshHomePath]) {
        expect(JSON.stringify(read)).not.toContain(secretPath)
        expect(JSON.stringify(escaped)).not.toContain(secretPath)
      }

      const receipts = runtime.outputs.filter(
        (frame) => frame.type === 'runtime.work_input_receipt',
      )
      expect(receipts.map((frame) => (frame.payload as { kind: string }).kind)).toEqual([
        'delivered',
        'read',
      ])
      expect(receipts[0]?.payload).toMatchObject({
        workKey: WORK_KEY,
        manifestDigest: MANIFEST_DIGEST,
        entriesDelivered: [ITEM_ID],
      })
      expect(receipts[1]?.payload).toMatchObject({
        workKey: WORK_KEY,
        manifestDigest: MANIFEST_DIGEST,
        inboxItemId: ITEM_ID,
        digestVerified: true,
        byteSize: Buffer.byteLength(CONTENT),
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('the body reaches the next model request (fromRequest echo)', async () => {
    const entriesDir = makeInputsDir()
    writeFileSync(join(entriesDir, ITEM_ID), CONTENT)
    const base = runtimeSpec()
    const spec = withWorkInputs(base, entriesDir)
    const runtime = await startReplayRuntime('read-work-input-manifest', spec)
    try {
      await driveToCompletion(runtime, 'read the work input')
      // marker 只在磁盘副本里，不在清单/prompt 中：出现即证明正文经工具投影进入
      // 了下一次模型请求；匹配不到 replay 会 fail loud。
      expect(JSON.stringify(spec.workInputs?.entries)).not.toContain('RD02A2_ECHO')
      expect(outputText(runtime.outputs)).toContain('Work input echo: RD02A2_ECHO')
      // 清单摘要必须进入首条 user 请求，模型才知道可读的 inboxItemId；
      // 只注册工具、不投影清单等于把不可猜的 UUID 藏起来。
      expect(outputText(runtime.outputs)).toContain('manifest: 本次工作输入清单')
    } finally {
      await runtime.dispose()
    }
  })

  it('without the manifest the tool does not exist at all (fail-closed surface)', async () => {
    const spec = { ...runtimeSpec(), approvalPolicy: 'full_access' as const }
    const runtime = await startReplayRuntime('read-work-input', spec)
    try {
      await driveToCompletion(runtime, 'try to read a work input')
      const results = toolResultsOf(runtime.outputs)
      expect(results).toHaveLength(2)
      for (const result of results) {
        expect(isErrorOf(result)).toBe(true)
        expect(result.error?.code).toBe('UNKNOWN_TOOL')
        expect(resultText(result)).toContain('unknown tool "read_work_input"')
      }
      expect(
        runtime.outputs.filter((frame) => frame.type === 'runtime.work_input_receipt'),
      ).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  })
})
