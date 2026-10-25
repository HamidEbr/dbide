/**
 * Runs the MongoDB driver against a real server. Skipped unless DBIDE_TEST_MONGO_URL is set, e.g.
 *
 *   DBIDE_TEST_MONGO_URL=mongodb://127.0.0.1:27017 pnpm test
 *
 * The URL's user needs to create and drop databases. Every test works inside a throwaway database
 * that is dropped at the end. Set DBIDE_TEST_MONGO_RS=1 when the server is a replica set, so the
 * transaction tests expect edits to be atomic.
 *
 * A server that requires a login is reached with credentials in the URL (percent-encode the password).
 * A server that requires TLS is covered by the last suites, which need DBIDE_TEST_MONGO_TLS_URL and the
 * certificate authority that signed its certificate in DBIDE_TEST_MONGO_CA. A server that also wants a
 * certificate from the client is DBIDE_TEST_MONGO_MTLS_URL, with the client's own DBIDE_TEST_MONGO_CLIENT_CERT
 * and DBIDE_TEST_MONGO_CLIENT_KEY.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newConnectionDraft, type ConnectionConfig } from '@shared/connection'
import type { DriverSession, ResultBatch, TreeNode } from '@shared/driver'
import type { DocumentEditBatch } from '@shared/mongo/documents'
import { formatShell, numberOf, typeOf, type Json } from '@shared/mongo/ejson'
import { parseConnectionUri } from '@shared/uri'
import { mongoDriver } from './driver'

const url = process.env.DBIDE_TEST_MONGO_URL
const parsed = url ? parseConnectionUri(url) : null
const replicaSet = process.env.DBIDE_TEST_MONGO_RS === '1'

async function connect(overrides: { readOnly?: boolean } = {}): Promise<DriverSession> {
  const config: ConnectionConfig = {
    ...newConnectionDraft('mongodb', 'it'),
    name: 'integration',
    host: parsed!.host,
    port: parsed!.port,
    ...(parsed!.username ? { username: parsed!.username } : {}),
    options: {
      ...parsed!.options,
      // A single member of a replica set advertises its own names; stay on the one address given.
      ...(replicaSet ? { directConnection: 'true' } : {}),
    },
  }
  return mongoDriver.connect({
    config,
    secrets: parsed!.password ? { password: parsed!.password } : {},
    endpoint: { host: config.host, port: config.port },
    ...(overrides.readOnly ? { readOnly: true } : {}),
    signal: new AbortController().signal,
  })
}

async function collect(
  session: DriverSession,
  text: string,
  target?: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<ResultBatch[]> {
  const batches: ResultBatch[] = []
  for await (const batch of session.execute({ text, ...(target ? { target } : {}) }, signal)) {
    batches.push(batch)
  }
  return batches
}

/** The documents of a result, read back from their Extended JSON text. */
const documentsOf = (batches: ResultBatch[]): Json[] =>
  batches
    .flatMap((b) => (b.kind === 'rows' ? b.rows : []))
    .map((row) => JSON.parse(String(row[0])) as Json)

const okOf = (batches: ResultBatch[]) => batches.find((b) => b.kind === 'ok')

const shell = (value: Json): string => formatShell(value)

describe.skipIf(!parsed)('MongoDB driver (live server)', () => {
  const database = `dbide_it_${Math.random().toString(16).slice(2, 10)}`
  let session: DriverSession
  let root: TreeNode[]

  beforeAll(async () => {
    session = await connect()
    await collect(
      session,
      `db.items.insertMany([
        { _id: 1, name: "apple", qty: 5, price: 1.5, tags: ["fruit", "red"], at: ISODate("2024-01-02T03:04:05Z"), nested: { a: { b: 1 } } },
        { _id: 2, name: "banana", qty: 12, price: 0.25, tags: ["fruit"], at: ISODate("2024-02-03T00:00:00Z") },
        { _id: 3, name: "carrot", qty: 0, price: 2.0, tags: [], big: NumberLong("9007199254740993"), dec: NumberDecimal("12.50") },
        { _id: 4, name: "date", qty: 7, uid: UUID("12345678-9abc-def0-1234-56789abcdef0"), bin: BinData(0, "AQID") },
      ])`,
      database,
    )
    await collect(session, 'db.items.createIndex({ name: 1 }, { unique: true })')
    await collect(session, `db.getCollection("order-items").insertOne({ sku: "x" })`, database)
    await collect(session, 'db.createView("fruit", "items", [{ $match: { tags: "fruit" } }])')
    root = await session.children(null, new AbortController().signal)
  })

  afterAll(async () => {
    await collect(session, 'db.dropDatabase()', database).catch(() => undefined)
    await session.close()
  })

  it('reports the server it connected to', () => {
    expect(session.info.serverVersion).toMatch(/^\d+\.\d+/)
    expect(session.info.readOnly).toBe(false)
    expect(session.info.readOnlyEnforcedByServer).toBe(false)
  })

  describe('the tree', () => {
    const none = new AbortController().signal

    it('lists databases, with the system ones grouped', () => {
      const node = root.find((n) => n.label === database)
      expect(node).toMatchObject({ kind: 'database', hasChildren: true, scope: database })
      expect(root.find((n) => n.kind === 'group')?.label).toBe('System databases')
      expect(root.every((n) => n.label !== 'admin' || n.kind === 'group')).toBe(true)
    })

    it('lists collections and views with their counts, then indexes', async () => {
      const db = root.find((n) => n.label === database)!
      const children = await session.children(db, none)
      expect(children.map((n) => [n.label, n.kind])).toEqual([
        ['fruit', 'view'],
        ['items', 'collection'],
        ['order-items', 'collection'],
        // The server keeps this for the view; it is listed last, as system collections are.
        ['system.views', 'collection'],
      ])
      expect(children.find((n) => n.label === 'items')?.detail).toBe('4')
      expect(children.find((n) => n.label === 'fruit')).toMatchObject({
        detail: 'view',
        hasChildren: false,
      })

      const indexes = await session.children(
        children.find((n) => n.label === 'items')!,
        none,
      )
      expect(indexes.map((n) => n.label).sort()).toEqual(['_id_', 'name_1'])
      expect(indexes.find((n) => n.label === 'name_1')?.detail).toBe('unique · name ↑')
    })

    it('gives collection names for autocomplete and field names from a sample', async () => {
      expect(Object.keys((await session.completionSchema?.(database, none)) ?? {})).toEqual(
        expect.arrayContaining(['items', 'order-items', 'fruit']),
      )
      const fields = (await session.sampleFields?.(database, 'items', none)) ?? []
      expect(fields).toEqual(
        expect.arrayContaining(['_id', 'name', 'tags', 'nested', 'nested.a', 'nested.a.b']),
      )
    })
  })

  describe('queries', () => {
    it('finds documents, sorted and limited, as one column of Extended JSON', async () => {
      const batches = await collect(
        session,
        'db.items.find({ qty: { $gt: 0 } }).sort({ qty: -1 }).limit(2)',
        database,
      )
      expect(batches[0]).toMatchObject({
        kind: 'columns',
        columns: [
          { name: 'document', type: 'document', source: { schema: database, table: 'items' } },
        ],
      })
      expect(documentsOf(batches).map((d) => (d as Record<string, Json>).name)).toEqual([
        'banana',
        'date',
      ])
    })

    it('keeps every number and BSON type exactly as stored', async () => {
      const docs = documentsOf(
        await collect(session, 'db.items.find({}).sort({ _id: 1 })', database),
      )
      const [apple, , carrot, date] = docs as Record<string, Json>[]
      expect(typeOf(apple!._id!)).toBe('int')
      expect(typeOf(apple!.price!)).toBe('double')
      expect(apple!.at).toEqual({ $date: { $numberLong: String(Date.UTC(2024, 0, 2, 3, 4, 5)) } })
      expect(typeOf(carrot!.big!)).toBe('long')
      expect(carrot!.big).toEqual({ $numberLong: '9007199254740993' })
      expect(typeOf(carrot!.dec!)).toBe('decimal')
      // A whole double stays a double.
      expect(carrot!.price).toEqual({ $numberDouble: '2.0' })
      expect(typeOf(date!.uid!)).toBe('uuid')
      expect(shell(date!.uid!)).toBe('UUID("12345678-9abc-def0-1234-56789abcdef0")')
      expect(shell(date!.bin!)).toBe('BinData(0, "AQID")')
    })

    it('filters by typed values', async () => {
      const byDate = await collect(
        session,
        'db.items.find({ at: { $gte: ISODate("2024-02-01") } }, { name: 1, _id: 0 })',
        database,
      )
      expect(documentsOf(byDate)).toEqual([{ name: 'banana' }])
      const byLong = await collect(
        session,
        'db.items.find({ big: NumberLong("9007199254740993") }, { name: 1, _id: 0 })',
        database,
      )
      expect(documentsOf(byLong)).toEqual([{ name: 'carrot' }])
      const byRegex = await collect(
        session,
        'db.items.find({ name: /^A/i }, { name: 1, _id: 0 })',
        database,
      )
      expect(documentsOf(byRegex)).toEqual([{ name: 'apple' }])
    })

    it('runs the other read methods', async () => {
      const count = documentsOf(
        await collect(session, 'db.items.countDocuments({ qty: { $gt: 0 } })', database),
      )
      expect(count).toEqual([{ $numberInt: '3' }])
      const estimated = documentsOf(
        await collect(session, 'db.items.estimatedDocumentCount()', database),
      )
      expect(estimated).toEqual([{ $numberInt: '4' }])
      const distinct = documentsOf(await collect(session, 'db.items.distinct("tags")', database))
      expect(distinct.sort()).toEqual(['fruit', 'red'])
      const one = documentsOf(await collect(session, 'db.items.findOne({ _id: 2 })', database))
      expect(one).toHaveLength(1)
      const none = await collect(session, 'db.items.findOne({ _id: 99 })', database)
      expect(documentsOf(none)).toEqual([])
      // An empty result still announces its column.
      expect(none[0]?.kind).toBe('columns')
      const names = documentsOf(await collect(session, 'db.getCollectionNames()', database))
      // A view makes the server keep system.views, which the shell lists too.
      expect(names).toEqual(['fruit', 'items', 'order-items', 'system.views'])
      const viaCursor = documentsOf(await collect(session, 'db.items.find({}).count()', database))
      expect(viaCursor).toEqual([{ $numberInt: '4' }])
    })

    it('runs aggregations', async () => {
      const batches = await collect(
        session,
        `db.items.aggregate([
          { $unwind: "$tags" },
          { $group: { _id: "$tags", n: { $sum: 1 } } },
          { $sort: { n: -1, _id: 1 } },
        ])`,
        database,
      )
      expect(documentsOf(batches).map((d) => (d as Record<string, Json>)._id)).toEqual([
        'fruit',
        'red',
      ])
      // Aggregation results are computed, so they are not tied to a collection for editing.
      expect((batches[0] as { columns: { source?: unknown }[] }).columns[0]?.source).toBeUndefined()
    })

    it('reads a view, and the collection and database it is addressed through', async () => {
      expect(
        documentsOf(
          await collect(
            session,
            'db.fruit.find({}, { name: 1, _id: 0 }).sort({ name: 1 })',
            database,
          ),
        ),
      ).toEqual([{ name: 'apple' }, { name: 'banana' }])
      expect(
        documentsOf(
          await collect(session, 'db.getCollection("order-items").find({}, { _id: 0 })', database),
        ),
      ).toEqual([{ sku: 'x' }])
      expect(
        documentsOf(
          await collect(session, `db.getSiblingDB("${database}").items.countDocuments({})`),
        ),
      ).toEqual([{ $numberInt: '4' }])
    })

    it('explains a query', async () => {
      const plan = documentsOf(
        await collect(
          session,
          'db.items.explain("executionStats").find({ name: "apple" })',
          database,
        ),
      )
      expect(JSON.stringify(plan)).toMatch(/IXSCAN/)
      const viaCursor = documentsOf(
        await collect(session, 'db.items.find({ qty: 5 }).explain()', database),
      )
      expect(JSON.stringify(viaCursor)).toMatch(/queryPlanner/)
    })

    it('lists indexes and runs commands', async () => {
      const indexes = documentsOf(await collect(session, 'db.items.getIndexes()', database))
      expect(indexes.map((i) => (i as Record<string, Json>).name).sort()).toEqual([
        '_id_',
        'name_1',
      ])
      const ping = documentsOf(await collect(session, 'db.runCommand({ ping: 1 })', database))
      expect(numberOf((ping[0] as Record<string, Json>).ok!)).toBe(1)
      const version = documentsOf(await collect(session, 'db.version()', database))
      expect(version[0]).toBe(session.info.serverVersion)
      const dbs = documentsOf(await collect(session, 'show dbs'))
      expect(JSON.stringify(dbs)).toContain(database)
    })

    it('uses the database a script switches to', async () => {
      const own = await connect()
      try {
        const switched = await collect(own, `use ${database}`)
        expect(okOf(switched)).toMatchObject({
          kind: 'ok',
          message: expect.stringContaining(database),
        })
        expect(documentsOf(await collect(own, 'db.items.countDocuments({})'))).toEqual([
          { $numberInt: '4' },
        ])
        expect(
          documentsOf(await collect(own, 'show collections')).map(
            (d) => (d as Record<string, Json>).name,
          ),
        ).toContain('items')
      } finally {
        await own.close()
      }
    })

    it('says so when no database is chosen', async () => {
      const own = await connect()
      try {
        await expect(collect(own, 'db.items.find()')).rejects.toMatchObject({ code: 'NO_DATABASE' })
      } finally {
        await own.close()
      }
    })
  })

  describe('streaming', () => {
    it('hands documents over in batches and closes the cursor when the reader leaves early', async () => {
      await collect(
        session,
        'db.bulk.insertMany(' +
          JSON.stringify(Array.from({ length: 2500 }, (_, i) => ({ n: i }))) +
          ')',
        database,
      )
      const sizes: number[] = []
      for await (const batch of session.execute(
        { text: 'db.bulk.find({}).sort({ n: 1 })', target: database },
        new AbortController().signal,
      )) {
        if (batch.kind === 'rows') sizes.push(batch.rows.length)
        if (sizes.length === 3) break
      }
      expect(sizes).toEqual([100, 100, 100])
      // The session is still usable afterwards.
      expect(documentsOf(await collect(session, 'db.bulk.countDocuments({})', database))).toEqual([
        { $numberInt: '2500' },
      ])
      const all = documentsOf(await collect(session, 'db.bulk.find({}).sort({ n: 1 })', database))
      expect(all).toHaveLength(2500)
    })

    it('cancels a query that is still running on the server', async () => {
      const controller = new AbortController()
      const started = Date.now()
      const run = collect(
        session,
        'db.bulk.find({ $where: "sleep(30000) || true" })',
        database,
        controller.signal,
      )
      setTimeout(() => controller.abort(), 300)
      await expect(run).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(5000)
      // The connection works again straight away.
      expect(documentsOf(await collect(session, 'db.items.countDocuments({})', database))).toEqual([
        { $numberInt: '4' },
      ])
    })
  })

  describe('syntax errors', () => {
    it('point at the line and column', async () => {
      await expect(
        collect(session, 'db.items.find({\n  qty: ObjectId("nope")\n})', database),
      ).rejects.toMatchObject({
        code: 'SYNTAX_ERROR',
        message: expect.stringMatching(/24 hexadecimal.*line 2, column 8/),
      })
    })

    it('say what is not supported', async () => {
      await expect(collect(session, 'var x = 1', database)).rejects.toMatchObject({
        code: 'SYNTAX_ERROR',
      })
      await expect(collect(session, 'db.items.mapReduce()', database)).rejects.toMatchObject({
        code: 'NOT_SUPPORTED',
        message: expect.stringContaining('aggregation pipeline'),
      })
      await expect(
        collect(session, 'db.items.find().forEach(printjson)', database),
      ).rejects.toMatchObject({
        code: 'NOT_SUPPORTED',
      })
    })

    it('relay the server’s own message for a query it refuses', async () => {
      await expect(
        collect(session, 'db.items.find({ $badOperator: 1 })', database),
      ).rejects.toThrow(/unknown top level operator/i)
    })
  })

  describe('writes', () => {
    it('insert, update, replace and delete, and say what they did', async () => {
      const inserted = await collect(session, 'db.scratch.insertOne({ _id: "a", n: 1 })', database)
      expect(okOf(inserted)).toMatchObject({ affectedRows: 1, insertId: '"a"' })
      const updated = await collect(
        session,
        'db.scratch.updateOne({ _id: "a" }, { $set: { n: 2 } })',
        database,
      )
      expect(okOf(updated)).toMatchObject({ affectedRows: 1, message: 'Matched 1, modified 1.' })
      const upserted = await collect(
        session,
        'db.scratch.updateOne({ _id: "b" }, { $set: { n: 1 } }, { upsert: true })',
        database,
      )
      expect(okOf(upserted)).toMatchObject({ insertId: '"b"' })
      const replaced = await collect(
        session,
        'db.scratch.replaceOne({ _id: "a" }, { n: 3 })',
        database,
      )
      expect(okOf(replaced)).toMatchObject({ message: 'Matched 1, modified 1.' })
      const after = await collect(
        session,
        'db.scratch.findOneAndUpdate({ _id: "a" }, { $inc: { n: 1 } }, { returnDocument: "after" })',
        database,
      )
      expect(documentsOf(after)).toEqual([{ _id: 'a', n: { $numberInt: '4' } }])
      const deleted = await collect(session, 'db.scratch.deleteMany({})', database)
      expect(okOf(deleted)).toMatchObject({ affectedRows: 2, message: 'Deleted 2 documents.' })
    })

    it('create and drop indexes and collections', async () => {
      expect(
        okOf(
          await collect(session, 'db.scratch.createIndex({ n: -1 }, { name: "by_n" })', database),
        ),
      ).toMatchObject({
        message: 'Created index by_n.',
      })
      await collect(session, 'db.scratch.dropIndex("by_n")', database)
      await collect(session, 'db.createCollection("made")', database)
      expect(documentsOf(await collect(session, 'db.getCollectionNames()', database))).toContain(
        'made',
      )
      expect(okOf(await collect(session, 'db.made.drop()', database))).toMatchObject({ kind: 'ok' })
    })
  })

  describe('read-only sessions', () => {
    it('refuse everything that is not a read, before it reaches the server', async () => {
      const locked = await connect({ readOnly: true })
      try {
        expect(locked.info.readOnly).toBe(true)
        await collect(locked, 'db.items.find({})', database)
        for (const text of [
          'db.items.insertOne({ _id: 99 })',
          'db.items.deleteMany({})',
          'db.items.updateOne({ _id: 1 }, { $set: { qty: 0 } })',
          'db.items.aggregate([{ $match: {} }, { $out: "copy" }])',
          'db.items.createIndex({ qty: 1 })',
          'db.items.drop()',
          'db.dropDatabase()',
          'db.runCommand({ drop: "items" })',
          'db.items.mapReduce()',
        ]) {
          await expect(collect(locked, text, database), text).rejects.toMatchObject({
            code: expect.stringMatching(/READ_ONLY|NOT_SUPPORTED/),
          })
        }
        expect(documentsOf(await collect(locked, 'db.items.countDocuments({})', database))).toEqual(
          [{ $numberInt: '4' }],
        )

        // Unlocking the same session lets writes through.
        await locked.setReadOnly?.(false)
        expect(
          okOf(await collect(locked, 'db.scratch.insertOne({ _id: "z" })', database)),
        ).toBeDefined()
        await locked.setReadOnly?.(true)
        await expect(
          collect(locked, 'db.scratch.deleteOne({ _id: "z" })', database),
        ).rejects.toMatchObject({ code: 'READ_ONLY' })
      } finally {
        await locked.close()
      }
    })
  })

  describe('editing documents', () => {
    const none = new AbortController().signal
    const batch = (changes: DocumentEditBatch['changes']): DocumentEditBatch => ({
      database,
      collection: 'people',
      changes,
    })
    const people = async (): Promise<Json[]> =>
      documentsOf(await collect(session, 'db.people.find({}).sort({ _id: 1 })', database))

    it('changes only the fields it is told to and returns the stored document', async () => {
      await collect(
        session,
        'db.people.insertMany([{ _id: 1, name: "Ada", age: 36, note: "x" }, { _id: 2, name: "Bob" }])',
        database,
      )
      const result = await session.applyDocumentEdits!(
        batch([
          {
            kind: 'update',
            id: { $numberInt: '1' },
            set: { age: { $numberInt: '37' }, 'address.city': 'London' },
            unset: ['note'],
          },
          { kind: 'insert', document: { _id: { $numberInt: '3' }, name: 'Cy' } },
          { kind: 'delete', id: { $numberInt: '2' } },
        ]),
        none,
      )
      expect(result).toMatchObject({ ok: true, atomic: replicaSet })
      if (!result.ok) return
      expect(JSON.parse(result.results[0]!.document!)).toEqual({
        _id: { $numberInt: '1' },
        name: 'Ada',
        age: { $numberInt: '37' },
        address: { city: 'London' },
      })
      expect(JSON.parse(result.results[1]!.document!)).toEqual({
        _id: { $numberInt: '3' },
        name: 'Cy',
      })
      expect(result.results[2]!.document).toBeNull()
      expect((await people()).map((d) => (d as Record<string, Json>).name)).toEqual(['Ada', 'Cy'])
    })

    it('fails a change whose document is gone, and says how much was kept', async () => {
      await collect(session, 'db.people.deleteMany({})', database)
      await collect(session, 'db.people.insertOne({ _id: 1, name: "Ada" })', database)
      const result = await session.applyDocumentEdits!(
        batch([
          { kind: 'update', id: { $numberInt: '1' }, set: { name: 'Ada L' }, unset: [] },
          { kind: 'delete', id: { $numberInt: '404' } },
        ]),
        none,
      )
      expect(result).toMatchObject({ ok: false, failedIndex: 1, code: 'ROW_COUNT' })
      const name = ((await people())[0] as Record<string, Json>).name
      if (replicaSet) {
        expect(result).toMatchObject({
          applied: 0,
          message: expect.stringContaining('Nothing was saved'),
        })
        expect(name).toBe('Ada')
      } else {
        expect(result).toMatchObject({
          applied: 1,
          message: expect.stringContaining('1 earlier change was already saved'),
        })
        expect(name).toBe('Ada L')
      }
    })

    it('refuses to change an _id, and a duplicate key is the server’s to report', async () => {
      expect(
        await session.applyDocumentEdits!(
          batch([
            {
              kind: 'update',
              id: { $numberInt: '1' },
              set: { _id: { $numberInt: '9' } },
              unset: [],
            },
          ]),
          none,
        ),
      ).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
      expect(
        await session.applyDocumentEdits!(
          batch([{ kind: 'insert', document: { _id: { $numberInt: '1' }, name: 'dup' } }]),
          none,
        ),
      ).toMatchObject({
        ok: false,
        code: 'DuplicateKey',
        message: expect.stringMatching(/duplicate key/i),
      })
    })

    it('refuses on a read-only session', async () => {
      const locked = await connect({ readOnly: true })
      try {
        expect(
          await locked.applyDocumentEdits!(
            batch([{ kind: 'delete', id: { $numberInt: '1' } }]),
            none,
          ),
        ).toMatchObject({ ok: false, code: 'READ_ONLY' })
      } finally {
        await locked.close()
      }
    })
  })

  describe('errors', () => {
    it('explain a refused login', async () => {
      const config: ConnectionConfig = {
        ...newConnectionDraft('mongodb', 'it'),
        host: parsed!.host,
        port: parsed!.port,
        username: 'nobody',
        options: { ...(replicaSet ? { directConnection: 'true' } : {}) },
      }
      const attempt = mongoDriver.connect({
        config,
        secrets: { password: 'wrong' },
        endpoint: { host: config.host, port: config.port },
        signal: new AbortController().signal,
      })
      if (parsed!.username) {
        await expect(attempt).rejects.toMatchObject({ code: 'AuthenticationFailed' })
      } else {
        // A server without access control lets any login in.
        await attempt.then((s) => s.close()).catch(() => undefined)
      }
    })

    it('stops trying to connect when cancelled', async () => {
      const controller = new AbortController()
      const config: ConnectionConfig = {
        ...newConnectionDraft('mongodb', 'it'),
        host: '10.255.255.1',
        port: 27017,
      }
      const attempt = mongoDriver.connect({
        config,
        secrets: {},
        endpoint: { host: config.host, port: config.port },
        signal: controller.signal,
      })
      setTimeout(() => controller.abort(), 200)
      await expect(attempt).rejects.toMatchObject({ name: 'AbortError' })
    })
  })
})

const tlsUrl = process.env.DBIDE_TEST_MONGO_TLS_URL
const caPath = process.env.DBIDE_TEST_MONGO_CA
const tls = tlsUrl ? parseConnectionUri(tlsUrl) : null

describe.skipIf(!tls || !caPath)(
  'MongoDB driver over TLS (live server)',
  { timeout: 20_000 },
  () => {
    const open = (
      overrides: Partial<ConnectionConfig['tls']> & { enabled?: boolean },
      options: Record<string, string> = {},
    ): Promise<DriverSession> => {
      const config: ConnectionConfig = {
        ...newConnectionDraft('mongodb', 'tls'),
        host: tls!.host,
        port: tls!.port,
        tls: { enabled: true, allowInvalidCertificates: false, ...overrides },
        options: { serverSelectionTimeoutMS: '3000', ...options },
      }
      return mongoDriver.connect({
        config,
        secrets: {},
        endpoint: { host: config.host, port: config.port },
        signal: new AbortController().signal,
      })
    }

    it('connects when it trusts the authority that signed the certificate', async () => {
      const session = await open({ caPath: caPath! })
      try {
        expect(
          documentsOf(await collect(session, 'db.runCommand({ ping: 1 })', 'admin')),
        ).toHaveLength(1)
      } finally {
        await session.close()
      }
    })

    it('refuses a certificate it has no reason to trust, and says to check the TLS settings', async () => {
      await expect(open({})).rejects.toMatchObject({
        message: expect.stringMatching(/certificate|TLS|self.signed/i),
      })
    })

    it('connects without checking when told to, for local use', async () => {
      const session = await open({ allowInvalidCertificates: true })
      await session.close()
    })

    it('does not manage to talk plainly to a server that wants TLS', async () => {
      await expect(open({ enabled: false })).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
    })
  },
)

const mtlsUrl = process.env.DBIDE_TEST_MONGO_MTLS_URL
const clientCert = process.env.DBIDE_TEST_MONGO_CLIENT_CERT
const clientKey = process.env.DBIDE_TEST_MONGO_CLIENT_KEY
const mtls = mtlsUrl ? parseConnectionUri(mtlsUrl) : null

describe.skipIf(!mtls || !caPath || !clientCert || !clientKey)(
  'MongoDB driver with a client certificate (live server)',
  { timeout: 20_000 },
  () => {
    const open = (withCertificate: boolean): Promise<DriverSession> => {
      const config: ConnectionConfig = {
        ...newConnectionDraft('mongodb', 'mtls'),
        host: mtls!.host,
        port: mtls!.port,
        tls: {
          enabled: true,
          allowInvalidCertificates: false,
          caPath: caPath!,
          ...(withCertificate ? { certPath: clientCert!, keyPath: clientKey! } : {}),
        },
        options: { serverSelectionTimeoutMS: '3000' },
      }
      return mongoDriver.connect({
        config,
        secrets: {},
        endpoint: { host: config.host, port: config.port },
        signal: new AbortController().signal,
      })
    }

    it('connects when it presents the certificate the server asks for', async () => {
      const session = await open(true)
      await session.close()
    })

    it('is turned away without one', async () => {
      await expect(open(false)).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
    })
  },
)
