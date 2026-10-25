/** The wire format of Redis (RESP2), for the stand-in server that tests and the smoke run talk to. */

export type Reply =
  | { k: 'status'; v: string }
  | { k: 'error'; v: string }
  | { k: 'int'; v: number }
  | { k: 'bulk'; v: Buffer | null }
  | { k: 'array'; v: Reply[] | null }
  /** The command sends nothing back, such as one that went into a transaction's queue after QUEUED. */
  | { k: 'none' }

export const status = (v: string): Reply => ({ k: 'status', v })
export const ok = (): Reply => status('OK')
export const err = (v: string): Reply => ({ k: 'error', v })
export const int = (v: number): Reply => ({ k: 'int', v })
export const bulk = (v: Buffer | string | null): Reply => ({
  k: 'bulk',
  v: v === null ? null : typeof v === 'string' ? Buffer.from(v) : v,
})
export const array = (v: Reply[] | null): Reply => ({ k: 'array', v })
export const nil = (): Reply => bulk(null)
export const bulks = (values: (Buffer | string)[]): Reply => array(values.map((v) => bulk(v)))

export function encode(reply: Reply): Buffer {
  switch (reply.k) {
    case 'status':
      return Buffer.from(`+${reply.v}\r\n`)
    case 'error':
      return Buffer.from(`-${reply.v}\r\n`)
    case 'int':
      return Buffer.from(`:${reply.v}\r\n`)
    case 'bulk':
      return reply.v === null
        ? Buffer.from('$-1\r\n')
        : Buffer.concat([Buffer.from(`$${reply.v.length}\r\n`), reply.v, Buffer.from('\r\n')])
    case 'array':
      return reply.v === null
        ? Buffer.from('*-1\r\n')
        : Buffer.concat([Buffer.from(`*${reply.v.length}\r\n`), ...reply.v.map(encode)])
    case 'none':
      return Buffer.alloc(0)
  }
}

/** Reads commands out of the bytes a client sends: arrays of bulk strings, and inline commands. */
export class CommandParser {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Buffer[][] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const commands: Buffer[][] = []
    for (;;) {
      const parsed = this.next()
      if (!parsed) break
      if (parsed.length > 0) commands.push(parsed)
    }
    return commands
  }

  private next(): Buffer[] | null {
    const buf = this.buffer
    if (buf.length === 0) return null
    if (buf[0] !== 0x2a) {
      // An inline command: one line, split on spaces.
      const end = buf.indexOf('\r\n')
      if (end === -1) return null
      this.buffer = buf.subarray(end + 2)
      return buf
        .subarray(0, end)
        .toString('latin1')
        .split(/\s+/)
        .filter(Boolean)
        .map((s) => Buffer.from(s, 'latin1'))
    }
    let pos = buf.indexOf('\r\n')
    if (pos === -1) return null
    const count = Number(buf.subarray(1, pos).toString())
    pos += 2
    const args: Buffer[] = []
    for (let i = 0; i < count; i++) {
      if (buf[pos] !== 0x24) return null
      const lineEnd = buf.indexOf('\r\n', pos)
      if (lineEnd === -1) return null
      const length = Number(buf.subarray(pos + 1, lineEnd).toString())
      const start = lineEnd + 2
      if (buf.length < start + length + 2) return null
      args.push(buf.subarray(start, start + length))
      pos = start + length + 2
    }
    this.buffer = buf.subarray(pos)
    return args
  }
}

/** A glob pattern as Redis reads it (`*`, `?`, `[a-z]`, `[^x]`, `\x`), matched against a binary string. */
export function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') out += '[\\s\\S]*'
    else if (c === '?') out += '[\\s\\S]'
    else if (c === '\\' && i + 1 < pattern.length) out += escapeRegExp(pattern[++i]!)
    else if (c === '[') {
      const close = pattern.indexOf(']', i + 2)
      if (close === -1) {
        out += '\\['
        continue
      }
      let set = pattern.slice(i + 1, close)
      const negate = set.startsWith('^')
      if (negate) set = set.slice(1)
      out += `[${negate ? '^' : ''}${set.replace(/[\\\]]/g, '\\$&')}]`
      i = close
    } else out += escapeRegExp(c)
  }
  return new RegExp(`${out}$`)
}

const escapeRegExp = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
