/**
 * Redis keys and values are byte strings, and most of them are text. DBIDE carries them as ordinary
 * strings: text as it is, and anything that is not valid UTF-8 as the marker `\u0000` followed by the
 * bytes in Base64. The marker can't start a real key by accident, because a key that really does begin
 * with U+0000 is written in the Base64 form too. Every API that takes or returns a key or a value uses
 * this form, so a binary key can be opened, copied and deleted like any other.
 */

const MARK = '\u0000'

// `ignoreBOM` keeps a byte-order mark as part of the text instead of dropping it.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The string form of some bytes. */
export function fromBytes(bytes: Uint8Array): string {
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    return MARK + toBase64(bytes)
  }
  return text.startsWith(MARK) ? MARK + toBase64(bytes) : text
}

/** The bytes a string stands for. */
export function toBytes(value: string): Uint8Array {
  return value.startsWith(MARK) ? fromBase64(value.slice(1)) : encoder.encode(value)
}

/** Whether the value is bytes that are not text. */
export const isBinary = (value: string): boolean => value.startsWith(MARK)

/** How many bytes the value is. */
export function byteLength(value: string): number {
  if (!value.startsWith(MARK)) return encoder.encode(value).length
  const encoded = value.slice(1)
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  return (encoded.length / 4) * 3 - padding
}

/**
 * The value as something to show: text as it is, and bytes the way redis-cli prints them, with `\xNN` for
 * anything that is not printable text.
 */
export function printable(value: string): string {
  if (!value.startsWith(MARK)) return value
  let out = ''
  for (const byte of fromBase64(value.slice(1))) {
    if (byte === 0x5c) out += '\\\\'
    else if (byte === 0x0a) out += '\\n'
    else if (byte === 0x0d) out += '\\r'
    else if (byte === 0x09) out += '\\t'
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte)
    else out += `\\x${byte.toString(16).padStart(2, '0')}`
  }
  return out
}

/** Binary text such as `\xff\xfe` typed by a person, back to a value. The inverse of `printable`. */
export function parseEscaped(text: string): string {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '\\' && i + 1 < text.length) {
      const next = text[i + 1]!
      if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 2, i + 4))) {
        bytes.push(parseInt(text.slice(i + 2, i + 4), 16))
        i += 3
        continue
      }
      const simple: Record<string, number> = { n: 10, r: 13, t: 9, '\\': 0x5c }
      if (next in simple) {
        bytes.push(simple[next]!)
        i += 1
        continue
      }
    }
    for (const byte of encoder.encode(String.fromCodePoint(text.codePointAt(i)!))) bytes.push(byte)
    if (text.codePointAt(i)! > 0xffff) i++
  }
  return fromBytes(Uint8Array.from(bytes))
}
