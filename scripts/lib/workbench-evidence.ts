import { strict as assert } from 'node:assert'

/** Independent P1-423 decision: missing observations never count as success. */
export function verifyWorkbenchEvidence(input: unknown) {
  let checks = 0
  const check = (condition: unknown, message: string) => {
    checks++
    assert(condition, message)
  }
  const record = (value: unknown): Record<string, unknown> => {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), 'missing record')
    return value as Record<string, unknown>
  }
  const number = (value: unknown): number => {
    check(typeof value === 'number' && Number.isFinite(value), 'missing finite measurement')
    return value as number
  }
  const box = (value: unknown, width: number) => {
    const rect = record(value)
    const x = number(rect.x),
      w = number(rect.width),
      h = number(rect.height)
    number(rect.y)
    check(x >= 0 && w > 0 && h > 0 && x + w <= width + 1, 'surface overflow or empty')
  }
  const result = record(input)
  check(result.ok === true, 'driver incomplete')
  check(
    Array.isArray(result.browserErrors) && result.browserErrors.length === 0,
    'browser errors missing or nonempty',
  )
  check(Array.isArray(result.facts), 'missing facts')
  const facts = (result.facts as unknown[])
    .map(record)
    .filter((row) => row.component === 'web.workbench')
  check(facts.length === 1, 'expected one workbench observation')
  for (const kind of ['start', 'room', 'run']) {
    const group = record(facts[0]![kind])
    check(Array.isArray(group.rows), 'missing layouts')
    const rows = (group.rows as unknown[]).map(record)
    check(JSON.stringify(rows.map((row) => row.width)) === '[1440,390,320]', 'incomplete viewports')
    if (kind !== 'run') check(group.posts === 0, 'unexpected mutation')
    for (const row of rows) {
      const width = number(row.width)
      const scroll = number(row.scroll)
      check(scroll > 0 && scroll <= width, 'page overflow')
      if (kind === 'start') {
        box(row.empty, width)
        box(row.search, width)
        const clip = record(row.clip)
        check(
          number(clip.client) > 0 &&
            number(clip.scroll) <= number(clip.client) &&
            clip.contained === true &&
            clip.footerVisible === true,
          'search content clipped',
        )
        check(row.profileCount === (width === 1440 ? 1 : 0), 'incorrect sidebar presence')
        check(row.mobileNameVisible === (width === 390), 'narrow identity must hide deliberately')
        check(
          row.uniqueSearch === true &&
            row.keyboardClear === true &&
            row.closeRestoresFocus === true,
          'search keyboard or focus broken',
        )
      } else if (kind === 'room') {
        box(row.drawer, width)
        box(row.welcome, width)
        check(
          row.resultNavigation === true && row.drawerFocus === true,
          'result navigation or drawer focus broken',
        )
      } else {
        box(row.tool, width)
        box(row.activity, width)
        check(row.status === 'completed' && row.working === null, 'terminal run pretends to work')
        check(row.reducedArcRule === true, 'missing reduced-motion suppression')
      }
    }
  }
  return { checks, layouts: 9 }
}
