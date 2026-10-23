import { readFileSync } from 'node:fs'
import { verifyAppUiEvidence } from './lib/app-ui-evidence.js'

const path = process.argv[2]
if (!path) throw new Error('Usage: verify-app-ui-evidence.mts <workspace-facts.json>')
const result = verifyAppUiEvidence(JSON.parse(readFileSync(path, 'utf8')))
process.stdout.write(
  `${JSON.stringify({ component: 'web.app-ui.verifier', ok: true, ...result })}\n`,
)
