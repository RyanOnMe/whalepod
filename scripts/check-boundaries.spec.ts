import { describe, expect, it } from 'vitest'
import { validateImport } from './check-boundaries.js'

const DSH_ERROR = 'DSH imports are restricted to packages/runtime-dsh and apps/runtime'

describe('DSH isolation', () => {
  it('blocks DSH imports outside runtime packages', () => {
    expect(() => validateImport('apps/hub/src/app.ts', '@deepseek-ai/dsh-agent')).toThrow(DSH_ERROR)
  })

  it('blocks the DSH root package and cordis outside runtime packages', () => {
    for (const specifier of [
      '@deepseek-ai/dsh',
      '@deepseek-ai/cordis',
      '@deepseek-ai/cordis/plugin',
    ]) {
      expect(() => validateImport('packages/domain/src/index.ts', specifier)).toThrow(DSH_ERROR)
    }
  })

  it('allows the runtime adapter to import DSH', () => {
    expect(() =>
      validateImport('packages/runtime-dsh/src/bridge.ts', '@deepseek-ai/dsh-agent'),
    ).not.toThrow()
    expect(() => validateImport('apps/runtime/src/bin.ts', '@deepseek-ai/cordis')).not.toThrow()
  })
})

describe('workspace dependency rules', () => {
  it('allows hub -> domain/protocol/db', () => {
    for (const specifier of ['@project311/domain', '@project311/protocol', '@project311/db']) {
      expect(() => validateImport('apps/hub/src/app.ts', specifier)).not.toThrow()
    }
  })

  it('inherits the package grant for subpath exports from server-side importers (P1-17 digest)', () => {
    expect(() =>
      validateImport('apps/node/src/plugin/lockfile.ts', '@project311/protocol/plugin-pack-digest'),
    ).not.toThrow()
    expect(() =>
      validateImport(
        'apps/hub/src/modules/plugin/pack-resolver.ts',
        '@project311/protocol/plugin-pack-digest',
      ),
    ).not.toThrow()
    expect(() => validateImport('apps/web/src/main.ts', '@project311/db/anything')).toThrow(
      'not allowed from apps/web/',
    )
  })

  it('denies web -> protocol subpaths not on the isomorphic whitelist (P1-17 regression)', () => {
    expect(() =>
      validateImport('apps/web/src/main.ts', '@project311/protocol/plugin-pack-digest'),
    ).toThrow('not allowed from apps/web/')
    expect(() =>
      validateImport('apps/web/src/main.ts', '@project311/protocol/plugin-pack-digest'),
    ).toThrow('isomorphic subpaths of @project311/protocol: none')
  })

  it('blocks hub -> runtime-dsh', () => {
    expect(() => validateImport('apps/hub/src/app.ts', '@project311/runtime-dsh')).toThrow(
      'not allowed from apps/hub/',
    )
  })

  it('allows web -> protocol only', () => {
    expect(() => validateImport('apps/web/src/main.ts', '@project311/protocol')).not.toThrow()
    for (const specifier of ['@project311/domain', '@project311/db', '@project311/runtime-dsh']) {
      expect(() => validateImport('apps/web/src/main.ts', specifier)).toThrow(
        'not allowed from apps/web/',
      )
    }
  })

  it('allows node -> domain/protocol only', () => {
    expect(() =>
      validateImport('apps/node/src/gateway/client.ts', '@project311/domain'),
    ).not.toThrow()
    expect(() =>
      validateImport('apps/node/src/gateway/client.ts', '@project311/protocol'),
    ).not.toThrow()
    expect(() => validateImport('apps/node/src/gateway/client.ts', '@project311/db')).toThrow(
      'not allowed from apps/node/',
    )
  })

  it('allows runtime -> protocol/runtime-dsh only', () => {
    expect(() => validateImport('apps/runtime/src/bin.ts', '@project311/protocol')).not.toThrow()
    expect(() => validateImport('apps/runtime/src/bin.ts', '@project311/runtime-dsh')).not.toThrow()
    expect(() => validateImport('apps/runtime/src/bin.ts', '@project311/domain')).toThrow(
      'not allowed from apps/runtime/',
    )
  })

  it('allows db/runtime-dsh/testkit package edges', () => {
    expect(() => validateImport('packages/db/src/schema.ts', '@project311/domain')).not.toThrow()
    expect(() => validateImport('packages/db/src/schema.ts', '@project311/protocol')).not.toThrow()
    expect(() =>
      validateImport('packages/runtime-dsh/src/bridge.ts', '@project311/protocol'),
    ).not.toThrow()
    expect(() =>
      validateImport('packages/testkit/src/fakes.ts', '@project311/runtime-dsh'),
    ).not.toThrow()
  })

  it('blocks reverse imports from leaf packages', () => {
    expect(() => validateImport('packages/domain/src/task.ts', '@project311/protocol')).toThrow(
      'not allowed from packages/domain/',
    )
    expect(() => validateImport('packages/protocol/src/run.ts', '@project311/domain')).toThrow(
      'not allowed from packages/protocol/',
    )
    expect(() => validateImport('packages/protocol/src/run.ts', '@project311/db')).toThrow(
      'not allowed from packages/protocol/',
    )
  })

  it('blocks packages from importing apps', () => {
    expect(() => validateImport('packages/protocol/src/run.ts', '@project311/hub')).toThrow(
      'not allowed from packages/protocol/',
    )
  })

  it('ignores third-party and relative specifiers', () => {
    expect(() => validateImport('apps/hub/src/app.ts', 'fastify')).not.toThrow()
    expect(() => validateImport('apps/hub/src/app.ts', './config.js')).not.toThrow()
    expect(() =>
      validateImport('scripts/check-boundaries.ts', '@project311/protocol'),
    ).not.toThrow()
  })
})

// P1-17 回归钉：子路径归一不得 blanket 放行 web（Q0 边界门）。
describe('isomorphic subpath whitelist: pinned edges (P1-17 regression)', () => {
  it('web -> @project311/protocol/plugin-pack-digest is DENY (node:crypto subpath)', () => {
    expect(() =>
      validateImport('apps/web/src/main.ts', '@project311/protocol/plugin-pack-digest'),
    ).toThrow(
      'Subpath import "@project311/protocol/plugin-pack-digest" is not allowed from apps/web/ ' +
        '(isomorphic subpaths of @project311/protocol: none)',
    )
  })

  it('node -> @project311/protocol/plugin-pack-digest is ALLOW (server-side package grant)', () => {
    expect(() =>
      validateImport('apps/node/src/plugin/lockfile.ts', '@project311/protocol/plugin-pack-digest'),
    ).not.toThrow()
  })

  it('web -> @project311/protocol bare package is ALLOW (isomorphic entry)', () => {
    expect(() => validateImport('apps/web/src/main.ts', '@project311/protocol')).not.toThrow()
  })
})
