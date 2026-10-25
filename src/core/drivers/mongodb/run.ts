import {
  BSON,
  type AnyBulkWriteOperation,
  type Collection,
  type Db,
  type Document,
  type MongoClient,
} from 'mongodb'
import type { ResultBatch } from '@shared/driver'
import { documentColumn } from '@shared/mongo/documents'
import { formatShell, numberOf, type Json } from '@shared/mongo/ejson'
import { evaluate } from '@shared/mongo/eval'
import { pipelineWrites, type Expr, type Modifier, type MongoCommand } from '@shared/mongo/lang'
import { fromEjson, plainNumber, toEjson, toEjsonText, type Bson } from './bson'
import { ShellError } from './errors'

/** Documents per `rows` batch handed to the window, and the most text one batch may hold. */
const BATCH_DOCS = 100
const BATCH_CHARS = 2 * 1024 * 1024

const { EJSON } = BSON

export interface RunEnv {
  client: MongoClient
  /** The database the statement runs in. Null when none was chosen. */
  database: string | null
  signal: AbortSignal
  /** Marks this statement's reads on the server, so a cancel can find them and stop them. */
  tag: string
  /** `use` switched the session's database. */
  switchDatabase: (name: string) => void
}

// ───────────────────────────── arguments ─────────────────────────────

/** The arguments of one call, evaluated on demand. Typed values keep their BSON type; options become plain. */
class Args {
  constructor(
    private readonly exprs: Expr[],
    private readonly method: string,
  ) {}

  get length(): number {
    return this.exprs.length
  }

  private json(index: number): Json | undefined {
    const expr = this.exprs[index]
    return expr === undefined ? undefined : evaluate(expr)
  }

  /** A document, array or value with every number keeping its type. Null for a missing argument. */
  bson(index: number): Bson | undefined {
    const json = this.json(index)
    return json === undefined ? undefined : fromEjson(json)
  }

  /** The same with plain numbers, for the options the driver reads (limit, sort directions, ...). */
  plain(index: number): unknown {
    const json = this.json(index)
    return json === undefined
      ? undefined
      : EJSON.deserialize(json as unknown as Document, { relaxed: true })
  }

  /** Plain-number form of a required document or array, such as index keys. */
  plainRequired(index: number, what: string): Bson {
    const value = this.plain(index)
    if (value === undefined || value === null || typeof value !== 'object') {
      throw new ShellError(`${this.method}() needs ${what}.`, 'BAD_ARGUMENT')
    }
    return value as Bson
  }

  number(index: number): number | undefined {
    const json = this.json(index)
    if (json === undefined || json === null) return undefined
    const number = numberOf(json)
    if (number === null)
      throw new ShellError(`${this.method}() needs a number here.`, 'BAD_ARGUMENT')
    return number
  }

  string(index: number): string | undefined {
    const json = this.json(index)
    if (json === undefined || json === null) return undefined
    if (typeof json !== 'string') {
      throw new ShellError(`${this.method}() needs text in quotes here.`, 'BAD_ARGUMENT')
    }
    return json
  }

  require(index: number, what: string): Bson {
    const value = this.bson(index)
    if (value === undefined || value === null) {
      throw new ShellError(`${this.method}() needs ${what}.`, 'BAD_ARGUMENT')
    }
    return value
  }

  document(index: number, what: string): Document {
    const value = this.require(index, what)
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new ShellError(
        `${this.method}() needs ${what} as a document, written { ... }.`,
        'BAD_ARGUMENT',
      )
    }
    return value as Document
  }

  array(index: number, what: string): Bson[] {
    const value = this.require(index, what)
    if (!Array.isArray(value)) {
      throw new ShellError(
        `${this.method}() needs ${what} as an array, written [ ... ].`,
        'BAD_ARGUMENT',
      )
    }
    return value
  }

  /** A filter: missing means every document. */
  filter(index: number): Document {
    const value = this.bson(index)
    if (value === undefined || value === null) return {}
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new ShellError(`${this.method}() needs a filter written { ... }.`, 'BAD_ARGUMENT')
    }
    return value as Document
  }

  options(index: number): Record<string, unknown> {
    const value = this.plain(index)
    if (value === undefined || value === null) return {}
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new ShellError(`${this.method}() needs its options written { ... }.`, 'BAD_ARGUMENT')
    }
    return value as Record<string, unknown>
  }
}

const ok = (message: string, affectedRows = 0, insertId: string | null = null): ResultBatch => ({
  kind: 'ok',
  affectedRows,
  insertId,
  message,
  warnings: 0,
})

const idText = (id: unknown): string => formatShell(toEjson(id))
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

// ───────────────────────────── results ─────────────────────────────

/**
 * Streams documents (or any values) as rows of one column. The column is announced only once the first
 * value is in hand, so a query the server rejects reports its error instead of an empty result.
 */
async function* emit(
  values: AsyncIterable<unknown> | Iterable<unknown>,
  source?: { database: string; collection: string },
): AsyncGenerator<ResultBatch> {
  const iterator =
    Symbol.asyncIterator in values
      ? (values as AsyncIterable<unknown>)[Symbol.asyncIterator]()
      : (async function* () {
          yield* values as Iterable<unknown>
        })()
  try {
    let next = await iterator.next()
    yield { kind: 'columns', columns: [documentColumn(source)] }
    let rows: unknown[][] = []
    let chars = 0
    while (!next.done) {
      const text = toEjsonText(next.value)
      rows.push([text])
      chars += text.length
      if (rows.length >= BATCH_DOCS || chars >= BATCH_CHARS) {
        yield { kind: 'rows', rows }
        rows = []
        chars = 0
      }
      next = await iterator.next()
    }
    if (rows.length > 0) yield { kind: 'rows', rows }
  } finally {
    await iterator.return?.(undefined)
  }
}

// ───────────────────────────── cursors ─────────────────────────────

/** The cursor calls scripts may chain, which `find` and `aggregate` cursors share between them. */
interface CursorLike {
  [Symbol.asyncIterator](): AsyncIterator<unknown>
  close(): Promise<void>
  explain(verbosity?: string): Promise<Document>
  sort(spec: unknown): unknown
  limit(count: number): unknown
  skip(count: number): unknown
  project(spec: unknown): unknown
  hint(spec: unknown): unknown
  collation(spec: unknown): unknown
  maxTimeMS(ms: number): unknown
  batchSize(count: number): unknown
  comment(text: string): unknown
  allowDiskUse(allow: unknown): unknown
  min(spec: unknown): unknown
  max(spec: unknown): unknown
  returnKey(on: unknown): unknown
  showRecordId(on: unknown): unknown
}

/** Cursor calls that change nothing about what the cursor returns. */
const NO_OPS = new Set(['toArray', 'pretty', 'hasNext', 'objsLeftInBatch'])

function applyModifiers(
  cursor: CursorLike,
  modifiers: Modifier[],
  allowed: Record<string, (cursor: CursorLike, args: Args) => void>,
): { explain: string | null; count: boolean } {
  let explain: string | null = null
  let count = false
  for (const modifier of modifiers) {
    const args = new Args(modifier.args, modifier.name)
    if (NO_OPS.has(modifier.name)) continue
    if (modifier.name === 'explain') {
      explain = args.string(0) ?? 'queryPlanner'
      continue
    }
    if (modifier.name === 'count' || modifier.name === 'itcount') {
      count = true
      continue
    }
    const apply = allowed[modifier.name]
    if (!apply) {
      throw new ShellError(
        modifier.name === 'forEach' || modifier.name === 'map'
          ? `.${modifier.name}() is not supported. Scripts can't loop; run the query and use the result.`
          : `.${modifier.name}() is not supported on this cursor.`,
        'NOT_SUPPORTED',
      )
    }
    apply(cursor, args)
  }
  return { explain, count }
}

const FIND_MODIFIERS: Record<string, (cursor: CursorLike, args: Args) => void> = {
  sort: (c, a) => c.sort(a.plain(0)),
  limit: (c, a) => c.limit(a.number(0) ?? 0),
  skip: (c, a) => c.skip(a.number(0) ?? 0),
  project: (c, a) => c.project(a.plain(0)),
  projection: (c, a) => c.project(a.plain(0)),
  hint: (c, a) => c.hint(a.plain(0)),
  collation: (c, a) => c.collation(a.plain(0)),
  maxTimeMS: (c, a) => c.maxTimeMS(a.number(0) ?? 0),
  batchSize: (c, a) => c.batchSize(a.number(0) ?? 0),
  comment: (c, a) => c.comment(a.string(0) ?? ''),
  allowDiskUse: (c, a) => c.allowDiskUse(a.plain(0) ?? true),
  min: (c, a) => c.min(a.plain(0)),
  max: (c, a) => c.max(a.plain(0)),
  returnKey: (c, a) => c.returnKey(a.plain(0) ?? true),
  showRecordId: (c, a) => c.showRecordId(a.plain(0) ?? true),
}

const AGGREGATE_MODIFIERS: Record<string, (cursor: CursorLike, args: Args) => void> = {
  maxTimeMS: (c, a) => c.maxTimeMS(a.number(0) ?? 0),
  batchSize: (c, a) => c.batchSize(a.number(0) ?? 0),
  hint: (c, a) => c.hint(a.plain(0)),
  collation: (c, a) => c.collation(a.plain(0)),
  comment: (c, a) => c.comment(a.string(0) ?? ''),
  allowDiskUse: (c, a) => c.allowDiskUse(a.plain(0) ?? true),
}

/** Options every read takes: cancel, and a tag the server shows in `currentOp`. */
const reading = (env: RunEnv, options: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...options,
  signal: env.signal,
  comment: options.comment ?? env.tag,
})

// ───────────────────────────── collection methods ─────────────────────────────

const LEGACY: Record<string, string> = {
  insert: 'Use insertOne() or insertMany().',
  update: 'Use updateOne(), updateMany() or replaceOne().',
  remove: 'Use deleteOne() or deleteMany().',
  save: 'Use insertOne() or replaceOne().',
  findAndModify: 'Use findOneAndUpdate(), findOneAndReplace() or findOneAndDelete().',
  mapReduce: 'Use an aggregation pipeline instead.',
  ensureIndex: 'Use createIndex().',
  reIndex: 'Rebuild the index with dropIndex() and createIndex().',
  getDB: 'Switch with use <database> instead.',
}

function updateSummary(result: {
  matchedCount: unknown
  modifiedCount: unknown
  upsertedCount?: unknown
  upsertedId?: unknown
}): ResultBatch {
  const upserted = result.upsertedId !== null && result.upsertedId !== undefined
  const modified = plainNumber(result.modifiedCount)
  return ok(
    `Matched ${plainNumber(result.matchedCount)}, modified ${modified}${upserted ? `, inserted ${idText(result.upsertedId)}` : ''}.`,
    modified + (upserted ? 1 : 0),
    upserted ? idText(result.upsertedId) : null,
  )
}

async function* collectionMethod(
  env: RunEnv,
  db: Db,
  command: Extract<MongoCommand, { kind: 'collection' }>,
): AsyncGenerator<ResultBatch> {
  const { method, modifiers } = command
  const args = new Args(command.args, method)
  const collection: Collection = db.collection(command.collection)
  const source = { database: db.databaseName, collection: command.collection }
  const write: Record<string, unknown> = { signal: env.signal }

  switch (method) {
    case 'find': {
      const options = args.options(2)
      const projection = args.plain(1)
      const cursor = collection.find(args.filter(0), {
        ...reading(env, options),
        ...(projection ? { projection } : {}),
      } as never) as unknown as CursorLike
      try {
        const { explain, count } = applyModifiers(cursor, modifiers, FIND_MODIFIERS)
        if (command.explain !== null || explain !== null) {
          yield* emit([await cursor.explain(command.explain ?? explain ?? 'queryPlanner')])
        } else if (count) {
          yield* emit([await collection.countDocuments(args.filter(0), reading(env) as never)])
        } else {
          yield* emit(cursor, source)
        }
      } finally {
        await cursor.close().catch(() => undefined)
      }
      return
    }

    case 'findOne': {
      const projection = args.plain(1)
      const cursor = collection.find(args.filter(0), {
        ...reading(env, args.options(2)),
        ...(projection ? { projection } : {}),
        limit: 1,
      } as never) as unknown as CursorLike
      try {
        const { explain } = applyModifiers(cursor, modifiers, FIND_MODIFIERS)
        if (command.explain !== null || explain !== null) {
          yield* emit([await cursor.explain(command.explain ?? explain ?? 'queryPlanner')])
        } else {
          yield* emit(cursor, source)
        }
      } finally {
        await cursor.close().catch(() => undefined)
      }
      return
    }

    case 'aggregate': {
      const pipeline = args.array(0, 'a pipeline')
      const cursor = collection.aggregate(
        pipeline,
        reading(env, args.options(1)) as never,
      ) as unknown as CursorLike
      try {
        const { explain } = applyModifiers(cursor, modifiers, AGGREGATE_MODIFIERS)
        if (command.explain !== null || explain !== null) {
          yield* emit([await cursor.explain(command.explain ?? explain ?? 'queryPlanner')])
        } else if (pipelineWrites(command.args[0])) {
          // A pipeline that ends in $out or $merge returns nothing; running it is iterating it.
          for await (const _ of cursor) void _
          yield ok('The pipeline ran and wrote its output.')
        } else {
          yield* emit(cursor)
        }
      } finally {
        await cursor.close().catch(() => undefined)
      }
      return
    }

    case 'countDocuments':
    case 'count':
      yield* emit([
        await collection.countDocuments(args.filter(0), reading(env, args.options(1)) as never),
      ])
      return

    case 'estimatedDocumentCount':
      yield* emit([await collection.estimatedDocumentCount({ signal: env.signal } as never)])
      return

    case 'distinct': {
      const field = args.string(0)
      if (!field) throw new ShellError('distinct() needs a field name in quotes.', 'BAD_ARGUMENT')
      const values = await collection.distinct(
        field,
        args.filter(1),
        reading(env, args.options(2)) as never,
      )
      yield* emit(values)
      return
    }

    case 'getIndexes':
      yield* emit(collection.listIndexes({ signal: env.signal } as never) as AsyncIterable<unknown>)
      return

    case 'stats':
    case 'validate':
      yield* emit([
        await db.command(
          method === 'stats' ? { collStats: command.collection } : { validate: command.collection },
          { signal: env.signal } as never,
        ),
      ])
      return

    case 'dataSize':
    case 'storageSize':
    case 'totalIndexSize':
    case 'totalSize':
    case 'isCapped': {
      const stats = (await db.command({ collStats: command.collection }, {
        promoteValues: true,
        signal: env.signal,
      } as never)) as Document
      const value =
        method === 'dataSize'
          ? stats.size
          : method === 'storageSize'
            ? stats.storageSize
            : method === 'totalIndexSize'
              ? stats.totalIndexSize
              : method === 'totalSize'
                ? Number(stats.storageSize) + Number(stats.totalIndexSize)
                : stats.capped
      yield* emit([value])
      return
    }

    case 'insertOne': {
      const result = await collection.insertOne(args.document(0, 'a document'), write as never)
      yield ok('Inserted 1 document.', 1, idText(result.insertedId))
      return
    }

    case 'insertMany': {
      const result = await collection.insertMany(args.array(0, 'an array of documents'), {
        ...write,
        ...args.options(1),
      } as never)
      yield ok(
        `Inserted ${plural(result.insertedCount, 'document')}.`,
        result.insertedCount,
        idText(result.insertedIds[0]),
      )
      return
    }

    case 'updateOne':
    case 'updateMany':
    case 'replaceOne': {
      const filter = args.filter(0)
      const update = args.require(
        1,
        method === 'replaceOne' ? 'a replacement document' : 'an update',
      )
      const options = { ...write, ...args.options(2) } as never
      const result =
        method === 'updateOne'
          ? await collection.updateOne(filter, update, options)
          : method === 'updateMany'
            ? await collection.updateMany(filter, update, options)
            : await collection.replaceOne(filter, update, options)
      yield updateSummary(result)
      return
    }

    case 'deleteOne':
    case 'deleteMany': {
      const options = { ...write, ...args.options(1) } as never
      const result =
        method === 'deleteOne'
          ? await collection.deleteOne(args.filter(0), options)
          : await collection.deleteMany(args.filter(0), options)
      const deleted = plainNumber(result.deletedCount)
      yield ok(`Deleted ${plural(deleted, 'document')}.`, deleted)
      return
    }

    case 'findOneAndUpdate':
    case 'findOneAndReplace':
    case 'findOneAndDelete': {
      const filter = args.filter(0)
      const second = method === 'findOneAndDelete' ? 1 : 2
      const options: Record<string, unknown> = { ...write, ...args.options(second) }
      // The shell's older spelling.
      if (options.returnNewDocument === true) options.returnDocument = 'after'
      delete options.returnNewDocument
      const document =
        method === 'findOneAndUpdate'
          ? await collection.findOneAndUpdate(
              filter,
              args.require(1, 'an update'),
              options as never,
            )
          : method === 'findOneAndReplace'
            ? await collection.findOneAndReplace(
                filter,
                args.document(1, 'a replacement'),
                options as never,
              )
            : await collection.findOneAndDelete(filter, options as never)
      yield* emit(document ? [document] : [])
      return
    }

    case 'bulkWrite': {
      const result = await collection.bulkWrite(
        args.array(0, 'an array of operations') as AnyBulkWriteOperation[],
        { ...write, ...args.options(1) } as never,
      )
      const counts = {
        inserted: plainNumber(result.insertedCount),
        matched: plainNumber(result.matchedCount),
        modified: plainNumber(result.modifiedCount),
        deleted: plainNumber(result.deletedCount),
        upserted: plainNumber(result.upsertedCount),
      }
      yield ok(
        `Inserted ${counts.inserted}, matched ${counts.matched}, modified ${counts.modified}, deleted ${counts.deleted}, upserted ${counts.upserted}.`,
        counts.inserted + counts.modified + counts.deleted + counts.upserted,
      )
      return
    }

    case 'createIndex': {
      const name = await collection.createIndex(
        args.plainRequired(0, 'the index keys, written { field: 1 }'),
        { ...write, ...args.options(1) } as never,
      )
      yield ok(`Created index ${name}.`)
      return
    }

    case 'createIndexes': {
      const names = await collection.createIndexes(
        args.plainRequired(0, 'an array of index specifications') as never,
        write as never,
      )
      yield ok(`Created ${plural(names.length, 'index')}: ${names.join(', ')}.`)
      return
    }

    case 'dropIndex': {
      const target = args.plain(0)
      await collection.dropIndex(
        typeof target === 'string' ? target : await indexNameFor(collection, target),
        write as never,
      )
      yield ok('Dropped the index.')
      return
    }

    case 'dropIndexes':
      await collection.dropIndexes(write as never)
      yield ok('Dropped every index except _id.')
      return

    case 'drop':
      await collection.drop(write as never)
      yield ok(`Dropped the collection ${command.collection}.`)
      return

    case 'renameCollection': {
      const to = args.string(0)
      if (!to)
        throw new ShellError('renameCollection() needs the new name in quotes.', 'BAD_ARGUMENT')
      await collection.rename(to, { ...write, dropTarget: args.plain(1) === true } as never)
      yield ok(`Renamed ${command.collection} to ${to}.`)
      return
    }

    default:
      throw new ShellError(
        LEGACY[method]
          ? `${method}() is no longer part of the shell. ${LEGACY[method]}`
          : `${method}() is not supported yet.`,
        'NOT_SUPPORTED',
      )
  }
}

/** The name of the index whose key matches, for `dropIndex({ a: 1 })`. */
async function indexNameFor(collection: Collection, key: unknown): Promise<string> {
  const wanted = JSON.stringify(key)
  for (const index of await collection.indexes({ promoteValues: true } as never)) {
    if (JSON.stringify(index.key) === wanted) return String(index.name)
  }
  throw new ShellError('No index has those keys.', 'NOT_FOUND')
}

// ───────────────────────────── database methods ─────────────────────────────

async function* databaseMethod(
  env: RunEnv,
  db: Db,
  command: Extract<MongoCommand, { kind: 'database' }>,
): AsyncGenerator<ResultBatch> {
  const { method } = command
  const args = new Args(command.args, method)
  const options = { signal: env.signal } as never
  const run = (document: Document, on: Db = db): Promise<Document> => on.command(document, options)

  switch (method) {
    case 'getName':
      yield* emit([db.databaseName])
      return
    case 'getCollectionNames': {
      const infos = await db
        .listCollections({}, { nameOnly: true, promoteValues: true, signal: env.signal } as never)
        .toArray()
      yield* emit(infos.map((i) => String(i.name)).sort((a, b) => a.localeCompare(b)))
      return
    }
    case 'getCollectionInfos':
    case 'listCollections':
      yield* emit(
        db.listCollections(args.filter(0), {
          signal: env.signal,
        } as never) as AsyncIterable<unknown>,
      )
      return
    case 'stats':
      yield* emit([await run({ dbStats: 1, ...(args.number(0) ? { scale: args.number(0) } : {}) })])
      return
    case 'version': {
      const info = (await db.command({ buildInfo: 1 }, {
        promoteValues: true,
        signal: env.signal,
      } as never)) as Document
      yield* emit([String(info.version)])
      return
    }
    case 'serverBuildInfo':
      yield* emit([await run({ buildInfo: 1 })])
      return
    case 'serverStatus':
      yield* emit([await run({ serverStatus: 1 })])
      return
    case 'hostInfo':
      yield* emit([await run({ hostInfo: 1 })])
      return
    case 'currentOp':
      yield* emit([
        await run(
          { currentOp: 1, ...(args.length > 0 ? args.document(0, 'a filter') : {}) },
          env.client.db('admin'),
        ),
      ])
      return
    case 'getProfilingStatus':
      yield* emit([await run({ profile: -1 })])
      return
    case 'hello':
    case 'isMaster':
      yield* emit([await run({ hello: 1 })])
      return
    case 'listCommands':
      yield* emit([await run({ listCommands: 1 })])
      return

    case 'runCommand':
    case 'adminCommand': {
      const first = args.require(0, 'a command')
      const document: Document = typeof first === 'string' ? { [first]: 1 } : first
      const on = method === 'adminCommand' ? env.client.db('admin') : db
      yield* emit([await on.command(document, { ...args.options(1), signal: env.signal } as never)])
      return
    }

    case 'createCollection': {
      const name = args.string(0)
      if (!name)
        throw new ShellError(
          'createCollection() needs the collection name in quotes.',
          'BAD_ARGUMENT',
        )
      // The driver sends every option it doesn't know to the server, so this one gets no signal.
      await db.createCollection(name, args.options(1) as never)
      yield ok(`Created the collection ${name}.`)
      return
    }
    case 'createView': {
      const name = args.string(0)
      const viewOn = args.string(1)
      if (!name || !viewOn) {
        throw new ShellError(
          'createView() needs the view name and the collection it reads, both in quotes.',
          'BAD_ARGUMENT',
        )
      }
      await db.createCollection(name, { viewOn, pipeline: args.array(2, 'a pipeline') } as never)
      yield ok(`Created the view ${name}.`)
      return
    }
    case 'dropDatabase':
      await db.dropDatabase(options)
      yield ok(`Dropped the database ${db.databaseName}.`)
      return

    default:
      throw new ShellError(`db.${method}() is not supported yet.`, 'NOT_SUPPORTED')
  }
}

// ───────────────────────────── entry point ─────────────────────────────

function needDatabase(env: RunEnv): string {
  if (!env.database) {
    throw new ShellError(
      'No database is selected. Pick one in the toolbar, or start the script with use <database>.',
      'NO_DATABASE',
    )
  }
  return env.database
}

/** Runs one parsed statement and streams what it returns. */
export async function* runCommand(command: MongoCommand, env: RunEnv): AsyncGenerator<ResultBatch> {
  env.signal.throwIfAborted()
  switch (command.kind) {
    case 'use':
      env.switchDatabase(command.database)
      yield ok(`Switched to the database ${command.database}.`)
      return

    case 'show':
      if (command.what === 'databases') {
        const reply = (await env.client
          .db('admin')
          .command({ listDatabases: 1, authorizedDatabases: true }, {
            signal: env.signal,
          } as never)) as Document
        yield* emit(reply.databases as Document[])
      } else {
        yield* emit(
          env.client.db(needDatabase(env)).listCollections({}, {
            nameOnly: false,
            signal: env.signal,
          } as never) as AsyncIterable<unknown>,
        )
      }
      return

    case 'database':
      // These work without a database; the server's own databases answer them.
      yield* databaseMethod(
        env,
        env.client.db(command.database ?? env.database ?? 'admin'),
        command,
      )
      return

    case 'collection':
      yield* collectionMethod(env, env.client.db(command.database ?? needDatabase(env)), command)
      return
  }
}
