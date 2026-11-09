import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  AnyCoordinationRequestSchema,
  RouterRuntimeInputSchema,
  RouterRuntimeOutputSchema,
  type AnyCoordinationRequest,
  type AnyCoordinationResult,
  type CoordinationUsage,
  type RouterRuntimeInitialize,
  type RouterRuntimeOutput,
} from '@whalepod/protocol'
import { probeCoordinationIsolation, spawnCoordinationWorker } from './coordination-isolation.js'
import {
  CoordinationModelFailure,
  requestCoordinationModel,
  validateCoordinationEndpoint,
  type CoordinationModelResponse,
} from './coordination-model.js'
import {
  coordinationResultDigest,
  evaluateCoordinationWorker,
  readCoordinationPrompt,
} from './coordination-worker.js'

export { probeCoordinationIsolation } from './coordination-isolation.js'
export { COORDINATION_MODEL_TOOLS } from './coordination-worker.js'

const MAX_LINE_BYTES = 1024 * 1024
const FAILURE_CODES = new Set([
  'isolation_unavailable',
  'invalid_provider_endpoint',
  'credential_unavailable',
  'input_digest_mismatch',
  'input_too_large',
  'unsupported_tool_call',
  'usage_missing',
  'incomplete_model_result',
  'output_too_large',
  'provider_request_failed',
  'invalid_model_result',
  'invalid_model_request',
  'invalid_citation',
  'invalid_coverage',
  'over_budget',
  'timeout',
  'cancelled',
])
function failureCode(error: unknown): string {
  return error instanceof Error && FAILURE_CODES.has(error.message)
    ? error.message
    : 'invalid_model_result'
}
function binding(request: AnyCoordinationRequest) {
  return {
    evaluationId: request.evaluationId,
    attempt: request.attempt,
    leaseToken: request.leaseToken,
  }
}
function purposeBinding(request: AnyCoordinationRequest) {
  return 'purpose' in request ? { ...binding(request), purpose: request.purpose } : binding(request)
}
function failed(
  request: AnyCoordinationRequest,
  code: string,
  readEntryIds: string[],
  usage?: CoordinationUsage,
): AnyCoordinationResult {
  return {
    ...purposeBinding(request),
    evaluationDigest: request.evaluationDigest,
    status: 'failed',
    failureCode: code,
    readEntryIds,
    ...(usage === undefined ? {} : { usage }),
  }
}
function costMicros(request: AnyCoordinationRequest, response: CoordinationModelResponse): number {
  const numerator =
    BigInt(response.inputTokens) * BigInt(request.inputPriceMicrosPerMillionTokens) +
    BigInt(response.outputTokens) * BigInt(request.outputPriceMicrosPerMillionTokens)
  const amount = (numerator + 999_999n) / 1_000_000n
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('over_budget')
  return Number(amount)
}
function parseLine(line: string): unknown {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('invalid_model_request')
  return JSON.parse(line)
}
function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid_model_request')
  return value as Record<string, unknown>
}

/** Private broker-worker wire never reaches Node/Hub and never contains a credential. */
export async function runCoordinationWorkerMode(
  input: NodeJS.ReadableStream,
  write: (value: unknown) => void,
): Promise<void> {
  const lines = createInterface({ input })
  const iterator = lines[Symbol.asyncIterator]()
  let request: AnyCoordinationRequest | undefined
  try {
    const first = await iterator.next()
    if (first.done) return
    const initialize = asObject(parseLine(first.value))
    if (
      Object.keys(initialize).some((key) => !['request', 'inputsDir'].includes(key)) ||
      typeof initialize['inputsDir'] !== 'string'
    )
      throw new Error('invalid_model_request')
    request = AnyCoordinationRequestSchema.parse(initialize['request'])
    const prompt = readCoordinationPrompt(request, initialize['inputsDir'])
    write({ type: 'worker.read', readEntryIds: prompt.readEntryIds })
    const proposal = await evaluateCoordinationWorker(request, prompt, async (system, user) => {
      write({
        type: 'worker.model_request',
        system,
        user,
        promptDigest: createHash('sha256').update(system).update(user).digest('hex'),
      })
      const incoming = await iterator.next()
      if (incoming.done) throw new Error('cancelled')
      const response = asObject(parseLine(incoming.value))
      if (response['type'] !== 'worker.model_response') throw new Error('invalid_model_result')
      const data = asObject(response['response'])
      if (
        typeof data['text'] !== 'string' ||
        typeof data['inputTokens'] !== 'number' ||
        typeof data['outputTokens'] !== 'number'
      )
        throw new Error('invalid_model_result')
      return {
        text: data['text'],
        inputTokens: data['inputTokens'],
        outputTokens: data['outputTokens'],
      }
    })
    write({ type: 'worker.result', proposal })
  } catch (error) {
    write({
      type: 'worker.failed',
      failureCode: failureCode(error),
      errorType: error instanceof Error ? error.name : 'unknown',
      errorCode:
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : undefined,
    })
  } finally {
    lines.close()
  }
}

function workerReadRoots(workerEntry: string, inputsDir: string): string[] {
  const require = createRequire(import.meta.url)
  const moduleFiles = [
    fileURLToPath(import.meta.url),
    require.resolve('@whalepod/protocol'),
    require.resolve('@deepseek-ai/dsh-llm'),
  ]
  const roots = new Set([dirname(dirname(workerEntry)), inputsDir, realpathSync(inputsDir)])
  for (const filename of moduleFiles) {
    const actual = realpathSync(filename)
    const marker = `${join('node_modules')}/`
    const index = actual.indexOf(marker)
    if (index >= 0) roots.add(actual.slice(0, index + 'node_modules'.length))
    roots.add(dirname(dirname(actual)))
  }
  return [...roots]
}

interface BrokerState {
  initialize: RouterRuntimeInitialize
  acknowledge(): void
  cancel(): void
  task: Promise<void>
}

export async function runCoordinationBroker(input: {
  stdin: NodeJS.ReadableStream
  workerEntry: string
  write: (output: RouterRuntimeOutput) => void
  environment?: NodeJS.ProcessEnv
}): Promise<void> {
  const lines = createInterface({ input: input.stdin })
  let state: BrokerState | undefined
  let completed = false
  const emit = (output: RouterRuntimeOutput) => input.write(RouterRuntimeOutputSchema.parse(output))
  try {
    for await (const line of lines) {
      const command = RouterRuntimeInputSchema.parse(parseLine(line))
      if (command.type === 'coordination.initialize') {
        if (state !== undefined) {
          state.cancel()
          continue
        }
        let acknowledge!: () => void
        const acknowledged = new Promise<void>((resolve) => {
          acknowledge = resolve
        })
        const controller = new AbortController()
        const task = evaluateBroker(
          command,
          input.workerEntry,
          input.environment ?? process.env,
          acknowledged,
          controller,
          emit,
        ).finally(() => {
          completed = true
          lines.close()
        })
        state = { initialize: command, acknowledge, cancel: () => controller.abort(), task }
        continue
      }
      const request = state?.initialize.request
      if (
        request === undefined ||
        command.payload.evaluationId !== request.evaluationId ||
        command.payload.attempt !== request.attempt ||
        command.payload.leaseToken !== request.leaseToken
      )
        continue
      if (command.type === 'coordination.model_start_ack') state?.acknowledge()
      else state?.cancel()
    }
  } finally {
    if (!completed) state?.cancel()
    await state?.task
    lines.close()
  }
}

async function evaluateBroker(
  initialize: RouterRuntimeInitialize,
  workerEntry: string,
  environment: NodeJS.ProcessEnv,
  acknowledged: Promise<void>,
  controller: AbortController,
  emit: (output: RouterRuntimeOutput) => void,
): Promise<void> {
  const request = initialize.request
  let readEntryIds: string[] = []
  let usage: CoordinationUsage | undefined
  let child: ReturnType<typeof spawnCoordinationWorker> | undefined
  let modelCalled = false
  let timedOut = false
  const remaining =
    Math.min(Date.parse(request.deadlineAt), Date.parse(request.leaseExpiresAt)) - Date.now()
  const timer = setTimeout(
    () => {
      timedOut = true
      controller.abort()
    },
    Math.max(1, remaining),
  )
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        child?.kill('SIGKILL')
        reject(new Error(timedOut ? 'timeout' : 'cancelled'))
      },
      { once: true },
    )
  })
  // The rejection is observed even if a synchronous validation fails before the race.
  void aborted.catch(() => {})
  try {
    if (remaining <= 0) throw new Error('timeout')
    validateCoordinationEndpoint(initialize.endpoint)
    const apiKey = environment['WHALEPOD_COORDINATION_API_KEY']
    if (apiKey === undefined || !/^[\x21-\x7e]+$/.test(apiKey))
      throw new Error('credential_unavailable')
    if (!isAbsolute(initialize.inputsDir) || !isAbsolute(initialize.homePath))
      throw new Error('input_digest_mismatch')
    if (!(await probeCoordinationIsolation())) throw new Error('isolation_unavailable')
    const args = [
      '--no-warnings',
      '--permission',
      ...workerReadRoots(workerEntry, initialize.inputsDir).map(
        (root) => `--allow-fs-read=${root}`,
      ),
      workerEntry,
    ]
    child = spawnCoordinationWorker(args, environment, initialize.homePath)
    const runningChild = child
    const workerLines = createInterface({ input: child.stdout })
    child.stderr.resume()
    const exited = new Promise<never>((_, reject) => {
      runningChild.once('error', () => reject(new Error('isolation_unavailable')))
      runningChild.once('close', () => reject(new Error('invalid_model_result')))
    })
    void exited.catch(() => {})
    child.stdin.write(`${JSON.stringify({ request, inputsDir: initialize.inputsDir })}\n`)
    const consume = async (): Promise<AnyCoordinationResult> => {
      for await (const line of workerLines) {
        const message = asObject(parseLine(line))
        if (message['type'] === 'worker.read') {
          if (readEntryIds.length > 0 || !Array.isArray(message['readEntryIds']))
            throw new Error('invalid_model_result')
          const actual = message['readEntryIds']
          const expected = request.manifest.map((entry) => entry.id)
          if (
            actual.length !== expected.length ||
            actual.some((id, index) => id !== expected[index])
          )
            throw new Error('invalid_model_result')
          readEntryIds = expected
          emit({
            type: 'coordination.heartbeat',
            payload: { ...purposeBinding(request), readEntryIds },
          })
        } else if (message['type'] === 'worker.model_request') {
          if (
            modelCalled ||
            readEntryIds.length !== request.manifest.length ||
            typeof message['system'] !== 'string' ||
            typeof message['user'] !== 'string'
          )
            throw new Error('invalid_model_request')
          modelCalled = true
          emit({
            type: 'coordination.heartbeat',
            payload: {
              ...purposeBinding(request),
              readEntryIds,
              modelStartedAt: new Date().toISOString(),
            },
          })
          await Promise.race([acknowledged, aborted])
          const response = await requestCoordinationModel({
            endpoint: initialize.endpoint,
            apiKey,
            model: request.model,
            maxOutputTokens: request.maxOutputTokens,
            system: message['system'],
            user: message['user'],
            signal: controller.signal,
          })
          usage = {
            provider: request.provider,
            model: request.model,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            costMicros: costMicros(request, response),
          }
          if (
            usage.inputTokens > request.maxInputTokens ||
            usage.inputTokens > request.inputTokensEstimate ||
            usage.outputTokens > request.maxOutputTokens ||
            usage.costMicros > request.maxCostMicros
          )
            throw new Error('over_budget')
          runningChild.stdin.write(
            `${JSON.stringify({ type: 'worker.model_response', response })}\n`,
          )
        } else if (message['type'] === 'worker.result') {
          if (!modelCalled || usage === undefined) throw new Error('invalid_model_result')
          const { validateCoordinationProposal, validateDiscoveryProposal } =
            await import('./coordination-worker.js')
          const base = {
            ...binding(request),
            evaluationDigest: request.evaluationDigest,
            status: 'completed' as const,
            readEntryIds,
            usage,
          }
          if ('purpose' in request) {
            const proposal = validateDiscoveryProposal(message['proposal'], request)
            return {
              ...base,
              purpose: request.purpose,
              proposal,
              resultDigest: coordinationResultDigest(proposal),
            }
          }
          const proposal = validateCoordinationProposal(message['proposal'], request)
          return { ...base, proposal, resultDigest: coordinationResultDigest(proposal) }
        } else if (message['type'] === 'worker.failed') {
          // Only classified diagnostics: Error.message may contain private input paths.
          const errorCode =
            typeof message['errorCode'] === 'string' && /^[A-Z_]{1,64}$/.test(message['errorCode'])
              ? message['errorCode']
              : undefined
          console.error(
            JSON.stringify({
              component: 'runtime.bridge.coordination',
              event: 'worker_failed',
              evaluationId: request.evaluationId,
              errorCode,
            }),
          )
          const code =
            typeof message['failureCode'] === 'string' && FAILURE_CODES.has(message['failureCode'])
              ? message['failureCode']
              : 'invalid_model_result'
          throw new Error(code)
        } else throw new Error('invalid_model_result')
      }
      throw new Error('invalid_model_result')
    }
    const result = await Promise.race([consume(), exited, aborted])
    emit({ type: 'coordination.result', payload: result })
    workerLines.close()
  } catch (error) {
    if (
      usage === undefined &&
      error instanceof CoordinationModelFailure &&
      error.usage !== undefined
    ) {
      const measured = { text: '', ...error.usage }
      usage = {
        provider: request.provider,
        model: request.model,
        ...error.usage,
        costMicros: costMicros(request, measured),
      }
    }
    emit({
      type: 'coordination.result',
      payload: failed(request, failureCode(error), readEntryIds, usage),
    })
  } finally {
    clearTimeout(timer)
    child?.stdin.end()
    child?.kill('SIGKILL')
  }
}
