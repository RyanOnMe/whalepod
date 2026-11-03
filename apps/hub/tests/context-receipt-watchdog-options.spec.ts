/**
 * ADR-0027 §4：首条回执 watchdog 的等待时长配置边界（默认 60 秒，上限 120 秒）。
 */
import { describe, expect, it } from 'vitest'
import {
  CONTEXT_RECEIPT_WATCHDOG_MAX_MS,
  CONTEXT_RECEIPT_WATCHDOG_MS,
  resolveContextReceiptWatchdogMs,
} from '../src/modules/context/receipt-watchdog.js'

describe('context receipt watchdog options', () => {
  it('defaults to 60s and accepts a configured value', () => {
    expect(resolveContextReceiptWatchdogMs()).toBe(CONTEXT_RECEIPT_WATCHDOG_MS)
    expect(resolveContextReceiptWatchdogMs(30_000)).toBe(30_000)
  })

  it('caps at 120s and falls back for invalid values', () => {
    expect(resolveContextReceiptWatchdogMs(600_000)).toBe(CONTEXT_RECEIPT_WATCHDOG_MAX_MS)
    expect(resolveContextReceiptWatchdogMs(0)).toBe(CONTEXT_RECEIPT_WATCHDOG_MS)
    expect(resolveContextReceiptWatchdogMs(-1)).toBe(CONTEXT_RECEIPT_WATCHDOG_MS)
    expect(resolveContextReceiptWatchdogMs(Number.NaN)).toBe(CONTEXT_RECEIPT_WATCHDOG_MS)
  })
})
