/**
 * Hub 进程入口：装配配置、数据库、Setup Token、HTTP 监听与后台驱动（worker/租约）。
 *
 * buildApp 负责 app 内部的 WS 路由 + orchestrator（WS 上行分发用）；
 * 此处额外启动组合根级别的后台循环：
 * - OutboxWorker：250ms 扫描派发队列，经 WsDeviceGateway 把 run.start/run.cancel 等下行帧投到在线 Node；
 * - reconcileLeases：10s 扫描活跃 Run，30s 无心跳的设备上的 Run 转 lost（03 §3.2/R5）。
 * 进程退出时清理定时器与连接。
 */
import { createDatabase, getTeam, Outbox } from '@project311/db'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { SetupTokenStore } from './modules/team/setup-token.js'
import { OutboxWorker } from './modules/run/index.js'
import { reconcileLeases } from './modules/run/reconciler.js'
import { WsDeviceGateway } from './modules/device/index.js'

const config = loadConfig()
const database = createDatabase({ connectionString: config.databaseUrl })
const setupTokenStore = new SetupTokenStore(config.setupTokenPath)

// 只有尚无 Team 时才生成一次性 Setup Token；Token 不打印进日志（由 CLI 读文件输出）。
if ((await getTeam(database.db)) === undefined) {
  await setupTokenStore.ensure()
}

const app = await buildApp({
  config,
  database,
  setupTokenStore,
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
})

// 组合根后台循环：测试不经本入口，故无需条件化。
const outbox = new Outbox(database)
const worker = new OutboxWorker({ outbox, gateway: new WsDeviceGateway() })
const workerTimer = setInterval(() => {
  void worker.dispatchOnce().catch((error) => {
    app.log.warn(
      { component: 'hub.outbox-worker', errorName: String(error) },
      'dispatch loop error',
    )
  })
}, 250)
const leaseTimer = setInterval(() => {
  void reconcileLeases(
    {
      database,
      outbox,
      // orchestrator 在 buildApp 内部持有 deviceActivity 投影；此处租约恢复
      // 只用 devices.lastSeenAt（进程重启后内存投影为空，退化为 DB 事实，符合 R8 语义）。
      activity: new Map(),
      now: () => new Date(),
    },
    new Date(),
  ).catch((error) => {
    app.log.warn({ component: 'hub.reconciler', errorName: String(error) }, 'lease reconcile error')
  })
}, 10_000)

await app.listen({ host: config.host, port: config.port })

const shutdown = async (): Promise<void> => {
  clearInterval(workerTimer)
  clearInterval(leaseTimer)
  await app.close()
  await database.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
