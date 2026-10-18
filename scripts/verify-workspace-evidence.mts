import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'

const directory = process.argv[2]
assert(directory, 'Usage: tsx scripts/verify-workspace-evidence.mts <evidence-directory>')
const result = JSON.parse(await readFile(join(directory, 'facts.json'), 'utf8'))
assert.equal(result.ok, true)
assert.deepEqual(result.browserErrors, [])
assert.equal(result.facts?.length, 5)
const fact = (component: string) => {
  const rows = result.facts.filter((row: { component: string }) => row.component === component)
  assert.equal(rows.length, 1, `missing or repeated ${component}`)
  return rows[0]
}
const micro = fact('web.micro')
assert.equal(micro.keyboardSelect, true)
assert.equal(micro.reducedMotion, true)
assert.equal(micro.oneInstruction, true)
assert.deepEqual(
  micro.layouts.map((row: { width: number }) => row.width),
  [1440, 390, 320],
)
for (const row of micro.layouts) {
  assert.equal(row.portal, true)
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
  'desktop-approval.png',
  'desktop-artifact.png',
  'mobile-conversation.png',
]) {
  assert((await stat(join(directory, image))).size > 0)
}
console.log(JSON.stringify({ component: 'web.workspace.verify', ok: true, scenarios: 5 }))
