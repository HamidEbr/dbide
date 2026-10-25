import { describe, expect, it } from 'vitest'
import { readZip } from './read-zip'
import { ZipWriter } from './zip'

const build = (make: (zip: ZipWriter) => Buffer[]): Buffer => {
  const zip = new ZipWriter(new Date('2026-03-01T12:30:40'))
  return Buffer.concat(make(zip))
}

describe('ZipWriter', () => {
  it('writes whole entries that any reader can open', () => {
    const file = build((zip) => [
      zip.addFile('a.txt', 'hello'),
      zip.addFile('dir/b.txt', 'wörld 🎉'),
      zip.close(),
    ])
    const files = readZip(file)
    expect([...files.keys()]).toEqual(['a.txt', 'dir/b.txt'])
    expect(files.get('a.txt')!.toString()).toBe('hello')
    expect(files.get('dir/b.txt')!.toString()).toBe('wörld 🎉')
  })

  it('streams an entry in pieces and gets the checksum and sizes right', () => {
    const pieces = Array.from({ length: 50 }, (_, i) => `line ${i} `.repeat(200) + '\n')
    const file = build((zip) => [
      zip.begin('big.txt'),
      ...pieces.map((p) => zip.append(p)),
      zip.finish(),
      zip.close(),
    ])
    expect(readZip(file).get('big.txt')!.toString()).toBe(pieces.join(''))
    // It really is compressed.
    expect(file.length).toBeLessThan(pieces.join('').length / 5)
  })

  it('mixes streamed and whole entries, and several streamed ones in a row', () => {
    const file = build((zip) => [
      zip.begin('one'),
      zip.append('1'),
      zip.finish(),
      zip.addFile('middle', 'm'),
      zip.begin('two'),
      zip.append(Buffer.from([0, 1, 2, 3, 255])),
      zip.append(''),
      zip.finish(),
      zip.close(),
    ])
    const files = readZip(file)
    expect(files.get('one')!.toString()).toBe('1')
    expect(files.get('middle')!.toString()).toBe('m')
    expect([...files.get('two')!]).toEqual([0, 1, 2, 3, 255])
  })

  it('writes an entry with no content', () => {
    const file = build((zip) => [zip.begin('empty'), zip.finish(), zip.close()])
    expect(readZip(file).get('empty')!.length).toBe(0)
  })

  it('is not fooled by a file that holds zip-like bytes', () => {
    const tricky = Buffer.from([0x50, 0x4b, 0x05, 0x06, 1, 2, 3])
    const file = build((zip) => [zip.begin('x'), zip.append(tricky), zip.finish(), zip.close()])
    expect(readZip(file).get('x')).toEqual(tricky)
  })

  it('refuses calls in the wrong order', () => {
    const zip = new ZipWriter()
    expect(() => zip.append('x')).toThrow(/Begin/)
    expect(() => zip.finish()).toThrow(/Begin/)
    zip.begin('a')
    expect(() => zip.begin('b')).toThrow(/open/)
    expect(() => zip.addFile('c', '')).toThrow(/open/)
    expect(() => zip.close()).toThrow(/open/)
  })

  it('puts the time the file was made in the entries', () => {
    const file = build((zip) => [zip.addFile('t', 'x'), zip.close()])
    // Local header: time at 10, date at 12.
    const time = file.readUInt16LE(10)
    const date = file.readUInt16LE(12)
    expect([time >> 11, (time >> 5) & 63, (time & 31) * 2]).toEqual([12, 30, 40])
    expect([1980 + (date >> 9), (date >> 5) & 15, date & 31]).toEqual([2026, 3, 1])
  })
})
