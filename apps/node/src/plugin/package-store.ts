/**
 * Content-addressed 插件包存储（02 Task 17 Step 4）。
 *
 * 布局：<storeRoot>/sha256/<treeDigest>/ 为完整解包后的只读包树；
 * 安装先在 <storeRoot>/tmp/staging-* 落地，全部校验过后 rename 原子发布，
 * 最终目录只读化。preflight 按 digest 查命中。
 */
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson, compareCodePoints } from '@project311/protocol/plugin-pack-digest'
import type { TarEntry } from './tar.js'
import { PluginError } from './integrity.js'

export class PackageStore {
  constructor(readonly root: string) {
    // store 根目录 0o700：插件代码树是敏感落盘面（可执行 JS），umask 不可靠，
    // 显式 chmod 保证目录已存在（宽权限遗留）时也收口到仅属主可读写。
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    chmodSync(this.root, 0o700)
  }

  /** digest 对应的包树绝对路径；未命中 undefined。 */
  lookup(treeDigest: string): string | undefined {
    const dir = join(this.root, 'sha256', treeDigest)
    return existsSync(dir) ? dir : undefined
  }

  /** 新建临时落盘目录（调用方负责 finalize 或 discard）。 */
  beginStaging(): string {
    const tmp = join(this.root, 'tmp')
    mkdirSync(tmp, { recursive: true })
    return mkdtempSync(join(tmp, 'staging-'))
  }

  /** 把解包条目写进 staging（结构安全已由 tar.ts 保证；可多次调用累加）。 */
  async writeEntries(staging: string, entries: readonly TarEntry[]): Promise<void> {
    for (const entry of entries) {
      const target = join(staging, entry.path)
      if (entry.kind === 'directory') {
        await mkdir(target, { recursive: true })
        continue
      }
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, entry.content, { mode: entry.mode & 0o777 })
    }
  }

  /**
   * 原子发布：重扫 staging 计算树 digest（排序文件清单 + 内容 digest 的
   * canonical JSON 再 sha256）→ rename 到 sha256/<digest> → 只读化。
   * digest 相同即内容相同（已存在则丢弃 staging 直接命中）。
   */
  async finalize(staging: string): Promise<{ treeDigest: string; path: string }> {
    const manifest: Array<{ path: string; executable: boolean; contentDigest: string }> = []
    await walk(staging, staging, manifest)
    manifest.sort((a, b) => compareCodePoints(a.path, b.path))
    const treeDigest = createHash('sha256').update(canonicalJson(manifest)).digest('hex')
    const finalDir = join(this.root, 'sha256', treeDigest)
    if (existsSync(finalDir)) {
      rmSync(staging, { recursive: true, force: true })
      return { treeDigest, path: finalDir }
    }
    mkdirSync(join(this.root, 'sha256'), { recursive: true })
    try {
      renameSync(staging, finalDir)
    } catch (error) {
      // 并发 finalize 同一内容：对手已在 existsSync→rename 窗口内发布
      // （POSIX rename 到非空目录报 ENOTEMPTY/EEXIST）。内容寻址保证 digest 同
      // 即内容同，直接命中对手产物，不假性失败。
      const code = (error as NodeJS.ErrnoException).code
      if ((code === 'ENOTEMPTY' || code === 'EEXIST') && existsSync(finalDir)) {
        rmSync(staging, { recursive: true, force: true })
        return { treeDigest, path: finalDir }
      }
      rmSync(staging, { recursive: true, force: true })
      throw new PluginError('STORE_IO', `failed to publish package tree: ${String(error)}`)
    }
    // rename 后再只读化（先 chmod 会让失败路径上的 rmSync 无权进入目录）。
    makeReadonly(finalDir)
    return { treeDigest, path: finalDir }
  }

  discard(staging: string): void {
    rmSync(staging, { recursive: true, force: true })
  }
}

async function walk(
  root: string,
  dir: string,
  out: Array<{ path: string; executable: boolean; contentDigest: string }>,
): Promise<void> {
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, dirent.name)
    if (dirent.isDirectory()) {
      await walk(root, abs, out)
    } else if (dirent.isFile()) {
      const content = await readFile(abs)
      const st = statSync(abs)
      out.push({
        path: abs
          .slice(root.length + 1)
          .split('\\')
          .join('/'),
        executable: (st.mode & 0o111) !== 0,
        contentDigest: createHash('sha256').update(content).digest('hex'),
      })
    }
  }
}

function makeReadonly(dir: string): void {
  for (const name of readdirSync(dir)) {
    const child = join(dir, name)
    const st = statSync(child)
    if (st.isDirectory()) {
      makeReadonly(child)
      chmodSync(child, 0o555)
    } else {
      // 保留可执行位：0o555 / 0o444。
      chmodSync(child, (st.mode & 0o111) !== 0 ? 0o555 : 0o444)
    }
  }
  chmodSync(dir, 0o555)
}

/** 测试/诊断用：读回已发布包树的文件。 */
export async function readStoredFile(dir: string, rel: string): Promise<Buffer> {
  return readFile(join(dir, rel))
}
