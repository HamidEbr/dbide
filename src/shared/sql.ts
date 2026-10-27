/**
 * Plain-TypeScript SQL helpers shared by the editor (which statement is under the cursor) and
 * the core (what a statement does). They understand MySQL lexical rules — quotes, backticks,
 * comments, `DELIMITER` — but are not a parser.
 */

type SegmentKind = 'code' | 'comment' | 'string' | 'identifier' | 'hint'

interface Segment {
  kind: SegmentKind
  start: number
  end: number
}

/**
 * Cuts the text into runs of code, comments, string literals, quoted identifiers, and
 * executable comments (the `/*!` form, which MySQL runs, so it counts as code that must not be
 * split).
 */
function scan(sql: string): Segment[] {
  const segments: Segment[] = []
  const n = sql.length
  let codeStart = 0
  let i = 0

  const flush = (end: number): void => {
    if (end > codeStart) segments.push({ kind: 'code', start: codeStart, end })
  }
  const push = (kind: SegmentKind, start: number, end: number): void => {
    flush(start)
    segments.push({ kind, start, end })
    codeStart = end
    i = end
  }
  const lineEnd = (from: number): number => {
    const newline = sql.indexOf('\n', from)
    return newline === -1 ? n : newline
  }
  const quoted = (from: number, quote: string, backslashEscapes: boolean): number => {
    let j = from + 1
    while (j < n) {
      const c = sql[j]
      if (backslashEscapes && c === '\\') j += 2
      else if (c === quote) {
        if (sql[j + 1] === quote) j += 2
        else return j + 1
      } else j++
    }
    return n
  }

  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-' && (i + 2 >= n || /\s/.test(sql[i + 2]!))) {
      push('comment', i, lineEnd(i))
    } else if (c === '#') {
      push('comment', i, lineEnd(i))
    } else if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      push(sql[i + 2] === '!' ? 'hint' : 'comment', i, end)
    } else if (c === "'" || c === '"') {
      push('string', i, quoted(i, c, true))
    } else if (c === '`') {
      push('identifier', i, quoted(i, '`', false))
    } else {
      i++
    }
  }
  flush(n)
  return segments
}

const isSpace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12

export interface SqlStatement {
  /** The statement without the terminator and without surrounding whitespace or comments. */
  text: string
  /** Offset of the first character of `text`. */
  from: number
  /** Offset just past the last character of `text`. */
  to: number
  /** Offset just past the terminator (or the end of the input for the last statement). */
  end: number
}

const DELIMITER_COMMAND = /^delimiter[ \t]+(\S+)/i

/**
 * Splits a script into statements the way the `mysql` client does: on `;`, ignoring semicolons
 * inside strings, comments, and quoted identifiers, and honoring `DELIMITER` for stored programs.
 * Statements that are only comments are dropped.
 */
export function splitStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = []
  let delimiter = ';'
  let first = -1
  let last = -1

  const noteContent = (from: number, to: number): void => {
    let a = from
    while (a < to && isSpace(sql.charCodeAt(a))) a++
    if (a >= to) return
    let b = to
    while (b > a && isSpace(sql.charCodeAt(b - 1))) b--
    if (first === -1) first = a
    last = b
  }
  const emit = (end: number): void => {
    if (first !== -1) {
      statements.push({ text: sql.slice(first, last), from: first, to: last, end })
    }
    first = -1
    last = -1
  }

  for (const segment of scan(sql)) {
    if (segment.kind === 'comment') continue
    if (segment.kind !== 'code') {
      noteContent(segment.start, segment.end)
      continue
    }

    let pos = segment.start
    while (pos < segment.end) {
      if (first === -1) {
        let p = pos
        while (p < segment.end && isSpace(sql.charCodeAt(p))) p++
        const newline = sql.indexOf('\n', p)
        const lineEnd = newline === -1 ? sql.length : newline
        const command = DELIMITER_COMMAND.exec(sql.slice(p, lineEnd))
        if (command) {
          delimiter = command[1]!
          pos = lineEnd
          continue
        }
      }

      const at = sql.indexOf(delimiter, pos)
      if (at === -1 || at + delimiter.length > segment.end) {
        noteContent(pos, segment.end)
        break
      }
      noteContent(pos, at)
      emit(at + delimiter.length)
      pos = at + delimiter.length
    }
  }
  emit(sql.length)
  return statements
}

/**
 * The statement the cursor belongs to. In the gap between statements it picks the one above,
 * because that is usually the one the user just finished typing.
 */
export function statementAt(statements: SqlStatement[], offset: number): SqlStatement | null {
  if (statements.length === 0) return null
  const inside = statements.find((s) => offset >= s.from && offset < s.end)
  if (inside) return inside
  const touching = statements.find((s) => offset >= s.from && offset <= s.end)
  if (touching) return touching
  let previous: SqlStatement | undefined
  for (const statement of statements) if (statement.end < offset) previous = statement
  return previous ?? statements[0]!
}

/** Replaces comments, strings, and quoted names with spaces, keeping offsets. For keyword checks. */
export function maskSql(sql: string): string {
  let masked = ''
  for (const segment of scan(sql)) {
    const text = sql.slice(segment.start, segment.end)
    masked +=
      segment.kind === 'code' || segment.kind === 'hint' ? text : text.replace(/[^\n]/g, ' ')
  }
  return masked
}

/** Like `maskSql`, but quoted names such as `orders` stay, because autocomplete has to read them. */
export function maskLiterals(sql: string): string {
  let masked = ''
  for (const segment of scan(sql)) {
    const text = sql.slice(segment.start, segment.end)
    masked +=
      segment.kind === 'string' || segment.kind === 'comment' ? text.replace(/[^\n]/g, ' ') : text
  }
  return masked
}

/** Whether the offset is inside a string or a comment, where names are not completed. */
export function insideLiteral(sql: string, offset: number): boolean {
  for (const segment of scan(sql)) {
    if (segment.kind !== 'string' && segment.kind !== 'comment') continue
    // Just after the opening mark is inside; just after the closing one is not, unless it never closed.
    if (offset > segment.start && offset < segment.end) return true
    if (offset === segment.end && segment.end === sql.length && segment.kind === 'string') {
      const text = sql.slice(segment.start, segment.end)
      return text.length < 2 || text[text.length - 1] !== text[0]
    }
    if (
      offset === segment.end &&
      segment.kind === 'comment' &&
      !sql.slice(segment.start, segment.end).endsWith('*/')
    ) {
      return true
    }
  }
  return false
}

export type StatementKind =
  'read' | 'write' | 'ddl' | 'admin' | 'transaction' | 'session' | 'unknown'

export interface StatementInfo {
  kind: StatementKind
  /** Removes or rewrites data in a way that is hard to undo. */
  destructive: boolean
  /** Why the statement is destructive, in words fit for a confirmation dialog. */
  reason?: string
}

const READ = new Set(['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN', 'VALUES', 'TABLE', 'HELP'])
const WRITE = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'LOAD', 'CALL', 'DO', 'HANDLER'])
const DDL = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'])
const ADMIN = new Set([
  'GRANT',
  'REVOKE',
  'FLUSH',
  'KILL',
  'OPTIMIZE',
  'ANALYZE',
  'REPAIR',
  'LOCK',
  'UNLOCK',
  'INSTALL',
  'UNINSTALL',
  'SHUTDOWN',
  'RESET',
  'PURGE',
  'CHECK',
  'CHECKSUM',
])
const TRANSACTION = new Set(['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'XA'])
const SESSION = new Set(['USE', 'SET', 'PREPARE', 'EXECUTE', 'DEALLOCATE'])

/** What a single statement does, so the app can guard writes on production connections. */
export function classifyStatement(statement: string): StatementInfo {
  const masked = maskSql(statement)
  const keyword = /^[\s(]*([A-Za-z]+)/.exec(masked)?.[1]?.toUpperCase()
  if (!keyword) return { kind: 'unknown', destructive: false }

  const hasWhere = /\bWHERE\b/i.test(masked)

  if (keyword === 'DELETE' || keyword === 'UPDATE') {
    return {
      kind: 'write',
      destructive: !hasWhere,
      ...(hasWhere ? {} : { reason: `${keyword} without a WHERE clause affects every row.` }),
    }
  }
  if (keyword === 'TRUNCATE') {
    return {
      kind: 'ddl',
      destructive: true,
      reason: 'TRUNCATE removes every row and can’t be rolled back.',
    }
  }
  if (keyword === 'DROP') {
    return { kind: 'ddl', destructive: true, reason: 'DROP permanently removes the object.' }
  }
  if (keyword === 'ALTER' && /\bDROP\b/i.test(masked)) {
    return {
      kind: 'ddl',
      destructive: true,
      reason: 'This ALTER drops a column, index, or constraint.',
    }
  }
  if (keyword === 'WITH') {
    // A CTE can sit in front of a write.
    return {
      kind: /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(masked) ? 'write' : 'read',
      destructive: false,
    }
  }

  if (READ.has(keyword)) return { kind: 'read', destructive: false }
  if (WRITE.has(keyword)) return { kind: 'write', destructive: false }
  if (DDL.has(keyword)) return { kind: 'ddl', destructive: false }
  if (ADMIN.has(keyword)) return { kind: 'admin', destructive: false }
  if (TRANSACTION.has(keyword)) return { kind: 'transaction', destructive: false }
  if (SESSION.has(keyword)) return { kind: 'session', destructive: false }
  return { kind: 'unknown', destructive: false }
}

/** Statements that cannot change data, so they are safe on a read-only connection. */
export function isReadOnlySafe(info: StatementInfo): boolean {
  return info.kind === 'read' || info.kind === 'session' || info.kind === 'transaction'
}
