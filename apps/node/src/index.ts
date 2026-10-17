export const NODE_VERSION = 1 as const

export { startDeviceSession } from './gateway/session.js'
// #352：hello 事实装配的公开面——harness（Q5 的 e2e-node/chain）与 CLI 必须同一份实现：
// createHelloFacts 供事实源，refreshHelloAfterPreflight 供将来给 harness 接 preflight 时
// 不偏离生产（本版 harness 还没接 preflight，见 docs/agent/hello-facts-refresh-acceptance.md）。
export { createHelloFacts, refreshHelloAfterPreflight } from './gateway/hello-facts.js'
export { checkPreparation } from './workspace/preparation.js'
