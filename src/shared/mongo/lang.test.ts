import { describe, expect, it } from 'vitest'
import {
  classifyMongo,
  lineAndColumn,
  MongoSyntaxError,
  parseMongoStatement,
  splitMongoStatements,
  tokenize,
  type Expr,
  type MongoCommand,
} from './lang'

const collection = (text: string): Extract<MongoCommand, { kind: 'collection' }> => {
  const command = parseMongoStatement(text)
  if (command.kind !== 'collection')
    throw new Error(`expected a collection command, got ${command.kind}`)
  return command
}

/** A value reduced to plain data, so tests can compare it. */
function plain(expr: Expr): unknown {
  switch (expr.t) {
    case 'object':
      return Object.fromEntries(expr.props.map((p) => [p.key, plain(p.value)]))
    case 'array':
      return expr.items.map(plain)
    case 'string':
    case 'bool':
      return expr.value
    case 'number':
      return expr.float ? { float: expr.value } : expr.value
    case 'null':
      return null
    case 'undefined':
      return undefined
    case 'regex':
      return { regex: expr.pattern, flags: expr.flags }
    case 'ref':
      return { ref: expr.name }
    case 'call':
      return { call: plain(expr.callee), args: expr.args.map(plain), new: expr.isNew }
    case 'unary':
      return { unary: expr.op, of: plain(expr.operand) }
    case 'binary':
      return { binary: expr.op, left: plain(expr.left), right: plain(expr.right) }
    default:
      return { [expr.t]: true }
  }
}

describe('tokenize', () => {
  it('reads strings with either quote and their escapes', () => {
    const { tokens, error } = tokenize(`'it\\'s' "tab\\there" "\\u00e9\\x41"`)
    expect(error).toBeNull()
    expect(tokens.map((t) => t.value)).toEqual(["it's", 'tab\there', 'éA'])
  })

  it('treats a slash after an operator as a regex and after a value as division', () => {
    const regex = tokenize('{ a: /ab+c/i }').tokens.find((t) => t.type === 'regex')
    expect(regex).toMatchObject({ value: 'ab+c', flags: 'i' })
    expect(tokenize('(4 / 2)').tokens.some((t) => t.type === 'regex')).toBe(false)
    // A slash inside a character class does not end the regex.
    expect(tokenize('/[/]x/').tokens[0]).toMatchObject({ type: 'regex', value: '[/]x' })
  })

  it('skips comments', () => {
    const { tokens } = tokenize('db // one\n/* two */ .a')
    expect(tokens.map((t) => t.value)).toEqual(['db', '.', 'a'])
  })

  it('reports what it could not read and keeps what came before', () => {
    const { tokens, error } = tokenize('db.a.find({ n: "oops')
    expect(error).toBeInstanceOf(MongoSyntaxError)
    expect(error?.message).toMatch(/never closed/)
    expect(tokens.map((t) => t.value)).toEqual(['db', '.', 'a', '.', 'find', '(', '{', 'n', ':'])
  })

  it('names the BigInt literal and the template placeholder as unsupported', () => {
    expect(tokenize('12n').error?.message).toMatch(/NumberLong/)
    expect(tokenize('`a ${b}`').error?.message).toMatch(/Placeholders/)
  })
})

describe('splitMongoStatements', () => {
  it('splits on semicolons and on a new line that starts with a name', () => {
    const text = 'db.a.find({})\ndb.b.find({});\nshow dbs\nuse shop'
    expect(splitMongoStatements(text).map((s) => s.text)).toEqual([
      'db.a.find({})',
      'db.b.find({})',
      'show dbs',
      'use shop',
    ])
  })

  it('keeps a chain that continues on the next line together', () => {
    const text = 'db.orders.find({ a: 1 })\n  .sort({ b: -1 })\n  .limit(5)\ndb.x.find()'
    expect(splitMongoStatements(text).map((s) => s.text)).toEqual([
      'db.orders.find({ a: 1 })\n  .sort({ b: -1 })\n  .limit(5)',
      'db.x.find()',
    ])
    expect(splitMongoStatements('db.a.\nfind()').map((s) => s.text)).toEqual(['db.a.\nfind()'])
  })

  it('never splits inside brackets, strings or comments', () => {
    const text = 'db.a.aggregate([\n  { $match: { s: "x;\\ny" } }, // a; b\n  { $limit: 1 }\n])'
    expect(splitMongoStatements(text)).toHaveLength(1)
  })

  it('gives each statement its offsets', () => {
    const text = '  db.a.find() ;\n\n  db.b.find()'
    const [first, second] = splitMongoStatements(text)
    expect(text.slice(first!.from, first!.to)).toBe('db.a.find()')
    expect(first!.end).toBe(text.indexOf(';') + 1)
    expect(text.slice(second!.from, second!.to)).toBe('db.b.find()')
  })

  it('keeps a half-typed string inside the statement being typed', () => {
    const statements = splitMongoStatements('db.a.find()\ndb.b.find({ n: "x')
    expect(statements.map((s) => s.text)).toEqual(['db.a.find()', 'db.b.find({ n: "x'])
  })

  it('returns nothing for empty text and comment-only text', () => {
    expect(splitMongoStatements('')).toEqual([])
    expect(splitMongoStatements('// nothing here\n/* or here */')).toEqual([])
    expect(splitMongoStatements(' ; ; ')).toEqual([])
  })
})

describe('parseMongoStatement', () => {
  it('reads a find with a chain of cursor calls', () => {
    const command = collection(
      'db.orders.find({ status: "paid", total: { $gt: 10.5 } }, { _id: 0 }).sort({ at: -1 }).limit(20)',
    )
    expect(command).toMatchObject({
      collection: 'orders',
      method: 'find',
      database: null,
      explain: null,
    })
    expect(command.args.map(plain)).toEqual([
      { status: 'paid', total: { $gt: { float: 10.5 } } },
      { _id: 0 },
    ])
    expect(command.modifiers.map((m) => [m.name, m.args.map(plain)])).toEqual([
      ['sort', [{ at: { unary: '-', of: 1 } }]],
      ['limit', [20]],
    ])
  })

  it('accepts the other ways to name a collection', () => {
    expect(collection('db.getCollection("order-items").find()').collection).toBe('order-items')
    expect(collection('db["order-items"].find()').collection).toBe('order-items')
    expect(collection('db.system.users.find()').collection).toBe('system.users')
    expect(collection('db.getSiblingDB("other").orders.find()')).toMatchObject({
      database: 'other',
      collection: 'orders',
    })
  })

  it('reads database-level calls', () => {
    expect(parseMongoStatement('db.stats()')).toMatchObject({ kind: 'database', method: 'stats' })
    expect(parseMongoStatement('db.runCommand({ ping: 1 })')).toMatchObject({
      kind: 'database',
      method: 'runCommand',
    })
    expect(parseMongoStatement('db.getSiblingDB("x").getCollectionNames()')).toMatchObject({
      kind: 'database',
      database: 'x',
      method: 'getCollectionNames',
    })
    expect(parseMongoStatement('db')).toMatchObject({ kind: 'database', method: 'getName' })
  })

  it('reads use and show', () => {
    expect(parseMongoStatement('use shop')).toEqual({ kind: 'use', database: 'shop' })
    expect(parseMongoStatement('use "my-db"')).toEqual({ kind: 'use', database: 'my-db' })
    expect(parseMongoStatement('show dbs')).toEqual({ kind: 'show', what: 'databases' })
    expect(parseMongoStatement('show collections;')).toEqual({ kind: 'show', what: 'collections' })
    expect(() => parseMongoStatement('show users')).toThrow(/not supported/)
  })

  it('reads explain in front of the method', () => {
    const command = collection('db.orders.explain("executionStats").find({ a: 1 })')
    expect(command).toMatchObject({ method: 'find', explain: 'executionStats' })
    expect(command.args.map(plain)).toEqual([{ a: 1 }])
  })

  it('reads the values a query is made of', () => {
    const [filter] = collection(
      `db.t.find({
        _id: ObjectId("507f1f77bcf86cd799439011"),
        at: { $gte: new Date(Date.now() - 7 * 86400000) },
        name: /^ab/i,
        'quoted key': [1, 2.0, -3, 0x10, 1e3,],
        n: NumberLong("5"), x: null, y: undefined, ok: true,
      })`,
    ).args
    const value = plain(filter!) as Record<string, unknown>
    expect(value._id).toEqual({
      call: { ref: 'ObjectId' },
      args: ['507f1f77bcf86cd799439011'],
      new: false,
    })
    expect(value.name).toEqual({ regex: '^ab', flags: 'i' })
    expect(value['quoted key']).toEqual([
      1,
      { float: 2 },
      { unary: '-', of: 3 },
      16,
      { float: 1000 },
    ])
    expect(value.at).toMatchObject({ $gte: { new: true, args: [{ binary: '-' }] } })
  })

  it('allows comments and a trailing semicolon', () => {
    expect(collection('// all of them\ndb.a.find() /* done */ ;').method).toBe('find')
  })

  it('says what is not supported instead of failing obscurely', () => {
    expect(() => parseMongoStatement('var x = db.a.findOne()')).toThrow(
      /Variables are not supported/,
    )
    expect(() => parseMongoStatement('db.a.find().forEach(printjson)')).not.toThrow()
    expect(() => parseMongoStatement('rs.status()')).toThrow(/rs\.\* helpers/)
    expect(() => parseMongoStatement('foo.bar()')).toThrow(/Unknown name “foo”/)
    expect(() => parseMongoStatement('db.a')).toThrow(/Call a method/)
    expect(() => parseMongoStatement('db.a.find({ a })')).toThrow(/needs a value/)
  })

  it('refuses two statements and points at the second', () => {
    try {
      parseMongoStatement('db.a.find()\ndb.b.find()')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(MongoSyntaxError)
      expect((error as MongoSyntaxError).message).toMatch(/one statement at a time/)
      expect((error as MongoSyntaxError).at).toBe('db.a.find()\n'.length)
    }
  })

  it('reports an unreadable tail as the error it is', () => {
    expect(() => parseMongoStatement('db.a.find({ n: "x')).toThrow(/never closed/)
    expect(() => parseMongoStatement('db.a.find({ n: ')).toThrow()
    expect(() => parseMongoStatement('')).toThrow(/nothing to run/)
  })
})

describe('lineAndColumn', () => {
  it('counts from one', () => {
    expect(lineAndColumn('ab\ncd', 0)).toEqual({ line: 1, column: 1 })
    expect(lineAndColumn('ab\ncd', 4)).toEqual({ line: 2, column: 2 })
  })
})

describe('classifyMongo', () => {
  const kind = (text: string): string => classifyMongo(text).kind

  it('knows the reads', () => {
    for (const text of [
      'db.a.find({})',
      'db.a.findOne()',
      'db.a.aggregate([{ $match: {} }])',
      'db.a.countDocuments({})',
      'db.a.distinct("x")',
      'db.a.getIndexes()',
      'db.a.explain().find({})',
      'db.a.find().explain("executionStats")',
      'db.getCollectionNames()',
      'db.stats()',
      'db.runCommand({ ping: 1 })',
      'db.adminCommand({ listDatabases: 1 })',
      'show dbs',
    ]) {
      expect(kind(text), text).toBe('read')
    }
  })

  it('knows the writes, schema changes and admin commands', () => {
    expect(kind('db.a.insertOne({})')).toBe('write')
    expect(kind('db.a.updateMany({ a: 1 }, { $set: { b: 2 } })')).toBe('write')
    expect(kind('db.a.aggregate([{ $match: {} }, { $out: "b" }])')).toBe('write')
    expect(kind('db.a.aggregate([{ $merge: { into: "b" } }])')).toBe('write')
    expect(kind('db.a.createIndex({ a: 1 })')).toBe('ddl')
    expect(kind('db.createCollection("c")')).toBe('ddl')
    expect(kind('db.runCommand({ shutdown: 1 })')).toBe('admin')
    expect(kind('use shop')).toBe('session')
    expect(kind('db.a.mapReduce()')).toBe('unknown')
  })

  it('flags what removes data, and filters that match everything', () => {
    expect(classifyMongo('db.a.drop()')).toMatchObject({ destructive: true })
    expect(classifyMongo('db.dropDatabase()')).toMatchObject({ destructive: true })
    expect(classifyMongo('db.runCommand({ dropDatabase: 1 })')).toMatchObject({ destructive: true })
    expect(classifyMongo('db.a.deleteMany({})')).toMatchObject({
      kind: 'write',
      destructive: true,
      reason: expect.stringMatching(/removes every document/),
    })
    expect(classifyMongo('db.a.deleteMany()')).toMatchObject({ destructive: true })
    expect(classifyMongo('db.a.updateMany({}, { $set: { a: 1 } })')).toMatchObject({
      destructive: true,
      reason: expect.stringMatching(/changes every document/),
    })
    expect(classifyMongo('db.a.deleteOne({})')).toMatchObject({ destructive: true })
    expect(classifyMongo('db.a.deleteMany({ a: 1 })').destructive).toBe(false)
    expect(classifyMongo('db.a.updateOne({ _id: 1 }, { $set: { a: 1 } })').destructive).toBe(false)
  })

  it('does not call text that fails to parse a write', () => {
    expect(kind('db.a.find({')).toBe('read')
    expect(kind('var x = 1')).toBe('read')
  })
})
