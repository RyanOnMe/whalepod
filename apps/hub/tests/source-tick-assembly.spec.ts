/**
 * #457：来源 reconcile tick 的装配级反面钉。
 *
 * 背景：慢权限重验曾让整轮 tick 被外层守卫跳过，健康租约因此过期（第三轮复核 #3）。
 * 修复把「只对重验单飞」放进 reconciler，server 与测试共用 `runSourceReconcileTick`。
 * 行为判据已有 `keeps renewing leases while a slow permission revalidation is running`；
 * 本文件补的是装配面：防止有人把整轮守卫加回 server 的 10s 回调或共享入口。
 *
 * 判据是源码结构，不是「看起来没报错」：整轮守卫必须先有可变状态或有条件早退，
 * 而调用点之前两者都不允许出现。这是 tripwire，只防字面 `if`/`return`/`let`；
 * 共享入口层的短路/三元由慢重验行为用例兜底，server 回调内的短路仍属未覆盖盲区。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HUB_SRC = join(import.meta.dirname, '../src')

function readHubSource(relativePath: string): string {
  return readFileSync(join(HUB_SRC, relativePath), 'utf8')
}

/** 取 `const leaseTimer = setInterval(` 到 `}, 10_000)` 之间的回调体。 */
function leaseTimerBody(serverSource: string): string {
  const start = serverSource.indexOf('const leaseTimer = setInterval(')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = serverSource.indexOf('}, 10_000)', start)
  expect(end).toBeGreaterThan(start)
  return serverSource.slice(start, end)
}

describe('source reconcile tick assembly (#457)', () => {
  it('calls the shared tick unconditionally from the 10s interval', () => {
    const body = leaseTimerBody(readHubSource('server.ts'))
    const call = body.indexOf('void runSourceReconcileTick({')
    expect(call).toBeGreaterThan(-1)

    const beforeCall = body.slice(0, call)
    expect(beforeCall).not.toMatch(/\bif\s*\(/)
    expect(beforeCall).not.toMatch(/\breturn\b/)
    expect(beforeCall).not.toMatch(/\blet\s+\w+/)
  })

  it('routes the tick through the shared entry exactly once', () => {
    const source = readHubSource('server.ts')
    expect(source.match(/runSourceReconcileTick\(/g) ?? []).toHaveLength(1)
    expect(source).toContain("from './modules/source/tick.js'")
  })

  it('keeps the shared entry free of a whole-round guard', () => {
    const source = readHubSource('modules/source/tick.ts')
    const start = source.indexOf('export function runSourceReconcileTick')
    expect(start).toBeGreaterThanOrEqual(0)
    const tail = source.slice(start)
    // 只扫入口函数体，避免把后续合法 helper 里的 if/let 误判成守卫。
    const end = tail.indexOf('\n}\n')
    const body = end === -1 ? tail : tail.slice(0, end)
    expect(body).not.toMatch(/\bif\s*\(/)
    expect(body).not.toMatch(/\blet\s+\w+/)
  })
})
