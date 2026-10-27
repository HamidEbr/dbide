import { commandCatalog, describeCommand, tokenize } from '@shared/redis/command'
import type { RedisReply } from '@shared/redis/types'

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\u0007': '\\a',
  '\b': '\\b',
}

/** A string the way redis-cli prints it: in quotes, with what can't be seen written out. */
function quote(text: string, alreadyEscaped: boolean): string {
  if (alreadyEscaped) return `"${text.replace(/"/g, '\\"')}"`
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    out +=
      ESCAPES[ch] ??
      (code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : ch)
  }
  return `"${out}"`
}

/** A reply as lines of text, laid out as redis-cli lays out the same reply. */
export function formatReply(reply: RedisReply): string[] {
  switch (reply.t) {
    case 'status':
      return [reply.text]
    case 'error':
      return [`(error) ${reply.text}`]
    case 'int':
      return [`(integer) ${reply.value}`]
    case 'nil':
      return ['(nil)']
    case 'bulk':
      return [
        `${quote(reply.text, reply.binary)}${reply.truncated ? ` … (${reply.bytes.toLocaleString()} bytes in all)` : ''}`,
      ]
    case 'array': {
      if (reply.items.length === 0 && reply.omitted === 0) return ['(empty array)']
      const width = String(reply.items.length).length
      const lines: string[] = []
      reply.items.forEach((item, i) => {
        const prefix = `${String(i + 1).padStart(width)}) `
        const inner = formatReply(item)
        lines.push(`${prefix}${inner[0]}`)
        for (const rest of inner.slice(1)) lines.push(`${' '.repeat(prefix.length)}${rest}`)
      })
      if (reply.omitted > 0) lines.push(`… ${reply.omitted.toLocaleString()} more`)
      return lines
    }
  }
}

export interface Completion {
  /** What to type. */
  text: string
  syntax: string
}

/**
 * Commands that complete what has been typed: first words while the first word is being typed, and
 * whole `CONFIG GET` style names once it has a space. Nothing once an argument is being typed.
 */
export function completions(line: string): { from: number; items: Completion[] } {
  const start = line.length - line.trimStart().length
  const typed = line.slice(start).replace(/\s+/g, (m) => (m.length > 0 ? ' ' : m))
  if (typed === '') return { from: start, items: [] }
  const upper = typed.toUpperCase()
  // After a second word, it is arguments.
  if ((upper.match(/ /g)?.length ?? 0) > 1 || (upper.endsWith(' ') && upper.trim().includes(' '))) {
    return { from: start, items: [] }
  }
  const catalog = commandCatalog()
  const items: Completion[] = []
  const seen = new Set<string>()
  if (!upper.includes(' ')) {
    for (const entry of catalog) {
      const first = entry.name.split(' ')[0]!
      if (!first.startsWith(upper) || seen.has(first)) continue
      seen.add(first)
      const hasSubcommands = catalog.some((e) => e.name.startsWith(`${first} `))
      items.push({ text: first, syntax: hasSubcommands ? '…' : entry.syntax })
    }
  } else {
    for (const entry of catalog) {
      if (entry.name.startsWith(upper) && entry.name.includes(' ')) {
        items.push({ text: entry.name, syntax: entry.syntax })
      }
    }
  }
  // A line that already is exactly one command has nothing left to complete, unless it opens more.
  if (items.length === 1 && items[0]!.text === upper.trim() && items[0]!.syntax !== '…') {
    return { from: start, items: [] }
  }
  return { from: start, items: items.slice(0, 8) }
}

/** The arguments of a syntax, with an optional group kept whole: `key [NX | XX] value` → three words. */
export function syntaxWords(syntax: string): string[] {
  const words: string[] = []
  let depth = 0
  let word = ''
  for (const ch of syntax) {
    if (ch === '[') depth++
    if (ch === ']') depth = Math.max(0, depth - 1)
    if (ch === ' ' && depth === 0) {
      if (word) words.push(word)
      word = ''
    } else word += ch
  }
  if (word) words.push(word)
  return words
}

export interface Hint {
  name: string
  words: string[]
  /** Which of `words` the cursor is on. */
  active: number
}

/** What to show while a command is being typed: its name and arguments, with the current one marked. */
export function hintFor(line: string): Hint | null {
  const parsed = tokenize(line)
  if (!parsed.ok || parsed.args.length === 0) return null
  const info = describeCommand(parsed.args)
  if (info.kind === 'unknown') return null
  const nameWords = info.name.split(' ').length
  const words = syntaxWords(info.syntax)
  if (words.length === 0) return { name: info.name, words, active: -1 }
  const typedArgs = Math.max(0, parsed.args.length - nameWords)
  // A line that ends in a space is already on the next argument.
  const consumed = /\s$/.test(line) ? typedArgs : Math.max(0, typedArgs - 1)
  const lastIsRepeat = words[words.length - 1]!.includes('...')
  const active = consumed < words.length ? consumed : lastIsRepeat ? words.length - 1 : -1
  return { name: info.name, words, active }
}

/** The words of a command's syntax that stand for a key. */
const KEY_WORDS = /^\[?(key|newkey|source|destination|srckey|dstkey|key1|key2)\b/i

/**
 * The key being typed as an argument, when the cursor is on one: where it starts, what is typed of it, and the
 * quote it was opened with. Null for a command name, another kind of argument, or a key with escapes in it.
 */
export function keyArgument(
  line: string,
): { from: number; prefix: string; quote: string | null } | null {
  const match = /(?:^|\s)(["']?)([^\s"'\\]*)$/.exec(line)
  if (!match) return null
  // An open quote can't be read as a command yet, so the hint is asked about the line with it closed.
  const hint = hintFor(match[1] ? line + match[1] : line)
  if (!hint || hint.active < 0 || !KEY_WORDS.test(hint.words[hint.active]!)) return null
  const quote = match[1] || null
  return {
    from: match.index + match[0].length - match[1]!.length - match[2]!.length,
    prefix: match[2]!,
    quote,
  }
}

/** A key as it is typed in a command: bare when it can be, in quotes when it has a space, a quote or a backslash. */
export function keyText(key: string, quoted = false): string {
  return !quoted && /^[^\s"'\\]+$/.test(key) ? key : `"${key.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

const STORAGE_KEY = 'dbide.redis.history'
const HISTORY_LIMIT = 500

/** The lines a person has run, newest last, remembered between sessions. */
export class CommandHistory {
  private lines: string[]
  private cursor: number

  constructor() {
    this.lines = this.load()
    this.cursor = this.lines.length
  }

  private load(): string[] {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === 'string') : []
    } catch {
      return []
    }
  }

  push(line: string): void {
    if (this.lines[this.lines.length - 1] !== line) this.lines.push(line)
    if (this.lines.length > HISTORY_LIMIT) this.lines.splice(0, this.lines.length - HISTORY_LIMIT)
    this.cursor = this.lines.length
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.lines))
    } catch {
      // Remembering is a convenience.
    }
  }

  /** The line before the one on screen, or null at the oldest. */
  previous(): string | null {
    if (this.cursor === 0) return null
    this.cursor--
    return this.lines[this.cursor] ?? null
  }

  /** The line after, or an empty line once past the newest. Null when already there. */
  next(): string | null {
    if (this.cursor >= this.lines.length) return null
    this.cursor++
    return this.lines[this.cursor] ?? ''
  }

  reset(): void {
    this.cursor = this.lines.length
  }

  all(): readonly string[] {
    return this.lines
  }
}
