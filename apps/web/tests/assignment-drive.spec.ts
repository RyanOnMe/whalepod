/**
 * 指派驱动的收窄与文案（#312）。
 *
 * 两条判据：
 * 1. 只认得出的形状才收窄——未知形状返回 null，页面据此**不说话**（宁可不说，
 *    也不替 Hub 编一个「已开始执行」）；
 * 2. 五种命运各有各的说法：排队、未受理、失败都不得被说成「已自动开始执行」。
 */
import { describe, expect, it } from 'vitest'
import { assignmentDriveToast, parseAssignmentDrive } from '../src/shared/assignment-drive.js'

const RUN_ID = '99999999-0000-4000-8000-0000000000r1'

describe('#312 指派驱动的收窄', () => {
  it('failed：带 error.code 才认；缺 code / 非对象 / 未知 outcome 一律 null', () => {
    expect(
      parseAssignmentDrive({ outcome: 'failed', error: { code: 'DEVICE_OFFLINE', message: 'x' } }),
    ).toEqual({ outcome: 'failed', error: { code: 'DEVICE_OFFLINE', message: 'x' } })
    expect(parseAssignmentDrive({ outcome: 'failed', error: { message: 'x' } })).toBeNull()
    expect(parseAssignmentDrive({ outcome: 'failed' })).toBeNull()
    expect(parseAssignmentDrive(null)).toBeNull()
    expect(parseAssignmentDrive('started_run')).toBeNull()
    expect(parseAssignmentDrive({ outcome: 'mystery', runId: RUN_ID })).toBeNull()
  })

  it('四种受理命运：带 runId 才认', () => {
    for (const outcome of ['started_run', 'followup', 'queued', 'rejected'] as const) {
      expect(parseAssignmentDrive({ outcome, runId: RUN_ID })).toEqual({ outcome, runId: RUN_ID })
      expect(parseAssignmentDrive({ outcome })).toBeNull()
    }
  })
})

describe('#312 指派驱动的如实文案', () => {
  it('started_run 才说「已自动开始执行」', () => {
    expect(assignmentDriveToast({ outcome: 'started_run', runId: RUN_ID })).toContain(
      '已自动开始执行',
    )
    for (const outcome of ['followup', 'queued', 'rejected'] as const) {
      expect(assignmentDriveToast({ outcome, runId: RUN_ID })).not.toContain('已自动开始执行')
    }
  })

  it('四种受理各说各话：不共用一句话（否则「受理」与「排队」又糊成一起）', () => {
    const texts = (['started_run', 'followup', 'queued', 'rejected'] as const).map((outcome) =>
      assignmentDriveToast({ outcome, runId: RUN_ID }),
    )
    expect(new Set(texts).size).toBe(4)
  })

  it('失败：任务已创建 + 错误码 + 恢复入口（去任务里的执行区手动发起）', () => {
    const text = assignmentDriveToast({
      outcome: 'failed',
      error: { code: 'DEVICE_OFFLINE', message: 'no device' },
    })
    expect(text).toContain('任务已创建')
    expect(text).toContain('DEVICE_OFFLINE')
    expect(text).toContain('任务执行区')
    expect(text).not.toContain('已自动开始执行')
  })
})
