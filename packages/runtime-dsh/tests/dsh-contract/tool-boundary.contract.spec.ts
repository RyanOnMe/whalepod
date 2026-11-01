/**
 * PC-00 (#463) —— 协调计算的 rc.8 能力边界：工具禁用、输入引用、结构化结果。
 *
 * 上游复用分析（docs/agent/2026-11-01-superagent-reuse-analysis.md）把「受限
 * 协调计算只回传结构化判断」列为持续协调的前提。本探针用**真 boot 栈**
 * （dsh-base → whalepod bundle → replay，与生产同一路径）验证三件事：
 *
 * 1. 工具禁用：patch 层 `disabled: true` 让插件**不挂载**——模型调用得到
 *    unknown-tool 错误、命令不执行、Run 仍正常收尾；正控（同 fixture 不禁用）
 *    与旁路控（禁用无关行）都真实执行。三者同绿才把失败归因到该 patch 行，
 *    而不是 fixture 写错或「任何额外层都会弄坏工具」。vendor README 明示
 *    `ctx.tools.restrict()` 只是可见性组合、不是权限边界，故本探针只认
 *    boot 层考察。
 * 2. 输入引用：带清单时 `read_artifact_input` 按白名单读取，模型侧拿到
 *    结构化元数据与正文；路径形 id 被拒且消息不含绝对路径；无清单时工具
 *    根本不存在（输入面 fail-closed）。
 * 3. 结构化结果：rc.8 的 canonical value 是 execution-local、不随 tool/result
 *    落库（dsh-tools README：「value … never replayed」），模型可见内容由
 *    `output.render` 投影决定。因此本探针断言的是**模型实际收到的内容**，
 *    这正是 Hub 侧解析结构化判断时必须依赖的面。
 *
 * #463 之前 `read_artifact_input` 的 render 只回 `artifact input: <id>`，
 * 正文与结构化字段都没进模型上下文（Reviewer 读不到材料）——本切片的探针
 * 与修复同时落地，否则「输入引用」只有接口没有交付。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeOutput } from '@whalepod/protocol'
import {
  commandFrame,
  initializeCommand,
  runtimeSpec,
  startReplayRuntime,
  type ProbeRuntime,
} from './helpers/replay-runtime.js'

const OVERLAYS_DIR = new URL('./overlays/', import.meta.url).pathname
const DISABLE_BASH = join(OVERLAYS_DIR, 'disable-bash.yml')
const DISABLE_JOBS = join(OVERLAYS_DIR, 'disable-jobs.yml')

const ARTIFACT_ID = '01905f7c-0000-7000-8000-000000000901'
const ARTIFACT_CONTENT = '# coordination input\n'
const ARTIFACT_SHA256 = '9df55e30bbb748b1a0ddc8bd3d47eeacac645a6876fa14c3bf5b3b238aa1946e'
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

/** initialize → ready → 指令 → 等 Run 收尾（工具结果先于收尾帧落 session 流）。 */
async function driveToCompletion(runtime: ProbeRuntime, prompt: string): Promise<void> {
  await runtime.send(initializeCommand(runtime.spec))
  await runtime.until('runtime.ready')
  await runtime.send(commandFrame('run.prompt', { runId: runtime.spec.runId, text: prompt }))
  await runtime.until('run.completed')
}

describe('PC-00: boot-level tool disabling is the coordination-compute authority boundary', () => {
  it('a disabled row removes the tool: unknown-tool result, no execution, run still completes', async () => {
    const spec = { ...runtimeSpec(), approvalPolicy: 'full_access' as const }
    // approval_policy 不是本用例的主体；full_access 让「禁用失效」当场以命令
    // 真实执行（marker 出现）暴露，而不是挂在审批等待上拖到超时。
    const runtime = await startReplayRuntime('tool-boundary', spec, {
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
      // 未知工具在策略层之前被拒：没有审批帧，也没有任何审批等待。
      expect(runtime.outputs.some((frame) => frame.type === 'approval.requested')).toBe(false)
      // 工具不可用不改变 Run 的生命周期：模型收到错误结果后继续收尾。
      expect(runtime.outputs.filter((frame) => frame.type === 'run.completed')).toHaveLength(1)
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
    const spec = {
      ...runtimeSpec(),
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
      expect(JSON.stringify(escaped)).not.toContain(inputsDir)
      expect(JSON.stringify(read)).not.toContain(inputsDir)
      expect(JSON.stringify(read)).not.toContain(spec.workspacePath)
      expect(JSON.stringify(escaped)).not.toContain(spec.dshHomePath)
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
