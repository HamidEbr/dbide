import { describe, expect, it } from 'vitest'
import {
  bytesToText,
  decodeBase64,
  decodeJwt,
  describeTimestamp,
  describeUuid,
  detectViews,
  encodeUtf8,
  hexdump,
  inflate,
  interpret,
  parsePhpSerialized,
  prettyJson,
  relativeTime,
  sniffImage,
  toBase64,
  tryPhp,
} from './decode'

const kinds = (value: Parameters<typeof detectViews>[0], name = 'col', type = 'text'): string[] =>
  detectViews(value, { name, type }).map((d) => d.kind)

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const base64url = (text: string): string =>
  toBase64(encodeUtf8(text)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe('base64 and text', () => {
  it('decodes standard and URL-safe Base64, padded or not', () => {
    const text = (s: string): string => bytesToText(decodeBase64(s)!)!
    expect(text('SGVsbG8gd29ybGQh')).toBe('Hello world!')
    expect(text('SGVsbG8=')).toBe('Hello')
    expect(text('SGVsbG8')).toBe('Hello')
    expect(text('a-_b')).toBe(bytesToText(decodeBase64('a+/b')!))
    expect(text('SGVs\nbG8=')).toBe('Hello')
  })

  it('rejects text that is not Base64', () => {
    expect(decodeBase64('hello world')).toBeNull()
    expect(decodeBase64('abc')).toBeNull()
    expect(decodeBase64('a')).toBeNull()
    expect(decodeBase64('')).toBeNull()
  })

  it('only calls bytes text when they are valid, mostly printable UTF-8', () => {
    expect(bytesToText(encodeUtf8('héllo 🎉'))).toBe('héllo 🎉')
    expect(bytesToText(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull()
    expect(bytesToText(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 65]))).toBeNull()
    expect(bytesToText(new Uint8Array())).toBe('')
  })

  it('round-trips bytes through Base64', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251)
    expect(decodeBase64(toBase64(bytes))).toEqual(bytes)
  })
})

describe('prettyJson', () => {
  it('indents without touching the digits of large numbers', () => {
    expect(prettyJson('{"id":9007199254740993,"tags":["a","b"],"nested":{"ok":true}}')).toBe(
      [
        '{',
        '  "id": 9007199254740993,',
        '  "tags": [',
        '    "a",',
        '    "b"',
        '  ],',
        '  "nested": {',
        '    "ok": true',
        '  }',
        '}',
      ].join('\n'),
    )
  })

  it('keeps empty containers compact and strings intact', () => {
    expect(prettyJson('{"a":{},"b":[],"c":"x, y: {z}","d":"q\\"uote"}')).toBe(
      ['{', '  "a": {},', '  "b": [],', '  "c": "x, y: {z}",', '  "d": "q\\"uote"', '}'].join('\n'),
    )
  })
})

describe('decodeJwt', () => {
  const token = (header: object, payload: object): string =>
    `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}.c2lnbmF0dXJl`

  it('reads the header, payload, and time claims, without verifying anything', () => {
    const now = Date.UTC(2026, 2, 1, 12, 0, 0)
    const jwt = decodeJwt(
      token(
        { alg: 'HS256', typ: 'JWT' },
        { sub: 'user-7', iss: 'auth.example', exp: Math.floor(now / 1000) + 3600, custom: 1 },
      ),
      now,
    )!
    expect(jwt.algorithm).toBe('HS256')
    expect(jwt.signatureBytes).toBe(9)
    expect(jwt.claims.map((c) => c.name)).toEqual(['iss', 'sub', 'exp'])
    expect(jwt.claims[2]!.time).toEqual({ iso: '2026-03-01T13:00:00.000Z', relative: 'in 1 hour' })
    expect(jwt.payload).toContain('"custom": 1')
  })

  it('rejects things that only look similar', () => {
    expect(decodeJwt('not.a.token')).toBeNull()
    expect(decodeJwt('a.b')).toBeNull()
    expect(decodeJwt(token({ alg: 'x' }, {}).replace(/\.[^.]+$/, ''))).toBeNull()
    expect(decodeJwt(`${base64url('[1]')}.${base64url('{}')}.`)).toBeNull()
  })
})

describe('describeTimestamp', () => {
  const now = Date.UTC(2023, 10, 14, 23, 13, 20)

  it('recognizes seconds, milliseconds, and microseconds', () => {
    expect(describeTimestamp(1_700_000_000, now)).toMatchObject({
      unit: 'seconds',
      utc: '2023-11-14T22:13:20.000Z',
      relative: '1 hour ago',
    })
    expect(describeTimestamp('1700000000000', now)).toMatchObject({ unit: 'milliseconds' })
    expect(describeTimestamp('1700000000000000', now)).toMatchObject({ unit: 'microseconds' })
    expect(describeTimestamp('1700000000.5', now)).toMatchObject({ unit: 'seconds' })
  })

  it('ignores numbers that are not plausible times', () => {
    expect(describeTimestamp(42)).toBeNull()
    expect(describeTimestamp('12345')).toBeNull()
    expect(describeTimestamp('99999999999')).toBeNull()
    expect(describeTimestamp('2026-03-01')).toBeNull()
    expect(describeTimestamp(null)).toBeNull()
  })

  it('phrases relative times', () => {
    expect(relativeTime(1000, 31_000)).toBe('30 seconds ago')
    expect(relativeTime(Date.UTC(2026, 0, 3), Date.UTC(2026, 0, 1))).toBe('in 2 days')
    expect(relativeTime(Date.UTC(2024, 0, 1), Date.UTC(2026, 0, 1))).toBe('2 years ago')
  })
})

describe('describeUuid', () => {
  it('reads the time out of version 7 and version 1 UUIDs', () => {
    expect(describeUuid('017F22E2-79B0-7CC3-98C4-DC0C0C07398F')).toMatchObject({
      version: 7,
      time: '2022-02-22T19:22:22.000Z',
    })
    expect(describeUuid('C232AB00-9414-11EC-B3C8-9F6BDECED846')!.time).toMatch(
      /^2022-02-22T19:22:22/,
    )
  })

  it('knows a random UUID has no time', () => {
    const info = describeUuid('f47ac10b-58cc-4372-a567-0e02b2c3d479')!
    expect(info.version).toBe(4)
    expect(info.time).toBeUndefined()
  })

  it('rejects other text', () => {
    expect(describeUuid('not-a-uuid')).toBeNull()
    expect(describeUuid('f47ac10b-58cc-0372-a567-0e02b2c3d479')).toBeNull()
  })
})

describe('parsePhpSerialized', () => {
  it('parses scalars', () => {
    expect(parsePhpSerialized('N;')).toBeNull()
    expect(parsePhpSerialized('b:1;')).toBe(true)
    expect(parsePhpSerialized('b:0;')).toBe(false)
    expect(parsePhpSerialized('i:-42;')).toBe(-42)
    expect(parsePhpSerialized('d:1.5;')).toBe(1.5)
    expect(parsePhpSerialized('d:INF;')).toBe('INF')
    expect(parsePhpSerialized('s:5:"hello";')).toBe('hello')
  })

  it('counts string lengths in bytes, not characters', () => {
    expect(parsePhpSerialized('s:6:"héllo";')).toBe('héllo')
    expect(parsePhpSerialized('s:4:"🎉";')).toBe('🎉')
  })

  it('parses lists as arrays and other keys as objects', () => {
    expect(parsePhpSerialized('a:2:{i:0;s:1:"a";i:1;s:1:"b";}')).toEqual(['a', 'b'])
    expect(parsePhpSerialized('a:2:{s:4:"name";s:3:"Ann";s:3:"age";i:30;}')).toEqual({
      name: 'Ann',
      age: 30,
    })
    expect(parsePhpSerialized('a:1:{i:5;s:1:"x";}')).toEqual({ '5': 'x' })
  })

  it('parses objects, keeps the class, and drops visibility markers from names', () => {
    const text = 'O:3:"Foo":2:{s:1:"a";i:1;s:6:"\0*\0bar";s:1:"x";}'
    expect(parsePhpSerialized(text)).toEqual({ __class: 'Foo', a: 1, bar: 'x' })
  })

  it('parses nested data and references', () => {
    expect(parsePhpSerialized('a:2:{i:0;a:1:{i:0;i:1;}i:1;r:2;}')).toEqual([[1], { __ref: 2 }])
  })

  it('rejects malformed and unsupported input instead of guessing', () => {
    for (const bad of ['', 'x:1;', 's:5:"hi";', 'a:1:{i:0;i:1;', 'i:1;garbage', 'C:3:"Foo":0:{}']) {
      expect(() => parsePhpSerialized(bad)).toThrow()
    }
  })

  it('refuses absurd nesting', () => {
    expect(() => parsePhpSerialized('a:1:{i:0;'.repeat(100) + 'N;' + '}'.repeat(100))).toThrow(
      /deeply/,
    )
  })

  it('tryPhp only tries things that look like PHP', () => {
    expect(tryPhp('hello')).toBeUndefined()
    expect(tryPhp('a:1:{i:0;i:1;}')).toEqual([1])
    expect(tryPhp('a:1:{broken')).toBeUndefined()
  })
})

describe('images and hex', () => {
  it('sniffs image formats from their first bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImage(encodeUtf8('GIF89a'))).toBe('image/gif')
    expect(sniffImage(encodeUtf8('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(encodeUtf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      'image/svg+xml',
    )
    expect(sniffImage(encodeUtf8('hello'))).toBeNull()
  })

  it('writes a hexdump with offsets and an ASCII column', () => {
    const dump = hexdump(encodeUtf8('Hello, world! 0123456789'))
    const lines = dump.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(
      `00000000  48 65 6c 6c 6f 2c 20 77  6f 72 6c 64 21 20 30 31  |Hello, world! 01|`,
    )
    expect(lines[1]!.startsWith('00000010  32 33 34 35 36 37 38 39')).toBe(true)
  })

  it('says how much a long dump leaves out', () => {
    expect(hexdump(new Uint8Array(100), 32).split('\n').at(-1)).toBe('… 68 B more')
  })
})

describe('compression', () => {
  it('inflates gzip data', async () => {
    const compressed = await gzip('{"hello":"world"}'.repeat(10))
    expect(bytesToText(await inflate(compressed))).toBe('{"hello":"world"}'.repeat(10))
  })
})

describe('detectViews', () => {
  it('offers JSON first for JSON text, with plain text as the fallback', () => {
    expect(kinds('{"a":1}')).toEqual(['json', 'text'])
    expect(kinds('[1,2]')).toEqual(['json', 'text'])
    expect(kinds('{not json')).toEqual(['text'])
  })

  it('offers nothing for NULL and text for ordinary strings', () => {
    expect(kinds(null)).toEqual([])
    expect(kinds('')).toEqual(['text'])
    expect(kinds('just words')).toEqual(['text'])
  })

  it('spots a JWT, a UUID, a URL, and PHP data', () => {
    const jwt = `${base64url('{"alg":"HS256"}')}.${base64url('{"sub":"1"}')}.sig`
    expect(kinds(jwt)).toContain('jwt')
    expect(kinds(jwt)[0]).toBe('jwt')
    expect(kinds('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toEqual(['uuid', 'text'])
    expect(kinds('https://example.com/a?b=1')).toEqual(['url', 'text'])
    expect(kinds('a:1:{i:0;s:1:"x";}')).toEqual(['php', 'text'])
  })

  it('offers Base64 only when it decodes to something meaningful', () => {
    expect(kinds('SGVsbG8gd29ybGQh')).toContain('base64')
    expect(kinds('abcdefghijklmnop')).not.toContain('base64')
    expect(kinds('deadbeefdeadbeef')).not.toContain('base64')
  })

  it('offers a timestamp last, unless the column name suggests a time', () => {
    expect(kinds('1700000000', 'order_id', 'bigint')).toEqual(['text', 'timestamp'])
    expect(kinds('1700000000', 'created_at', 'bigint')).toEqual(['timestamp', 'text'])
  })

  it('handles binary cells', () => {
    expect(kinds(PNG)).toEqual(['image', 'hex'])
    expect(kinds(new Uint8Array([0x1f, 0x8b, ...new Array(30).fill(0)]))).toEqual(['gzip', 'hex'])
    expect(kinds(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toEqual(['hex'])
    expect(kinds(encodeUtf8('{"a":1}'))).toEqual(['json', 'text', 'hex'])
    const uuidBytes = new Uint8Array([
      0xf4, 0x7a, 0xc1, 0x0b, 0x58, 0xcc, 0x43, 0x72, 0xa5, 0x67, 0x0e, 0x02, 0xb2, 0xc3, 0xd4,
      0x79,
    ])
    expect(kinds(uuidBytes, 'id', 'binary')[0]).toBe('uuid')
  })
})

describe('interpret', () => {
  it('pretty-prints JSON', async () => {
    const result = await interpret('{"a":[1,2]}', { name: 'c', type: 'json' })
    expect(result.layers.map((l) => l.kind)).toEqual(['json'])
    expect(result.rendered).toEqual({ type: 'json', text: '{\n  "a": [\n    1,\n    2\n  ]\n}' })
  })

  it('unwraps Base64 around gzip around JSON, layer by layer', async () => {
    const wrapped = toBase64(await gzip('{"deep":true,"n":1234567890123456789}'))
    const result = await interpret(wrapped, { name: 'payload', type: 'text' })
    expect(result.layers.map((l) => l.kind)).toEqual(['base64', 'gzip', 'json'])
    expect(result.rendered).toMatchObject({ type: 'json' })
    expect((result.rendered as { text: string }).text).toContain('1234567890123456789')
  })

  it('shows a decoded image', async () => {
    const result = await interpret(PNG, { name: 'avatar', type: 'blob' })
    expect(result.rendered).toMatchObject({ type: 'image', mime: 'image/png' })
  })

  it('shows the view the user asked for, not the best guess', async () => {
    const asText = await interpret('{"a":1}', { name: 'c', type: 'json' }, 'text')
    expect(asText.rendered).toEqual({ type: 'text', text: '{"a":1}' })
    const asHex = await interpret('Hi', { name: 'c', type: 'text' }, 'hex')
    expect(asHex.rendered).toMatchObject({ type: 'hex' })
  })

  it('reports a failure in words instead of throwing', async () => {
    const result = await interpret('abcdabcdabcdabcd', { name: 'c', type: 'text' }, 'gzip')
    expect(result.rendered).toMatchObject({ type: 'error' })
  })

  it('shows NULL as empty', async () => {
    expect((await interpret(null, { name: 'c', type: 'text' })).rendered).toEqual({ type: 'empty' })
  })
})
