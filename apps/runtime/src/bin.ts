#!/usr/bin/env node
/**
 * project311-runtime —— per-Run DSH Runtime 子进程入口（02 Task 11 Step 6，03 §7）。
 *
 * 通道纪律：stdout 只写 NDJSON 协议帧（每帧过 RuntimeOutputSchema，同步写，
 * 任何库打点一律改道 stderr）；stderr 写结构化 JSON 日志行。
 *
 * 进程处置表（02 Step 6）：首帧必须 runtime.initialize，boot 失败发
 * runtime.fatal(RUNTIME_START_FAILED) 后 exit 1；runtime.shutdown 收敛后
 * exit 0；stdin EOF（父 Node 消失）先收敛再 exit 0；单行超 1 MiB exit 2。
 *
 * `PROJECT311_RUNTIME_EXTRA_PATCH_FILES`（path.delimiter 分隔）追加 Loader
 * patch 层：契约探针用它挂 replay overlay；生产留给 P1-17 批准的 Plugin Pack。
 */
import { randomUUID } from 'node:crypto'
import { writeSync } from 'node:fs'
import { delimiter } from 'node:path'
import { format } from 'node:util'
import type { RuntimeCommand, RuntimeOutput } from '@project311/protocol'
import {
  dispatchRuntimeCommand,
  readRuntimeCommands,
  writeRuntimeOutput,
  type LogSink,
  type RuntimeBridgeSlot,
} from '@project311/runtime-dsh'

// console 一律转 stderr：stdout 是协议单通道。
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[method] = (...args: unknown[]) => {
    writeSync(2, `${format(...args)}\n`)
  }
}

const emit = (output: RuntimeOutput): void =>
  writeRuntimeOutput((chunk) => writeSync(1, chunk), output)

const log: LogSink = (record) => {
  writeSync(2, `${JSON.stringify(record)}\n`)
}

function emitStartFatal(runId: string, error: unknown): void {
  const summary = (error instanceof Error ? error.message : String(error)).slice(0, 1000)
  emit({
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type: 'runtime.fatal',
    payload: { runId, code: 'RUNTIME_START_FAILED', summary: summary || 'runtime start failed' },
  })
}

function main(): void {
  const extraPatchFiles = (process.env['PROJECT311_RUNTIME_EXTRA_PATCH_FILES'] ?? '')
    .split(delimiter)
    .filter((entry) => entry.length > 0)
  const slot: RuntimeBridgeSlot = { current: undefined }
  const options = { emit, log, extraPatchFiles }

  const disposeQuietly = async (): Promise<void> => {
    const bridge = slot.current
    slot.current = undefined
    if (bridge === undefined) return
    try {
      await bridge.dispose()
    } catch (error) {
      log({
        level: 'error',
        component: 'runtime.bin',
        msg: 'dispose failed during process exit',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  readRuntimeCommands(process.stdin, {
    async onCommand(command: RuntimeCommand) {
      if (command.type === 'runtime.initialize') {
        try {
          await dispatchRuntimeCommand(slot, command, options)
        } catch (error) {
          emitStartFatal(command.payload.runId, error)
          process.exit(1)
        }
        return
      }
      if (command.type === 'runtime.shutdown') {
        try {
          await dispatchRuntimeCommand(slot, command, options)
        } catch (error) {
          log({
            level: 'error',
            component: 'runtime.bin',
            msg: 'runtime.shutdown convergence failed',
            error: error instanceof Error ? error.message : String(error),
          })
          process.exit(1)
        }
        process.exit(0)
      }
      await dispatchRuntimeCommand(slot, command, options)
    },
    onInvalid(error, rawLine) {
      // 非法帧不执行、不打断流（03 §11）；行内容可能携带未过校验的外部输入，只记长度。
      log({
        level: 'warn',
        component: 'runtime.bin',
        msg: 'invalid command frame dropped',
        error: error instanceof Error ? error.message : String(error),
        lineBytes: rawLine.length,
      })
    },
    async onOversize() {
      log({
        level: 'error',
        component: 'runtime.bin',
        msg: 'command line exceeds 1 MiB; runtime exiting',
      })
      await disposeQuietly()
      process.exit(2)
    },
    async onEof() {
      await disposeQuietly()
      process.exit(0)
    },
  })
}

main()
