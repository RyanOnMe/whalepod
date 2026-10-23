import { strict as assert } from 'node:assert'
/** Independent P1-432 verdict over production observations. */
export function verifyManagementEvidence(input: unknown) {
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
  check(result.ok === true && result.component === 'web.management', 'incomplete driver')
  check(Array.isArray(result.browserErrors) && result.browserErrors.length === 0, 'browser errors')
  check(result.readOnlyPosts === 0, 'unexpected mutation')
  for (const key of [
    'inviteRetained',
    'inviteCopied',
    'memberJoined',
    'pluginInstalled',
    'packCreated',
    'agentCreated',
    'paired',
    'pairingCopied',
    'memberReadOnly',
  ])
    check(result[key] === true, `workflow missing: ${key}`)
  check(Array.isArray(result.rows), 'missing layouts')
  const rows = (result.rows as unknown[]).map(record)
  check(JSON.stringify(rows.map((row) => row.width)) === '[1440,390,320]', 'incomplete widths')
  for (const row of rows) {
    for (const key of [
      'inviteCollapsed',
      'inviteRoleRetained',
      'closeRestoresFocus',
      'revisionPrefill',
      'onePairingAction',
      'reduced',
    ])
      check(row[key] === true, `interaction failed: ${key}`)
    for (const [kind, min] of [
      ['members', 3],
      ['plugins', 6],
      ['agents', 2],
      ['devices', 2],
    ] as const) {
      const page = record(row[kind])
      check(
        page.width === row.width &&
          typeof page.scroll === 'number' &&
          page.scroll > 0 &&
          page.scroll <= (row.width as number),
        'page overflow',
      )
      check(Array.isArray(page.surfaces) && page.surfaces.length >= min, `missing ${kind} surfaces`)
      for (const surface of page.surfaces as unknown[]) {
        const box = record(surface)
        for (const field of ['x', 'y', 'width', 'height', 'client', 'scroll'])
          check(
            typeof box[field] === 'number' && Number.isFinite(box[field]),
            'missing finite geometry',
          )
        check(
          (box.x as number) >= 0 &&
            (box.width as number) > 0 &&
            (box.height as number) > 0 &&
            (box.x as number) + (box.width as number) <= (row.width as number) + 1,
          'surface overflow',
        )
        check(
          (box.client as number) > 0 && (box.scroll as number) <= (box.client as number) + 1,
          'clipped content',
        )
      }
    }
  }
  return { checks, layouts: rows.length * 4 }
}
