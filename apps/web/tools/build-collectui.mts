/** P1-421: production asset compiler, not a test/harness assembly entry. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const input = join(root, 'artifacts/private-ui/collectui')
const output = join(root, 'apps/web/src/vendor/collectui')
const webRequire = createRequire(join(root, 'apps/web/package.json'))
const viteRequire = createRequire(webRequire.resolve('vite/package.json'))
// Reuse Vite's pinned compiler; no application dependency added.
const compiler = viteRequire('esbuild') as {
  version: string
  buildSync(options: Record<string, unknown>): {
    outputFiles: Array<{ path: string; contents: Uint8Array }>
    warnings: unknown[]
  }
}
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const excerpts = JSON.parse(readFileSync(join(input, 'upstream-excerpts.json'), 'utf8')) as Array<{
  item: string
  url: string
  excerpt: string
  adaptation: string
  normalizedFragmentSha256?: string
}>
const agentCore = readFileSync(join(input, 'agent-core.tsx'), 'utf8')
const agentFragment = agentCore.split('const fragmentShader = `')[1]?.split('`')[0]
const originalFragment = excerpts.find(
  (source) => source.item === 'ai-blob',
)?.normalizedFragmentSha256
if (!agentFragment || sha256(agentFragment.replace(/\s+/g, '')) !== originalFragment)
  throw new Error('AI Blob fragment field differs from the captured mirror source')
const built = compiler.buildSync({
  entryPoints: [join(input, 'presentation.tsx')],
  outfile: join(output, 'collectui.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  banner: {
    js: '/*! Copyright (c) 2026 React Bits Pro. Restricted compiled adaptation; see LICENSE.md. */',
    css: '/*! Copyright (c) 2026 React Bits Pro. Restricted compiled adaptation; see LICENSE.md. */',
  },
  write: false,
})
if (built.warnings.length > 0)
  throw new Error('Fix compiler warnings before distributing the bundle')
mkdirSync(output, { recursive: true })
const files = built.outputFiles.map((file) => {
  const name = basename(file.path)
  if (!['collectui.js', 'collectui.css'].includes(name))
    throw new Error('Unexpected compiler output')
  writeFileSync(join(output, name), file.contents)
  return { name, sha256: sha256(file.contents), bytes: file.contents.byteLength }
})
const manifest = {
  format: 1,
  license: 'LicenseRef-CollectUI-Restricted',
  licenseUrl: 'https://bits.collectui.pro/license',
  distribution: 'Compiled app-internal presentation; editable sources and source maps excluded',
  compiler: { name: 'esbuild', version: compiler.version, minify: true, sourceMap: false },
  exports: [
    'ActivityFrame',
    'ApprovalFrame',
    'CommandFrame',
    'EmptyPanel',
    'FileCard',
    'PromptFrame',
    'SheetHeading',
    'SidebarProfile',
    'ToolCallFrame',
    'ResourceCard',
    'TaskRow',
    'DiscussionMessage',
    'DiscussionComposer',
    'SettingsSection',
    'InboxFrame',
    'InboxRow',
    'EnterItem',
    'ExpandPanel',
    'AdminPanel',
    'MemberIdentity',
    'IntegrationTile',
    'ChoiceCard',
    'AdminDetailHeading',
    'DeviceIdentity',
    'TimelineFold',
    'ArtifactPreviewFrame',
    'PairingSteps',
    'ToolOutputFrame',
    'FileCollectionMark',
    'DepthSurface',
    'AgentStateCore',
  ],
  sources: excerpts.map(({ excerpt, ...metadata }) => ({
    ...metadata,
    capturedExcerptSha256: sha256(excerpt),
  })),
  privateInputSha256: {
    tsx: sha256(readFileSync(join(input, 'presentation.tsx'))),
    css: sha256(readFileSync(join(input, 'presentation.css'))),
    agentCore: sha256(readFileSync(join(input, 'agent-core.tsx'))),
  },
  files,
}
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(
  `Compiled ${manifest.exports.length} presentation slots; ${files.length} assets, no source maps.\n`,
)
