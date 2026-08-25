export const HUB_VERSION = 1 as const

export { buildApp } from './app.js'
export type { HubDeps } from './app.js'
export { loadConfig } from './config.js'
export type { HubConfig, RateLimitConfig } from './config.js'
