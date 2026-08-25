/**
 * 结构化日志 sink（bridge 内共用）：stdout 只走协议帧，日志一律经此进
 * stderr（02 Task 11 Step 6）。字段带 component 分层（验证六原语 #4 归因）。
 */
export interface LogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly component: string
  readonly msg: string
  readonly [field: string]: unknown
}

export type LogSink = (record: LogRecord) => void

/** 默认丢弃的 sink；生产由 apps/runtime 的 stderr logger 注入。 */
export const nullLog: LogSink = () => {}
