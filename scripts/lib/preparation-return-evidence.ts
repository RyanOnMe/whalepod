export interface PreparationReturnVerdict {
  component: 'web.preparation.return.verify'
  verdict: 'PASS' | 'FAIL'
  problems: string[]
}
export function verifyPreparationReturnEvidence(_input: unknown): PreparationReturnVerdict {
  return {
    component: 'web.preparation.return.verify',
    verdict: 'FAIL',
    problems: ['not implemented'],
  }
}
