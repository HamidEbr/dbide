import type { Cell } from '@shared/query'
import { toHex } from '@shared/value'

/**
 * Everything the value viewer needs to understand a cell: what it might be, and how to show it.
 * Pure functions, no DOM, so each decoder is testable. Nothing here ever executes data.
 */

export type ViewKind =
  | 'text'
  | 'json'
  | 'jwt'
  | 'php'
  | 'timestamp'
  | 'uuid'
  | 'url'
  | 'base64'
  | 'gzip'
  | 'image'
  | 'hex'

export interface Detection {
  kind: ViewKind
  label: string
}

const LABELS: Record<ViewKind, string> = {
  text: 'Text',
  json: 'JSON',
  jwt: 'JWT',
  php: 'PHP serialize',
  timestamp: 'Timestamp',
  uuid: 'UUID',
  url: 'URL',
  base64: 'Base64',
  gzip: 'Compressed',
  image: 'Image',
  hex: 'Hex',
}

const detection = (kind: ViewKind): Detection => ({ kind, label: LABELS[kind] })

const MAX_INTERPRET_CHARS = 4_000_000
export const MAX_INFLATED_BYTES = 8 * 1024 * 1024

// ───────── bytes and text ─────────

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** The text in `bytes`, or null when it is not valid, mostly printable UTF-8. */
export function bytesToText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return ''
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  let control = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) control++
  }
  return control / text.length > 0.02 ? null : text
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

const BASE64_BODY = /^[A-Za-z0-9+/_-]+={0,2}$/

/** Decodes standard or URL-safe Base64, or returns null when the text isn't Base64. */
export function decodeBase64(text: string): Uint8Array | null {
  // Line breaks are normal in wrapped Base64; a space or tab means it is prose.
  if (/[ \t]/.test(text.trim())) return null
  const compact = text.replace(/\s+/g, '')
  if (compact.length < 4 || !BASE64_BODY.test(compact)) return null
  if (compact.replace(/=+$/, '').length % 4 === 1) return null
  const standard = compact.replace(/-/g, '+').replace(/_/g, '/')
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4)
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

export function formatByteCount(count: number): string {
  if (count < 1024) return `${count} B`
  const units = ['KB', 'MB', 'GB']
  let value = count / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** `offset  hex bytes  |ascii|` lines, like `hexdump -C`. */
export function hexdump(bytes: Uint8Array, limit = 16384): string {
  const lines: string[] = []
  const end = Math.min(bytes.length, limit)
  for (let offset = 0; offset < end; offset += 16) {
    const slice = bytes.subarray(offset, Math.min(offset + 16, end))
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0'))
    const left = hex.slice(0, 8).join(' ')
    const right = hex.slice(8).join(' ')
    const ascii = [...slice]
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
      .join('')
    lines.push(
      `${offset.toString(16).padStart(8, '0')}  ${left.padEnd(23)}  ${right.padEnd(23)}  |${ascii}|`,
    )
  }
  if (bytes.length > end) lines.push(`… ${formatByteCount(bytes.length - end)} more`)
  return lines.join('\n')
}

// ───────── compression ─────────

export const isGzip = (bytes: Uint8Array): boolean =>
  bytes.length > 18 && bytes[0] === 0x1f && bytes[1] === 0x8b

/** zlib streams start with a CMF byte and a check value that makes the pair divisible by 31. */
export const isZlib = (bytes: Uint8Array): boolean =>
  bytes.length > 6 && (bytes[0]! & 0x0f) === 8 && ((bytes[0]! << 8) | bytes[1]!) % 31 === 0

export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const format = isGzip(bytes) ? 'gzip' : 'deflate'
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_INFLATED_BYTES) {
      await reader.cancel()
      throw new Error(
        `The decompressed data is larger than ${formatByteCount(MAX_INFLATED_BYTES)}.`,
      )
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

// ───────── images ─────────

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml'

export function sniffImage(bytes: Uint8Array): ImageMime | null {
  const at = (i: number): number => bytes[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif'
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return 'image/webp'
  }
  const head = bytesToText(bytes.subarray(0, 512))
  if (head && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return null
}

const DATA_URI = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i

export function parseImageDataUri(text: string): { mime: ImageMime; bytes: Uint8Array } | null {
  const match = DATA_URI.exec(text.trim())
  if (!match) return null
  const bytes = decodeBase64(match[2]!)
  return bytes ? { mime: match[1]!.toLowerCase() as ImageMime, bytes } : null
}

// ───────── JSON ─────────

export function tryJson(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * Re-indents JSON text without parsing it, so numbers keep every digit. `JSON.stringify` would
 * round 9007199254740993 to 9007199254740992. Assumes the input is valid JSON.
 */
export function prettyJson(text: string, indent = 2): string {
  let out = ''
  let level = 0
  let i = 0
  const newline = (): string => `\n${' '.repeat(level * indent)}`
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '{' || c === '[') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] === (c === '{' ? '}' : ']')) {
        out += c + text[j]
        i = j + 1
      } else {
        level++
        out += c + newline()
        i++
      }
    } else if (c === '}' || c === ']') {
      level = Math.max(0, level - 1)
      out += newline() + c
      i++
    } else if (c === ',') {
      out += ',' + newline()
      i++
    } else if (c === ':') {
      out += ': '
      i++
    } else if (/\s/.test(c)) {
      i++
    } else {
      out += c
      i++
    }
  }
  return out
}

// ───────── JWT ─────────

export interface Claim {
  name: string
  value: string
  /** For time claims: the date it stands for. */
  time?: { iso: string; relative: string }
}

export interface DecodedJwt {
  header: string
  payload: string
  claims: Claim[]
  algorithm: string | null
  signatureBytes: number
}

const JWT_SHAPE = /^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*$/
const TIME_CLAIMS = new Set(['exp', 'nbf', 'iat'])
const CLAIM_ORDER = ['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti']

/** Decodes a JWT's header and payload. The signature is never checked. */
export function decodeJwt(token: string, now = Date.now()): DecodedJwt | null {
  const trimmed = token.trim()
  if (!JWT_SHAPE.test(trimmed)) return null
  const [h, p, s] = trimmed.split('.') as [string, string, string]
  const headerBytes = decodeBase64(h)
  const payloadBytes = decodeBase64(p)
  if (!headerBytes || !payloadBytes) return null
  const headerText = bytesToText(headerBytes)
  const payloadText = bytesToText(payloadBytes)
  if (headerText === null || payloadText === null) return null
  const header = tryJson(headerText)
  const payload = tryJson(payloadText)
  if (!header || !payload || Array.isArray(header) || Array.isArray(payload)) return null

  const payloadObject = payload as Record<string, unknown>
  const claims: Claim[] = []
  for (const name of CLAIM_ORDER) {
    if (!(name in payloadObject)) continue
    const raw = payloadObject[name]
    const claim: Claim = {
      name,
      value: typeof raw === 'string' ? raw : JSON.stringify(raw),
    }
    if (TIME_CLAIMS.has(name) && typeof raw === 'number') {
      const date = new Date(raw * 1000)
      if (!Number.isNaN(date.getTime())) {
        claim.time = { iso: date.toISOString(), relative: relativeTime(date.getTime(), now) }
      }
    }
    claims.push(claim)
  }

  const algorithm = (header as Record<string, unknown>).alg
  return {
    header: prettyJson(headerText),
    payload: prettyJson(payloadText),
    claims,
    algorithm: typeof algorithm === 'string' ? algorithm : null,
    signatureBytes: decodeBase64(s)?.length ?? 0,
  }
}

// ───────── time ─────────

export function relativeTime(target: number, now = Date.now()): string {
  const seconds = Math.round((target - now) / 1000)
  const abs = Math.abs(seconds)
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (abs < 60) return formatter.format(seconds, 'second')
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return formatter.format(Math.round(seconds / 3600), 'hour')
  if (abs < 86_400 * 30) return formatter.format(Math.round(seconds / 86_400), 'day')
  if (abs < 86_400 * 365) return formatter.format(Math.round(seconds / (86_400 * 30)), 'month')
  return formatter.format(Math.round(seconds / (86_400 * 365)), 'year')
}

export interface TimestampInfo {
  unit: 'seconds' | 'milliseconds' | 'microseconds' | 'nanoseconds'
  utc: string
  local: string
  relative: string
}

const YEAR_MIN = Date.UTC(1990, 0, 1)
const YEAR_MAX = Date.UTC(2100, 0, 1)

/** A Unix time, when the number is plausibly one (between 1990 and 2100). */
export function describeTimestamp(value: Cell, now = Date.now()): TimestampInfo | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const text = String(value).trim()
  if (!/^\d+(\.\d+)?$/.test(text)) return null

  const [whole = ''] = text.split('.')
  const units: [TimestampInfo['unit'], number][] = [
    ['seconds', 1000],
    ['milliseconds', 1],
    ['microseconds', 1 / 1000],
    ['nanoseconds', 1 / 1_000_000],
  ]
  const lengths: Record<TimestampInfo['unit'], [number, number]> = {
    seconds: [9, 10],
    milliseconds: [12, 13],
    microseconds: [15, 16],
    nanoseconds: [18, 19],
  }
  for (const [unit, toMillis] of units) {
    const [min, max] = lengths[unit]
    if (whole.length < min || whole.length > max) continue
    const ms = Number(text) * toMillis
    if (!Number.isFinite(ms) || ms < YEAR_MIN || ms > YEAR_MAX) continue
    const date = new Date(ms)
    return {
      unit,
      utc: date.toISOString(),
      local: date.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' }),
      relative: relativeTime(ms, now),
    }
  }
  return null
}

// ───────── UUID ─────────

export interface UuidInfo {
  text: string
  version: number
  variant: string
  time?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function describeUuid(text: string): UuidInfo | null {
  const trimmed = text.trim()
  if (!UUID.test(trimmed)) return null
  const hex = trimmed.replace(/-/g, '')
  const version = parseInt(hex[12]!, 16)
  const variantNibble = parseInt(hex[16]!, 16)
  const info: UuidInfo = {
    text: trimmed.toLowerCase(),
    version,
    variant: variantNibble >= 8 && variantNibble <= 11 ? 'RFC 4122 / 9562' : 'other',
  }
  if (version === 7) {
    const ms = parseInt(hex.slice(0, 12), 16)
    if (Number.isFinite(ms)) info.time = new Date(ms).toISOString()
  } else if (version === 1) {
    const low = BigInt(`0x${hex.slice(0, 8)}`)
    const mid = BigInt(`0x${hex.slice(8, 12)}`)
    const high = BigInt(`0x${hex.slice(13, 16)}`)
    const intervals = (high << 48n) | (mid << 32n) | low
    const ms = Number(intervals / 10_000n) - 12_219_292_800_000
    if (ms > 0) info.time = new Date(ms).toISOString()
  }
  return info
}

export function bytesToUuid(bytes: Uint8Array): string | null {
  if (bytes.length !== 16) return null
  const hex = toHex(bytes)
  const text = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  return UUID.test(text) ? text : null
}

// ───────── PHP serialize ─────────

/** What a PHP `serialize()` string holds, as plain data. Objects keep their class in `__class`. */
export function parsePhpSerialized(input: string | Uint8Array): unknown {
  const bytes = typeof input === 'string' ? encodeUtf8(input) : input
  const decoder = new TextDecoder('utf-8')
  let pos = 0

  const fail = (message: string): never => {
    throw new Error(`${message} at byte ${pos}`)
  }
  const expect = (char: string): void => {
    if (bytes[pos] !== char.charCodeAt(0)) fail(`Expected "${char}"`)
    pos++
  }
  const readUntil = (char: string): string => {
    const start = pos
    const code = char.charCodeAt(0)
    while (pos < bytes.length && bytes[pos] !== code) pos++
    if (pos >= bytes.length) fail('Unexpected end of data')
    const text = decoder.decode(bytes.subarray(start, pos))
    pos++
    return text
  }
  const readCount = (terminator: string): number => {
    const count = Number(readUntil(terminator))
    if (!Number.isInteger(count) || count < 0) fail('Bad length')
    return count
  }
  const readQuoted = (): string => {
    const length = readCount(':')
    expect('"')
    if (pos + length > bytes.length) fail('String runs past the end')
    const text = decoder.decode(bytes.subarray(pos, pos + length))
    pos += length
    expect('"')
    return text
  }
  const cleanName = (key: string): string =>
    key.includes('\0') ? key.slice(key.lastIndexOf('\0') + 1) : key

  const readValue = (depth: number): unknown => {
    if (depth > 64) fail('Nested too deeply')
    const type = String.fromCharCode(bytes[pos++] ?? 0)
    switch (type) {
      case 'N':
        expect(';')
        return null
      case 'b': {
        expect(':')
        return readUntil(';') === '1'
      }
      case 'i': {
        expect(':')
        return Number(readUntil(';'))
      }
      case 'd': {
        expect(':')
        const text = readUntil(';')
        return text === 'INF' || text === '-INF' || text === 'NAN' ? text : Number(text)
      }
      case 's': {
        expect(':')
        const text = readQuoted()
        expect(';')
        return text
      }
      case 'E': {
        expect(':')
        const text = readQuoted()
        expect(';')
        return text
      }
      case 'r':
      case 'R': {
        expect(':')
        return { __ref: Number(readUntil(';')) }
      }
      case 'a': {
        expect(':')
        const count = readCount(':')
        expect('{')
        const entries: [string, unknown][] = []
        for (let n = 0; n < count; n++) {
          const key = readValue(depth + 1)
          entries.push([String(key), readValue(depth + 1)])
        }
        expect('}')
        const sequential = entries.every(([key], index) => key === String(index))
        return sequential ? entries.map(([, v]) => v) : Object.fromEntries(entries)
      }
      case 'O': {
        expect(':')
        const className = (() => {
          const length = readCount(':')
          expect('"')
          const name = decoder.decode(bytes.subarray(pos, pos + length))
          pos += length
          expect('"')
          return name
        })()
        expect(':')
        const count = readCount(':')
        expect('{')
        const object: Record<string, unknown> = { __class: className }
        for (let n = 0; n < count; n++) {
          const key = String(readValue(depth + 1))
          object[cleanName(key)] = readValue(depth + 1)
        }
        expect('}')
        return object
      }
      default:
        return fail(`Unsupported type "${type}"`)
    }
  }

  const value = readValue(0)
  while (pos < bytes.length && (bytes[pos] === 10 || bytes[pos] === 13 || bytes[pos] === 32)) pos++
  if (pos !== bytes.length) fail('Extra data after the value')
  return value
}

const PHP_START = /^(a|O|s):\d+:/

export function tryPhp(text: string): unknown | undefined {
  if (!PHP_START.test(text)) return undefined
  try {
    return parsePhpSerialized(text)
  } catch {
    return undefined
  }
}

// ───────── detection ─────────

const NAME_HINT = /(_at|_on|time|date|ts|timestamp|created|updated|expires|expiry)$/i

function bytesViews(bytes: Uint8Array, column: { type: string }): Detection[] {
  if (sniffImage(bytes)) return [detection('image'), detection('hex')]
  if (isGzip(bytes) || isZlib(bytes)) return [detection('gzip'), detection('hex')]
  const views: Detection[] = []
  if (bytes.length === 16 && bytesToUuid(bytes)) views.push(detection('uuid'))
  const text = bytesToText(bytes)
  if (text !== null && text.length > 0) {
    views.push(
      ...stringViews(text, { name: '', type: column.type }).filter((d) => d.kind !== 'hex'),
    )
  }
  views.push(detection('hex'))
  return views
}

function stringViews(text: string, column: { name: string; type: string }): Detection[] {
  const views: Detection[] = []
  if (text.length > MAX_INTERPRET_CHARS) return [detection('text')]
  const trimmed = text.trim()

  if (/^eyJ/.test(trimmed) && decodeJwt(trimmed)) views.push(detection('jwt'))
  if (tryJson(trimmed) !== undefined) views.push(detection('json'))
  else if (tryPhp(trimmed) !== undefined) views.push(detection('php'))
  if (parseImageDataUri(trimmed)) views.push(detection('image'))
  if (describeUuid(trimmed)) views.push(detection('uuid'))
  if (/^https?:\/\/\S+$/i.test(trimmed)) views.push(detection('url'))

  if (trimmed.length >= 16 && !/^[0-9a-f]+$/i.test(trimmed)) {
    const decoded = decodeBase64(trimmed)
    if (decoded && (isGzip(decoded) || isZlib(decoded) || sniffImage(decoded))) {
      views.push(detection('base64'))
    } else if (decoded) {
      const inner = bytesToText(decoded)
      if (inner && inner.length >= 4) views.push(detection('base64'))
    }
  }

  if (describeTimestamp(trimmed)) {
    // Any ten-digit number could be a time; only lead with it when the column name agrees.
    if (NAME_HINT.test(column.name)) return [detection('timestamp'), ...views, detection('text')]
    return [...views, detection('text'), detection('timestamp')]
  }
  views.push(detection('text'))
  return views
}

/** The ways a value can be shown, best first. Empty for NULL. */
export function detectViews(value: Cell, column: { name: string; type: string }): Detection[] {
  if (value === null) return []
  if (value instanceof Uint8Array) return bytesViews(value, column)
  return stringViews(String(value), column)
}

// ───────── interpretation ─────────

export type Rendered =
  | { type: 'empty' }
  | { type: 'text'; text: string }
  | { type: 'json'; text: string }
  | { type: 'php'; text: string }
  | { type: 'jwt'; jwt: DecodedJwt }
  | { type: 'timestamp'; info: TimestampInfo }
  | { type: 'uuid'; info: UuidInfo }
  | { type: 'url'; url: URL }
  | { type: 'image'; mime: ImageMime; bytes: Uint8Array }
  | { type: 'hex'; bytes: Uint8Array }
  | { type: 'error'; message: string }

export interface Interpretation {
  /** The steps taken, such as Base64, then Compressed, then JSON. */
  layers: Detection[]
  rendered: Rendered
}

function fromBytes(bytes: Uint8Array): Cell {
  return bytesToText(bytes) ?? bytes
}

const MAX_LAYERS = 4

/**
 * Picks the best view of a value (or the one asked for) and, where a value wraps another
 * (Base64 of gzip of JSON), unwraps it layer by layer.
 */
export async function interpret(
  value: Cell,
  column: { name: string; type: string },
  forced?: ViewKind,
): Promise<Interpretation> {
  const layers: Detection[] = []
  let current: Cell = value

  for (let depth = 0; depth < MAX_LAYERS; depth++) {
    const views = detectViews(current, column)
    const pick =
      depth === 0 && forced ? (views.find((v) => v.kind === forced) ?? detection(forced)) : views[0]
    if (!pick) return { layers, rendered: { type: 'empty' } }
    layers.push(pick)

    try {
      switch (pick.kind) {
        case 'base64': {
          const bytes = decodeBase64(String(current).trim())
          if (!bytes)
            return { layers, rendered: { type: 'error', message: 'That isn’t valid Base64.' } }
          current = fromBytes(bytes)
          continue
        }
        case 'gzip': {
          const bytes = current instanceof Uint8Array ? current : encodeUtf8(String(current))
          current = fromBytes(await inflate(bytes))
          continue
        }
        case 'json': {
          const text = String(current).trim()
          return { layers, rendered: { type: 'json', text: prettyJson(text) } }
        }
        case 'php': {
          const parsed = parsePhpSerialized(
            current instanceof Uint8Array ? current : String(current).trim(),
          )
          return { layers, rendered: { type: 'php', text: JSON.stringify(parsed, null, 2) } }
        }
        case 'jwt': {
          const jwt = decodeJwt(String(current))
          return {
            layers,
            rendered: jwt
              ? { type: 'jwt', jwt }
              : { type: 'error', message: 'That isn’t a valid JWT.' },
          }
        }
        case 'timestamp': {
          const info = describeTimestamp(current)
          return {
            layers,
            rendered: info
              ? { type: 'timestamp', info }
              : { type: 'error', message: 'That isn’t a plausible Unix time.' },
          }
        }
        case 'uuid': {
          const text = current instanceof Uint8Array ? bytesToUuid(current) : String(current)
          const info = text ? describeUuid(text) : null
          return {
            layers,
            rendered: info
              ? { type: 'uuid', info }
              : { type: 'error', message: 'That isn’t a UUID.' },
          }
        }
        case 'url': {
          return { layers, rendered: { type: 'url', url: new URL(String(current).trim()) } }
        }
        case 'image': {
          if (current instanceof Uint8Array) {
            const mime = sniffImage(current)
            if (mime) return { layers, rendered: { type: 'image', mime, bytes: current } }
          } else {
            const parsed = parseImageDataUri(String(current))
            if (parsed) return { layers, rendered: { type: 'image', ...parsed } }
          }
          return { layers, rendered: { type: 'error', message: 'That isn’t an image.' } }
        }
        case 'hex': {
          const bytes = current instanceof Uint8Array ? current : encodeUtf8(String(current))
          return { layers, rendered: { type: 'hex', bytes } }
        }
        case 'text':
          return {
            layers,
            rendered: {
              type: 'text',
              text: current instanceof Uint8Array ? `0x${toHex(current)}` : String(current),
            },
          }
      }
    } catch (error) {
      return {
        layers,
        rendered: {
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }
  return { layers, rendered: { type: 'error', message: 'Too many layers to unwrap.' } }
}
