/**
 * Hub 进程入口：装配配置、数据库、Setup Token、HTTP 监听与后台驱动（worker/租约）。
 *
 * buildApp 负责 app 内部的 WS 路由 + orchestrator（WS 上行分发用）；
 * 此处额外启动组合根级别的后台循环：
 * - OutboxWorker：250ms 扫描派发队列，经 WsDeviceGateway 把 run.start/run.cancel/approval.decide 等下行帧投到在线 Node；
 * - reconcileLeases：10s 扫描活跃 Run，30s 无心跳的设备上的 Run 转 lost（03 §3.2/R5）；
 *   同周期驱动 Approval 过期清扫（P1-14，G5-05 pending → expired 等价拒绝）。
 * 进程退出时清理定时器与连接。
 */
import { applyMigrations, createDatabase, getTeam, Outbox } from '@project311/db'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { SetupTokenStore } from './modules/team/setup-token.js'
import { OutboxWorker } from './modules/run/index.js'
import { reconcileLeases } from './modules/run/reconciler.js'
import { expireApprovals } from './modules/run/approval-expiry.js'
import { WsDeviceGateway } from './modules/device/index.js'

const config = loadConfig()
const database = createDatabase({ connectionString: config.databaseUrl })
// 启动即应用迁移（P1-20 空卷冷启动判据）：幂等 + advisory lock 串行化（#55），
// 多副本同起也安全。此前 applyMigrations 只有测试 helper 与 e2e-serve 调用——
// 「库已就绪」在测试里永远是真，这个洞就永远隐身（#95/#97 同族：生产入口
// 从未被执行过）。DB 不可达时进程崩溃退出是**正确语义**：compose 的 healthy
// 条件等不到它，编排层负责重试与报警，绝不静默半启动。
await applyMigrations(database)
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
      // P1-16：喂入 buildApp 装配的 orchestrator 心跳投影——Node 在线但心跳
      // 已不含该 Run 时立即收敛 lost（03 §3.2）；进程重启后内存投影为空，
      // 退化为 devices.lastSeenAt（DB 事实），语义不变。
      activity: app.runOrchestrator.deviceActivity,
      now: () => new Date(),
    },
    new Date(),
  ).catch((error) => {
    app.log.warn({ component: 'hub.reconciler', errorName: String(error) }, 'lease reconcile error')
  })
  // P1-14：Approval 过期清扫与租约 reconcile 同周期（幂等，重复触发无害）。
  void expireApprovals({ database, outbox, now: () => new Date() }, new Date()).catch((error) => {
    app.log.warn(
      { component: 'hub.approval.expiry', errorName: String(error) },
      'approval expiry sweep error',
    )
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
