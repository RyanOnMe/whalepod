/** Regression for untrusted Office links. All resources are synthetic fixtures owned by this test. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { convertOfficeToPdf, OfficePreviewGenerator } from '../src/artifact/preview.js'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whalepod-preview-isolation-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A stored ZIP is enough for a real DOCX. This is only a fixture writer, never a production parser. */
function officeZip(entries: Record<string, string>): Buffer {
  const bodies: Buffer[] = [],
    directory: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const fileName = Buffer.from(name),
      body = Buffer.from(text),
      crc = crc32(body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(fileName.length, 26)
    bodies.push(local, fileName, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(fileName.length, 28)
    central.writeUInt32LE(offset, 42)
    directory.push(central, fileName)
    offset += local.length + fileName.length + body.length
  }
  const tail = Buffer.alloc(22),
    count = Object.keys(entries).length,
    central = Buffer.concat(directory)
  tail.writeUInt32LE(0x06054b50)
  tail.writeUInt16LE(count, 8)
  tail.writeUInt16LE(count, 10)
  tail.writeUInt32LE(central.length, 12)
  tail.writeUInt32LE(offset, 16)
  return Buffer.concat([...bodies, central, tail])
}

function linkedDocx(target: string): Buffer {
  return officeZip({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Synthetic linked image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="fixture.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:link="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:sectPr/></w:body></w:document>',
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}" TargetMode="External"/></Relationships>`,
  })
}
function syntheticPng(): Buffer {
  const chunk = (name: string, body: Buffer) => {
    const type = Buffer.from(name),
      header = Buffer.alloc(4),
      checksum = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    checksum.writeUInt32BE(crc32(Buffer.concat([type, body])))
    return Buffer.concat([header, type, body, checksum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(32)
  ihdr.writeUInt32BE(32, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const pixels = Buffer.concat(
    Array.from({ length: 32 }, () =>
      Buffer.concat([
        Buffer.from([0]),
        Buffer.concat(Array.from({ length: 32 }, () => Buffer.from([255, 0, 0]))),
      ]),
    ),
  )
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
async function generate(bytes: Buffer, extra: { sofficePath?: string } = {}) {
  const uploaded: Buffer[] = [],
    reasons: string[] = []
  const generator = new OfficePreviewGenerator({
    stagingDir: join(root, 'staging'),
    ...extra,
    upload: async (_id, _meta, pdf) => {
      uploaded.push(pdf)
    },
    reportFailure: async (_id, report) => {
      expect(report.converter).toBe('unknown')
      reasons.push(report.reason)
    },
  })
  await generator.generate({
    runId: 'fixture-run',
    artifactId: 'fixture-artifact',
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    mediaType: DOCX,
    bytes,
  })
  await expect(stat(join(root, 'staging'))).rejects.toMatchObject({ code: 'ENOENT' })
  return { uploaded, reasons }
}

describe('Office conversion requires a verified isolation boundary', () => {
  it('does not let real soffice load a document-linked local image outside staging', async () => {
    const image = join(root, 'outside-image.png')
    await writeFile(image, syntheticPng())
    const result = await generate(linkedDocx(pathToFileURL(image).href))
    expect(result.uploaded).toHaveLength(0)
    expect(result.reasons).toEqual(['ISOLATION_REQUIRED'])
  }, 30_000)

  it('does not let a document fetch a linked HTTP image', async () => {
    let requests = 0
    const server = createServer((_req, response) => {
      requests++
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(syntheticPng())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test listener missing')
      const result = await generate(linkedDocx(`http://127.0.0.1:${address.port}/fixture.png`))
      expect(result.uploaded).toHaveLength(0)
      expect(requests).toBe(0)
      expect(result.reasons).toEqual(['ISOLATION_REQUIRED'])
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  }, 30_000)

  it.each(['<html><img src="file:untrusted"></html>', '<office:document/>', 'unknown bytes'])(
    'rejects actual unknown or masquerading containers before starting a configured executable: %s',
    async (bytes) => {
      const marker = join(root, 'spawned'),
        bin = join(root, 'configured-converter')
      await writeFile(bin, `#!/bin/sh\nprintf called > '${marker}'\nexit 0\n`)
      await chmod(bin, 0o755)
      const result = await generate(Buffer.from(bytes), { sofficePath: bin })
      expect(result.reasons).toEqual(['ISOLATION_REQUIRED'])
      expect(result.uploaded).toHaveLength(0)
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('also blocks the low-level conversion entry point before it can spawn', async () => {
    const marker = join(root, 'low-level-spawned'),
      bin = join(root, 'low-level-converter')
    await writeFile(bin, `#!/bin/sh\nprintf called > '${marker}'\nexit 0\n`)
    await chmod(bin, 0o755)
    await expect(
      convertOfficeToPdf(join(root, 'untrusted.docx'), join(root, 'out'), { sofficePath: bin }),
    ).rejects.toMatchObject({ code: 'ISOLATION_REQUIRED' })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
