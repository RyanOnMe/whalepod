/**
 * Branded primitive ids（02-第一阶段实施计划.md Task 2）。
 * 领域层只消费这些不透明 id 与时间戳，不感知 DB/HTTP/DSH。
 */
declare const idBrand: unique symbol

export type Brand<Base, Name extends string> = Base & { readonly [idBrand]: Name }

export type TeamId = Brand<string, 'TeamId'>
export type UserId = Brand<string, 'UserId'>
export type ProjectId = Brand<string, 'ProjectId'>
export type TaskId = Brand<string, 'TaskId'>
export type AgentId = Brand<string, 'AgentId'>
export type ProfileRevisionId = Brand<string, 'ProfileRevisionId'>
export type DeviceId = Brand<string, 'DeviceId'>
export type WorkspaceId = Brand<string, 'WorkspaceId'>
export type RunId = Brand<string, 'RunId'>
export type ApprovalId = Brand<string, 'ApprovalId'>
export type ArtifactId = Brand<string, 'ArtifactId'>

export const asTeamId = (raw: string): TeamId => raw as TeamId
export const asUserId = (raw: string): UserId => raw as UserId
export const asProjectId = (raw: string): ProjectId => raw as ProjectId
export const asTaskId = (raw: string): TaskId => raw as TaskId
export const asAgentId = (raw: string): AgentId => raw as AgentId
export const asProfileRevisionId = (raw: string): ProfileRevisionId => raw as ProfileRevisionId
export const asDeviceId = (raw: string): DeviceId => raw as DeviceId
export const asWorkspaceId = (raw: string): WorkspaceId => raw as WorkspaceId
export const asRunId = (raw: string): RunId => raw as RunId
export const asApprovalId = (raw: string): ApprovalId => raw as ApprovalId
export const asArtifactId = (raw: string): ArtifactId => raw as ArtifactId
