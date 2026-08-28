/**
 * Workspace Registry（P1-12；03 §2.4 workspace_registry、G3-04/06）。
 *
 * Node 本地 SQLite（node:sqlite 内置，零新依赖）保存 device-local 事实：
 * opaque workspace_id（device 本地生成）、canonical_path（realpath 后绝对路径，永不发给
 * Hub）、filesystem identity（dev:ino，检测目录被替换/symlink 调包）、path_fingerprint
 * （HMAC-SHA-256，密钥为本库初始化时随机生成并本地保存，不外发）。
 *
 * resolve 是每次使用前的 preflight：canonical 路径仍存在 + realpath 归一不变 +
 * identity 未变，任一不满足 → WORKSPACE_UNAVAILABLE（G3-05/G3-06 的 Node 侧判定）。
 * 删除 registry 项不删目录。
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { stat, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

export class WorkspaceError extends Error {
  constructor(
    readonly code: 'WORKSPACE_UNAVAILABLE' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

export type WorkspaceKind = 'directory' | 'git_repository'

export interface RegisteredWorkspace {
  readonly id: string
  readonly name: string
  readonly kind: WorkspaceKind
  /** realpath 后绝对路径；只在 Node 本地存在（03 §2.4：永不发给 Hub）。 */
  readonly canonicalPath: string
  readonly createdAt: string
}

interface RegistryRow {
  workspace_id: string
  name: string
  kind: string
  canonical_path: string
  path_fingerprint: string
  fs_identity: string
  created_at: string
}

function detectKind(canonicalPath: string): WorkspaceKind {
  return existsSync(join(canonicalPath, '.git')) ? 'git_repository' : 'directory'
}

export class WorkspaceRegistry {
  private readonly db: DatabaseSync
  private readonly hmacKey: Buffer

  constructor(private readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec('pragma journal_mode = WAL')
    this.db.exec('pragma synchronous = FULL')
    this.db.exec(`
      create table if not exists workspace_registry (
        workspace_id text primary key,
        name text not null unique,
        kind text not null,
        canonical_path text not null,
        path_fingerprint text not null,
        fs_identity text not null,
        created_at text not null
      )
    `)
    // HMAC 密钥：库初始化时生成并本地保存；路径指纹用于本地检测路径变化，不外发。
    this.db.exec('create table if not exists meta (key text primary key, value text not null)')
    this.hmacKey = this.loadOrCreateHmacKey()
  }

  private loadOrCreateHmacKey(): Buffer {
    const row = this.db.prepare('select value from meta where key = ?').get('hmac_key') as
      | { value: string }
      | undefined
    if (row !== undefined) return Buffer.from(row.value, 'base64url')
    const key = randomBytes(32)
    this.db
      .prepare('insert into meta (key, value) values (?, ?)')
      .run('hmac_key', key.toString('base64url'))
    return Buffer.from(key)
  }

  fingerprint(canonicalPath: string): string {
    return createHmac('sha256', this.hmacKey).update(canonicalPath).digest('base64url')
  }

  /** 注册真实目录：realpath 归一（G3-06：canonical 被采用）+ filesystem identity 落库。 */
  async register(rawPath: string, input: { name: string }): Promise<RegisteredWorkspace> {
    let canonical: string
    try {
      canonical = await realpath(rawPath)
    } catch {
      throw new WorkspaceError('WORKSPACE_UNAVAILABLE', `workspace path does not exist: ${rawPath}`)
    }
    const st = await stat(canonical)
    if (!st.isDirectory()) {
      throw new WorkspaceError('WORKSPACE_UNAVAILABLE', 'workspace path is not a directory')
    }
    const kind = detectKind(canonical)
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    try {
      this.db
        .prepare(
          'insert into workspace_registry (workspace_id, name, kind, canonical_path, path_fingerprint, fs_identity, created_at) values (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          input.name,
          kind,
          canonical,
          this.fingerprint(canonical),
          `${st.dev}:${st.ino}`,
          createdAt,
        )
    } catch (error) {
      // SQLite 唯一约束（owner 范围内同名）→ CONFLICT，与 Hub 侧同形态。
      // node:sqlite 的 SqliteError：code=ERR_SQLITE_ERROR，errstr=SQLITE_CONSTRAINT_*。
      const err = error as { errstr?: string; message?: string }
      if (
        err.errstr?.startsWith('SQLITE_CONSTRAINT') ||
        err.message?.includes('UNIQUE constraint failed')
      ) {
        throw new WorkspaceError('CONFLICT', `workspace name already registered: ${input.name}`)
      }
      throw error
    }
    return { id, name: input.name, kind, canonicalPath: canonical, createdAt }
  }

  /**
   * 使用前 preflight：canonical 仍存在 + realpath 归一不变 + identity 未变。
   * 任一不满足 → WORKSPACE_UNAVAILABLE（目录删除/symlink 调包/路径变化）。
   */
  async resolve(workspaceId: string): Promise<string> {
    const row = this.db
      .prepare('select * from workspace_registry where workspace_id = ?')
      .get(workspaceId) as unknown as RegistryRow | undefined
    if (row === undefined) {
      throw new WorkspaceError('WORKSPACE_UNAVAILABLE', 'workspace is not registered')
    }
    let current: Awaited<ReturnType<typeof stat>>
    try {
      current = await stat(row.canonical_path)
    } catch {
      throw new WorkspaceError('WORKSPACE_UNAVAILABLE', 'workspace directory is missing')
    }
    if (`${current.dev}:${current.ino}` !== row.fs_identity) {
      throw new WorkspaceError('WORKSPACE_UNAVAILABLE', 'workspace directory was replaced')
    }
    const canonical = await realpath(row.canonical_path)
    if (canonical !== row.canonical_path) {
      throw new WorkspaceError('WORKSPACE_UNAVAILABLE', 'workspace path no longer canonical')
    }
    return row.canonical_path
  }

  async list(): Promise<RegisteredWorkspace[]> {
    const rows = this.db
      .prepare('select * from workspace_registry order by created_at asc')
      .all() as unknown as RegistryRow[]
    return rows.map((row) => ({
      id: row.workspace_id,
      name: row.name,
      kind: row.kind as WorkspaceKind,
      canonicalPath: row.canonical_path,
      createdAt: row.created_at,
    }))
  }

  /** 删除 registry 项；不删目录（02 Task 12 Step 3）。 */
  async remove(workspaceId: string): Promise<void> {
    this.db.prepare('delete from workspace_registry where workspace_id = ?').run(workspaceId)
  }

  close(): void {
    this.db.close()
  }
}
