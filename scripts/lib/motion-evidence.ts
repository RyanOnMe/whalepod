import { strict as assert } from 'node:assert'

/** Independent verdict: styling declarations alone cannot prove motion happened. */
export function verifyMotionEvidence(input: unknown) {
  let checks = 0
  const check = (value: unknown, reason: string) => {
    checks++
    assert(value, reason)
  }
  const record = (value: unknown): Record<string, unknown> => {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), 'missing record')
    return value as Record<string, unknown>
  }
  const result = record(input)
  check(result.ok === true && result.component === 'web.motion', 'driver incomplete')
  const project = record(result.project)
  check(
    typeof project.depthTransform === 'string' && project.depthTransform.startsWith('matrix3d('),
    'depth motion absent',
  )
  check(
    project.reducedTransform === 'none' && project.idleWrites === 0 && project.returned === true,
    'depth reset or idle failure',
  )
  const workspace = record(result.workspace)
  check(
    workspace.posts === 0 && workspace.contentReads === 1,
    'unexpected writes or repeat immutable read',
  )
  check(
    workspace.toolsReal === true && workspace.candidatePrivate === true,
    'tool or audience regression',
  )
  check(
    typeof workspace.secondRunId === 'string' && /^[0-9a-f-]{36}$/.test(workspace.secondRunId),
    'missing production rerun',
  )
  check(Array.isArray(workspace.rows), 'missing layouts')
  const rows = (workspace.rows as unknown[]).map(record)
  check(JSON.stringify(rows.map((row) => row.width)) === '[1440,390,320]', 'incomplete viewports')
  for (const row of rows) {
    for (const [kind, duration] of [
      ['reveal', 360],
      ['inspector', 320],
    ] as const) {
      const motion = record(row[kind])
      check(
        Array.isArray(motion.durations) &&
          motion.durations.length >= 2 &&
          motion.durations.every(
            (value) => typeof value === 'number' && value > 0 && value <= duration + 1,
          ),
        'missing real transitions',
      )
      check(
        motion.declaredDuration === (kind === 'reveal' ? '0.36s' : '0.32s, 0.32s'),
        'declared motion timing drift',
      )
      const early = record(motion.early),
        late = record(motion.late)
      for (const frame of [early, late])
        for (const key of ['x', 'height', 'opacity'])
          check(
            typeof frame[key] === 'number' && Number.isFinite(frame[key]),
            'missing intermediate frame',
          )
      check((early.height as number) > 0 && (late.height as number) > 0, 'empty motion surface')
      if (kind === 'reveal')
        check((late.height as number) - (early.height as number) > 1, 'reveal does not move')
      else check((early.x as number) - (late.x as number) > 1, 'inspector does not travel')
    }
    check(
      Array.isArray(row.fanBefore) &&
        row.fanBefore.length === 2 &&
        Array.isArray(row.fanAfter) &&
        row.fanAfter.length === 2 &&
        JSON.stringify(row.fanBefore) !== JSON.stringify(row.fanAfter),
      'file fan absent',
    )
    const keyboardGroup = record(row.keyboardGroup)
    check(
      keyboardGroup.duration === '0s' &&
        keyboardGroup.animations === 0 &&
        keyboardGroup.raised === true,
      'keyboard focus fan missing or animated',
    )
    const keyboardFan = record(row.keyboardFan),
      keyboardTimeline = record(row.keyboardTimeline)
    check(
      JSON.stringify(keyboardFan.durations) === '["0s","0s"]' && keyboardFan.animations === 0,
      'keyboard fan still animates',
    )
    check(
      keyboardTimeline.duration === '0s' && keyboardTimeline.animations === 0,
      'keyboard timeline still animates',
    )
    const reduced = record(row.reduced)
    check(reduced.duration === '0s' && reduced.transform === 'none', 'reduced motion ignored')
    const geometry = record(row.geometry)
    check(
      geometry.width === row.width &&
        typeof geometry.scroll === 'number' &&
        geometry.scroll > 0 &&
        geometry.scroll <= (row.width as number),
      'page overflow',
    )
    check(
      typeof geometry.client === 'number' &&
        geometry.client > 0 &&
        typeof geometry.content === 'number' &&
        geometry.content <= geometry.client + 1,
      'content clipping',
    )
    for (const key of ['interrupted', 'closedInert', 'previewRetained', 'focusReturned'])
      check(row[key] === true, `interaction failure: ${key}`)
  }
  return { checks, layouts: rows.length }
}
