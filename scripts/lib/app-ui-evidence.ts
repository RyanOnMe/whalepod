/** Independent P1-421 judgment over recorded browser observations. Missing facts fail. */
export function verifyAppUiEvidence(input: unknown): { checks: number; layouts: number } {
  let checks = 0
  const assert = (condition: unknown, message: string): void => {
    checks++
    if (!condition) throw new Error(message)
  }
  const record = (value: unknown): Record<string, unknown> => {
    assert(
      typeof value === 'object' && value !== null && !Array.isArray(value),
      'Missing observation',
    )
    return value as Record<string, unknown>
  }
  const number = (value: unknown): number => {
    assert(typeof value === 'number' && Number.isFinite(value), 'Missing finite measurement')
    return value as number
  }
  const rect = (value: unknown) => {
    const box = record(value)
    const measured = {
      x: number(box.x),
      y: number(box.y),
      width: number(box.width),
      height: number(box.height),
    }
    assert(measured.width > 0 && measured.height > 0, 'Empty measured surface')
    return measured
  }
  const result = record(input)
  assert(result.ok === true, 'Driver did not complete')
  assert(
    Array.isArray(result.browserErrors) && result.browserErrors.length === 0,
    'Browser errors or missing error observations',
  )
  assert(Array.isArray(result.facts), 'Missing facts')
  const facts = (result.facts as unknown[])
    .map(record)
    .filter((fact) => fact.component === 'web.app-ui')
  assert(facts.length === 1, 'Expected one App UI observation')
  const fact = facts[0]!
  assert(fact.scenario === 'restricted-presentation', 'Unexpected scenario')
  for (const kind of ['prompts', 'approvals', 'files', 'sendFocus']) {
    assert(Array.isArray(fact[kind]), `Missing ${kind}`)
    const rows = (fact[kind] as unknown[]).map(record)
    assert(
      JSON.stringify(rows.map((row) => number(row.width)).sort((a, b) => a - b)) ===
        '[320,390,1440]',
      `Incomplete ${kind} viewports`,
    )
    for (const row of rows) {
      const width = number(row.width)
      if (kind === 'prompts') {
        assert(row.inputCount === 1, 'Duplicate input')
        assert(
          row.inputShadow === 'none' &&
            typeof row.frameShadow === 'string' &&
            row.frameShadow !== 'none' &&
            row.frameShadow !== '',
          'Focus must be on the single composer surface',
        )
      } else if (kind === 'approvals') {
        const card = rect(row.card)
        const preview = rect(row.preview)
        assert(card.x >= 0 && card.x + card.width <= width, 'Approval overflows viewport')
        assert(
          preview.x >= card.x && preview.x + preview.width <= card.x + card.width,
          'Approval arguments overflow card',
        )
        assert(
          number(row.approveHeight) >= 40 && number(row.rejectHeight) >= 40,
          'Decision target is too small',
        )
      } else if (kind === 'files') {
        const menu = rect(row.menu)
        assert(
          menu.x >= 0 && menu.x + menu.width <= width && menu.y >= 0 && menu.y + menu.height <= 960,
          'File menu overflows viewport',
        )
        assert(row.itemCount === 3 && row.posts === 0, 'Missing actions or unexpected mutation')
        assert(
          row.escapeRestoresFocus === true && row.outerPanelPreserved === true,
          'Escape/focus contract lost',
        )
      } else {
        assert(
          row.focused === true && typeof row.shadow === 'string',
          'Missing keyboard send focus',
        )
        const shadow = row.shadow as string
        assert(
          !shadow.includes('inset') &&
            /0px 0px 0px 2px/.test(shadow) &&
            /0px 0px 0px 4px/.test(shadow),
          'Send button has no visible double focus ring',
        )
      }
    }
  }
  return { checks, layouts: 9 }
}
