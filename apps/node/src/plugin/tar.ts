/**
 * 安全 tar.gz 解包（02 Task 17 Step 4；04 §6.5 tarbomb/symlink escape）。
 *
 * 手写最小 ustar+pax 读取器（不引系统 tar——行为可测、无平台差）：
 * - 只接受普通文件与目录；symlink/hardlink 一律拒绝（第一阶段最严档，
 *   fixture 与真实 npm 包均不需要）。
 * - 路径必须是包内相对路径：拒绝绝对路径、.. 段、解出目录边界的 pax
 *   longname。
 * - 单文件与总大小上限在 installer 层卡住（这里只做结构性安全）。
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import { PluginError } from './integrity.js'

export interface TarEntry {
  /** 包内相对路径（posix 分隔，无前导 ./）。 */
  readonly path: string
  readonly kind: 'file' | 'directory'
  readonly content: Buffer
  /** 原始 mode（用于可执行位保留）。 */
  readonly mode: number
}

const BLOCK = 512

function parseOctal(field: Buffer): number {
  const text = field.toString('latin1').replace(/\0.*$/s, '').trim()
  if (text === '') return 0
  return parseInt(text, 8)
}

/** 规范化并校验包内路径；非法返回 undefined（调用方抛 TARBALL_UNSAFE）。 */
function safePath(raw: string): string | undefined {
  const trimmed = raw.replace(/^\.\//, '')
  if (trimmed === '' || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return undefined
  const parts = trimmed.split('/')
  if (parts.some((p) => p === '..' || p === '' || p === '.')) return undefined
  return parts.join('/')
}

/** 解 tar.gz 为条目数组（全部读进内存——installer 已先卡 tarball 字节上限）。 */
export function unpackTarGz(archive: Buffer): TarEntry[] {
  let tar: Buffer
  try {
    tar = gunzipSync(archive)
  } catch {
    throw new PluginError('TARBALL_UNSAFE', 'not a gzip stream')
  }
  const entries: TarEntry[] = []
  let paxPath: string | undefined
  let offset = 0
  for (;;) {
    if (offset + BLOCK > tar.length) break
    const header = tar.subarray(offset, offset + BLOCK)
    offset += BLOCK
    if (header.every((b) => b === 0)) break // 结束块
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const size = parseOctal(header.subarray(124, 136))
    const mode = parseOctal(header.subarray(100, 108))
    const name = header.subarray(0, 100).toString('latin1').replace(/\0.*$/s, '')
    const content = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / BLOCK) * BLOCK

    if (typeflag === 'x') {
      // pax 扩展头：只取 path= 键（其余键忽略——第一阶段最小支持面）。
      const text = content.toString('utf8')
      const pathMatch = /(?:^|\n)\d+ path=([^\n]+)/.exec(`\n${text}`)
      paxPath = pathMatch?.[1]
      continue
    }
    if (typeflag === 'g') continue // pax 全局头：无每文件语义
    const rawName = paxPath ?? name
    paxPath = undefined
    const path = safePath(rawName)
    if (path === undefined) {
      throw new PluginError('TARBALL_UNSAFE', `unsafe entry path: ${rawName.slice(0, 120)}`)
    }
    if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      entries.push({ path, kind: 'file', content: Buffer.from(content), mode })
    } else if (typeflag === '5') {
      entries.push({ path, kind: 'directory', content: Buffer.alloc(0), mode })
    } else {
      // '1' hardlink / '2' symlink / 设备节点等：一律拒绝。
      throw new PluginError(
        'TARBALL_UNSAFE',
        `unsupported entry type '${typeflag}' at ${path} (links/devices forbidden)`,
      )
    }
  }
  return entries
}

// ---------- 规范化写入器（catalog/fixture tarball 制作用） ----------

export interface TarInputEntry {
  readonly path: string
  readonly content?: Buffer
  readonly kind?: 'file' | 'directory'
  readonly mode?: number
}

/**
 * 确定性 tar.gz：uid/gid 0、mtime 0、条目按路径排序、固定 gzip 参数——
 * 同一输入永远产出同一字节流（catalog integrity 可离线复算验证）。
 */
export function buildTarGz(entries: readonly TarInputEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const content = entry.content ?? Buffer.alloc(0)
    const header = Buffer.alloc(512)
    header.write(entry.path, 0, 'latin1')
    header.write((entry.mode ?? 0o644).toString(8).padStart(7, '0'), 100, 'latin1')
    header.write('0000000', 108, 'latin1')
    header.write('0000000', 116, 'latin1')
    header.write(content.length.toString(8).padStart(11, '0'), 124, 'latin1')
    header.write('00000000000', 136, 'latin1')
    header.fill(0x20, 148, 156)
    header.write(entry.kind === 'directory' ? '5' : '0', 156, 'latin1')
    header.write('ustar\0', 257, 'latin1')
    header.write('00', 263, 'latin1')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
    blocks.push(header)
    if (entry.kind !== 'directory' && content.length > 0) {
      blocks.push(content)
      const pad = (512 - (content.length % 512)) % 512
      if (pad > 0) blocks.push(Buffer.alloc(pad))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}
