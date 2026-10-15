export interface AttentionVerdict {
  component: 'web.attention.verify'
  verdict: 'PASS' | 'FAIL'
  problems: string[]
}
export function verifyAttentionEvidence(_input: unknown): AttentionVerdict {
  return { component: 'web.attention.verify', verdict: 'FAIL', problems: ['not implemented'] }
}
