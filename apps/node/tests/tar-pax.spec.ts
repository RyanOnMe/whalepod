/**
 * P1-17 tar pax 扩展头攻击矩阵（04 §6.5 机器证据——pax 变体此前只有手工验证）。
 *
 * 覆盖 unpackTarGz（apps/node/src/plugin/tar.ts）的 pax 语义：
 * 1. pax 'x' 头 path= 越界（.. 段、绝对路径）→ safePath 拒绝 TARBALL_UNSAFE；
 * 2. 良性超长名（>100 字节，ustar name 字段放不下）经 pax path 正常解出；
 * 3. 'g' 全局头隔离：'x' 设置的 paxPath 被 'g' 清空，不泄漏到下一条目（n4）；
 * 4. 畸形 pax size（头 size 字段超出归档剩余字节）→ fail-closed TARBALL_UNSAFE，
 *    不越界读、不把尾部字节误当 header。
 *
 * 手写带 pax 记录的 tar 构造器（plugin-installer.spec.ts 的 buildTarGz 不支持
 * pax 头）：pax 条目 = typeflag 'x' 的 512 头 + record 内容
 * （"<len> path=<name>\n"，len 为十进制整条 record 字节数）+ 对齐填充。
 */
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PluginError } from '../src/plugin/integrity.js'
import { unpackTarGz } from '../src/plugin/tar.js'

// ---------- 带 pax 记录的手写 tar 构造器 ----------

const BLOCK = 512

function tarHeader(opts: { name: string; typeflag: string; size?: number }): Buffer {
  const header = Buffer.alloc(BLOCK)
  // ustar name 字段只有 100 字节：显式截断写入（超长名的全名走 pax path）。
  header.write(opts.name, 0, 100, 'latin1')
  header.write('0000644', 100, 'latin1') // mode
  header.write('0000000', 108, 'latin1') // uid
  header.write('0000000', 116, 'latin1') // gid
  header.write((opts.size ?? 0).toString(8).padStart(11, '0'), 124, 'latin1')
  header.write('00000000000', 136, 'latin1') // mtime 0
  header.fill(0x20, 148, 156) // checksum 位先填空格
  header.write(opts.typeflag, 156, 'latin1')
  header.write('ustar\0', 257, 'latin1')
  header.write('00', 263, 'latin1')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
  return header
}

/** pax record：`<len> path=<value>\n`，len（十进制）= 整条 record 字节数（含自身）。 */
function paxPathRecord(path: string): Buffer {
  const valueBytes = Buffer.byteLength(path, 'utf8')
  let digits = 1
  for (;;) {
    // len = 位数 + 空格 + 'path' + '=' + value 字节数 + '\n'；位数自洽才定稿。
    const len = digits + 1 + 4 + 1 + valueBytes + 1
    if (String(len).length === digits) {
      const record = Buffer.from(`${len} path=${path}\n`, 'utf8')
      if (record.length !== len) throw new Error(`pax record len drift: ${record.length} != ${len}`)
      return record
    }
    digits = String(len).length
  }
}

/** 内容块对齐填充。 */
function padBlocks(size: number): Buffer[] {
  const pad = (BLOCK - (size % BLOCK)) % BLOCK
  return pad > 0 ? [Buffer.alloc(pad)] : []
}

/** pax 'x' 扩展头块序列：512 头 + record 内容 + 对齐填充。 */
function paxXBlocks(path: string): Buffer[] {
  const record = paxPathRecord(path)
  return [
    tarHeader({ name: '././@PaxHeader', typeflag: 'x', size: record.length }),
    record,
    ...padBlocks(record.length),
  ]
}

/** pax 'g' 全局头（size 0：本读取器对全局头只做「清 paxPath」这一个动作）。 */
function paxGBlocks(): Buffer[] {
  return [tarHeader({ name: 'pax_global_header', typeflag: 'g', size: 0 })]
}

/** 普通文件条目块序列。 */
function fileBlocks(name: string, content: string): Buffer[] {
  const body = Buffer.from(content, 'utf8')
  return [tarHeader({ name, typeflag: '0', size: body.length }), body, ...padBlocks(body.length)]
}

function tarGz(blocks: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(2 * BLOCK)]), { level: 9 })
}

// ---------- 同步抛错断言（与 runtime-config.spec.ts 的 expectSyncCode 同形态） ----------

function expectSyncCode(fn: () => unknown, code: PluginError['code']): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(PluginError)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected PluginError ${code}, but nothing was thrown`)
}

// ---------- 攻击矩阵 ----------

describe('unpackTarGz pax 扩展头（攻击矩阵机器证据）', () => {
  it.each([
    ['.. 越界段', '../escape'],
    ['绝对路径', '/abs/path'],
  ])('pax path %s → TARBALL_UNSAFE（safePath 拒绝 pax 携带名）', (_label, badPath) => {
    // 'x' 头携带越界 path，其后跟随普通条目：读取器消费 paxPath 时必须拒绝；
    // 若实现忽略 pax 头或不在消费点校验，本测试会以「未抛错」失败。
    const tarball = tarGz([...paxXBlocks(badPath), ...fileBlocks('victim.txt', 'harmless')])
    expectSyncCode(() => unpackTarGz(tarball), 'TARBALL_UNSAFE')
  })

  it('良性超长名（>100 字节）经 pax path 解出：路径精确、内容逐字节一致', () => {
    const longPath = `deep/${'a'.repeat(120)}.txt` // 129 字节，ustar name 字段放不下
    const content = 'pax-longname-payload\n'
    // ustar name 字段故意写一个不同的合法短名：验证取的是 pax path 而非 name 残段。
    const tarball = tarGz([
      ...paxXBlocks(longPath),
      ...fileBlocks('name-field-cannot-hold-this', content),
    ])
    const entries = unpackTarGz(tarball)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ path: longPath, kind: 'file', mode: 0o644 })
    expect(Buffer.compare(entries[0]!.content, Buffer.from(content, 'utf8'))).toBe(0)
  })

  it("'g' 全局头隔离：'x' 设 ../evil 后插 'g'，下一条目用自身 ustar name 解出（n4）", () => {
    const tarball = tarGz([
      ...paxXBlocks('../evil'),
      ...paxGBlocks(),
      ...fileBlocks('own-name.txt', 'clean-bytes'),
    ])
    // 若 paxPath 泄漏，下一条目将拿到 ../evil → TARBALL_UNSAFE；
    // 隔离正确则该条目按自身名正常解出。
    const entries = unpackTarGz(tarball)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ path: 'own-name.txt', kind: 'file' })
    expect(entries[0]!.content.toString('utf8')).toBe('clean-bytes')
  })

  it("'g' 全局头同样清掉良性 pax path（隔离不限于越界值）", () => {
    const tarball = tarGz([
      ...paxXBlocks('pax-carried-name.txt'),
      ...paxGBlocks(),
      ...fileBlocks('own-name.txt', 'clean-bytes'),
    ])
    const entries = unpackTarGz(tarball)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe('own-name.txt')
    expect(entries[0]!.path).not.toBe('pax-carried-name.txt')
  })

  it('畸形 pax size（头 size 字段超出归档剩余字节）→ fail-closed TARBALL_UNSAFE', () => {
    // 'x' 头声明 0o10000 = 4096 字节 record，但归档其后只剩双零结束块（1024 字节）：
    // 不得越界读、不得崩溃，必须 fail-closed（尾部零块不是合法 record 序列）。
    const tarball = tarGz([tarHeader({ name: '././@PaxHeader', typeflag: 'x', size: 0o10000 })])
    expectSyncCode(() => unpackTarGz(tarball), 'TARBALL_UNSAFE')
  })

  it('tar 头 size 字段为非八进制垃圾 → fail-closed TARBALL_UNSAFE（不得静默截断）', () => {
    // parseOctal 得 NaN 时 offset 算术塌缩，会把零块误判成结束块、静默产出残缺
    // 条目集——合法 tar 的 size 恒为八进制，非八进制即坏归档，拒绝之。
    const header = tarHeader({ name: 'victim.txt', typeflag: '0', size: 4 })
    // 覆写 size 字段为非八进制内容（124..136），并重算 checksum。
    header.fill(0x20, 124, 136)
    header.write('not-octal!', 124, 'latin1')
    header.fill(0x20, 148, 156)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
    const tarball = tarGz([header])
    expectSyncCode(() => unpackTarGz(tarball), 'TARBALL_UNSAFE')
  })
})
