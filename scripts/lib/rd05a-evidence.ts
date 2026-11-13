/** RD-05a is one fresh campaign, not a wrapper around earlier acceptance reports.
 * These are data contracts only: the producer and independent judge share no verdict code.
 */
export interface Rd05aBinding {
  commit: string
  harnessDigest: string
  assemblyDigest: string
}

export interface Rd05aSource {
  kind: 'task_message' | 'artifact'
  sourceId: string
  sourceVersion: string
  sourceDigest: string
  authorizationGeneration: string
}

export interface Rd05aEntry extends Omit<Rd05aSource, 'kind'> {
  inboxItemId: string
  sourceType: string
  bodyDigest: string
}

export interface Rd05aRun {
  role: 'bootstrap' | 'continuation' | 'discovery'
  id: string
  projectId: string
  taskId: string
  status: string
  origin: string
  workKey: string
  dshSessionId: string | null
  dispatchIntentId: string
  mandateId: string
  specRevisionId: string
  manifestDigest: string
  itemIds: string[]
  startedAt: string
  finishedAt: string
}

export interface Rd05aReceipt {
  id: string
  runId: string
  manifestDigest: string
  receiptSeq: number
  digestVerified: boolean
  entriesDelivered: string[]
  entriesRead: string[]
  readEvents: { inboxItemId: string; at: string; digestVerified: boolean }[]
  missing: string[]
}

export interface Rd05aToolRead {
  runId: string
  callId: string
  inboxItemId: string
  bodyDigest: string
}

export interface Rd05aToolError {
  callId: string
  toolName: string
  role: string
  resultDigest: string
}

export interface Rd05aDraft {
  id: string
  runId: string
  ownerUserId: string
  status: string
  sha256: string
  ownerDownloadDigest: string
  ownerHttp: number
  memberHttp: number
  cacheControl: string | null
  publishHttp: number | null
}

export interface Rd05aSurface {
  surface: 'http' | 'ws_live' | 'ws_replay'
  observed: number
  draftLeaks: number
  toolErrorLeaks: number
}

/** Each checkpoint is also captured as a campaign.stage event with identical facts.
 * Only positive stages have three Runs; the final, isolated negative adds a fourth.
 */
export interface Rd05aStage {
  stage: 'fast_stable' | 'discovery_created' | 'slow_complete' | 'revoke_before_read_complete'
  at: string
  taskCount: number
  runIds: string[]
}

export interface Rd05aStability {
  startedAt: string
  finishedAt: string
  observedMs: number
  before: { taskIds: string[]; runIds: string[]; evaluationIds: string[] }
  after: { taskIds: string[]; runIds: string[]; evaluationIds: string[] }
}

export interface Rd05aUsage {
  inputTokens: number
  outputTokens: number
  costMicros: number
}

export interface Rd05aAccounting {
  handoff: {
    runId: string
    draftId: string
    taskId: string
    specRevisionId: string
    status: string
    origin: string
    requests: number
    inputTokens: number
    outputTokens: number
    metering: 'loopback_unmetered'
    published: boolean
  }[]
  localEvaluations: {
    id: string
    projectId: string
    purpose: 'inference'
    status: string
    modelStarted: false
  }[]
  coordination: {
    id: string
    evaluationId: string
    purpose: string
    attempt: number
    phase: string
    projectId: string
    workKey: string | null
    reservedTokens: number
    reservedCostMicros: number
    chargeMode: string | null
    usage: (Rd05aUsage & { provider: string; model: string }) | null
  }[]
  executor: {
    id: string
    runId: string
    phase: string
    projectId: string
    workKey: string
    mandateId: string
    reservedTokens: number
    reservedCostMicros: number
    chargeMode: string | null
    usage: Rd05aUsage | null
  }[]
  replay: {
    runId: string
    mode: 'ordinary_ledger' | 'loopback_unmetered'
    requests: number
    liveDispatchRows: number
    liveAttemptRows: number
  }[]
}

export interface Rd05aHumanAction {
  action:
    | 'setup'
    | 'bootstrap'
    | 'publication'
    | 'catalogVerification'
    | 'executionAuthorization'
    | 'correction'
    | 'run'
    | 'evaluate'
    | 'followup'
    | 'dispatch'
  subjectId: string
}

export interface Rd05aEvidence {
  schemaVersion: 1
  mode: 'rd05a_loopback_combined'
  campaignId: string
  generatedAt: string
  projectId: string
  members: { ownerId: string; memberId: string; count: number }
  assembly: {
    hub: 'production-package-bin'
    node: 'production-package-replay-assembly'
    runtime: 'production-dsh-package-bin'
    database: 'postgresql'
    model: 'loopback-http-replay'
  }
  modelQuality: 'not_run'
  humanEfficiency: 'not_run'
  invoice: 'not_run'
  paidRequests: number
  provenance: Rd05aBinding & { eventsDigest: string }
  runs: Rd05aRun[]
  stages: Rd05aStage[]
  stability: Rd05aStability
  accounting: Rd05aAccounting
  humanActions: {
    setup: Rd05aHumanAction[]
    positive: Rd05aHumanAction[]
    corrections: Rd05aHumanAction[]
    negative: Rd05aHumanAction[]
  }
  fast: {
    taskId: string
    discussionTaskId: string
    workKey: string
    mandateId: string
    subscriptionId: string
    bootstrapIntentId: string
    firstSnapshot: string
    bootstrapSource: Rd05aSource
    statusBeforeBoundary: string
    supplement: {
      source: Rd05aSource
      authorId: string
      itemId: string
      replayedMessageId: string
      admissionCount: number
      outcome: string
      reason: string
      subscriptionId: string
      admissionItemId: string
      admissionSubscriptionId: string
      status: string
      routerInvoked: boolean
      routerCalls: number
      routerRows: number
      runCount: number
    }
    inbox: { id: string; sourceId: string; status: string; bodyDigest: string }[]
    receipts: Rd05aReceipt[]
    consumptions: {
      receiptId: string
      runId: string
      inboxItemId: string
      kind: string
      manifestDigest: string
      readAt: string
    }[]
    intents: {
      id: string
      runId: string
      status: string
      approvalBasis: string
      mandateId: string
    }[]
    boundaries: { runId: string; evaluationId: string; triggerKey: string; status: string }[]
    evaluations: {
      id: string
      status: string
      decision: string
      coverage: { inputId: string; status: string; evidenceIds: string[] }[]
      readEntryIds: string[]
      entries: { id: string; kind: string; sourceId: string; digest: string }[]
    }[]
    applications: {
      evaluationId: string
      decision: string
      status: string
      runId: string | null
      intentId: string | null
      waitId: string | null
    }[]
    wait: { id: string; evaluationId: string; status: string }
    replay: {
      routerCalls: { decision: string; sources: number; evidence: number }[]
      toolReads: Rd05aToolRead[]
    }
    publicArtifact: {
      id: string
      runId: string
      ownerUserId: string
      sha256: string
      status: string
      memberHttp: number
      publishedAt: string
    }
    draft: Rd05aDraft
  }
  slow: {
    taskId: string
    specRevisionId: string
    applicationId: string
    evaluationId: string
    source: Rd05aSource
    sourceAuthorId: string
    createdTaskIds: string[]
    beforeAuthorizationRuns: number
    wrongAccountHttp: number
    nonownerHttp: number
    authorization: {
      id: string
      ownerUserId: string
      status: string
      purpose: string
      sourceManifestDigest: string
      sources: Rd05aSource[]
      executor: {
        provider: string
        model: string
        endpoint: string
        account: string
        policyGeneration: number
      }
      executorDigest: string
      liveOnlyGrantCount: number
    }
    repeatExecutionId: string
    concurrentExecutionId: string
    targetRunCount: number
    executionId: string
    approvalPolicy: string
    entries: Rd05aEntry[]
    receipts: Rd05aReceipt[]
    replay: {
      discoveryRequests: number
      privateRequests: number
      toolReads: Rd05aToolRead[]
      toolErrors: Rd05aToolError[]
      draftDigest: string
    }
    draft: Rd05aDraft
    publicArtifactMemberHttp: number
    visibility: Rd05aSurface[]
    privateDirectoriesObserved: number
    workspaceClean: boolean
    revocation: {
      executionId: string
      status: string
      ownerHttp: number
      ownerRoomHasRevokedTitle: boolean
    }
  }
  /** Fresh slot/comment after the positive campaign has closed, on the same assembly.
   * Its Run, task and authorization are deliberately outside the three positive roles.
   */
  revokeBeforeRead: {
    projectId: string
    taskId: string
    workKey: string
    evaluationId: string
    sourceId: string
    executionId: string
    authorizedExecutionId: string
    sourceManifestDigest: string
    sources: Rd05aSource[]
    manifestDigest: string
    entries: Rd05aEntry[]
    runId: string
    delivery: number
    correctionHttp: number
    runStatus: string
    executionStatus: string
    privateRequests: number
    toolResults: number
    drafts: number
    reads: number
    receipts: Rd05aReceipt[]
    privateDirectoriesObserved: number
    workspaceClean: boolean
  }
}

/** Receipt events retain the captured Hub fields rather than a derived success flag.
 * Other variants bind stages, actual model tool messages and persisted Run lifecycle.
 */
export type Rd05aEvent =
  | ({ component: 'hub.work_input'; type: 'work_input.receipt' } & Rd05aReceipt)
  | ({ component: 'acceptance.campaign'; type: 'campaign.stage'; campaignId: string } & Rd05aStage)
  | ({
      component: 'acceptance.snapshot'
      type: 'campaign.stability'
      campaignId: string
    } & Rd05aStability)
  | ({ component: 'acceptance.replay'; type: 'tool_read.observed' } & Rd05aToolRead)
  | ({
      component: 'acceptance.replay'
      type: 'tool_error.observed'
      runId: string
    } & Rd05aToolError)
  | {
      component: 'hub.run'
      type: 'runtime.ready' | 'run.completed' | 'run.failed' | 'run.cancelled'
      runId: string
      audience: 'owner' | 'project'
    }
  | {
      component: 'acceptance.snapshot'
      type: 'run.status'
      runId: string
      status: string
      projectId: string
      taskId: string
      workKey: string
      executionId: string | null
    }
