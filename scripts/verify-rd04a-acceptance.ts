#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fingerprintProductionAssembly, isSha256 } from './lib/acceptance-provenance.js'

type EffectCounts = {
  tasks: number
  works: number
  specs: number
  questions: number
  intents: number
  runs: number
}

export interface Rd04aEvidence {
  schemaVersion: 1
  campaign?: 'pilot-fences'
  generatedAt: string
  assemblyDigest: string
  modelQuality: 'not_run'
  fast: {
    sourceId: string
    workKey: string
    subscriptionId: string
    admissions: {
      sourceId: string
      inboxItemId: string | null
      outcome: string
      reason: string
      routerInvoked: boolean
    }[]
    inbox: { id: string; sourceId: string; workKey: string; subscriptionId: string | null }[]
    routerCalls: number
  }
  shadow: {
    sourceId: string
    replayId: string
    offSourceId: string
    routes: { sourceId: string; route: string; reason: string; evaluationId: string | null }[]
    providerCalls: { aliases: string[]; sourceMatched: boolean; heldTools: number }[]
    evaluations: {
      id: string
      purpose: string
      status: string
      workKey: string | null
      inferenceEntryId: string | null
      downloadedIds: string[]
      readEntryIds: string[]
      manifestIds: string[]
    }[]
    candidate: { id: string; evaluationId: string; sourceId: string; classification: string }
    ledger: {
      evaluationId: string
      workKey: string | null
      phase: string
      chargeMode: string | null
      attempt: number
    }[]
  }
  visibility: {
    publicHttp: number
    ownerHttp: number
    ownerCache: string | null
    colleagueHttp: number
    revokedOwnerHttp: number
    candidateRowsAfterRevoke: number
    nodeAttemptDirGone: boolean
    outputCanaryOnAuthorizedRead: boolean
    surfaces: {
      name: 'ws_live' | 'ws_replay' | 'team_event' | 'log' | 'http'
      observations: number
      leaks: number
    }[]
  }
  effects: { before: EffectCounts; after: EffectCounts }
}

export function verifyRd04a(evidence: Rd04aEvidence, expectedAssemblyDigest?: string): void {
  assert.equal(evidence.schemaVersion, 1, 'unknown evidence schema')
  assert(
    evidence.campaign === undefined || evidence.campaign === 'pilot-fences',
    'unknown engineering campaign',
  )
  assert(Number.isFinite(Date.parse(evidence.generatedAt)), 'missing evidence timestamp')
  assert(isSha256(evidence.assemblyDigest), 'missing production assembly fingerprint')
  if (expectedAssemblyDigest !== undefined) {
    assert.equal(
      evidence.assemblyDigest,
      expectedAssemblyDigest,
      'evidence is from another assembly',
    )
  }
  assert.equal(evidence.modelQuality, 'not_run', 'replay cannot attest real model quality')
  const { fast, shadow, visibility, effects } = evidence
  assert(fast.workKey && fast.subscriptionId, 'missing existing work binding')
  assert.notEqual(fast.sourceId, shadow.sourceId, 'fast and discovery inputs must be distinct')
  assert.equal(fast.admissions.length, 1, 'fast comment must have one admission')
  assert.equal(fast.inbox.length, 1, 'fast comment must have one inbox item')
  assert.equal(fast.routerCalls, 0, 'fast comment invoked Router')
  const [admission] = fast.admissions
  const [item] = fast.inbox
  assert(admission && item)
  assert.equal(admission.sourceId, fast.sourceId)
  assert.equal(item.sourceId, fast.sourceId)
  assert.equal(admission.inboxItemId, item.id)
  assert.equal(item.workKey, fast.workKey)
  assert.equal(item.subscriptionId, fast.subscriptionId)
  assert.equal(admission.outcome, 'deliver')
  assert.equal(admission.reason, 'subscription_match')
  assert.equal(admission.routerInvoked, false)

  assert.equal(shadow.replayId, shadow.sourceId, 'idempotent comment created a second source')
  assert.notEqual(shadow.offSourceId, shadow.sourceId, 'off control must be a separate source')
  assert.equal(shadow.routes.length, 3, 'missing unique route for one of the three comments')
  assert.equal(new Set(shadow.routes.map((row) => row.sourceId)).size, 3, 'comment admitted twice')
  assert.equal(shadow.evaluations.length, 1, 'shadow path must have one evaluation in total')
  assert.equal(
    shadow.providerCalls.length,
    1,
    'one eligible comment must cause one provider request',
  )
  const [evaluation] = shadow.evaluations
  const [provider] = shadow.providerCalls
  assert(evaluation && provider)
  assert.equal(evaluation.purpose, 'discovery')
  assert.equal(evaluation.status, 'completed')
  const fastRoute = shadow.routes.find((row) => row.sourceId === fast.sourceId)
  const discoveryRoute = shadow.routes.find((row) => row.sourceId === shadow.sourceId)
  const revokedRoute = shadow.routes.find((row) => row.sourceId === shadow.offSourceId)
  assert.equal(fastRoute?.route, 'existing_work')
  assert.equal(fastRoute?.evaluationId, null)
  assert.equal(discoveryRoute?.route, 'discovery')
  assert.equal(discoveryRoute?.evaluationId, evaluation.id, 'admission and evaluation do not match')
  assert.equal(revokedRoute?.route, 'rejected')
  assert.equal(revokedRoute?.reason, 'permit_required')
  assert.equal(revokedRoute?.evaluationId, null)
  assert.equal(evaluation.workKey, null, 'discovery must not bind a work or synthetic work key')
  assert.equal(evaluation.inferenceEntryId, null, 'discovery must not create a project inference')
  assert(evaluation.manifestIds.length >= 3, 'incomplete manifest: source, slot, evidence')
  assert.equal(new Set(evaluation.manifestIds).size, evaluation.manifestIds.length)
  assert.deepEqual(
    [...evaluation.downloadedIds].sort(),
    [...evaluation.manifestIds].sort(),
    'missing/extra authenticated HTTP downloads',
  )
  assert.deepEqual(
    [...evaluation.readEntryIds].sort(),
    [...evaluation.manifestIds].sort(),
    'missing/extra read receipts',
  )
  assert.equal(provider.sourceMatched, true, 'provider did not receive exact triggering source')
  assert.equal(provider.heldTools, 0, 'discovery exposes tools to the model')
  assert(
    provider.aliases.some((id) => /^S[1-9]\d*$/.test(id)),
    'model prompt missed source alias',
  )
  assert(
    provider.aliases.some((id) => /^[AE][1-9]\d*$/.test(id)),
    'model prompt missed corroborating evidence',
  )
  assert.equal(shadow.candidate.evaluationId, evaluation.id)
  assert.equal(
    shadow.candidate.sourceId,
    shadow.sourceId,
    'candidate cites the wrong triggering source',
  )
  assert.equal(shadow.candidate.classification, 'independent_gap')
  assert(shadow.candidate.id, 'no candidate id on the authorized read')

  assert.equal(shadow.ledger.length, 2, 'expected one reserve/settle pair')
  assert.deepEqual(shadow.ledger.map((row) => row.phase).sort(), ['reserved', 'settled'])
  for (const row of shadow.ledger) {
    assert.equal(row.evaluationId, evaluation.id)
    assert.equal(row.attempt, 1)
    assert.equal(row.workKey, null, 'discovery charge leaked into a Work budget')
    assert.equal(row.chargeMode, row.phase === 'settled' ? 'actual' : null)
  }

  assert.equal(
    visibility.publicHttp,
    200,
    'colleague must be logged in and have public project access',
  )
  assert.equal(visibility.ownerHttp, 200)
  const cache = visibility.ownerCache?.split(',').map((value) => value.trim()) ?? []
  assert(
    cache.includes('private') && cache.includes('no-store'),
    'authorized candidate read can be cached',
  )
  assert.equal(visibility.colleagueHttp, 404, 'another member could read the candidate')
  assert.equal(visibility.revokedOwnerHttp, 404)
  assert.equal(visibility.candidateRowsAfterRevoke, 0, 'revocation left a stored candidate body')
  assert.equal(visibility.nodeAttemptDirGone, true, 'Node retained the discovery attempt directory')
  assert.equal(
    visibility.outputCanaryOnAuthorizedRead,
    true,
    'positive control did not expose candidate text',
  )
  assert.deepEqual(visibility.surfaces.map((surface) => surface.name).sort(), [
    'http',
    'log',
    'team_event',
    'ws_live',
    'ws_replay',
  ])
  for (const surface of visibility.surfaces) {
    assert(
      Number.isInteger(surface.observations) && surface.observations > 0,
      `no observations for ${surface.name}`,
    )
    assert.equal(surface.leaks, 0, `private candidate leaked to ${surface.name}`)
  }
  const effectsKeys: (keyof EffectCounts)[] = [
    'tasks',
    'works',
    'specs',
    'questions',
    'intents',
    'runs',
  ]
  for (const key of effectsKeys) {
    assert(
      Number.isInteger(effects.before[key]) && effects.before[key] >= 0,
      `missing baseline for ${key}`,
    )
    assert.equal(
      effects.after[key],
      effects.before[key],
      `shadow path produced a business write: ${key}`,
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2] ?? 'artifacts/evidence/rd04a/result.json'
  const currentAssembly = await fingerprintProductionAssembly(resolve(import.meta.dirname, '..'))
  verifyRd04a(JSON.parse(await readFile(path, 'utf8')) as Rd04aEvidence, currentAssembly)
  console.log('RD-04a production replay: PASS (real model quality not_run)')
}
