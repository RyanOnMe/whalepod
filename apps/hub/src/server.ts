/** Hub 进程入口：装配配置、数据库、Setup Token 与 HTTP 监听。 */
import { createDatabase, getTeam } from '@project311/db'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { SetupTokenStore } from './modules/team/setup-token.js'

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
await app.listen({ host: config.host, port: config.port })

const shutdown = async (): Promise<void> => {
  await app.close()
  await database.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
