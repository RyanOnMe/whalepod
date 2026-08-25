/**
 * 协议 catalog：四类 wire 的 frame 类型登记处（02-第一阶段实施计划.md Task 3）。
 *
 * 各 TYPE 列表直接从对应 schema union 的判别字面量导出（单一事实源在 schema），
 * fixtures/ 目录与这些列表的一一对应由 tests/catalog-drift.spec.ts 强制；
 * generated/ 的 JSON Schema 与 schema 的一致由 scripts/generate-json-schema.mts
 * --check 强制（接在 pnpm check 里）。
 */
import type { ZodType } from 'zod'
import { CLIENT_FRAME_KINDS, CLIENT_PERSISTENT_EVENT_TYPES } from './client-events.js'
import {
  AcceptInviteRequestSchema,
  ApiFailureSchema,
  CreateAgentRequestSchema,
  CreateAgentRevisionRequestSchema,
  CreateCommentRequestSchema,
  CreateInviteRequestSchema,
  CreateProjectRequestSchema,
  CreateRunRequestSchema,
  CreateTaskRequestSchema,
  DecideApprovalRequestSchema,
  LoginRequestSchema,
  ReassignTaskRequestSchema,
  SetupRequestSchema,
  UpdateTaskRequestSchema,
} from './http.js'
import {
  NODE_DOWNSTREAM_TYPES,
  NODE_UPSTREAM_TYPES,
  PROJECTED_RUN_EVENT_TYPES,
} from './node-wire.js'
import { RUNTIME_COMMAND_TYPES, RUNTIME_OUTPUT_TYPES } from './runtime-wire.js'

export {
  CLIENT_FRAME_KINDS,
  CLIENT_PERSISTENT_EVENT_TYPES,
  NODE_DOWNSTREAM_TYPES,
  NODE_UPSTREAM_TYPES,
  PROJECTED_RUN_EVENT_TYPES,
  RUNTIME_COMMAND_TYPES,
  RUNTIME_OUTPUT_TYPES,
}

/** fixtures/http/ 下每个示例 body 对应的 DTO schema；键即 fixture 文件基名。 */
export const HTTP_FIXTURE_SCHEMAS: Record<string, ZodType> = {
  'api-failure': ApiFailureSchema,
  'accept-invite-request': AcceptInviteRequestSchema,
  'create-agent-request': CreateAgentRequestSchema,
  'create-agent-revision-request': CreateAgentRevisionRequestSchema,
  'create-comment-request': CreateCommentRequestSchema,
  'create-invite-request': CreateInviteRequestSchema,
  'create-project-request': CreateProjectRequestSchema,
  'create-run-request': CreateRunRequestSchema,
  'create-task-request': CreateTaskRequestSchema,
  'decide-approval-request': DecideApprovalRequestSchema,
  'login-request': LoginRequestSchema,
  'reassign-task-request': ReassignTaskRequestSchema,
  'setup-request': SetupRequestSchema,
  'update-task-request': UpdateTaskRequestSchema,
}
