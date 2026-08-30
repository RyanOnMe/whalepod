/**
 * `read_artifact_input` 工具（P1-15；G6-07 Reviewer 只读输入）。
 *
 * Reviewer Run 对已发布 Artifact 的唯一读取面：Node 在 run.start 前把任务已
 * 发布 Artifact 经 Hub 受控下载（sha256 校验）到 `artifactInputsDir`，本工具
 * 按清单条目提供只读访问。安全形态：
 * - 参数只有 artifactId；文件名 = 清单成员 UUID（白名单），模型的任何字符串
 *   都不可能变成任意文件路径（先查清单，命中才触 fs）。
 * - 只读：无任何写参数；文本媒体类型回显内容（超限截断并标注），二进制只给
 *   元数据，不伪造「已读」。
 * - 红线：所有拒绝消息不携带 inputsDir 绝对路径。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { RuntimeArtifactInput } from '@project311/protocol'

export const READ_ARTIFACT_INPUT_TOOL = 'read_artifact_input'

/** 清单条目 = 协议的 RuntimeArtifactInput（单一事实源在 wire schema）。 */
export type ArtifactInputEntry = RuntimeArtifactInput

/** 文本回显上限（字符预算进入模型上下文；截断时置 truncated=true）。 */
export const INPUT_TEXT_ECHO_LIMIT_BYTES = 64 * 1024

function isTextual(mediaType: string): boolean {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  return (
    base.startsWith('text/') ||
    base === 'application/json' ||
    base.endsWith('+json') ||
    base === 'application/xml' ||
    base.endsWith('+xml')
  )
}

export function createReadArtifactInputTool(
  inputs: readonly ArtifactInputEntry[],
  inputsDir: string,
): ToolDefinition {
  const byId = new Map(inputs.map((entry) => [entry.artifactId, entry]))
  return defineTool({
    name: READ_ARTIFACT_INPUT_TOOL,
    description:
      'Read a read-only artifact input delivered to this run. Only artifact ids listed in the ' +
      'run input manifest are readable. Text artifacts return content (truncated when large); ' +
      'binary artifacts return metadata only.',
    parameters: {
      artifactId: {
        type: 'string',
        required: true,
        description: 'Artifact id from the run input manifest.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          artifactId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          byteSize: { type: 'number', required: true },
          sha256: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          content: { type: 'string' },
          note: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, _value) => [{ type: 'text', text: `artifact input: ${args.artifactId}` }],
    },
    execute: async (args) => {
      // 白名单判定在触 fs 之前：未知 id（含任何路径形字符串）直接拒绝。
      const entry = byId.get(args.artifactId)
      if (entry === undefined) {
        throw new Error(`unknown artifact input: ${args.artifactId}`)
      }
      const base = {
        artifactId: entry.artifactId,
        title: entry.title,
        mediaType: entry.mediaType,
        byteSize: entry.byteSize,
        sha256: entry.sha256,
        truncated: false,
      }
      if (!isTextual(entry.mediaType)) {
        return {
          ...base,
          note: 'binary artifact: content not shown; obtain the full file via the team Hub download API',
        }
      }
      let raw: Buffer
      try {
        // 文件名来自清单成员（UUID），非模型输入；目录由 Node 在 run.start 时建好。
        raw = await readFile(join(inputsDir, entry.artifactId))
      } catch {
        throw new Error('artifact input copy is unavailable in this run')
      }
      if (raw.byteLength > INPUT_TEXT_ECHO_LIMIT_BYTES) {
        const head = raw.subarray(0, INPUT_TEXT_ECHO_LIMIT_BYTES)
        return {
          ...base,
          truncated: true,
          content: head.toString('utf8'),
          note: `text truncated at ${INPUT_TEXT_ECHO_LIMIT_BYTES} bytes; full file available via the team Hub download API`,
        }
      }
      return { ...base, content: raw.toString('utf8') }
    },
  })
}
