import { describe, expect, it } from 'vitest'
import { byteLength, fromBytes, isBinary, parseEscaped, printable, toBytes } from './bstring'
import {
  argBytes,
  argText,
  classifyRedis,
  commandCatalog,
  describeCommand,
  isReadSafe,
  isStreamingCommand,
  tokenize,
} from './command'
import { describeTtl, isCoreType, prefixGlob, toGlob } from './types'

const text = (bytes: Uint8Array): string => String.fromCharCode(...bytes)

describe('binary-safe strings', () => {
  it('leaves text as it is, in both directions', () => {
    for (const value of ['hello', 'héllo ☕', '', 'a\u0000b', 'with\nnewline']) {
      expect(fromBytes(toBytes(value))).toBe(value)
      expect(isBinary(value)).toBe(false)
    }
  })

  it('keeps a byte-order mark, which text decoders usually drop', () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])
    expect(fromBytes(bom)).toBe('\ufeffa')
    expect(toBytes('\ufeffa')).toEqual(bom)
  })

  it('writes bytes that are not text as a marker and Base64, and reads them back', () => {
    const bytes = Uint8Array.from(Array.from({ length: 256 }, (_, i) => i))
    const value = fromBytes(bytes)
    expect(isBinary(value)).toBe(true)
    expect(value.startsWith('\u0000')).toBe(true)
    expect(toBytes(value)).toEqual(bytes)
    expect(byteLength(value)).toBe(256)
  })

  it('writes bytes that start with a NUL in the Base64 form too, so a value is never taken for the marker', () => {
    const bytes = new TextEncoder().encode('\u0000plain')
    const value = fromBytes(bytes)
    expect(isBinary(value)).toBe(true)
    expect(toBytes(value)).toEqual(bytes)
    expect(printable(value)).toBe('\\x00plain')
  })

  it('counts the bytes of text and of binary values', () => {
    expect(byteLength('héllo')).toBe(6)
    expect(byteLength(fromBytes(Uint8Array.from([0xff])))).toBe(1)
    expect(byteLength(fromBytes(Uint8Array.from([0xff, 0xfe])))).toBe(2)
    expect(byteLength(fromBytes(Uint8Array.from([0xff, 0xfe, 0xfd])))).toBe(3)
  })

  it('prints bytes the way redis-cli does, and reads them back', () => {
    const value = fromBytes(Uint8Array.from([0xff, 0x00, 0x5c, 0x0a, 0x41]))
    expect(printable(value)).toBe('\\xff\\x00\\\\\\nA')
    expect(parseEscaped(printable(value))).toBe(value)
    expect(printable('plain text')).toBe('plain text')
  })

  it('reads a typed escape such as \\xff as that byte', () => {
    expect(toBytes(parseEscaped('\\xff!'))).toEqual(Uint8Array.from([0xff, 0x21]))
    expect(parseEscaped('abc')).toBe('abc')
  })
})

describe('tokenize', () => {
  const args = (line: string): string[] => {
    const result = tokenize(line)
    if (!result.ok) throw new Error(result.error)
    return result.args
  }

  it('splits on spaces and ignores extra ones', () => {
    expect(args('  SET   a  b ')).toEqual(['SET', 'a', 'b'])
    expect(args('')).toEqual([])
  })

  it('reads double quotes with escapes, and single quotes as they are', () => {
    expect(args('SET k "two words"')).toEqual(['SET', 'k', 'two words'])
    expect(args('SET k "a\\"b\\\\c\\nd"')).toEqual(['SET', 'k', 'a"b\\c\nd'])
    expect(args("SET k 'it\\'s \"fine\"'")).toEqual(['SET', 'k', 'it\'s "fine"'])
    expect(args('SET k ""')).toEqual(['SET', 'k', ''])
  })

  it('reads \\xNN as one byte, and text as its UTF-8 bytes', () => {
    const [, , value] = args('SET k "caf\\xc3\\xa9 \\xff"')
    expect(text(argBytes(value!))).toBe(
      text(Uint8Array.from([...new TextEncoder().encode('café '), 0xff])),
    )
    const [, , utf8] = args('SET k café')
    expect(argBytes(utf8!)).toEqual(new TextEncoder().encode('café'))
    expect(argText(utf8!)).toBe('café')
    expect(argText(args('SET k "\\xff"')[2]!)).toBe('\u00ff')
  })

  it('refuses unbalanced quotes, and a closing quote glued to more text', () => {
    expect(tokenize('SET k "open')).toMatchObject({ ok: false })
    expect(tokenize("SET k 'open")).toMatchObject({ ok: false })
    expect(tokenize('SET k "a"b')).toMatchObject({ ok: false })
  })
})

describe('what a command does', () => {
  it('reads a command by its name, whatever the case', () => {
    expect(describeCommand(['get', 'k'])).toMatchObject({ name: 'GET', kind: 'read' })
    expect(describeCommand(['SET', 'k', 'v'])).toMatchObject({ name: 'SET', kind: 'write' })
    expect(describeCommand(['DEL', 'k'])).toMatchObject({ kind: 'destructive' })
    expect(describeCommand(['FLUSHALL'])).toMatchObject({ kind: 'destructive' })
    expect(describeCommand(['SELECT', '1'])).toMatchObject({ kind: 'session' })
  })

  it('reads a command with sub-commands by both words', () => {
    expect(describeCommand(['config', 'get', 'x'])).toMatchObject({
      name: 'CONFIG GET',
      kind: 'read',
    })
    expect(describeCommand(['CONFIG', 'SET', 'x', 'y'])).toMatchObject({
      name: 'CONFIG SET',
      kind: 'admin',
    })
    expect(describeCommand(['XGROUP', 'DESTROY', 'k', 'g'])).toMatchObject({ kind: 'destructive' })
    expect(describeCommand(['MEMORY', 'USAGE', 'k'])).toMatchObject({ kind: 'read' })
  })

  it('treats what it does not know as unknown, which is not read-safe', () => {
    expect(describeCommand(['NOSUCH'])).toMatchObject({ kind: 'unknown' })
    expect(describeCommand(['CONFIG', 'NOSUCHSUB'])).toMatchObject({ kind: 'unknown' })
    expect(describeCommand(['CONFIG'])).toMatchObject({ kind: 'unknown' })
    expect(describeCommand([])).toMatchObject({ kind: 'unknown' })
    expect(isReadSafe('unknown')).toBe(false)
  })

  it('lets only reads and session commands through while writes are locked', () => {
    for (const kind of ['read', 'session'] as const) expect(isReadSafe(kind)).toBe(true)
    for (const kind of ['write', 'admin', 'destructive', 'unknown'] as const) {
      expect(isReadSafe(kind)).toBe(false)
    }
    // Scripts may do anything; only their read-only forms are reads.
    expect(describeCommand(['EVAL', 's', '0']).kind).toBe('admin')
    expect(describeCommand(['EVAL_RO', 's', '0']).kind).toBe('read')
    expect(describeCommand(['FCALL', 'f', '0']).kind).toBe('admin')
  })

  it('classifies a whole line, with the reason for a destructive one', () => {
    expect(classifyRedis('DEL a b')).toMatchObject({
      kind: 'destructive',
      destructive: true,
      name: 'DEL',
    })
    expect(classifyRedis('DEL a b').reason).toMatch(/removes/)
    expect(classifyRedis('GET a')).toMatchObject({ kind: 'read', destructive: false })
    expect(classifyRedis('SET a "unclosed')).toMatchObject({ kind: 'unknown', name: '' })
    expect(classifyRedis('   ')).toMatchObject({ kind: 'unknown' })
  })

  it('knows the commands that turn a connection into a stream', () => {
    for (const name of ['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'MONITOR', 'SYNC', 'PSYNC']) {
      expect(isStreamingCommand(name)).toBe(true)
    }
    expect(isStreamingCommand('GET')).toBe(false)
  })

  it('offers a sorted catalog without what the console will not run', () => {
    const names = commandCatalog().map((c) => c.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    expect(names).toContain('UNLINK')
    expect(names).toContain('CONFIG GET')
    expect(names).not.toContain('SUBSCRIBE')
    expect(names).not.toContain('MONITOR')
    expect(names).not.toContain('UNSUBSCRIBE')
  })
})

describe('keys and times', () => {
  it('turns what a person types into a glob: plain text matches anywhere', () => {
    expect(toGlob('')).toBe('*')
    expect(toGlob('  ')).toBe('*')
    expect(toGlob('session')).toBe('*session*')
    expect(toGlob('user:*')).toBe('user:*')
    expect(toGlob('h?llo')).toBe('h?llo')
    expect(toGlob('[ab]x')).toBe('[ab]x')
  })

  it('escapes a prefix so only keys that begin with it match', () => {
    expect(prefixGlob('user:')).toBe('user:*')
    expect(prefixGlob('a*b?c[d]e\\')).toBe('a\\*b\\?c\\[d\\]e\\\\*')
  })

  it('says a TTL in a few words', () => {
    expect(describeTtl(null)).toBe('no expiry')
    expect(describeTtl(250)).toBe('250 ms')
    expect(describeTtl(45_000)).toBe('45s')
    expect(describeTtl(60_000)).toBe('1m')
    expect(describeTtl(90_000)).toBe('1m 30s')
    expect(describeTtl(3 * 3600_000 + 20 * 60_000)).toBe('3h 20m')
    expect(describeTtl(2 * 86400_000 + 4 * 3600_000)).toBe('2d 4h')
    expect(describeTtl(2 * 86400_000)).toBe('2d')
  })

  it('knows the types the app has editors for', () => {
    expect(isCoreType('zset')).toBe(true)
    expect(isCoreType('ReJSON-RL')).toBe(false)
  })
})
