import {
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import type { SchemaDetail, SchemaTable } from '@shared/driver'
import { analyzeSql, type SqlContext, type TableRef } from '@shared/sql-context'
import type { SchemaCache } from './schema-cache'

/** The most a first completion waits for a schema that is still being read. */
const LOAD_WAIT_MS = 1500
/** Names past this many are left out of one popup; typing more narrows it anyway. */
const MAX_OPTIONS = 4000

const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

/** Words that need quoting to be used as a name. */
const RESERVED = new Set(
  (
    'ADD ALL ALTER AND AS ASC BETWEEN BY CASE COLUMN CREATE CROSS DATABASE DEFAULT DELETE DESC DISTINCT DROP ELSE ' +
    'EXISTS FOR FOREIGN FROM GROUP HAVING IF IN INDEX INNER INSERT INTO IS JOIN KEY LEFT LIKE LIMIT NOT NULL ON OR ' +
    'ORDER OUTER PRIMARY RANGE REFERENCES RIGHT SELECT SET TABLE THEN TO UNION UNIQUE UPDATE USING VALUES WHEN WHERE ' +
    'WITH RANK GROUPS ROW ROWS SYSTEM'
  ).split(' '),
)

const quoteIfNeeded = (name: string): string =>
  /^[A-Za-z_][\w$]*$/.test(name) && !RESERVED.has(name.toUpperCase())
    ? name
    : `\`${name.replace(/`/g, '``')}\``

export interface CompletionEnv {
  connectionId: string
  /** The database the script runs in, or null when it hasn't picked one. */
  database: () => string | null
  cache: SchemaCache
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** The database a script is in: the one it was given, or the last `USE` it has typed. */
export function currentDatabase(env: CompletionEnv, doc: string, upTo: number): string | null {
  const used = [...doc.slice(0, upTo).matchAll(/\bUSE\s+`?([\w$]+)`?\s*;/gi)].at(-1)
  return used ? used[1]! : env.database()
}

const wait = <T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])

function tableOptions(
  detail: SchemaDetail,
  database: string | null,
  qualified: boolean,
): Completion[] {
  return detail.tables.map((table) => ({
    label: table.name,
    type: table.view ? 'interface' : 'class',
    detail: table.view ? 'view' : database && qualified ? database : 'table',
    ...(table.comment ? { info: table.comment } : {}),
    apply: quoteIfNeeded(table.name),
  }))
}

function columnOptions(
  table: SchemaTable,
  owner: string | null,
  foreign: ReadonlySet<string>,
): Completion[] {
  return table.columns.map((column) => ({
    label: column.name,
    type: 'property',
    detail: owner ? `${column.type} · ${owner}` : column.type,
    ...(column.comment ? { info: column.comment } : {}),
    apply: quoteIfNeeded(column.name),
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

/** Tables a column context reads, resolved against the schema they live in. */
function resolveRefs(
  refs: TableRef[],
  env: CompletionEnv,
  current: string | null,
): { ref: TableRef; table: SchemaTable | undefined; detail: SchemaDetail | undefined }[] {
  return refs.map((ref) => {
    const database = ref.database ?? current
    const detail = database ? env.cache.peek(env.connectionId, database) : undefined
    const table = detail?.tables.find((t) => same(t.name, ref.table))
    return { ref, table, detail }
  })
}

/** `a.customer = b.name` for the foreign keys between the table being joined and the ones before it. */
function joinOptions(refs: ReturnType<typeof resolveRefs>): Completion[] {
  if (refs.length < 2) return []
  const options: Completion[] = []
  const last = refs[refs.length - 1]!
  const nameOf = (r: TableRef): string => r.alias ?? r.table
  for (const earlier of refs.slice(0, -1)) {
    for (const [from, to] of [
      [last, earlier],
      [earlier, last],
    ] as const) {
      for (const key of from.detail?.foreignKeys ?? []) {
        if (!same(key.table, from.ref.table) || !same(key.refTable, to.ref.table)) continue
        const label = `${nameOf(from.ref)}.${key.column} = ${nameOf(to.ref)}.${key.refColumn}`
        options.push({ label, type: 'text', detail: 'foreign key', boost: 9 })
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
    const analysis = analyzeSql(doc, context.pos)
    if (analysis.kind === 'none' || analysis.kind === 'keyword') return null
    // Without a typed start, only a key press that asked for it shows names, except after a dot.
    const dotted =
      (analysis.kind === 'table' && analysis.qualifier !== null) ||
      (analysis.kind === 'column' && analysis.qualifier !== null)
    if (analysis.prefix === '' && !context.explicit && !dotted && analysis.kind !== 'table') {
      return null
    }
    const current = currentDatabase(env, doc, context.pos)
    const options = await optionsFor(analysis, env, current)
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
): Promise<Completion[] | null> {
  const { cache, connectionId } = env

  if (analysis.kind === 'database') {
    const names = await wait(cache.databases(connectionId), null, LOAD_WAIT_MS)
    return names ? databaseOptions(names, false) : null
  }

  if (analysis.kind === 'table') {
    if (analysis.qualifier) {
      const detail = await wait(cache.detail(connectionId, analysis.qualifier), null, LOAD_WAIT_MS)
      return detail ? tableOptions(detail, analysis.qualifier, true) : null
    }
    const [detail, names] = await Promise.all([
      current
        ? wait(cache.detail(connectionId, current), null, LOAD_WAIT_MS)
        : Promise.resolve(null),
      wait(cache.databases(connectionId), null, LOAD_WAIT_MS),
    ])
    return [
      ...(detail ? tableOptions(detail, current, false) : []),
      ...(names ? databaseOptions(names, true) : []),
    ]
  }

  // A column.
  const refs = analysis.tables
  const databases = new Set<string>()
  if (current) databases.add(current)
  for (const ref of refs) if (ref.database) databases.add(ref.database)
  if (analysis.qualifierDatabase) databases.add(analysis.qualifierDatabase)
  if (analysis.qualifier) databases.add(analysis.qualifier)
  await Promise.all(
    [...databases].map((d) => wait(cache.detail(connectionId, d), null, LOAD_WAIT_MS)),
  )
  const resolved = resolveRefs(refs, env, current)
  const foreign = new Set(
    resolved.flatMap((r) => (r.detail?.foreignKeys ?? []).map((k) => `${k.table}.${k.column}`)),
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
    if (byName?.table) return columnOptions(byName.table, null, foreign)
    // `shop.orders.` — a table of a named database.
    const database = analysis.qualifierDatabase ?? current
    const direct = database
      ? cache.peek(connectionId, database)?.tables.find((t) => same(t.name, q))
      : undefined
    if (direct) return columnOptions(direct, null, foreign)
    // `shop.` in a column position: the tables of that database.
    const inDatabase = cache.peek(connectionId, q)
    return inDatabase ? tableOptions(inDatabase, q, true) : null
  }

  if (analysis.clause === 'insert') {
    const target = resolved[0]?.table
    return target ? columnOptions(target, null, foreign) : null
  }

  const options: Completion[] = []
  if (analysis.clause === 'on') options.push(...joinOptions(resolved))
  const many = resolved.length > 1
  for (const { ref, table } of resolved) {
    if (!table) continue
    const owner = ref.alias ?? ref.table
    options.push(...columnOptions(table, many ? owner : null, foreign))
    // The alias or table name itself, so `o` can become `o.` and go on to its columns.
    if (many || ref.alias) {
      options.push({
        label: owner,
        type: 'variable',
        detail: ref.alias ? ref.table : 'table',
        boost: -1,
        apply: (view, _completion, from, to) => {
          view.dispatch({
            changes: { from, to, insert: `${owner}.` },
            selection: { anchor: from + owner.length + 1 },
          })
          startCompletion(view)
        },
      })
    }
  }
  // Nothing to read from yet (`SELECT |` before FROM): offer the columns of the whole database, named by table.
  if (refs.length === 0 && current) {
    const detail = cache.peek(connectionId, current)
    for (const table of detail?.tables ?? []) {
      if (options.length > MAX_OPTIONS) break
      options.push(...columnOptions(table, table.name, foreign).map((o) => ({ ...o, boost: -2 })))
    }
  }
  return options
}

function databaseOptions(names: string[], withDot: boolean): Completion[] {
  return names.map((name) => ({
    label: name,
    type: 'namespace',
    detail: 'database',
    boost: SYSTEM_DATABASES.has(name) ? -3 : -1,
    apply: withDot
      ? (view, _completion, from, to) => {
          view.dispatch({
            changes: { from, to, insert: `${quoteIfNeeded(name)}.` },
            selection: { anchor: from + quoteIfNeeded(name).length + 1 },
          })
          startCompletion(view)
        }
      : quoteIfNeeded(name),
  }))
}
