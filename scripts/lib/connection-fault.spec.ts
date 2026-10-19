import { describe, expect, it } from 'vitest'
import { ConnectionFault } from './connection-fault.js'
import { r8WindowFailures } from './r8-window.js'

describe('#399 断连窗口由显式释放控制', () => {
  it('超过旧 4 秒窗口仍拒绝连接，只有持有者明确释放才恢复', () => {
    let now = 1000
    const fault = new ConnectionFault(() => now)
    fault.hold('r8-fault')
    now += 60_000
    expect(fault.blockConnection()).toBe(true)
    expect(fault.snapshot()).toMatchObject({
      held: true,
      offline: true,
      faultId: 'r8-fault',
      blockedConnectionAttempts: 1,
    })
    expect(() => fault.release('wrong-id')).toThrow()
    expect(() => fault.dropFor(1)).toThrow()
    fault.release('r8-fault')
    expect(fault.blockConnection()).toBe(false)
    fault.release('r8-fault') // 重复清理幂等，但旧 id 不得释放后来的故障。
    fault.hold('new-fault')
    expect(() => fault.release('r8-fault')).toThrow()
  })
  it('保留 R4/R5 的定时断连；非法时长必须拒绝', () => {
    let now = 1000
    const fault = new ConnectionFault(() => now)
    fault.dropFor(4000)
    now = 4999
    expect(fault.blockConnection()).toBe(true)
    now = 5000
    expect(fault.blockConnection()).toBe(false)
    for (const ms of [0, -1, NaN, Infinity]) expect(() => fault.dropFor(ms)).toThrow()
  })
})

describe('#399 R8 崩溃前提必须机器判定', () => {
  const good = () => ({
    fault: { held: true, offline: true, faultId: 'r8-fault', liveSockets: 0 },
    expectedFaultId: 'r8-fault',
    runStatus: 'dispatching',
    startCommands: [{ acked: false, attempts: 1 }],
  })
  it('正确窗口通过；已释放、错误窗口、活连接、已 ack、无失败派发均拒绝', () => {
    expect(r8WindowFailures(good())).toEqual([])
    for (const changes of [
      { fault: { ...good().fault, held: false } },
      { fault: { ...good().fault, faultId: 'wrong' } },
      { fault: { ...good().fault, offline: false } },
      { fault: { ...good().fault, liveSockets: 1 } },
      { runStatus: 'waiting_approval' },
      { startCommands: [{ acked: true, attempts: 1 }] },
      { startCommands: [{ acked: false, attempts: 0 }] },
      { startCommands: [] },
    ])
      expect(r8WindowFailures({ ...good(), ...changes }).length).toBeGreaterThan(0)
  })
})
