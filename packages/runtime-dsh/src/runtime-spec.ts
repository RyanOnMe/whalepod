/**
 * RuntimeSpec —— `runtime.initialize` 命令载荷的桥内形态（03 §7.1）。
 *
 * profileDigest/pluginPackDigest 在 P1-11 仅随 wire 到达并记录；P1-17 起新增
 * `pluginPackOverlayPath`：Node preflight 为已安装 Plugin Pack 生成的 Cordis
 * overlay yml 绝对路径（本地 wire 专用，红线同 workspacePath——不进 Hub、日志
 * 与 evidence），RuntimeBridge.start 把它作为最后一层 patch 挂进 boot 栈
 * （bridge.ts）。pack 为 core-empty 时不携带（wire optional）。
 */
import type { RuntimeCommand } from '@project311/protocol'

export interface RuntimeSpec {
  readonly runId: string
  readonly workspacePath: string
  readonly dshHomePath: string
  readonly profileDigest: string
  readonly pluginPackDigest: string
  /** 本 Run 的 Plugin Pack overlay yml 绝对路径；core-empty pack / 契约探针缺省。 */
  readonly pluginPackOverlayPath?: string
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly persona: string
}

type InitializeCommand = Extract<RuntimeCommand, { type: 'runtime.initialize' }>

export function runtimeSpecFromInitialize(command: InitializeCommand): RuntimeSpec {
  const { maxTokens, pluginPackOverlayPath, ...rest } = command.payload
  // exactOptionalPropertyTypes：zod 的 optional 产出 `number | undefined`，
  // 桥内形态要求键存在即有效值。
  return {
    ...rest,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(pluginPackOverlayPath === undefined ? {} : { pluginPackOverlayPath }),
  }
}

/** 本 Run 的 DSH Session 身份：`runId + dshSessionId` 关联的桥侧锚点（03 §8）。 */
export function dshSessionIdOf(spec: RuntimeSpec): string {
  return `project311-run-${spec.runId}`
}
