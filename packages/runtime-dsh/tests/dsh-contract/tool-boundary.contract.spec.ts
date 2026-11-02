/**
 * PC-00 (#463) —— 协调计算的 rc.8 能力边界：工具禁用、输入引用、结构化结果。
 *
 * 上游复用分析（docs/agent/2026-11-01-superagent-reuse-analysis.md）把「受限
 * 协调计算只回传结构化判断」列为持续协调的前提。本探针用**真 boot 栈**
 * （dsh-base → whalepod bundle → replay，与生产同一路径）验证三件事：
 *
 * 1. 工具行禁用：patch 层 `disabled: true` 让该插件**不挂载**——模型调用得到
 *    unknown-tool 错误、命令不执行、Run 仍正常收尾；正控（同 fixture 不禁用）
 *    与旁路控（禁用无关行）都真实执行。三者同绿才把失败归因到该 patch 行，
 *    而不是 fixture 写错或「任何额外层都会弄坏工具」。
 *    只证明**被禁用的那一行**从模型面消失；协调专用装配还要逐项禁用
 *    workflow/fs/web 等行，那是后续切片（见验收文档的边界）。
 * 2. 输入引用：带清单时 `read_artifact_input` 按白名单读取，模型可见内容含
 *    结构化字段与正文，并且**该内容真的进入下一次模型请求**（回放脚本用
 *    `{{fromRequest:...}}` 引用只存在于投影里的正文；匹配不到即 fail loud）；
 *    路径形 id 被拒且消息不含绝对路径；无清单时工具根本不存在。
 * 3. 结构化结果：rc.8 的 canonical value 是 execution-local、不随 tool/result
 *    落库（dsh-tools README：「value … never replayed」）。这里直接断言
 *    tool/result 的 data 与 message 都没有 `value`；模型可见内容由
 *    `output.render` 投影决定——Hub 侧要解析的结构化判断必须走这一面。
 *
 * approval_required 下的顺序是 vendor native 路径的事实：未知工具仍会先经
 * `tools/pre-execute` 产生一次审批请求，批准后执行体才解析失败。所以本文件
 * 另有一条用例钉住「会打扰一次审批，但命令仍不执行」；不能把「零审批帧」
 * 写成禁用行的性质。
 *
 * #463 之前 `read_artifact_input` 的 render 只回 `artifact input: <id>`，
 * 正文与结构化字段都没进模型上下文（Reviewer 读不到材料）——本切片的探针
 * 与修复同时落地，否则「输入引用」只有接口没有交付。
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeOutput } from '@whalepod/protocol'
import { projectContextNonce } from '../../src/index.js'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
  type ProbeRuntime,
} from './helpers/replay-runtime.js'

const OVERLAYS_DIR = dirname(fileURLToPath(new URL('./overlays/disable-bash.yml', import.meta.url)))
const DISABLE_BASH = join(OVERLAYS_DIR, 'disable-bash.yml')
const DISABLE_JOBS = join(OVERLAYS_DIR, 'disable-jobs.yml')

const ARTIFACT_ID = '01905f7c-0000-7000-8000-000000000901'
const ARTIFACT_CONTENT = '# coordination input PC00_ECHO_463\n'
const ARTIFACT_SHA256 = '27d7914d8616dabcda2ec2a18beb01a89fc67e0427fec6834fbe3d51fbe29410'
const ARTIFACT_BYTES = Buffer.byteLength(ARTIFACT_CONTENT)

/**
 * `session.event` 里 `tool/result` 的 data 形状（rc.8）：消息体是一条 user
 * 消息，其 content 只有一个 `tool-result` block，block 里才是模型看到的
 * 结果内容；`isError` 在 block 上，错误码在 data.error。
 */
interface ToolResultData {
  turn: number
  step: number
  message: {
    source: { kind: string; callId?: string }
    content: {
      type: string
      toolCallId?: string
      isError?: boolean
      content?: { type: string; text?: string }[]
    }[]
  }
  error?: { name?: string; code?: string }
}

interface ToolResultBlock {
  toolCallId?: string
  isError?: boolean
  content?: { type: string; text?: string }[]
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeInputsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'whalepod-pc00-inputs-'))
  tempDirs.push(dir)
  return dir
}

function sessionEventsOf(outputs: readonly RuntimeOutput[]): { type: string; data: unknown }[] {
  return outputs
    .filter((frame) => frame.type === 'session.event')
    .map((frame) => frame.payload.event as { type: string; data: unknown })
}

function toolResultsOf(outputs: readonly RuntimeOutput[]): ToolResultData[] {
  return sessionEventsOf(outputs)
    .filter((event) => event.type === 'tool/result')
    .map((event) => event.data as ToolResultData)
}

function blockOf(data: ToolResultData): ToolResultBlock | undefined {
  return data.message.content.find((block) => block.type === 'tool-result')
}

function callIdOf(data: ToolResultData): string | undefined {
  return blockOf(data)?.toolCallId ?? data.message.source.callId
}

function isErrorOf(data: ToolResultData): boolean {
  return blockOf(data)?.isError === true
}

function resultText(data: ToolResultData): string {
  return (blockOf(data)?.content ?? []).map((block) => block.text ?? '').join('\n')
}

/** 帧里所有字符串叶子——用于断言回放脚本真的引用了上一轮结果。 */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsOf)
  return []
}

function outputsText(outputs: readonly RuntimeOutput[]): string {
  return stringsOf(outputs.map((frame) => frame.payload)).join('\n')
}

/** initialize → ready → 指令 → 等 Run 收尾（工具结果先于收尾帧落 session 流）。 */
async function driveToCompletion(runtime: ProbeRuntime, prompt: string): Promise<void> {
  await runtime.send(initializeCommand(runtime.spec))
  await runtime.until('runtime.ready')
  await runtime.send(commandFrame('run.prompt', { runId: runtime.spec.runId, text: prompt }))
  await waitForSettled(runtime)
}

/**
 * 正常路径是 run.completed；replay 的 {{fromRequest}} 解析失败或其它桥内错误
 * 会先发 runtime.fatal——两条一起等，红的时候当场说明是哪条，而不是挂 90s。
 */
async function waitForSettled(runtime: ProbeRuntime): Promise<void> {
  const outcome = await Promise.race([
    runtime.until('run.completed').then(() => 'completed'),
    runtime
      .until('runtime.fatal')
      .then((fatal) => `runtime.fatal ${fatal.payload.code}: ${fatal.payload.summary}`),
  ])
  expect(outcome).toBe('completed')
}

describe('PC-00: a disabled tool row leaves the model surface and cannot execute', () => {
  it('a disabled row removes the tool: unknown-tool result, no execution, run still completes', async () => {
    const spec = { ...runtimeSpec(), approvalPolicy: 'full_access' as const }
    // full_access 让「禁用失效」当场以命令真实执行（marker 出现）暴露，而不是
    // 挂在审批等待上拖到超时；审批顺序另有 approval_required 用例钉住。
    const runtime = await startReplayRuntime('tool-boundary-disabled', spec, {
      extraPatchFiles: [DISABLE_BASH],
    })
    try {
      await driveToCompletion(runtime, 'run the bash probe')

      const results = toolResultsOf(runtime.outputs)
      expect(results).toHaveLength(1)
      const [result] = results as [ToolResultData]
      expect(callIdOf(result)).toBe('call-bash-1')
      expect(isErrorOf(result)).toBe(true)
      expect(result.error?.code).toBe('UNKNOWN_TOOL')
      expect(resultText(result)).toContain('unknown tool "bash"')
      // 插件不挂载 ⇒ 命令零执行：正控里 stdout 的 marker 在此绝不能出现在
      // 结果内容里（模型自己的调用参数仍会出现在 session 日志，那不是执行证据）。
      expect(resultText(result)).not.toContain('probe-ok')
      // 错误结果真的进入了下一次模型请求：回放脚本的 {{fromRequest}} 只在这一步
      // 能解析（匹配不到即 fail loud），引用的正是 tool/result 里的错误文本。
      expect(outputsText(runtime.outputs)).toContain('Tool error seen: Error: unknown tool "bash"')
      // 工具不可用不改变 Run 的生命周期：模型收到错误结果后继续收尾。
      expect(runtime.outputs.filter((frame) => frame.type === 'run.completed')).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('approval_required: a disabled tool still asks once, and still cannot execute', async () => {
    // vendor native 路径：未知工具先经 tools/pre-execute（审批门），批准后执行体
    // 才解析失败。这是「禁用行不执行」的补充事实，不是零打扰的能力。
    // 显式写 approval_required：默认值变化时用例应当先红在意图上，而不是退化成别的档位。
    const spec = { ...runtimeSpec(), approvalPolicy: 'approval_required' as const }
    const runtime = await startReplayRuntime('tool-boundary', spec, {
      extraPatchFiles: [DISABLE_BASH],
    })
    try {
      await runtime.send(initializeCommand(spec))
      await runtime.until('runtime.ready')
      await runtime.send(
        commandFrame('run.prompt', { runId: spec.runId, text: 'run the bash probe' }),
      )
      const requested = await runtime.until('approval.requested')
      expect(requested.payload.toolName).toBe('bash')
      await runtime.send(
        commandFrame('approval.decide', {
          runId: spec.runId,
          callId: requested.payload.callId,
          decision: 'allowed_once',
        }),
      )
      await waitForSettled(runtime)

      const [toolResult] = toolResultsOf(runtime.outputs) as [ToolResultData]
      expect(isErrorOf(toolResult)).toBe(true)
      expect(toolResult.error?.code).toBe('UNKNOWN_TOOL')
      expect(resultText(toolResult)).not.toContain('probe-ok')
      expect(runtime.outputs.filter((frame) => frame.type === 'approval.requested')).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('positive control: the same fixture really executes bash when no row disables it', async () => {
    const spec = { ...runtimeSpec(), approvalPolicy: 'full_access' as const }
    const runtime = await startReplayRuntime('tool-boundary', spec)
    try {
      await driveToCompletion(runtime, 'run the bash probe')

      const results = toolResultsOf(runtime.outputs)
      expect(results).toHaveLength(1)
      const [result] = results as [ToolResultData]
      expect(isErrorOf(result)).toBe(false)
      expect(resultText(result)).toContain('probe-ok')
    } finally {
      await runtime.dispose()
    }
  })

  it('attribution control: disabling an unrelated row leaves bash mounted', async () => {
    const spec = { ...runtimeSpec(), approvalPolicy: 'full_access' as const }
    const runtime = await startReplayRuntime('tool-boundary', spec, {
      extraPatchFiles: [DISABLE_JOBS],
    })
    try {
      await driveToCompletion(runtime, 'run the bash probe')

      const [result] = toolResultsOf(runtime.outputs) as [ToolResultData]
      expect(isErrorOf(result)).toBe(false)
      expect(resultText(result)).toContain('probe-ok')
    } finally {
      await runtime.dispose()
    }
  })
})

describe('PC-00: artifact input references reach the model as structured content', () => {
  it('projects metadata and text content into the model-facing tool result', async () => {
    const inputsDir = makeInputsDir()
    writeFileSync(join(inputsDir, ARTIFACT_ID), ARTIFACT_CONTENT)
    const spec = withManifest(runtimeSpec(), inputsDir)
    const runtime = await startReplayRuntime('read-artifact-input', spec)
    try {
      await driveToCompletion(runtime, 'read the listed input')

      const results = toolResultsOf(runtime.outputs)
      expect(results).toHaveLength(2)
      const [read, escaped] = results as [ToolResultData, ToolResultData]

      // 结构化字段 + 正文都必须在模型可见内容里：canonical value 不落库
      // （execution-local），render 投影是唯一交付面。
      const text = resultText(read)
      expect(isErrorOf(read)).toBe(false)
      expect(text).toContain(`artifact input: ${ARTIFACT_ID}`)
      expect(text).toContain('title: Coordination input')
      expect(text).toContain('mediaType: text/markdown')
      expect(text).toContain(`byteSize: ${ARTIFACT_BYTES}`)
      expect(text).toContain(`sha256: ${ARTIFACT_SHA256}`)
      expect(text).toContain('truncated: false')
      expect(text).toContain(ARTIFACT_CONTENT)

      // 路径形 id 不是文件路径：白名单拒绝，且拒绝面不含任何本机绝对路径。
      expect(callIdOf(escaped)).toBe('call-input-2')
      expect(isErrorOf(escaped)).toBe(true)
      expect(resultText(escaped)).toContain('unknown artifact input')
      for (const secretPath of [inputsDir, spec.workspacePath, spec.dshHomePath]) {
        expect(JSON.stringify(read)).not.toContain(secretPath)
        expect(JSON.stringify(escaped)).not.toContain(secretPath)
      }

      // canonical value 不在工具结果事件里（rc.8：execution-local、不落库）。
      // 一旦上游改变这一点，这条兼容判据应当红，提醒重新评估 Hub 解析面。
      expect(Object.hasOwn(read, 'value')).toBe(false)
      expect(Object.hasOwn(read.message, 'value')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('the projected content reaches the next model request (fromRequest echo)', async () => {
    const inputsDir = makeInputsDir()
    writeFileSync(join(inputsDir, ARTIFACT_ID), ARTIFACT_CONTENT)
    const spec = withManifest(runtimeSpec(), inputsDir)
    const runtime = await startReplayRuntime('read-artifact-input-manifest', spec)
    try {
      await driveToCompletion(runtime, 'read the listed input')

      // fixture 的 step 2 用 {{fromRequest:PC00_ECHO_463}} 引用只存在于
      // render 投影里的正文；匹配不到会 fail loud，所以这句出现即证明投影
      // 真的进了下一次模型请求，而不只是落在 tool/result 事件里。
      // nonce 不在 manifest/prompt 里：请求级证据不是「当前文本恰好不同」。
      expect(JSON.stringify(spec.artifactInputs)).not.toContain('PC00_ECHO_463')
      expect(outputsText(runtime.outputs)).toContain('Input echo: PC00_ECHO_463')
    } finally {
      await runtime.dispose()
    }
  })

  it('without a manifest the input tool does not exist at all (fail-closed surface)', async () => {
    const spec = { ...runtimeSpec(), approvalPolicy: 'full_access' as const }
    const runtime = await startReplayRuntime('read-artifact-input', spec)
    try {
      await driveToCompletion(runtime, 'try to read an input')

      const results = toolResultsOf(runtime.outputs)
      expect(results).toHaveLength(2)
      for (const result of results) {
        expect(isErrorOf(result)).toBe(true)
        expect(result.error?.code).toBe('UNKNOWN_TOOL')
        expect(resultText(result)).toContain('unknown tool "read_artifact_input"')
      }
    } finally {
      await runtime.dispose()
    }
  })
})

function withManifest(
  spec: ReturnType<typeof runtimeSpec>,
  inputsDir: string,
): ReturnType<typeof runtimeSpec> {
  return {
    ...spec,
    approvalPolicy: 'full_access' as const,
    artifactInputs: [
      {
        artifactId: ARTIFACT_ID,
        title: 'Coordination input',
        mediaType: 'text/markdown',
        byteSize: ARTIFACT_BYTES,
        sha256: ARTIFACT_SHA256,
      },
    ],
    artifactInputsDir: inputsDir,
  }
}

// ADR-0027（PC-05a）：项目上下文快照经专用只读工具进入模型；正文不在 run.start
// 清单或 executionContext 里，只能来自 Node 下载副本。回执在本地 wire 上可观测。
const CONTEXT_ENTRY_ID = '01905f7c-0000-7000-8000-000000000951'
const CONTEXT_CONTENT = '# frozen project context\nPC05A_ECHO\n'
const CONTEXT_DIGEST = createHash('sha256').update(CONTEXT_CONTENT).digest('hex')
const CONTEXT_SNAPSHOT_DIGEST = createHash('sha256').update('pc05a-contract').digest('hex')

function withProjectContext(
  spec: ReturnType<typeof runtimeSpec>,
  entriesDir: string,
  runId: string,
): ReturnType<typeof runtimeSpec> {
  const nonce = projectContextNonce(CONTEXT_SNAPSHOT_DIGEST, runId)
  const headerText = `[project-context:${nonce}]\n- ${CONTEXT_ENTRY_ID} 预算结论`
  return {
    ...spec,
    approvalPolicy: 'full_access' as const,
    projectContext: {
      snapshotId: '01905f7c-0000-7000-8000-000000000961',
      digest: CONTEXT_SNAPSHOT_DIGEST,
      headerText,
      headerDigest: createHash('sha256').update(headerText).digest('hex'),
      entries: [
        {
          entryId: CONTEXT_ENTRY_ID,
          kind: 'decision',
          title: '预算结论',
          revisionId: null,
          businessRef: 'taskSpec:01905f7c-0000-7000-8000-000000000201',
          digest: CONTEXT_DIGEST,
          byteSize: Buffer.byteLength(CONTEXT_CONTENT),
          snapshotAuthorizationGeneration: null,
        },
      ],
      entriesDir,
    },
  }
}

describe('ADR-0027: project context entries reach the model through read_project_context', () => {
  it('projects the frozen body and structured fields, and emits delivered/read receipts', async () => {
    const entriesDir = makeInputsDir()
    writeFileSync(join(entriesDir, CONTEXT_ENTRY_ID), CONTEXT_CONTENT)
    const base = runtimeSpec()
    const spec = withProjectContext(base, entriesDir, base.runId)
    const runtime = await startReplayRuntime('read-project-context', spec)
    try {
      await driveToCompletion(runtime, 'read the project context')

      const results = toolResultsOf(runtime.outputs)
      expect(results).toHaveLength(2)
      const [read, escaped] = results as [ToolResultData, ToolResultData]
      const text = resultText(read)
      expect(isErrorOf(read)).toBe(false)
      expect(text).toContain(`project context: ${CONTEXT_ENTRY_ID}`)
      expect(text).toContain('kind: decision')
      expect(text).toContain('title: 预算结论')
      expect(text).toContain(`digest: ${CONTEXT_DIGEST}`)
      expect(text).toContain(CONTEXT_CONTENT)
      expect(callIdOf(escaped)).toBe('call-context-2')
      expect(isErrorOf(escaped)).toBe(true)
      expect(resultText(escaped)).toContain('unknown project context entry')
      for (const secretPath of [entriesDir, spec.workspacePath, spec.dshHomePath]) {
        expect(JSON.stringify(read)).not.toContain(secretPath)
        expect(JSON.stringify(escaped)).not.toContain(secretPath)
      }

      const receipts = runtime.outputs.filter((frame) => frame.type === 'runtime.context_receipt')
      expect(receipts.map((frame) => (frame.payload as { kind: string }).kind)).toEqual([
        'delivered',
        'read',
      ])
      expect(receipts[0]?.payload).toMatchObject({
        snapshotId: '01905f7c-0000-7000-8000-000000000961',
        nonceMatched: true,
        entriesDelivered: [CONTEXT_ENTRY_ID],
      })
      expect(receipts[1]?.payload).toMatchObject({
        entryId: CONTEXT_ENTRY_ID,
        digestVerified: true,
        byteSize: Buffer.byteLength(CONTEXT_CONTENT),
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('the body reaches the next model request (fromRequest echo)', async () => {
    const entriesDir = makeInputsDir()
    writeFileSync(join(entriesDir, CONTEXT_ENTRY_ID), CONTEXT_CONTENT)
    const base = runtimeSpec()
    const spec = withProjectContext(base, entriesDir, base.runId)
    const runtime = await startReplayRuntime('read-project-context-manifest', spec)
    try {
      await driveToCompletion(runtime, 'read the project context')
      // marker 只在磁盘副本里，不在快照清单/header/prompt 中：出现即证明正文经
      // 工具投影进入了下一次模型请求。
      expect(JSON.stringify(spec.projectContext?.entries)).not.toContain('PC05A_ECHO')
      expect(spec.projectContext?.headerText).not.toContain('PC05A_ECHO')
      expect(outputsText(runtime.outputs)).toContain('Context echo: PC05A_ECHO')
      expect(outputsText(runtime.outputs)).toContain('nonce: [project-context:')
    } finally {
      await runtime.dispose()
    }
  })
})
