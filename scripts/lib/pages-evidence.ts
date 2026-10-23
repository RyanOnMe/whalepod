import { strict as assert } from 'node:assert'

/** Independent P1-425 verdict; an absent measurement is a failure. */
export function verifyPagesEvidence(input: unknown) {
  let checks = 0
  const check = (condition: unknown, reason: string) => {
    checks++
    assert(condition, reason)
  }
  const record = (value: unknown): Record<string, unknown> => {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), 'missing record')
    return value as Record<string, unknown>
  }
  const result = record(input)
  check(result.ok === true, 'driver incomplete')
  check(Array.isArray(result.browserErrors) && result.browserErrors.length === 0, 'browser errors')
  check(Array.isArray(result.facts), 'missing facts')
  const facts = (result.facts as unknown[])
    .map(record)
    .filter((row) => row.component === 'web.pages')
  check(facts.length === 1, 'missing or repeated page observation')
  const fact = facts[0]!
  check(fact.posts === 0, 'unexpected mutation')
  check(
    fact.commentShared === true && fact.memberReadOnly === true,
    'comment or permission regression',
  )
  check(Array.isArray(fact.rows), 'missing layouts')
  const rows = (fact.rows as unknown[]).map(record)
  check(JSON.stringify(rows.map((row) => row.width)) === '[1440,390,320]', 'incomplete viewports')
  for (const row of rows) {
    const width = row.width as number
    for (const key of ['projectBounds', 'inboxBounds', 'settingsBounds', 'discussionBounds']) {
      const box = record(row[key])
      for (const field of ['x', 'y', 'width', 'height'])
        check(typeof box[field] === 'number' && Number.isFinite(box[field]), 'missing geometry')
      check(
        (box.x as number) >= 0 &&
          (box.width as number) > 0 &&
          (box.height as number) > 0 &&
          (box.x as number) + (box.width as number) <= width + 1,
        'surface overflow or empty',
      )
    }
    for (const key of ['homeScroll', 'settingsScroll', 'discussionScroll'])
      check(
        typeof row[key] === 'number' && (row[key] as number) > 0 && (row[key] as number) <= width,
        'page overflow',
      )
    check(
      row.pointerDuration === '0.16s, 0.16s' && row.entryDuration === '0.16s, 0.16s',
      'pointer motion missing or too slow',
    )
    check(
      row.keyboardDuration === '0s' && row.reducedDuration === '0s' && row.reducedEntry === '0s',
      'keyboard or reduced-motion delay',
    )
    for (const key of [
      'closedInert',
      'keyboardFocus',
      'interrupted',
      'stableNode',
      'filterDeepLink',
      'advancedRetained',
      'invalidFocus',
      'draftRetained',
    ])
      check(row[key] === true, `interaction failed: ${key}`)
    check(row.replayed === 0, 'refresh replays entry')
    check(row.groups === 4, 'settings hierarchy missing')
  }
  return { checks, layouts: rows.length * 4 }
}
