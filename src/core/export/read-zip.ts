import { crc32, inflateRawSync } from 'node:zlib'

/**
 * Reads a zip file through its table of contents, checking every entry's checksum and size. It
 * exists so tests can hold the writer to what any other program would see; nothing else uses it.
 */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end === -1) throw new Error('No end-of-directory record')
  const count = zip.readUInt16LE(end + 10)
  const directorySize = zip.readUInt32LE(end + 12)
  const directoryStart = zip.readUInt32LE(end + 16)
  if (directoryStart + directorySize !== end)
    throw new Error('The directory does not end where the record starts')

  const files = new Map<string, Buffer>()
  let at = directoryStart
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('Bad directory entry')
    const method = zip.readUInt16LE(at + 10)
    const crc = zip.readUInt32LE(at + 16)
    const compressed = zip.readUInt32LE(at + 20)
    const uncompressed = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    const offset = zip.readUInt32LE(at + 42)
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    at += 46 + nameLength + extraLength + commentLength

    // The local header repeats the name; the data starts after it.
    if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(`Bad local header for ${name}`)
    const localName = zip.readUInt16LE(offset + 26)
    const localExtra = zip.readUInt16LE(offset + 28)
    const start = offset + 30 + localName + localExtra
    const packed = zip.subarray(start, start + compressed)
    if (method !== 8) throw new Error(`Unsupported method ${method}`)
    const data = inflateRawSync(packed)
    if (data.length !== uncompressed)
      throw new Error(`${name}: size ${data.length} is not ${uncompressed}`)
    if (crc32(data) !== crc) throw new Error(`${name}: checksum does not match`)
    files.set(name, data)

    // A streamed entry is followed by a descriptor that says the same thing as the directory.
    const flags = zip.readUInt16LE(offset + 6)
    if (flags & 0x0008) {
      const d = start + compressed
      if (zip.readUInt32LE(d) !== 0x08074b50) throw new Error(`${name}: no data descriptor`)
      if (zip.readUInt32LE(d + 4) !== crc) throw new Error(`${name}: descriptor checksum differs`)
      if (zip.readUInt32LE(d + 8) !== compressed)
        throw new Error(`${name}: descriptor size differs`)
      if (zip.readUInt32LE(d + 12) !== uncompressed)
        throw new Error(`${name}: descriptor size differs`)
    }
  }
  return files
}
