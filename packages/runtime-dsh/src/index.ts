/**
 * @project311/runtime-dsh —— 唯一允许依赖 DSH 的 Adapter 包（02 Global
 * Constraints，check-boundaries 强制）。公共面见 02 Task 11 Interfaces：
 * RuntimeBridge.start/followup(经 handleCommand)/cancel/dispose 与
 * NDJSON 单通道边界。
 */
export const RUNTIME_DSH_VERSION = 1 as const

export { RuntimeBridge, dispatchRuntimeCommand } from './bridge.js'
export type { RuntimeBridgeOptions, RuntimeBridgeSlot } from './bridge.js'
export { runtimeSpecFromInitialize, dshSessionIdOf } from './runtime-spec.js'
export type { RuntimeSpec } from './runtime-spec.js'
export { SessionOwner } from './session-owner.js'
export type { RunScopedPorts, SessionOwnerEvents } from './session-owner.js'
export { ApprovalPort } from './approval-port.js'
export type { ApprovalRequestedFact } from './approval-port.js'
export { createPublishArtifactTool, PUBLISH_ARTIFACT_TOOL } from './artifact-tool.js'
export type { ArtifactCandidate, ArtifactPort } from './artifact-tool.js'
export { readRuntimeCommands, writeRuntimeOutput, MAX_COMMAND_LINE_BYTES } from './protocol-port.js'
export type { CommandSourceOptions } from './protocol-port.js'
export { nullLog } from './log.js'
export type { LogRecord, LogSink } from './log.js'
