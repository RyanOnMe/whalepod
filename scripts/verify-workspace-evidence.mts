import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'
import { verifyAppUiEvidence } from './lib/app-ui-evidence.js'
import { verifyWorkbenchEvidence } from './lib/workbench-evidence.js'

const directory = process.argv[2]
assert(directory, 'Usage: tsx scripts/verify-workspace-evidence.mts <evidence-directory>')
const result = JSON.parse(await readFile(join(directory, 'facts.json'), 'utf8'))
assert.equal(result.ok, true)
assert.deepEqual(result.browserErrors, [])
assert.equal(result.facts?.length, 8)
verifyAppUiEvidence(result)
verifyWorkbenchEvidence(result)
for (const width of [1440, 390, 320]) {
  for (const kind of ['empty', 'search', 'search-empty', 'results', 'drawer', 'run'])
    assert((await stat(join(directory, `workbench-${kind}-${width}.png`))).size > 0)
}
for (const width of [1440, 390, 320]) {
  for (const kind of ['approval', 'files', 'send-focus']) {
    assert((await stat(join(directory, `app-ui-${kind}-${width}.png`))).size > 0)
  }
}
const fact = (component: string) => {
  const rows = result.facts.filter((row: { component: string }) => row.component === component)
  assert.equal(rows.length, 1, `missing or repeated ${component}`)
  return rows[0]
}
const micro = fact('web.micro')
assert.equal(micro.keyboardSelect, true)
assert.equal(micro.reducedMotion, true)
assert.equal(micro.oneInstruction, true)
assert.equal(micro.settingsLabelsVisible, true)
assert.equal(micro.conciseDefault?.oneSettings, true)
assert.equal(micro.conciseDefault?.noEmptyApproval, true)
assert(
  Number.isFinite(micro.conciseDefault?.headerHeight) &&
    micro.conciseDefault.headerHeight > 0 &&
    micro.conciseDefault.headerHeight <= 80,
)
assert(
  Number.isFinite(micro.conciseDefault?.composerTextLength) &&
    micro.conciseDefault.composerTextLength <= 60,
)

assert.deepEqual(
  micro.layouts.map((row: { width: number }) => row.width),
  [1440, 390, 320],
)
for (const row of micro.layouts) {
  assert.equal(row.portal, true)
  assert.equal(row.settingsKeyboard, true)
  assert.equal(row.composerHeightStable, true)
  for (const key of ['x', 'y', 'width', 'height']) assert(Number.isFinite(row.settings?.[key]))
  assert(
    row.settings.x >= 0 && row.settings.y >= 0 && row.settings.width > 0 && row.settings.height > 0,
  )
  assert(row.settings.x + row.settings.width <= row.width)
  assert(row.settings.y + row.settings.height <= 960)
  for (const key of ['x', 'y', 'width', 'height']) assert(Number.isFinite(row.menu[key]))
  assert(row.menu.x >= 0 && row.menu.y >= 0 && row.menu.width > 0 && row.menu.height > 0)
  assert(row.menu.x + row.menu.width <= row.width && row.menu.y + row.menu.height <= 960)
  assert((await stat(join(directory, `micro-menu-${row.width}.png`))).size > 0)
}
const discussion = fact('web.workspace')
assert.equal(discussion.draftRetained, true)
assert.equal(discussion.separateChannel, true)
const approval = fact('web.approval')
assert.equal(approval.ownerCanApprove, true)
assert.equal(approval.memberWaits, true)
assert.equal(approval.candidatePrivate, true)
const artifact = fact('web.artifact')
assert.equal(artifact.runId, approval.runId)
assert.match(artifact.runId, /^[0-9a-f-]{36}$/)
assert.equal(artifact.previewFailureVisible, true)
assert.equal(artifact.previewRetried, true)
assert.equal(artifact.publishedShared, true)
assert.equal(artifact.taskStatus, 'in_progress')
const layout = fact('web.layout')
assert.equal(layout.closeRestoresFocus, true)
assert.equal(layout.agreementReachable, true)
assert.deepEqual(
  layout.dimensions.map((row: { width: number }) => row.width),
  [1440, 1024, 736, 390, 320],
)
for (const row of layout.dimensions) {
  assert.equal(row.width, row.viewport)
  assert(Number.isFinite(row.scroll) && row.scroll > 0 && row.scroll <= row.viewport)
  assert((await stat(join(directory, `artifact-${row.width}.png`))).size > 0)
}
for (const image of [
  'desktop-ready.png',
  'desktop-settings.png',
  'desktop-approval.png',
  'desktop-artifact.png',
  'mobile-conversation.png',
]) {
  assert((await stat(join(directory, image))).size > 0)
}

const surfaces = fact('web.surfaces')
for (const key of [
  'agreementHeadingUnique',
  'draftPreserved',
  'memberReadOnly',
  'fullAccessCancelled',
  'closeRestoresFocus',
])
  assert.equal(surfaces[key], true)
assert.equal(surfaces.rows?.length, 30)
for (const name of [
  'agreement',
  'artifacts',
  'run',
  'console',
  'projects',
  'permissions',
  'devices',
  'agents',
  'members',
  'plugins',
]) {
  const rows = surfaces.rows.filter((row: { name: string }) => row.name === name)
  assert.deepEqual(
    rows.map((row: { width: number }) => row.width),
    [1440, 390, 320],
  )
  for (const row of rows) {
    assert.equal(row.headerCount, 1)
    // 标题叠放：Console 是弹在开着的运行详情抽屉之上的模态（ADR-0019 把入口挪进详情），
    // 所以它那一档恰好两层；其余每一档都只有一层。少于/多于都不许悄悄放过。
    assert(
      Number.isInteger(row.stackedHeaderCount) &&
        row.stackedHeaderCount >= 1 &&
        row.stackedHeaderCount <= 2,
      `${name}/${row.width}: stackedHeaderCount 必须是 1 或 2`,
    )
    assert.equal(
      row.stackedHeaderCount,
      name === 'console' ? 2 : 1,
      `${name}/${row.width} 叠放层数`,
    )
    assert.equal(row.viewport, row.width)
    assert(Number.isFinite(row.scroll) && row.scroll > 0 && row.scroll <= row.viewport)
    assert((await stat(join(directory, `surface-${name}-${row.width}.png`))).size > 0)
  }
}
assert.deepEqual(
  surfaces.confirmations?.map((row: { width: number }) => row.width),
  [1440, 390, 320],
)
for (const row of surfaces.confirmations) {
  assert.equal(row.contained, true)
  assert((await stat(join(directory, `surface-permission-confirm-${row.width}.png`))).size > 0)
}
for (const name of ['agent-create', 'device-guide'])
  assert((await stat(join(directory, `surface-${name}.png`))).size > 0)
console.log(JSON.stringify({ component: 'web.workspace.verify', ok: true, scenarios: 8 }))
