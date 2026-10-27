import {
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { dialectInfo, type SqlDialect } from '@shared/dialect'
import type { SchemaDetail, SchemaForeignKey, SchemaTable } from '@shared/driver'
import {
  aliasFollows,
  analyzeSql,
  suggestAlias,
  type SqlContext,
  type TableRef,
} from '@shared/sql-context'
import type { SchemaCache } from './schema-cache'

/** The most a first completion waits for a schema that is still being read. */
const LOAD_WAIT_MS = 3000
/** Names past this many are left out of one popup; typing more narrows it anyway. */
const MAX_OPTIONS = 4000

/** Words that need quoting to be used as a name. */
const RESERVED = new Set(
  (
    'ADD ALL ALTER AND AS ASC BETWEEN BY CASE COLUMN CREATE CROSS DATABASE DEFAULT DELETE DESC DISTINCT DROP ELSE ' +
    'EXISTS FOR FOREIGN FROM GROUP HAVING IF IN INDEX INNER INSERT INTO IS JOIN KEY LEFT LIKE LIMIT NOT NULL ON OR ' +
    'ORDER OUTER PRIMARY RANGE REFERENCES RIGHT SELECT SET TABLE THEN TO UNION UNIQUE UPDATE USING VALUES WHEN WHERE ' +
    'WITH RANK GROUPS ROW ROWS SYSTEM'
  ).split(' '),
)

const quoted = (name: string, dialect: SqlDialect = 'mysql'): string =>
  dialectInfo(dialect).quote(name)

/** The name as it is written when it needs no quotes: PostgreSQL folds capitals, so a name with one needs them. */
const quoteIfNeeded = (name: string, dialect: SqlDialect = 'mysql'): string => {
  const plain =
    dialect === 'postgresql' ? /^[a-z_][a-z0-9_$]*$/.test(name) : /^[A-Za-z_][\w$]*$/.test(name)
  return plain && !RESERVED.has(name.toUpperCase()) ? name : quoted(name, dialect)
}

/** The character that closes a quoted name, which the editor adds when the opening one is typed. */
const closer = (dialect: SqlDialect = 'mysql'): string =>
  dialect === 'postgresql' ? '"' : dialect === 'mssql' ? ']' : '`'

export interface CompletionEnv {
  connectionId: string
  /** The database the script runs in, or null when it hasn't picked one. */
  database: () => string | null
  cache: SchemaCache
  /** Write names in full: `db`.`table` alias, and `alias`.`column`. */
  fullPaths?: () => boolean
  /** The server's SQL, for how names are quoted. MySQL when missing. */
  dialect?: () => SqlDialect
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** The database a script is in: the one it was given, or the last `USE` it has typed. */
export function currentDatabase(env: CompletionEnv, doc: string, upTo: number): string | null {
  const used = [...doc.slice(0, upTo).matchAll(/\bUSE\s+`?([\w$]+)`?\s*;/gi)].at(-1)
  return used ? used[1]! : env.database()
}

const wait = <T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])

/**
 * Replaces the typed name with a full one. The range reaches back over the `db.` typed before the name and an
 * opening backtick, and forward over the closing backtick the editor added, so nothing is left doubled.
 */
function writeOver(
  view: EditorView,
  from: number,
  to: number,
  analysis: { quoted: boolean; from: number; dialect?: SqlDialect },
  insert: string,
  start?: number | null,
  /** A second change, earlier in the script, such as an alias after a table name. */
  also?: { at: number; insert: string },
): void {
  const begin = start ?? (analysis.quoted ? from - 1 : from)
  const end =
    view.state.sliceDoc(to, to + 1) === closer(analysis.dialect) && analysis.quoted ? to + 1 : to
  const early = also && also.at <= begin ? also : undefined
  view.dispatch({
    changes: [
      ...(early ? [{ from: early.at, insert: early.insert }] : []),
      { from: begin, to: end, insert },
    ],
    selection: { anchor: begin + insert.length + (early ? early.insert.length : 0) },
  })
}

function tableOptions(
  detail: SchemaDetail,
  database: string | null,
  qualified: boolean,
  write?: {
    analysis: Extract<SqlContext, { kind: 'table' }>
    full: boolean
    dialect: SqlDialect
  },
): Completion[] {
  return detail.tables.map((table) => ({
    label: table.name,
    type: table.view ? 'interface' : 'class',
    detail: table.view ? 'view' : database && qualified ? database : 'table',
    ...(table.comment ? { info: table.comment } : {}),
    apply: write?.full
      ? (view: EditorView, _completion: Completion, from: number, to: number) => {
          const d = write.dialect
          const path = database
            ? `${quoted(database, d)}.${quoted(table.name, d)}`
            : quoted(table.name, d)
          const hasAlias = aliasFollows(view.state.sliceDoc(to))
          const alias =
            write.analysis.aliasable && !hasAlias
              ? ` ${suggestAlias(table.name, new Set(write.analysis.taken))}`
              : ''
          writeOver(
            view,
            from,
            to,
            { quoted: write.analysis.quoted, from: write.analysis.from, dialect: d },
            path + alias,
            write.analysis.qualifierFrom,
          )
        }
      : quoteIfNeeded(table.name, write?.dialect),
  }))
}

/** How a name is written when it is chosen: where the typed part starts, and whether to write names in full. */
interface Write {
  full: boolean
  typed: { quoted: boolean; from: number; dialect?: SqlDialect }
  /** What qualifies a column (an alias or table name), or null to write the column alone. */
  prefix?: string | null
  /** A table with no alias yet gets this one written after its name, so the column can use it. */
  alias?: { at: number; name: string } | null
}

function columnOptions(
  table: SchemaTable,
  owner: string | null,
  foreign: ReadonlySet<string>,
  write: Write,
): Completion[] {
  return table.columns.map((column) => ({
    label: column.name,
    type: 'property',
    detail: owner ? `${column.type} · ${owner}` : column.type,
    ...(column.comment ? { info: column.comment } : {}),
    apply: write.full
      ? (view: EditorView, _completion: Completion, from: number, to: number) =>
          writeOver(
            view,
            from,
            to,
            write.typed,
            `${write.prefix ? `${quoted(write.prefix, write.typed.dialect)}.` : ''}${quoted(column.name, write.typed.dialect)}`,
            undefined,
            write.alias ? { at: write.alias.at, insert: ` ${write.alias.name}` } : undefined,
          )
      : quoteIfNeeded(column.name, write.typed.dialect),
    // Keys first: they are what joins and filters usually use.
    boost:
      column.key === 'PRI'
        ? 3
        : foreign.has(`${table.name}.${column.name}`)
          ? 2
          : column.key
            ? 1
            : 0,
  }))
}

interface Resolved {
  ref: TableRef
  database: string | null
  table: SchemaTable | undefined
  foreignKeys: SchemaForeignKey[]
}

/** Tables a column context reads, resolved against what has been read of the schema they live in. */
function resolveRefs(refs: TableRef[], env: CompletionEnv, current: string | null): Resolved[] {
  return refs.map((ref) => {
    const database = ref.database ?? current
    if (!database) return { ref, database, table: undefined, foreignKeys: [] }
    const name = env.cache.realName(env.connectionId, database, ref.table)
    return {
      ref,
      database,
      table: env.cache.peekTable(env.connectionId, database, name),
      foreignKeys: env.cache.peekForeignKeys(env.connectionId, database, name),
    }
  })
}

/** `a.customer = b.name` for the foreign keys between the table being joined and the ones before it. */
function joinOptions(refs: ReturnType<typeof resolveRefs>, write: Write): Completion[] {
  if (refs.length < 2) return []
  const options: Completion[] = []
  const last = refs[refs.length - 1]!
  const nameOf = (r: TableRef): string => r.alias ?? r.table
  for (const earlier of refs.slice(0, -1)) {
    for (const [from, to] of [
      [last, earlier],
      [earlier, last],
    ] as const) {
      for (const key of from.foreignKeys) {
        if (!same(key.table, from.ref.table) || !same(key.refTable, to.ref.table)) continue
        const label = `${nameOf(from.ref)}.${key.column} = ${nameOf(to.ref)}.${key.refColumn}`
        const [a, b] = [nameOf(from.ref), nameOf(to.ref)]
        options.push({
          label,
          type: 'text',
          detail: 'foreign key',
          boost: 9,
          ...(write.full
            ? {
                apply: (view: EditorView, _c: Completion, at: number, end: number) =>
                  writeOver(
                    view,
                    at,
                    end,
                    write.typed,
                    `${quoted(a, write.typed.dialect)}.${quoted(key.column, write.typed.dialect)} = ${quoted(b, write.typed.dialect)}.${quoted(key.refColumn, write.typed.dialect)}`,
                  ),
              }
            : {}),
        })
      }
    }
  }
  return options
}

/**
 * Names for a SQL script: tables and views after FROM and JOIN, databases after USE and before a dot, columns
 * of the tables a statement reads, and the join condition a foreign key suggests after ON. Keywords come from
 * the language's own source, which the editor lists after this one.
 */
export function sqlCompletionSource(env: CompletionEnv): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const doc = context.state.doc.toString()
    const dialect = env.dialect?.() ?? 'mysql'
    const analysis = analyzeSql(doc, context.pos, dialect)
    if (analysis.kind === 'none' || analysis.kind === 'keyword') return null
    // Without a typed start, only a key press that asked for it shows names, except after a dot.
    const dotted =
      (analysis.kind === 'table' && analysis.qualifier !== null) ||
      (analysis.kind === 'column' && analysis.qualifier !== null)
    if (analysis.prefix === '' && !context.explicit && !dotted && analysis.kind !== 'table') {
      return null
    }
    const current = currentDatabase(env, doc, context.pos)
    const options = await optionsFor(analysis, env, current, dialect)
    if (options === null || options.length === 0) return null
    return {
      from: analysis.from,
      options: options.slice(0, MAX_OPTIONS),
      validFor: /^[\w$]*$/,
    }
  }
}

async function optionsFor(
  analysis: Exclude<SqlContext, { kind: 'none' } | { kind: 'keyword' }>,
  env: CompletionEnv,
  current: string | null,
  dialect: SqlDialect,
): Promise<Completion[] | null> {
  const { cache, connectionId } = env
  const full = env.fullPaths?.() ?? false
  const typed = { quoted: analysis.quoted, from: analysis.from, dialect }

  if (analysis.kind === 'database') {
    const names = await wait(cache.databases(connectionId), null, LOAD_WAIT_MS)
    return names ? databaseOptions(names, false, full, dialect) : null
  }

  if (analysis.kind === 'table') {
    if (analysis.qualifier) {
      const detail = await wait(cache.detail(connectionId, analysis.qualifier), null, LOAD_WAIT_MS)
      return detail
        ? tableOptions(detail, analysis.qualifier, true, { analysis, full, dialect })
        : null
    }
    const [detail, names] = await Promise.all([
      current
        ? wait(cache.detail(connectionId, current), null, LOAD_WAIT_MS)
        : Promise.resolve(null),
      wait(cache.databases(connectionId), null, LOAD_WAIT_MS),
    ])
    return [
      ...(detail ? tableOptions(detail, current, false, { analysis, full, dialect }) : []),
      ...(names ? databaseOptions(names, true, full, dialect) : []),
    ]
  }

  // A column.
  const refs = analysis.tables
  // Which tables' columns are needed, by database: the ones the statement reads, and one named before a dot.
  const wanted = new Map<string, Set<string>>()
  const want = (database: string | null, table: string): void => {
    if (!database) return
    const names = wanted.get(database) ?? new Set<string>()
    names.add(table)
    wanted.set(database, names)
  }
  for (const ref of refs) want(ref.database ?? current, ref.table)
  if (analysis.qualifier) want(analysis.qualifierDatabase ?? current, analysis.qualifier)
  const lists = new Set<string>(wanted.keys())
  if (analysis.qualifier) lists.add(analysis.qualifier)
  // The table lists first, so a name typed in another case is asked for as it really is.
  await Promise.all([...lists].map((d) => wait(cache.detail(connectionId, d), null, LOAD_WAIT_MS)))
  await Promise.all(
    [...wanted].map(([database, names]) =>
      wait(
        cache.columns(
          connectionId,
          database,
          [...names].map((n) => cache.realName(connectionId, database, n)),
        ),
        undefined,
        LOAD_WAIT_MS,
      ),
    ),
  )
  const resolved = resolveRefs(refs, env, current)
  const foreign = new Set(
    resolved.flatMap((r) => r.foreignKeys.map((k) => `${k.table}.${k.column}`)),
  )

  if (analysis.qualifier) {
    const q = analysis.qualifier
    // An alias or the name of a table the statement reads.
    const byName =
      resolved.find((r) => (r.ref.alias ? same(r.ref.alias, q) : false)) ??
      resolved.find(
        (r) =>
          same(r.ref.table, q) &&
          (!analysis.qualifierDatabase || same(r.ref.database ?? '', analysis.qualifierDatabase)),
      )
    if (byName?.table) return columnOptions(byName.table, null, foreign, { full, typed })
    // `shop.orders.` or `orders.` — a table that the statement doesn't read, in a named database.
    const database = analysis.qualifierDatabase ?? current
    const direct = database
      ? cache.peekTable(connectionId, database, cache.realName(connectionId, database, q))
      : undefined
    if (direct) return columnOptions(direct, null, foreign, { full, typed })
    // `shop.` in a column position: the tables of that database.
    const inDatabase = cache.peek(connectionId, q)
    return inDatabase ? tableOptions(inDatabase, q, true, undefined) : null
  }

  if (analysis.clause === 'insert') {
    const target = resolved[0]?.table
    return target ? columnOptions(target, null, foreign, { full, typed }) : null
  }

  const taken = new Set(
    resolved.flatMap((r) => [
      r.ref.table.toLowerCase(),
      ...(r.ref.alias ? [r.ref.alias.toLowerCase()] : []),
    ]),
  )
  const options: Completion[] = []
  if (analysis.clause === 'on') options.push(...joinOptions(resolved, { full, typed }))
  const many = resolved.length > 1
  for (const { ref, table } of resolved) {
    if (!table) continue
    // A table without an alias gets one now, so the statement reads `c`.`id` rather than `Cities`.`id`.
    const give =
      full && analysis.aliasable && !ref.alias && ref.nameEnd < analysis.from
        ? suggestAlias(ref.table, taken)
        : null
    if (give) taken.add(give.toLowerCase())
    const owner = give ?? ref.alias ?? ref.table
    const alias = give ? { at: ref.nameEnd, name: give } : null
    options.push(
      ...columnOptions(table, many ? owner : null, foreign, { full, typed, prefix: owner, alias }),
    )
    // The alias or table name itself, so `o` can become `o.` and go on to its columns.
    if (many || ref.alias) {
      options.push({
        label: owner,
        type: 'variable',
        detail: ref.alias ? ref.table : 'table',
        boost: -1,
        apply: (view, _completion, from, to) => {
          const name = full ? quoted(owner, dialect) : quoteIfNeeded(owner, dialect)
          writeOver(view, from, to, typed, `${name}.`)
          startCompletion(view)
        },
      })
    }
  }
  return options
}

function databaseOptions(
  names: string[],
  withDot: boolean,
  full: boolean,
  dialect: SqlDialect,
): Completion[] {
  const system = dialectInfo(dialect).systemSchemas
  const write = (name: string): string =>
    full ? quoted(name, dialect) : quoteIfNeeded(name, dialect)
  return names.map((name) => ({
    label: name,
    type: 'namespace',
    detail: dialect === 'mysql' ? 'database' : 'schema',
    boost: system.has(name) ? -3 : -1,
    apply: withDot
      ? (view, _completion, from, to) => {
          view.dispatch({
            changes: { from, to, insert: `${write(name)}.` },
            selection: { anchor: from + write(name).length + 1 },
          })
          startCompletion(view)
        }
      : full
        ? (view, _completion, from, to) =>
            writeOver(view, from, to, { quoted: false, from, dialect }, quoted(name, dialect))
        : quoteIfNeeded(name, dialect),
  }))
}
