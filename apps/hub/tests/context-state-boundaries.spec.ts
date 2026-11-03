/**
 * ADR-0027 §6（PC-05b）：撤权状态机的架构边界。把「先派生再交付」「派发前复核」
 * 「Runtime 每次读都看状态文件」「只删未读副本」变成源码级判据，防止后续改动
 * 把 fail-closed 悄悄降级成 fail-open。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

function read(path: string): string {
  return readFileSync(`${REPO_ROOT}${path}`, 'utf8')
}

describe('PC-05b context state boundaries', () => {
  it('derives current state before serving a bundle or dispatching', () => {
    const snapshot = read('apps/hub/src/modules/context/run-snapshot.ts')
    const bundleStart = snapshot.indexOf('export async function buildRunProjectContextBundle')
    const bundleEnd = snapshot.indexOf('\n}\n', bundleStart)
    const bundle = snapshot.slice(bundleStart, bundleEnd)
    const deriveAt = bundle.indexOf('deriveRunContextStateReadOnly')
    const bodyAt = bundle.indexOf('bodyBase64')
    expect(deriveAt).toBeGreaterThan(-1)
    expect(bodyAt).toBeGreaterThan(deriveAt)
    expect(bundle).toContain("entry.state !== 'frozen'")

    const verifyStart = snapshot.indexOf('export async function verifyRunProjectContext')
    const verifyEnd = snapshot.indexOf('\n}\n', verifyStart)
    const verify = snapshot.slice(verifyStart, verifyEnd)
    expect(verify).toContain('verifyRunContextStateFrozen')
  })

  it('checks the local state file before every runtime read', () => {
    const tool = read('packages/runtime-dsh/src/project-context-tool.ts')
    const executeAt = tool.indexOf('execute: async (args) => {')
    const stateAt = tool.indexOf('RUN_CONTEXT_STATE_FILE', executeAt)
    const entryReadAt = tool.indexOf('readFile(join(entriesDir, entry.entryId))', executeAt)
    expect(stateAt).toBeGreaterThan(executeAt)
    expect(entryReadAt).toBeGreaterThan(stateAt)
    expect(tool).toContain('localState.paused')
    expect(tool).toContain('RUN_CONTEXT_STATE_SYNC_MAX_AGE_MS')
    expect(tool).toContain("current.state !== 'frozen'")
  })

  it('deletes only copies that were not read', () => {
    const source = read('apps/node/src/context/state.ts')
    const applyStart = source.indexOf('export async function applyRunContextState')
    const applyEnd = source.indexOf('\n}\n', applyStart)
    const apply = source.slice(applyStart, applyEnd)
    // 读集合守卫必须先于清理调用；实际「已读不删」由
    // apps/node/tests/context-state-cleanup.spec.ts 的行为判据覆盖。
    const readGuard = apply.indexOf('!read.has(entry.entryId)')
    expect(readGuard).toBeGreaterThan(-1)
    expect(apply).toContain('stored.entries.filter')
    expect(apply).toContain('cleanupUnreadEntries')
    expect(apply).not.toContain('rm(prepared.dir')
  })
})
