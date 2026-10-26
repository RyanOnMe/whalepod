/** #430/#440: 独立重判真实装配下的审阅、冻结输入、版本发布与人工复核证据。 */
export function verifyDeliveryReviewEvidence(value: unknown): {
  ok: boolean
  failures: string[]
  checks: number
} {
  const failures: string[] = []
  let checks = 0
  const check = (ok: boolean, name: string) => {
    checks++
    if (!ok) failures.push(`reviewLoop: ${name}`)
  }
  const obj = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const root = obj(value)
  const round = obj(root['round'])
  const context = typeof root['runtimeContext'] === 'string' ? root['runtimeContext'] : ''
  const basis = obj(root['basis'])
  const sourceCopy = obj(root['sourceCopy'])
  const agreement = obj(basis['agreement'])
  const revision = obj(agreement['revision'])
  const roundComments = Array.isArray(round['comments']) ? round['comments'] : []
  const resolutions = Array.isArray(round['resolutions']) ? round['resolutions'] : []
  for (const key of [
    'sourceArtifactId',
    'sourceRunId',
    'sourceSha256',
    'commentId',
    'comment',
    'direction',
    'lateComment',
    'revisionRunId',
    'output',
    'candidateId',
    'candidateSha256',
  ])
    check(typeof root[key] === 'string' && root[key] !== '', `${key} missing`)
  for (const key of ['sourceSha256', 'candidateSha256'])
    check(
      typeof root[key] === 'string' && /^[a-f0-9]{64}$/.test(root[key] as string),
      `${key} invalid`,
    )
  check(root['revisionRunId'] !== root['sourceRunId'], 'revision must use a new Run')
  check(
    root['candidateId'] !== root['sourceArtifactId'],
    'revision must publish a distinct artifact',
  )
  check(root['candidateSha256'] !== root['sourceSha256'], 'original and new output must differ')
  for (const key of ['sourceArtifactId', 'sourceSha256', 'commentId', 'comment', 'direction'])
    check(
      typeof root[key] === 'string' && context.includes(root[key] as string),
      `Runtime context missing ${key}`,
    )
  check(
    typeof root['lateComment'] === 'string' && !context.includes(root['lateComment']),
    'Runtime context contains late feedback',
  )
  check(
    obj(round['sourceArtifact'])['artifactId'] === root['sourceArtifactId'],
    'round original mismatch',
  )
  const roundSource = obj(round['sourceArtifact'])
  check(roundSource['sha256'] === root['sourceSha256'], 'round original digest mismatch')
  check(
    sourceCopy['artifactId'] === root['sourceArtifactId'] &&
      sourceCopy['sha256'] === root['sourceSha256'] &&
      sourceCopy['fileSha256'] === root['sourceSha256'] &&
      typeof sourceCopy['byteSize'] === 'number' &&
      sourceCopy['byteSize'] === roundSource['byteSize'],
    'original file did not reach execution with matching bytes',
  )

  check(round['runId'] === root['revisionRunId'], 'round Run mismatch')
  check(
    obj(round['candidate'])['artifactId'] === root['candidateId'] &&
      typeof obj(round['candidate'])['publishedAt'] === 'string',
    'published round candidate missing',
  )
  for (const [label, list] of [['round', roundComments]] as const) {
    check(
      list.length === 1 &&
        obj(list[0])['commentId'] === root['commentId'] &&
        obj(list[0])['body'] === root['comment'],
      `${label} must contain exactly the selected comment`,
    )
    check(
      !JSON.stringify(list).includes(String(root['lateComment'])),
      `${label} contains late feedback`,
    )
  }
  check(round['direction'] === root['direction'], 'frozen direction mismatch')
  check(
    typeof root['output'] === 'string' &&
      typeof root['comment'] === 'string' &&
      root['output'].includes(root['comment']),
    'Runtime did not consume selected feedback',
  )
  check(
    typeof root['output'] === 'string' &&
      typeof root['direction'] === 'string' &&
      root['output'].includes(root['direction']),
    'Runtime did not consume direction',
  )
  check(
    root['privateContentStatus'] === 404 && root['hiddenCandidate'] === null,
    'unpublished candidate leaks to member',
  )
  check(root['publishedContentStatus'] === 200, 'published candidate unavailable')
  check(
    Array.isArray(root['beforeHumanResolutions']) && root['beforeHumanResolutions'].length === 0,
    'Agent or publisher must not auto-resolve feedback',
  )
  check(
    resolutions.length === 1 &&
      obj(resolutions[0])['commentId'] === root['commentId'] &&
      obj(resolutions[0])['status'] === 'resolved' &&
      typeof root['reviewerUserId'] === 'string' &&
      obj(resolutions[0])['resolvedBy'] === root['reviewerUserId'],
    'human resolution missing',
  )
  check(
    basis['artifactId'] === root['sourceArtifactId'] &&
      obj(basis['sourceRun'])['id'] === root['sourceRunId'],
    'basis source mismatch',
  )
  check(
    agreement['status'] === 'bound' && revision['revisionNumber'] === 1,
    'basis must show bound historical agreement',
  )
  return { ok: failures.length === 0, failures, checks }
}
