import { constants, crc32, deflateRawSync } from 'node:zlib'

/**
 * A zip file written front to back, so a large entry never has to be held in memory. Each call hands
 * back the bytes to write next; the caller writes them in order.
 *
 * An entry that is streamed (`begin`, `append`…, `finish`) is compressed a piece at a time. Each piece
 * is deflated on its own and ends at a byte boundary, so the pieces join into one valid deflate
 * stream, closed by an empty final block. Its sizes and checksum come after the data, in a data
 * descriptor, because they are not known before.
 */

const LOCAL_HEADER = 0x04034b50
const DATA_DESCRIPTOR = 0x08074b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_DIRECTORY = 0x06054b50

const FLAG_DATA_DESCRIPTOR = 0x0008
const FLAG_UTF8 = 0x0800
const DEFLATE = 8
const MAX_32 = 0xffffffff

/** The empty final block that ends a deflate stream made of flushed pieces. */
const FINAL_BLOCK = Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff])

interface Entry {
  name: Buffer
  crc: number
  compressed: number
  uncompressed: number
  offset: number
  flags: number
}

/** A zip entry's time and date fields, which count two-second steps from 1980. */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date:
      ((Math.max(1980, date.getFullYear()) - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  }
}

export class ZipWriter {
  private position = 0
  private readonly entries: Entry[] = []
  private open: Entry | null = null
  private readonly stamp: { time: number; date: number }

  constructor(now: Date = new Date()) {
    this.stamp = dosDateTime(now)
  }

  private emit(...parts: Buffer[]): Buffer {
    const bytes = Buffer.concat(parts)
    this.position += bytes.length
    return bytes
  }

  private header(entry: Entry, compression: number): Buffer {
    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_HEADER, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(entry.flags, 6)
    header.writeUInt16LE(compression, 8)
    header.writeUInt16LE(this.stamp.time, 10)
    header.writeUInt16LE(this.stamp.date, 12)
    // Checksum and sizes follow the data for a streamed entry; a whole entry fills them in below.
    header.writeUInt16LE(entry.name.length, 26)
    return header
  }

  /** Starts an entry whose content arrives in pieces. */
  begin(name: string): Buffer {
    if (this.open) throw new Error('Finish the entry that is open first.')
    const entry: Entry = {
      name: Buffer.from(name, 'utf8'),
      crc: 0,
      compressed: 0,
      uncompressed: 0,
      offset: this.position,
      flags: FLAG_UTF8 | FLAG_DATA_DESCRIPTOR,
    }
    this.open = entry
    return this.emit(this.header(entry, DEFLATE), entry.name)
  }

  /** Adds content to the open entry. */
  append(data: string | Uint8Array): Buffer {
    const entry = this.open
    if (!entry) throw new Error('Begin an entry first.')
    const plain = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    if (plain.length === 0) return Buffer.alloc(0)
    entry.crc = crc32(plain, entry.crc)
    entry.uncompressed += plain.length
    const packed = deflateRawSync(plain, { finishFlush: constants.Z_SYNC_FLUSH })
    entry.compressed += packed.length
    return this.emit(packed)
  }

  /** Closes the open entry. */
  finish(): Buffer {
    const entry = this.open
    if (!entry) throw new Error('Begin an entry first.')
    this.open = null
    entry.compressed += FINAL_BLOCK.length
    if (entry.compressed > MAX_32 || entry.uncompressed > MAX_32) {
      throw new Error('This entry is too large for a zip file without the zip64 extension.')
    }
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0)
    descriptor.writeUInt32LE(entry.crc, 4)
    descriptor.writeUInt32LE(entry.compressed, 8)
    descriptor.writeUInt32LE(entry.uncompressed, 12)
    this.entries.push(entry)
    return this.emit(FINAL_BLOCK, descriptor)
  }

  /** Adds a small entry in one step. */
  addFile(name: string, data: string): Buffer {
    if (this.open) throw new Error('Finish the entry that is open first.')
    const plain = Buffer.from(data, 'utf8')
    const packed = deflateRawSync(plain)
    const entry: Entry = {
      name: Buffer.from(name, 'utf8'),
      crc: crc32(plain),
      compressed: packed.length,
      uncompressed: plain.length,
      offset: this.position,
      flags: FLAG_UTF8,
    }
    const header = this.header(entry, DEFLATE)
    header.writeUInt32LE(entry.crc, 14)
    header.writeUInt32LE(entry.compressed, 18)
    header.writeUInt32LE(entry.uncompressed, 22)
    this.entries.push(entry)
    return this.emit(header, entry.name, packed)
  }

  /** The table of contents at the end of the file. Nothing can be added after it. */
  close(): Buffer {
    if (this.open) throw new Error('Finish the entry that is open first.')
    const start = this.position
    const records = this.entries.map((entry) => {
      const record = Buffer.alloc(46)
      record.writeUInt32LE(CENTRAL_HEADER, 0)
      record.writeUInt16LE(20, 4)
      record.writeUInt16LE(20, 6)
      record.writeUInt16LE(entry.flags, 8)
      record.writeUInt16LE(DEFLATE, 10)
      record.writeUInt16LE(this.stamp.time, 12)
      record.writeUInt16LE(this.stamp.date, 14)
      record.writeUInt32LE(entry.crc, 16)
      record.writeUInt32LE(entry.compressed, 20)
      record.writeUInt32LE(entry.uncompressed, 24)
      record.writeUInt16LE(entry.name.length, 28)
      record.writeUInt32LE(entry.offset, 42)
      return Buffer.concat([record, entry.name])
    })
    const directory = Buffer.concat(records)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END_OF_DIRECTORY, 0)
    end.writeUInt16LE(this.entries.length, 8)
    end.writeUInt16LE(this.entries.length, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(start, 16)
    return this.emit(directory, end)
  }
}
