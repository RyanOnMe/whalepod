/**
 * RuntimeSpec —— `runtime.initialize` 命令载荷的桥内形态（03 §7.1）。
 *
 * profileDigest/pluginPackDigest 在 P1-11 仅随 wire 到达并记录；Profile Revision
 * 与 Plugin Pack 的真实校验/挂载由 P1-17 接线（02 Task 11/17 的边界）。
 */
import type { RuntimeCommand } from '@project311/protocol'

export interface RuntimeSpec {
  readonly runId: string
  readonly workspacePath: string
  readonly dshHomePath: string
  readonly profileDigest: string
  readonly pluginPackDigest: string
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly persona: string
}

type InitializeCommand = Extract<RuntimeCommand, { type: 'runtime.initialize' }>

export function runtimeSpecFromInitialize(command: InitializeCommand): RuntimeSpec {
  const { maxTokens, ...rest } = command.payload
  // exactOptionalPropertyTypes：zod 的 optional 产出 `number | undefined`，
  // 桥内形态要求键存在即有效值。
  return maxTokens === undefined ? rest : { ...rest, maxTokens }
}

/** 本 Run 的 DSH Session 身份：`runId + dshSessionId` 关联的桥侧锚点（03 §8）。 */
export function dshSessionIdOf(spec: RuntimeSpec): string {
  return `project311-run-${spec.runId}`
}
