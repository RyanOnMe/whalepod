/**
 * 安全 tar.gz 解包（02 Task 17 Step 4；04 §6.5 tarbomb/symlink escape）。
 *
 * 手写最小 ustar+pax 读取器（不引系统 tar——行为可测、无平台差）：
 * - 只接受普通文件与目录；symlink/hardlink 一律拒绝（第一阶段最严档，
 *   fixture 与真实 npm 包均不需要）。
 * - 路径必须是包内相对路径：拒绝绝对路径、.. 段、解出目录边界的 pax
 *   longname。
 * - 压缩侧字节上限在 installer 层卡住；解压侧总上限在本模块
 *   MAX_UNCOMPRESSED_TAR_BYTES（gzip bomb 第二道闸）。
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import { compareCodePoints } from '@project311/protocol/plugin-pack-digest'
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

/** gzip 头 OS 字段归一值（3 = Unix；见 buildTarGz 注释）。 */
const GZIP_OS_UNIX = 3

/**
 * 解压后总上限（M4：gzip bomb 第二道闸）。
 *
 * 压缩侧 tarball 已由 installer 卡在 maxTarballBytes（默认 8 MiB）；真实 npm
 * 包压缩比只有数倍，64 MiB 解压上限 = 压缩上限的 8 倍，对合法大包留足余量，
 * 而 1000:1 以上放大比的炸弹（8 MiB 压缩 → 8 GiB 解压）在此截断。
 */
export const MAX_UNCOMPRESSED_TAR_BYTES = 64 * 1024 * 1024

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

/**
 * 解析 pax 'x' 头的 record 序列，返回 path= 键值（其余键忽略）。
 *
 * record 格式：`<len> <key>=<value>\n`，len（十进制、含自身）= 整条 record
 * 字节数（n3：len 超过实有字节、缺空格/换行、len 不自洽一律 fail-closed
 * TARBALL_UNSAFE——绝不截断后把后续字节误当 header）。
 */
function parsePaxPath(content: Buffer): string | undefined {
  let path: string | undefined
  let pos = 0
  while (pos < content.length) {
    const space = content.indexOf(0x20, pos)
    const lenText = content.subarray(pos, space === -1 ? content.length : space).toString('latin1')
    if (space === -1 || lenText === '' || !/^\d{1,10}$/.test(lenText)) {
      throw new PluginError('TARBALL_UNSAFE', 'malformed pax record')
    }
    const recordLen = Number.parseInt(lenText, 10)
    // recordLen 必须至少覆盖 "<len> " 前缀，且不得超出实有字节。
    if (recordLen <= space - pos + 1 || pos + recordLen > content.length) {
      throw new PluginError('TARBALL_UNSAFE', 'malformed pax record')
    }
    if (content[pos + recordLen - 1] !== 0x0a) {
      throw new PluginError('TARBALL_UNSAFE', 'malformed pax record')
    }
    const record = content.subarray(space + 1, pos + recordLen - 1)
    const eq = record.indexOf(0x3d)
    if (eq > 0 && record.subarray(0, eq).toString('latin1') === 'path') {
      path = record.subarray(eq + 1).toString('utf8')
    }
    pos += recordLen
  }
  return path
}

/** 解 tar.gz 为条目数组（全部读进内存——installer 已先卡 tarball 字节上限）。 */
export function unpackTarGz(archive: Buffer): TarEntry[] {
  let tar: Buffer
  try {
    // maxOutputLength 超限抛 ERR_ZLIB_BUDGET_EXHAUSTED（gzip bomb 在此截断，M4）。
    tar = gunzipSync(archive, { maxOutputLength: MAX_UNCOMPRESSED_TAR_BYTES })
  } catch (error) {
    const budgetExhausted =
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === 'ERR_ZLIB_BUDGET_EXHAUSTED'
    // 固定话术：不携带输入细节；两类失败统一 fail-closed TARBALL_UNSAFE。
    throw new PluginError(
      'TARBALL_UNSAFE',
      budgetExhausted ? 'decompressed tarball exceeds size limit' : 'not a gzip stream',
    )
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
    // size 字段非八进制垃圾时 parseOctal 得 NaN：offset 算术塌缩会把零块误判
    // 成结束块、静默截断归档——fail-closed 拒绝（合法 tar 的 size 恒为八进制）。
    if (!Number.isFinite(size)) {
      throw new PluginError('TARBALL_UNSAFE', 'tar header size field is not octal')
    }
    const mode = parseOctal(header.subarray(100, 108))
    const name = header.subarray(0, 100).toString('latin1').replace(/\0.*$/s, '')
    const content = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / BLOCK) * BLOCK

    if (typeflag === 'x') {
      // pax 扩展头：只取 path= 键（其余键忽略——第一阶段最小支持面）；
      // 每条 record 声明长度必须与实有字节自洽，否则 fail-closed（n3：
      // 截断后继续会把后续字节误当 header）。
      paxPath = parsePaxPath(content)
      continue
    }
    if (typeflag === 'g') {
      // pax 全局头：无每文件语义；清掉未消费的 'x' 路径，防泄漏到下一条目（n4）。
      paxPath = undefined
      continue
    }
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
 *
 * 注意 gzip 头第 9 字节是 OS 字段（zlib 编译期 OS_CODE：macOS=19、Linux=3），
 * 不归一则同一 tar 在不同平台产出不同字节流，catalog integrity 跨平台复算
 * 漂移（P1-17 CI 实证）。这里归一为 3（Unix，部署目标 POSIX）；mtime 由
 * zlib 默认置 0、XFL 随固定 level 固定，OS 是唯一平台相关字节。
 */
export function buildTarGz(entries: readonly TarInputEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of [...entries].sort((a, b) => compareCodePoints(a.path, b.path))) {
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
  const gz = gzipSync(Buffer.concat(blocks), { level: 9 })
  gz[9] = GZIP_OS_UNIX // 跨平台字节级确定性：归一 gzip 头 OS 字段
  return gz
}
