import { describe, expect, it } from 'vitest'
import { asUserId } from '../src/ids.js'
import type { Actor, Resource, Role } from '../src/policy.js'
import { authorize, can } from '../src/policy.js'

// 权限矩阵以 03-领域模型与运行协议.md §4「权限」列为准。
const U1 = asUserId('00000000-0000-4000-8000-0000000000a1')
const U2 = asUserId('00000000-0000-4000-8000-0000000000b2')

const actor = (role: Role, userId = U1, disabledAt?: number): Actor =>
  disabledAt === undefined ? { role, userId } : { role, userId, disabledAt }

const owner = actor('owner')
const admin = actor('admin')
const member = actor('member')
const foreignMember = actor('member', U2)

const NO_RESOURCE: Resource = {}
const OWN: Resource = { ownerUserId: U1 }
const FOREIGN: Resource = { ownerUserId: U2 }
const ASSIGNEE_ACCEPTED: Resource = { assigneeUserId: U1, assignmentStatus: 'accepted' }
const ASSIGNEE_PENDING: Resource = { assigneeUserId: U1, assignmentStatus: 'pending' }
const ASSIGNEE_FOREIGN_ACCEPTED: Resource = { assigneeUserId: U2, assignmentStatus: 'accepted' }
const ART_OWN_CANDIDATE: Resource = { ownerUserId: U1, artifactStatus: 'candidate' }
const ART_FOREIGN_PUBLISHED: Resource = { ownerUserId: U2, artifactStatus: 'published' }
const ART_FOREIGN_CANDIDATE: Resource = { ownerUserId: U2, artifactStatus: 'candidate' }

describe('authorize: owner/admin only actions', () => {
  it.each([
    ['create_invite', 'owner', true],
    ['create_invite', 'admin', true],
    ['create_invite', 'member', false],
    ['manage_agent', 'owner', true],
    ['manage_agent', 'admin', true],
    ['manage_agent', 'member', false],
    ['install_plugin', 'owner', true],
    ['install_plugin', 'admin', true],
    ['install_plugin', 'member', false],
    ['create_plugin_pack', 'owner', true],
    ['create_plugin_pack', 'admin', true],
    ['create_plugin_pack', 'member', false],
    ['reassign_task', 'owner', true],
    ['reassign_task', 'admin', true],
    ['reassign_task', 'member', false],
    ['disable_member', 'owner', true],
    ['disable_member', 'admin', true],
    ['disable_member', 'member', false],
  ] as const)('%s by %s -> %s', (action, role, allowed) => {
    expect(authorize(actor(role), action, NO_RESOURCE)).toBe(allowed)
  })
})

describe('authorize: any enabled member actions', () => {
  it.each(['create_task', 'update_task', 'comment_task', 'view_run', 'pair_device'] as const)(
    '%s by every role -> true',
    (action) => {
      for (const role of ['owner', 'admin', 'member'] as const) {
        expect(authorize(actor(role), action, NO_RESOURCE)).toBe(true)
      }
    },
  )
})

describe('authorize: assignment decisions belong to the assignee', () => {
  it.each([
    ['accept_assignment', ASSIGNEE_ACCEPTED, true],
    ['accept_assignment', ASSIGNEE_PENDING, true],
    ['reject_assignment', ASSIGNEE_PENDING, true],
  ] as const)('%s by the assignee -> %s', (action, resource, allowed) => {
    expect(authorize(member, action, resource)).toBe(allowed)
  })

  it.each(['accept_assignment', 'reject_assignment'] as const)(
    '%s by anyone but the assignee -> false, even Owner/Admin',
    (action) => {
      expect(authorize(foreignMember, action, ASSIGNEE_PENDING)).toBe(false)
      expect(authorize(actor('owner', U2), action, ASSIGNEE_PENDING)).toBe(false)
      expect(authorize(actor('admin', U2), action, ASSIGNEE_PENDING)).toBe(false)
    },
  )
})

describe('authorize: accepted-assignee task commands', () => {
  it.each(['submit_review', 'complete_task', 'cancel_task', 'create_run'] as const)(
    '%s by the accepted assignee -> true',
    (action) => {
      expect(authorize(member, action, ASSIGNEE_ACCEPTED)).toBe(true)
    },
  )

  it.each(['submit_review', 'complete_task', 'cancel_task', 'create_run'] as const)(
    '%s while the Assignment is not accepted -> false',
    (action) => {
      expect(authorize(member, action, ASSIGNEE_PENDING)).toBe(false)
    },
  )

  it.each(['submit_review', 'complete_task', 'cancel_task', 'create_run'] as const)(
    '%s by a non-assignee -> false, even Owner/Admin',
    (action) => {
      expect(authorize(foreignMember, action, ASSIGNEE_ACCEPTED)).toBe(false)
      expect(authorize(actor('owner', U2), action, ASSIGNEE_ACCEPTED)).toBe(false)
      expect(authorize(actor('admin', U2), action, ASSIGNEE_ACCEPTED)).toBe(false)
    },
  )
})

describe('authorize: cancel_run', () => {
  it.each([
    ['member', OWN, true],
    ['owner', FOREIGN, true],
    ['admin', FOREIGN, true],
    ['member', FOREIGN, false],
  ] as const)('%s with %j -> %s', (role, resource, allowed) => {
    expect(authorize(actor(role), 'cancel_run', resource)).toBe(allowed)
  })
})

describe('authorize: revoke_device', () => {
  it.each([
    ['member', OWN, true],
    ['owner', FOREIGN, true],
    ['admin', FOREIGN, true],
    ['member', FOREIGN, false],
  ] as const)('%s with %j -> %s', (role, resource, allowed) => {
    expect(authorize(actor(role), 'revoke_device', resource)).toBe(allowed)
  })
})

describe('authorize: run-owner only actions', () => {
  it.each(['decide_approval', 'publish_artifact'] as const)(
    '%s by the Run owner -> true',
    (action) => {
      expect(authorize(member, action, OWN)).toBe(true)
    },
  )

  it.each(['decide_approval', 'publish_artifact'] as const)(
    '%s by anyone but the Run owner -> false, even Owner/Admin',
    (action) => {
      expect(authorize(foreignMember, action, OWN)).toBe(false)
      expect(authorize(actor('owner', U2), action, OWN)).toBe(false)
      expect(authorize(actor('admin', U2), action, OWN)).toBe(false)
    },
  )
})

describe('authorize: read_artifact_content', () => {
  it.each([
    ['member', ART_OWN_CANDIDATE, true],
    ['member', ART_FOREIGN_PUBLISHED, true],
    ['member', ART_FOREIGN_CANDIDATE, false],
    ['admin', ART_FOREIGN_CANDIDATE, false],
    ['owner', ART_FOREIGN_PUBLISHED, true],
  ] as const)('%s with %j -> %s', (role, resource, allowed) => {
    expect(authorize(actor(role), 'read_artifact_content', resource)).toBe(allowed)
  })
})

describe('authorize: disabled members can do nothing', () => {
  it.each([
    ['member', 'create_task', NO_RESOURCE],
    ['member', 'cancel_run', OWN],
    ['owner', 'manage_agent', NO_RESOURCE],
    ['admin', 'install_plugin', NO_RESOURCE],
    ['member', 'decide_approval', OWN],
    ['admin', 'reassign_task', NO_RESOURCE],
    ['owner', 'disable_member', NO_RESOURCE],
  ] as const)('disabled %s cannot %s', (role, action, resource) => {
    expect(authorize(actor(role, U1, 1_700_000_000_000), action, resource)).toBe(false)
  })
})

describe('can', () => {
  it('is the same decision function as authorize', () => {
    expect(can).toBe(authorize)
    expect(can(member, 'cancel_run', OWN)).toBe(true)
    expect(can(foreignMember, 'cancel_run', OWN)).toBe(false)
  })
})
