/**
 * 交接叙述的 Unicode 防线（#379；评审 F-残余）：JSON 线上可携带孤立代理项
 * （`"\ud800"`），结构与字节上限都会放行，但 PostgreSQL 的 jsonb 编码会以 22P02
 * 拒行——抛穿 ingest 事务就是毒帧路径回归（与容量毒帧同一类）。schema 层拒绝。
 */
import { describe, expect, it } from 'vitest'
import { HandoffNarrativeSchema, emptyHandoffNarrative } from '../src/index.js'

function withText(text: string) {
  return { ...emptyHandoffNarrative(), completed: [{ text, verified: false, refs: [] }] }
}

describe('#379 交接叙述的 Unicode 防线', () => {
  it('正常文本与合法代理对（emoji）放行', () => {
    expect(HandoffNarrativeSchema.safeParse(emptyHandoffNarrative()).success).toBe(true)
    expect(HandoffNarrativeSchema.safeParse(withText('完成登录接口 😀')).success).toBe(true)
  })

  it('孤立代理项拒绝：高/低位、任意字段位置都不放行', () => {
    expect(HandoffNarrativeSchema.safeParse(withText('bad \uD800 tail')).success).toBe(false)
    expect(HandoffNarrativeSchema.safeParse(withText('bad \uDC00 head')).success).toBe(false)
    const inCommits = { ...emptyHandoffNarrative(), commits: ['abc\uD800'] }
    expect(HandoffNarrativeSchema.safeParse(inCommits).success).toBe(false)
  })
})
