/**
 * `read_work_input` 工具（ADR-0028 §3；RD-02a-2b）。
 *
 * Node 在 Run 启动前把工作输入正文经 Hub 受控下载到 `entriesDir`（按 inboxItemId
 * 命名）。本工具只按清单白名单读取，读取时再次核对 bodyDigest/byteSize；成功才发
 * `runtime.work_input_receipt(kind=read)`。拒绝消息不携带本地路径。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { WorkInputManifestEntry } from '@whalepod/protocol'

export const READ_WORK_INPUT_TOOL = 'read_work_input'

export interface WorkInputReadFact {
  readonly inboxItemId: string
  readonly digestVerified: boolean
  readonly byteSize: number
  readonly at: string
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function createReadWorkInputTool(
  entries: readonly WorkInputManifestEntry[],
  entriesDir: string,
  onRead: (fact: WorkInputReadFact) => void,
  authorizeRead?: () => Promise<void>,
): ToolDefinition {
  const byId = new Map(entries.map((entry) => [entry.inboxItemId, entry]))
  return defineTool({
    name: READ_WORK_INPUT_TOOL,
    description:
      'Read a frozen work-input item delivered to this run. Only inbox item ids listed in the ' +
      'run work-input manifest are readable. The manifest is the execution basis; later inbox ' +
      'changes do not replace it automatically.',
    parameters: {
      inboxItemId: {
        type: 'string',
        required: true,
        description: 'Inbox item id from the work-input manifest.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          inboxItemId: { type: 'string', required: true },
          sourceType: { type: 'string', required: true },
          sourceId: { type: 'string', required: true },
          sourceVersion: { type: 'string', required: true },
          title: { type: 'string', required: true },
          digest: { type: 'string', required: true },
          byteSize: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
          content: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const lines = [
          `work input: ${value.inboxItemId}`,
          `source: ${value.sourceType}/${value.sourceId}`,
          `version: ${value.sourceVersion}`,
          `title: ${value.title}`,
          `digest: ${value.digest}`,
          `byteSize: ${value.byteSize}`,
          `truncated: ${value.truncated}`,
          '',
          value.content,
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const entry = byId.get(args.inboxItemId)
      if (entry === undefined) {
        throw new Error(`unknown work input item: ${args.inboxItemId}`)
      }
      let raw: Buffer
      try {
        raw = await readFile(join(entriesDir, entry.inboxItemId))
      } catch {
        throw new Error('work input copy is unavailable in this run')
      }
      if (raw.byteLength !== entry.byteSize || sha256Hex(raw) !== entry.bodyDigest) {
        throw new Error('work input copy failed digest verification')
      }
      // A local copy is not a capability: revalidate after the digest check,
      // before recording consumption or exposing any bytes to the DSH turn.
      await authorizeRead?.()
      onRead({
        inboxItemId: entry.inboxItemId,
        digestVerified: true,
        byteSize: raw.byteLength,
        at: new Date().toISOString(),
      })
      return {
        inboxItemId: entry.inboxItemId,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        sourceVersion: entry.sourceVersion,
        title: entry.title,
        digest: entry.bodyDigest,
        byteSize: entry.byteSize,
        truncated: false,
        content: raw.toString('utf8'),
      }
    },
  })
}
