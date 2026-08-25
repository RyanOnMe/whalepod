import { describe, expect, it } from 'vitest'
import { builderAgent, reviewerAgent } from '../src/fixtures.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DIGEST_RE = /^[0-9a-f]{64}$/

describe('Builder/Reviewer standard fixtures', () => {
  it.each([builderAgent, reviewerAgent])('$name is well-formed', (agent) => {
    expect(agent.agentId).toMatch(UUID_RE)
    expect(agent.profileRevisionId).toMatch(UUID_RE)
    expect(agent.profileDigest).toMatch(DIGEST_RE)
    expect(agent.pluginPackDigest).toMatch(DIGEST_RE)
  })

  it('Builder and Reviewer are distinct Agents with distinct Revisions', () => {
    expect(builderAgent.agentId).not.toBe(reviewerAgent.agentId)
    expect(builderAgent.profileRevisionId).not.toBe(reviewerAgent.profileRevisionId)
    expect(builderAgent.profileDigest).not.toBe(reviewerAgent.profileDigest)
  })
})
