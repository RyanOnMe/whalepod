/**
 * `publish_artifact` 工具（03 §7.2：Runtime Bridge 注册的唯一业务工具）。
 *
 * 工具执行本身不搬字节：它把 workspace 内的候选文件登记为一个
 * `artifact.candidate` output 帧，交给 Node 做后续收集与哈希校验（P1-13 起）。
 * 每个 Run 的 agent scope 里单独注册一次（02 Task 11 Step 5 的
 * `installRunScopedPorts`），端口回调钉在本次 Run 的 runId 上。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

export const PUBLISH_ARTIFACT_TOOL = 'publish_artifact'

export interface ArtifactCandidate {
  readonly relativePath: string
  readonly title: string
  readonly mediaType: string
}

/** 桥侧回调：把候选登记为 output 帧（由 bridge 绑定 runId 后注入）。 */
export interface ArtifactPort {
  publish(candidate: ArtifactCandidate): void
}

export function createPublishArtifactTool(port: ArtifactPort): ToolDefinition {
  return defineTool({
    name: PUBLISH_ARTIFACT_TOOL,
    description:
      'Publish a workspace file as a Run artifact candidate. The Runtime registers the ' +
      'candidate and the Node side collects and verifies it; the model only names the ' +
      'workspace-relative path, a title, and a media type.',
    parameters: {
      relativePath: {
        type: 'string',
        required: true,
        description: 'Workspace-relative path of the file to publish.',
      },
      title: { type: 'string', required: true, description: 'Human-readable artifact title.' },
      mediaType: { type: 'string', required: true, description: 'IANA media type of the file.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { registered: { type: 'boolean', required: true } },
        additionalProperties: false,
      },
      render: (args, _value) => [
        { type: 'text', text: `artifact candidate registered: ${args.relativePath}` },
      ],
    },
    execute: (args) => {
      port.publish({
        relativePath: args.relativePath,
        title: args.title,
        mediaType: args.mediaType,
      })
      return Promise.resolve({ registered: true })
    },
  })
}
