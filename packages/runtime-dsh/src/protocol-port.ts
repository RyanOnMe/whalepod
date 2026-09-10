/**
 * NDJSON 单通道边界（02 Task 11 Step 6，03 §7）：stdout 只写协议帧，
 * 每帧过 `RuntimeOutputSchema` 后一次 `write`；stdin 每行仅 parse 一条
 * command，单行上限 1 MiB，超限与 EOF 都上报给宿主（apps/runtime）处置。
 *
 * 本模块只做 framing/解析，不持有进程生命周期。
 */
import {
  parseRuntimeFrame,
  RuntimeOutputSchema,
  type RuntimeCommand,
  type RuntimeOutput,
} from '@whalepod/protocol'

/** 单行命令上限（02 Step 6）：1 MiB。 */
export const MAX_COMMAND_LINE_BYTES = 1024 * 1024

/** 写一帧 output：先过 schema（fail-closed），再一次 write。schema 不过属桥内 bug，抛给宿主。 */
export function writeRuntimeOutput(write: (chunk: string) => unknown, output: RuntimeOutput): void {
  write(`${JSON.stringify(RuntimeOutputSchema.parse(output))}\n`)
}

export interface CommandSourceOptions {
  /** 一条合法 command（按到达顺序串行分发）。 */
  onCommand(command: RuntimeCommand): void | Promise<void>
  /** 帧解析/校验失败（JSON 或 fail-closed wire 解析）：Runtime 不执行该帧。 */
  onInvalid(error: unknown, rawLine: string): void
  /** 单行超 1 MiB：上报一次后停止读取（02 Step 6：结束 Runtime 由宿主决定）。 */
  onOversize(): void | Promise<void>
  /** stdin EOF：父 Node 消失，宿主立即 cancel/flush/dispose 并退出（02 Step 6）。 */
  onEof(): void | Promise<void>
}

/**
 * 逐行读 stdin 命令。命令处理器按序串行（审批决定不得与 prompt 乱序）；
 * 处理器抛错不打断流（未知/非法命令 Runtime 不执行，03 §11）。
 */
export function readRuntimeCommands(
  input: NodeJS.ReadableStream,
  options: CommandSourceOptions,
): void {
  input.setEncoding('utf8')
  let buffer = ''
  let oversize = false
  let ended = false
  let chain: Promise<void> = Promise.resolve()

  const enqueue = (task: () => void | Promise<void>): void => {
    chain = chain.then(task).catch(() => {})
  }

  const handleLine = (line: string): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      options.onInvalid(error, line)
      return
    }
    let command: RuntimeCommand
    try {
      command = parseRuntimeFrame(parsed, 'command')
    } catch (error) {
      options.onInvalid(error, line)
      return
    }
    enqueue(async () => {
      try {
        await options.onCommand(command)
      } catch (error) {
        options.onInvalid(error, line)
      }
    })
  }

  input.on('data', (chunk: string) => {
    if (oversize || ended) return
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) {
        if (buffer.length > MAX_COMMAND_LINE_BYTES) {
          oversize = true
          enqueue(options.onOversize)
        }
        return
      }
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length > MAX_COMMAND_LINE_BYTES) {
        oversize = true
        enqueue(options.onOversize)
        return
      }
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
      if (trimmed.length === 0) continue
      handleLine(trimmed)
    }
  })

  input.on('end', () => {
    if (ended) return
    ended = true
    // EOF 前到达的命令先串行消化完，再走 EOF 处置。
    enqueue(options.onEof)
  })

  input.on('error', () => {
    if (ended) return
    ended = true
    enqueue(options.onEof)
  })
}
