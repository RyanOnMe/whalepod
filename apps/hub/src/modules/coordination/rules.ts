/**
 * ADR-0026（PC-04a）：确定性协调的规则与处理器版本。
 *
 * 任一版本变化都会改变 inputDigest，从而让旧结果不可复用；模型/Node 路径
 * 落地时通过新的 rulesVersion/processorVersion 显式升级。
 */
export const COORDINATION_RULES_VERSION = 'pc04a.v1' as const
export const COORDINATION_PROCESSOR_VERSION = 'deterministic.v1' as const

/** 单次输入上限（ADR-0026 §5；本切片只做条目数与字节预算）。 */
export const COORDINATION_INPUT_MAX_ENTRIES = 32
export const COORDINATION_INPUT_MAX_BYTES = 256 * 1024

/** queued 合并窗口：TTL 10 分钟、总寿命 30 分钟（ADR-0026 §3）。 */
export const COORDINATION_QUEUE_TTL_MS = 10 * 60 * 1000
export const COORDINATION_QUEUE_MAX_MS = 30 * 60 * 1000

/** tick 每轮最多处理的评估数。 */
export const COORDINATION_TICK_BATCH = 20
