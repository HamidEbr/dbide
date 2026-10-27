import { insideLiteral, maskLiterals, splitStatements } from './sql'

/**
 * What belongs at the cursor of a SQL script: a table, a column of the tables the statement reads, a database,
 * a keyword. Autocomplete asks this and then looks the names up. It reads the statement with a small
 * tokenizer, not a full parser, so it answers well for everyday statements and says "keyword" or "nothing"
 * when it can't tell, rather than guessing a wrong name.
 */

export interface TableRef {
  database: string | null
  table: string
  alias: string | null
}

export type Clause = 'select' | 'where' | 'on' | 'group' | 'having' | 'set' | 'using' | 'insert'

interface Typed {
  /** The part of the name already typed. */
  prefix: string
  /** Where the typed part starts in the script; what a choice replaces runs from here to the cursor. */
  from: number
  /** A backtick was typed before the name, so a choice must not open another. */
  quoted: boolean
}

export type SqlContext =
  | ({ kind: 'database' } & Typed)
  /** A table or view. `qualifier` is the database typed before the dot, if any. */
  | ({
      kind: 'table'
      qualifier: string | null
      /** Where the `db.` typed before the name starts, so a choice can rewrite it whole. Null with no qualifier. */
      qualifierFrom: number | null
      /** A table here can take an alias (FROM, JOIN, UPDATE), unlike INSERT INTO, DELETE FROM or DROP TABLE. */
      aliasable: boolean
      /** The aliases and table names the statement already uses, in lower case, which a new alias must not repeat. */
      taken: string[]
    } & Typed)
  /**
   * A column. `qualifier` is what was typed before the dot (an alias, a table, or a database), with
   * `qualifierDatabase` when two names were typed (`shop.orders.`). `tables` are the tables the statement reads.
   */
  | ({
      kind: 'column'
      clause: Clause
      qualifier: string | null
      qualifierDatabase: string | null
      tables: TableRef[]
    } & Typed)
  /** Somewhere a keyword or function goes. */
  | ({ kind: 'keyword'; atStart: boolean } & Typed)
  | { kind: 'none' }

interface Token {
  text: string
  /** Upper-case, for a word; the name without backticks, for a quoted name. */
  value: string
  type: 'word' | 'quoted' | 'punct'
  start: number
  end: number
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const re = /`((?:[^`]|``)*)`?|([A-Za-z_$][\w$]*)|(\d+[\w$]*)|(\S)/g
  for (const match of text.matchAll(re)) {
    const start = match.index
    const raw = match[0]
    if (match[1] !== undefined) {
      tokens.push({
        text: raw,
        value: match[1].replace(/``/g, '`'),
        type: 'quoted',
        start,
        end: start + raw.length,
      })
    } else if (match[2] !== undefined) {
      tokens.push({
        text: raw,
        value: raw.toUpperCase(),
        type: 'word',
        start,
        end: start + raw.length,
      })
    } else if (match[3] !== undefined) {
      tokens.push({ text: raw, value: raw, type: 'punct', start, end: start + raw.length })
    } else {
      tokens.push({ text: raw, value: raw, type: 'punct', start, end: start + raw.length })
    }
  }
  return tokens
}

/** Words that can follow a table name without being its alias. */
const NOT_AN_ALIAS = new Set([
  'WHERE',
  'ON',
  'USING',
  'SET',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'CROSS',
  'NATURAL',
  'STRAIGHT_JOIN',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'UNION',
  'FOR',
  'LOCK',
  'VALUES',
  'VALUE',
  'SELECT',
  'PARTITION',
  'FORCE',
  'USE',
  'IGNORE',
  'WINDOW',
  'INTO',
  'FROM',
  'DEFAULT',
  'LIKE',
  'WITH',
  'AS',
  'OFFSET',
  'EXCEPT',
  'INTERSECT',
])

const isName = (token: Token | undefined): token is Token =>
  token !== undefined &&
  (token.type === 'quoted' || (token.type === 'word' && !NOT_AN_ALIAS.has(token.value)))

const isPunct = (token: Token | undefined, text: string): boolean =>
  token !== undefined && token.type === 'punct' && token.text === text

/** Reads `name`, `db.name` and an optional alias starting at token `i`. Returns the end index too. */
function readRef(tokens: Token[], i: number): { ref: TableRef; next: number } | null {
  const first = tokens[i]
  if (!(
    first &&
    (first.type === 'quoted' || first.type === 'word') &&
    !(first.type === 'word' && NOT_AN_ALIAS.has(first.value))
  )) {
    return null
  }
  let database: string | null = null
  let table = tokens[i]!.type === 'quoted' ? tokens[i]!.value : tokens[i]!.text
  let next = i + 1
  if (
    isPunct(tokens[next], '.') &&
    (tokens[next + 1]?.type === 'quoted' || tokens[next + 1]?.type === 'word')
  ) {
    database = table
    const second = tokens[next + 1]!
    table = second.type === 'quoted' ? second.value : second.text
    next += 2
  }
  let alias: string | null = null
  if (tokens[next]?.type === 'word' && tokens[next]!.value === 'AS' && isName(tokens[next + 1])) {
    alias = tokens[next + 1]!.type === 'quoted' ? tokens[next + 1]!.value : tokens[next + 1]!.text
    next += 2
  } else if (isName(tokens[next])) {
    alias = tokens[next]!.type === 'quoted' ? tokens[next]!.value : tokens[next]!.text
    next += 1
  }
  return { ref: { database, table, alias }, next }
}

/** Every table the statement reads or writes, wherever the cursor is in it. */
export function tableRefs(tokens: Token[]): TableRef[] {
  const refs: TableRef[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.type !== 'word') continue
    const list = t.value === 'FROM' || t.value === 'UPDATE'
    const single =
      t.value === 'JOIN' ||
      (t.value === 'INTO' && !['OUTFILE', 'DUMPFILE'].includes(tokens[i + 1]?.value ?? ''))
    if (!list && !single) continue
    let at = i + 1
    // UPDATE LOW_PRIORITY IGNORE t
    while (
      tokens[at]?.type === 'word' &&
      (tokens[at]!.value === 'LOW_PRIORITY' || tokens[at]!.value === 'IGNORE')
    )
      at++
    for (;;) {
      const read = readRef(tokens, at)
      if (!read) break
      refs.push(read.ref)
      at = read.next
      if (list && isPunct(tokens[at], ',')) {
        at++
        continue
      }
      break
    }
  }
  return refs
}

const TABLE_KEYWORDS = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE'])
const COLUMN_CLAUSES: Record<string, Clause> = {
  SELECT: 'select',
  WHERE: 'where',
  ON: 'on',
  BY: 'group',
  HAVING: 'having',
  SET: 'set',
  USING: 'using',
}

/** What can sit between a table keyword and the name of the table without being part of it. */
const TABLE_MODIFIERS = new Set([
  'LOW_PRIORITY',
  'IGNORE',
  'IF',
  'EXISTS',
  'NOT',
  'ONLY',
  'LATERAL',
])

export function analyzeSql(script: string, offset: number): SqlContext {
  if (insideLiteral(script, offset)) return { kind: 'none' }

  // The statement the cursor is in: the last one that starts before it, unless a `;` came in between, which starts
  // a new, empty one. A statement's own end leaves out the whitespace after it, which the cursor may be in.
  const statements = splitStatements(script)
  let statement = statements.filter((s) => s.from <= offset).at(-1)
  if (statement && offset > statement.to && script.slice(statement.to, offset).includes(';')) {
    statement = undefined
  }
  const base = statement ? statement.from : offset
  const text = statement
    ? maskLiterals(script).slice(statement.from, Math.max(statement.to, offset))
    : ''
  const rel = offset - base

  const before = text.slice(0, rel)
  // Inside a quoted name when there is an odd number of backticks before the cursor.
  const ticks = (before.match(/`/g) ?? []).length
  const quoted = ticks % 2 === 1
  let prefix: string
  let wordStart: number
  if (quoted) {
    wordStart = before.lastIndexOf('`') + 1
    prefix = before.slice(wordStart)
  } else {
    prefix = /[\w$]*$/.exec(before)![0]
    wordStart = rel - prefix.length
  }
  const typed: Typed = { prefix, from: base + wordStart, quoted }

  // `name.` or `db.name.` just before the word.
  let head = before.slice(0, quoted ? wordStart - 1 : wordStart)
  let qualifier: string | null = null
  let qualifierDatabase: string | null = null
  let qualifierFrom: number | null = null
  const name = '(`(?:[^`]|``)*`|[A-Za-z_$][\\w$]*)'
  const dotted = new RegExp(`(?:${name}\\s*\\.\\s*)?${name}\\s*\\.\\s*$`).exec(head)
  if (dotted) {
    const unquote = (s: string): string =>
      s.startsWith('`') ? s.slice(1, -1).replace(/``/g, '`') : s
    qualifier = unquote(dotted[2]!)
    qualifierDatabase = dotted[1] ? unquote(dotted[1]) : null
    qualifierFrom = base + dotted.index
    head = head.slice(0, dotted.index)
  }

  const tokens = tokenize(text)
  // The tokens before the name being typed, which say what kind of name it is.
  const earlier = tokens.filter((t) => t.end <= head.length)
  const refs = tableRefs(tokens)
  const takenNames = refs.flatMap((r) => [
    r.table.toLowerCase(),
    ...(r.alias ? [r.alias.toLowerCase()] : []),
  ])

  if (earlier.length === 0) {
    return qualifier ? { kind: 'none' } : { kind: 'keyword', atStart: true, ...typed }
  }

  // USE db
  if (earlier.length === 1 && earlier[0]!.value === 'USE' && !qualifier)
    return { kind: 'database', ...typed }
  // DESCRIBE t, EXPLAIN t, DESC t
  if (
    earlier.length === 1 &&
    ['DESCRIBE', 'DESC', 'EXPLAIN'].includes(earlier[0]!.value) &&
    earlier[0]!.type === 'word'
  ) {
    return {
      kind: 'table',
      qualifier,
      qualifierFrom,
      aliasable: false,
      taken: takenNames,
      ...typed,
    }
  }

  // INSERT INTO t ( | , — the columns of t.
  let depth = 0
  for (let i = earlier.length - 1; i >= 0; i--) {
    const t = earlier[i]!
    if (isPunct(t, ')')) depth++
    else if (isPunct(t, '(')) {
      if (depth > 0) {
        depth--
        continue
      }
      // The unmatched bracket: is it the column list of an INSERT or REPLACE?
      const nameToken = earlier[i - 1]
      if (nameToken && (nameToken.type === 'quoted' || nameToken.type === 'word')) {
        const hasDot = isPunct(earlier[i - 2], '.')
        const intoAt = hasDot ? i - 4 : i - 2
        const into = earlier[intoAt]
        if (into?.type === 'word' && into.value === 'INTO') {
          const dbToken = hasDot ? earlier[i - 3] : undefined
          const tableText = nameToken.type === 'quoted' ? nameToken.value : nameToken.text
          return {
            kind: 'column',
            clause: 'insert',
            qualifier,
            qualifierDatabase,
            tables: [
              {
                database: dbToken
                  ? dbToken.type === 'quoted'
                    ? dbToken.value
                    : dbToken.text
                  : null,
                table: tableText,
                alias: null,
              },
            ],
            ...typed,
          }
        }
      }
      break
    }
  }

  // The nearest clause keyword before the cursor says what comes next.
  for (let i = earlier.length - 1; i >= 0; i--) {
    const t = earlier[i]!
    if (t.type !== 'word') continue
    if (TABLE_KEYWORDS.has(t.value)) {
      // After the keyword, a table is being named, unless one is already complete (then a keyword follows).
      const after = earlier.slice(i + 1)
      let start = 0
      for (let j = after.length - 1; j >= 0; j--) {
        if ((t.value === 'FROM' || t.value === 'UPDATE') && isPunct(after[j], ',')) {
          start = j + 1
          break
        }
      }
      const pending = after
        .slice(start)
        .filter((x) => !(x.type === 'word' && TABLE_MODIFIERS.has(x.value)))
      if (pending.length === 0) {
        // A table can take an alias after FROM (but not in DELETE FROM), after JOIN, and after UPDATE.
        const aliasable =
          t.value === 'JOIN' ||
          t.value === 'UPDATE' ||
          (t.value === 'FROM' && earlier[0]?.value !== 'DELETE')
        return { kind: 'table', qualifier, qualifierFrom, aliasable, taken: takenNames, ...typed }
      }
      return qualifier ? { kind: 'none' } : { kind: 'keyword', atStart: false, ...typed }
    }
    const clause = COLUMN_CLAUSES[t.value]
    if (clause) {
      // `SET` in `SET NAMES utf8` or `SET @x = 1` is not an UPDATE's SET.
      if (clause === 'set' && refs.length === 0) return { kind: 'none' }
      // BY only means columns after GROUP or ORDER (PARTITION BY too).
      return { kind: 'column', clause, qualifier, qualifierDatabase, tables: refs, ...typed }
    }
    if (['LIMIT', 'OFFSET', 'VALUES', 'VALUE', 'AS', 'LIKE'].includes(t.value))
      return { kind: 'none' }
  }
  return qualifier ? { kind: 'none' } : { kind: 'keyword', atStart: false, ...typed }
}

/** Whether a name just completed already has an alias after it: the next word is a name, not a keyword. */
export function aliasFollows(textAfter: string): boolean {
  // `AS o` is an alias too, whatever the name after it.
  if (/^[\w$]*\s+AS\s+(`[^`]*`|[A-Za-z_$][\w$]*)/i.test(textAfter)) return true
  const match = /^[\w$]*\s+(`[^`]*`|[A-Za-z_$][\w$]*)/.exec(textAfter)
  if (!match) return false
  const word = match[1]!
  return word.startsWith('`') || !NOT_AN_ALIAS.has(word.toUpperCase())
}

const RESERVED_ALIASES = new Set([
  'AS',
  'BY',
  'DO',
  'IF',
  'IN',
  'IS',
  'ON',
  'OR',
  'TO',
  'AND',
  'ASC',
  'ALL',
  'FOR',
  'KEY',
  'NOT',
  'SET',
  'USE',
  'ROW',
  'OUT',
  'MOD',
  'XOR',
  'END',
  'DIV',
  'INT',
  'NO',
  'OF',
])

/** The words of a table name: `order_items` and `OrderItems` are both order and items. */
function nameWords(table: string): string[] {
  return table
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
}

/**
 * A short alias for a table: its initials (`order_items` → `oi`, `Cities` → `c`), longer when that is taken, and
 * numbered as a last resort. `taken` holds the aliases and table names the statement already uses, in lower case.
 */
export function suggestAlias(table: string, taken: ReadonlySet<string>): string {
  const words = nameWords(table).map((w) => w.toLowerCase())
  const initials =
    words
      .map((w) => w[0])
      .join('')
      .slice(0, 3) || 't'
  const first = words[0] ?? 't'
  const candidates = [initials]
  // More letters of the first word: c, ci, cit, …
  for (let n = 2; n <= Math.min(first.length, 4); n++)
    candidates.push(first.slice(0, n) + initials.slice(1))
  const ok = (a: string): boolean =>
    !taken.has(a) && !RESERVED_ALIASES.has(a.toUpperCase()) && /^[a-z_]/.test(a)
  for (const candidate of candidates) if (ok(candidate)) return candidate
  for (let n = 2; ; n++) if (ok(`${initials}${n}`)) return `${initials}${n}`
}
