#!/usr/bin/env node
/**
 * whalepod-hub CLI（02 Task 5 Step 3）。
 *
 * 用法：whalepod-hub setup-token
 * 只在尚无 Team 时读取并打印一次性 Setup Token 到 stdout；已初始化实例拒绝并退出非零。
 */
import { createDatabase, getTeam } from '@whalepod/db'
import { loadConfig } from './config.js'
import { SetupTokenStore } from './modules/team/setup-token.js'

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command !== 'setup-token') {
    console.error('usage: whalepod-hub setup-token')
    process.exitCode = 1
    return
  }
  const config = loadConfig()
  const database = createDatabase({ connectionString: config.databaseUrl })
  try {
    if ((await getTeam(database.db)) !== undefined) {
      console.error('instance already initialized; setup token is no longer available')
      process.exitCode = 1
      return
    }
    const store = new SetupTokenStore(config.setupTokenPath)
    await store.ensure()
    process.stdout.write(`${await store.read()}\n`)
  } finally {
    await database.close()
  }
}

await main()
