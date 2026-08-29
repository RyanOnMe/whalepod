// wire 协议的 protocolVersion 固定为 1（见 02-第一阶段实施计划.md Global Constraints）；
// PROTOCOL_VERSION 在 envelope.ts 定义，由此 re-export。
export * from './errors.js'
export * from './envelope.js'
export * from './http.js'
export * from './client-events.js'
export * from './node-wire.js'
export * from './runtime-wire.js'
export * from './catalog.js'
export * from './plugin-manifest.js'
export * from './plugin-api.js'
export * from './plugin-runtime-config.js'
