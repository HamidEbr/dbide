import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { mongoCompletionSource, type CompletionEnv } from './completion'

const env = (fields: Record<string, string[]> = {}): CompletionEnv => ({
  collections: () => ['orders', 'order-items', 'users'],
  fields: (_db, collection) => Promise.resolve(fields[collection] ?? []),
})

/** What the editor offers with the cursor at the `|` in `text`. */
async function at(
  text: string,
  source = env({ orders: ['_id', 'status', 'address.city', 'total'] }),
) {
  const pos = text.indexOf('|')
  const doc = text.replace('|', '')
  const context = new CompletionContext(EditorState.create({ doc }), pos, false)
  const result = (await mongoCompletionSource(
    source,
    () => 'shop',
  )(context)) as CompletionResult | null
  return {
    from: result?.from,
    labels: result ? (result.options as { label: string }[]).map((o) => o.label) : null,
    options: result?.options as { label: string; apply?: unknown }[] | undefined,
  }
}

describe('mongoCompletionSource', () => {
  it('offers the collections and the database methods after db.', async () => {
    const { labels, from } = await at('db.|')
    expect(labels).toEqual(
      expect.arrayContaining(['orders', 'order-items', 'users', 'getCollection', 'runCommand']),
    )
    expect(from).toBe(3)
  })

  it('finishes a word being typed, and writes a collection with an odd name as getCollection', async () => {
    const { from, options } = await at('db.ord|')
    expect(from).toBe(3)
    expect(options!.find((o) => o.label === 'order-items')?.apply).toBe(
      'getCollection("order-items")',
    )
    expect(options!.find((o) => o.label === 'orders')?.apply).toBeUndefined()
  })

  it('offers the collection methods after a collection', async () => {
    expect((await at('db.orders.|')).labels).toEqual(
      expect.arrayContaining(['find', 'aggregate', 'updateOne', 'createIndex']),
    )
    expect((await at('db.getCollection("a-b").fi|')).labels).toContain('find')
    expect((await at('db.getSiblingDB("other").users.|')).labels).toContain('deleteMany')
  })

  it('offers the cursor methods after a call', async () => {
    const { labels } = await at('db.orders.find({}).|')
    expect(labels).toEqual(expect.arrayContaining(['sort', 'limit', 'skip', 'explain']))
    expect(labels).not.toContain('find')
  })

  it('offers operators where a $ is typed, for the kind of call it is in', async () => {
    const find = (await at('db.orders.find({ total: { $|')).labels!
    expect(find).toEqual(expect.arrayContaining(['$gt', '$in']))
    const pipeline = (await at('db.orders.aggregate([{ $|')).labels!
    expect(pipeline.indexOf('$match')).toBeLessThan(pipeline.indexOf('$gt'))
    const update = (await at('db.orders.updateOne({}, { $|')).labels!
    expect(update.indexOf('$set')).toBeLessThan(update.indexOf('$gt'))
  })

  it('offers the fields of the collection being queried where a key goes', async () => {
    const { labels, options } = await at('db.orders.find({ st|')
    expect(labels).toEqual(expect.arrayContaining(['_id', 'status', 'total', 'address.city']))
    expect(options!.find((o) => o.label === 'address.city')?.apply).toBe('"address.city"')
    expect(options!.find((o) => o.label === 'status')?.apply).toBeUndefined()
    // After a comma too, but not where a value goes.
    expect((await at('db.orders.find({ a: 1, |')).labels).toContain('status')
    expect((await at('db.orders.find({ status: |')).labels).toBeNull()
  })

  it('offers nothing for a collection whose fields could not be read', async () => {
    expect((await at('db.users.find({ |')).labels).toBeNull()
  })

  it('offers the BSON helpers where a value goes', async () => {
    const { labels } = await at('db.orders.find({ _id: Obj|')
    expect(labels).toEqual(expect.arrayContaining(['ObjectId', 'ISODate', 'NumberLong']))
  })

  it('offers the statements that start a script', async () => {
    const { labels } = await at('sh|')
    expect(labels).toEqual(expect.arrayContaining(['db', 'use', 'show dbs']))
  })

  it('looks only at the statement the cursor is in', async () => {
    const { labels } = await at('db.orders.find({})\ndb.users.|')
    expect(labels).toContain('insertOne')
  })

  it('has nothing to say in the middle of a plain word', async () => {
    expect((await at('db.orders.find({ a: "hello wor|')).labels).toBeNull()
  })
})
