/**
 * `read_project_context` 工具（ADR-0027 §4；PC-05a）。
 *
 * Node 在 Run 启动前把快照条目经 Hub 受控下载到 `entriesDir`（按 entryId 命名），
 * 本工具按清单白名单提供只读访问。安全形态与 `read_artifact_input` 同口径：
 * - 参数只有 entryId；文件名来自清单成员（UUID），模型输入不可能变成任意路径；
 * - 读取时再次核对 digest/byteSize，不符不回正文；
 * - 拒绝消息不携带 entriesDir 绝对路径；
 * - 每次成功读取发一条 `runtime.context_receipt`（digestVerified/byteSize），
 *   让 Node/Hub 区分「存了快照 ID」与「正文真的进入过模型请求」。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { RunProjectContextManifestEntry } from '@whalepod/protocol'

export const READ_PROJECT_CONTEXT_TOOL = 'read_project_context'

export interface ProjectContextReadFact {
  readonly entryId: string
  readonly digestVerified: boolean
  readonly byteSize: number
  readonly at: string
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** ADR-0027 §4：nonce = sha256(snapshotDigest + '|' + runId) 的前 16 个十六进制字符。 */
export function projectContextNonce(snapshotDigest: string, runId: string): string {
  return sha256Hex(`${snapshotDigest}|${runId}`).slice(0, 16)
}

export function projectContextHeaderNonceMatches(
  headerText: string,
  snapshotDigest: string,
  runId: string,
): boolean {
  return headerText.includes(`[project-context:${projectContextNonce(snapshotDigest, runId)}]`)
}

export function createReadProjectContextTool(
  entries: readonly RunProjectContextManifestEntry[],
  entriesDir: string,
  onRead: (fact: ProjectContextReadFact) => void,
): ToolDefinition {
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]))
  return defineTool({
    name: READ_PROJECT_CONTEXT_TOOL,
    description:
      'Read a frozen project-context entry delivered to this run. Only entry ids listed in ' +
      'the snapshot manifest are readable. The snapshot is the execution basis; later project ' +
      'changes do not replace it automatically.',
    parameters: {
      entryId: {
        type: 'string',
        required: true,
        description: 'Entry id from the project context manifest.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          entryId: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          title: { type: 'string', required: true },
          businessRef: { type: 'string' },
          revisionId: { type: 'string' },
          digest: { type: 'string', required: true },
          byteSize: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
          content: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      // DSH 的 canonical value 是 execution-local、不随 tool/result 落库；正文与
      // 结构化字段必须显式投影到 render，否则模型只拿到一个 entryId。
      render: (_args, value) => {
        const lines = [
          `project context: ${value.entryId}`,
          `kind: ${value.kind}`,
          `title: ${value.title}`,
        ]
        if (value.businessRef !== undefined) lines.push(`businessRef: ${value.businessRef}`)
        if (value.revisionId !== undefined) lines.push(`revisionId: ${value.revisionId}`)
        lines.push(
          `digest: ${value.digest}`,
          `byteSize: ${value.byteSize}`,
          `truncated: ${value.truncated}`,
          '',
          value.content,
        )
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const entry = byId.get(args.entryId)
      if (entry === undefined) {
        throw new Error(`unknown project context entry: ${args.entryId}`)
      }
      let raw: Buffer
      try {
        // 文件名 = 清单成员（UUID），非模型输入；目录由 Node 在 run.start 时建好。
        raw = await readFile(join(entriesDir, entry.entryId))
      } catch {
        throw new Error('project context copy is unavailable in this run')
      }
      if (raw.byteLength !== entry.byteSize || sha256Hex(raw) !== entry.digest) {
        throw new Error('project context copy failed digest verification')
      }
      onRead({
        entryId: entry.entryId,
        digestVerified: true,
        byteSize: raw.byteLength,
        at: new Date().toISOString(),
      })
      return {
        entryId: entry.entryId,
        kind: entry.kind,
        title: entry.title,
        ...(entry.businessRef !== null ? { businessRef: entry.businessRef } : {}),
        ...(entry.revisionId !== null ? { revisionId: entry.revisionId } : {}),
        digest: entry.digest,
        byteSize: entry.byteSize,
        truncated: false,
        content: raw.toString('utf8'),
      }
    },
  })
}
