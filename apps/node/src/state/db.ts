/**
 * Node 本地状态库统一打开入口（P1-12；02 Task 12 Files: state/{db,migrations}.ts）。
 *
 * WAL + synchronous=FULL：崩溃/掉电后已确认状态不丢（02 Task 12 Step 4）。
 * 各 store 在此连接上自行建表（幂等 create if not exists）。
 */
import { DatabaseSync } from 'node:sqlite'

export function openStateDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = WAL')
  db.exec('pragma synchronous = FULL')
  return db
}
